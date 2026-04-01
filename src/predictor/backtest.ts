/**
 * 历史回测模块
 *
 * 通过 ClickHouse GH Archive 公开实例查询历史事件数据，
 * 验证"先导信号→爆发"的时间差假设。
 *
 * 多因子分析：star 加速度、fork 活跃度、issue 活跃度、PR 活跃度
 */

const CLICKHOUSE_URL = 'https://play.clickhouse.com/?user=play';

// ─── ClickHouse 查询 ────────────────────────────────────────────

interface WeeklyMetrics {
  week: string;
  new_stars: number;
  new_forks: number;
  new_issues: number;
  new_prs: number;
  unique_pushers: number;    // unique contributors (PushEvent actors)
  new_releases: number;      // ReleaseEvent count
}

/**
 * 从 ClickHouse GH Archive 查询仓库的周级多因子指标
 */
export async function fetchWeeklyMetrics(
  repoName: string,
  fromDate?: string,
  toDate?: string,
): Promise<WeeklyMetrics[]> {
  const from = fromDate ?? '2020-01-01';
  const to = toDate ?? new Date().toISOString().slice(0, 10);

  const sql = `
    SELECT
      toStartOfWeek(created_at) AS week,
      countIf(event_type = 'WatchEvent') AS new_stars,
      countIf(event_type = 'ForkEvent') AS new_forks,
      countIf(event_type = 'IssuesEvent') AS new_issues,
      countIf(event_type = 'PullRequestEvent') AS new_prs,
      uniqIf(actor_login, event_type = 'PushEvent') AS unique_pushers,
      countIf(event_type = 'ReleaseEvent') AS new_releases
    FROM github_events
    WHERE repo_name = '${escapeSQL(repoName)}'
      AND created_at >= '${from}'
      AND created_at <= '${to}'
    GROUP BY week
    ORDER BY week ASC
    FORMAT JSONEachRow
  `;

  const res = await fetch(CLICKHOUSE_URL, {
    method: 'POST',
    body: sql,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`ClickHouse query failed: ${res.status} — ${text.slice(0, 200)}`);
  }

  const text = await res.text();
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.map(line => {
    const row = JSON.parse(line);
    return {
      week: row.week.slice(0, 10),
      new_stars: Number(row.new_stars),
      new_forks: Number(row.new_forks),
      new_issues: Number(row.new_issues),
      new_prs: Number(row.new_prs),
      unique_pushers: Number(row.unique_pushers ?? 0),
      new_releases: Number(row.new_releases ?? 0),
    };
  });
}

function escapeSQL(s: string): string {
  return s.replace(/'/g, "\\'");
}

// ─── 信号检测算法（变点检测）────────────────────────────────────

interface SignalPoint {
  date: string;
  factor: string;       // 哪个因子触发的
  value: number;        // 当周值
  baseline: number;     // 基线值（前 N 周均值）
  acceleration: number; // 加速度（倍数）
}

/**
 * 变点检测：检测增长加速度突变
 *
 * 用滑动窗口计算基线，当某周的值相比基线增长超过阈值时标记为信号。
 * 对每个因子独立检测，返回最早的信号点。
 *
 * 关键改进：
 * - 用相对加速度而非绝对阈值，适应不同规模的项目
 * - 多因子交叉验证，至少 2 个因子同期加速才算强信号
 */
function detectSignals(
  history: WeeklyMetrics[],
  windowSize: number = 4,
  accelerationThreshold: number = 2.0,
): SignalPoint[] {
  if (history.length < windowSize + 2) return [];

  const signals: SignalPoint[] = [];
  const factors: { key: keyof WeeklyMetrics; name: string }[] = [
    { key: 'new_stars', name: 'stars' },
    { key: 'new_forks', name: 'forks' },
    { key: 'new_issues', name: 'issues' },
    { key: 'new_prs', name: 'prs' },
    { key: 'unique_pushers', name: 'contributors' },
    { key: 'new_releases', name: 'releases' },
  ];

  for (const { key, name } of factors) {
    for (let i = windowSize; i < history.length; i++) {
      const window = history.slice(i - windowSize, i);
      const baseline = window.reduce((sum, w) => sum + (w[key] as number), 0) / windowSize;
      const current = history[i][key] as number;

      // 基线太低则跳过（避免从 0→1 的误报）
      if (baseline < 3) continue;

      const acceleration = current / baseline;
      if (acceleration >= accelerationThreshold) {
        signals.push({
          date: history[i].week,
          factor: name,
          value: current,
          baseline: Math.round(baseline),
          acceleration: Math.round(acceleration * 10) / 10,
        });
        break; // 每个因子只取首次信号
      }
    }
  }

  return signals.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * 检测首次"强信号"：至少 1 个因子出现加速
 * 返回最早的信号点
 */
function detectFirstSignal(history: WeeklyMetrics[]): SignalPoint | null {
  const signals = detectSignals(history);
  return signals.length > 0 ? signals[0] : null;
}

/**
 * 检测"强信号"：多因子在 4 周内同时加速
 */
function detectStrongSignal(history: WeeklyMetrics[]): { date: string; factors: string[] } | null {
  const signals = detectSignals(history);
  if (signals.length < 2) return null;

  // 检查是否有 2+ 个因子在 4 周内同时触发
  for (let i = 0; i < signals.length; i++) {
    const nearby = signals.filter(s => {
      const diff = Math.abs(new Date(s.date).getTime() - new Date(signals[i].date).getTime());
      return diff <= 28 * 24 * 60 * 60 * 1000; // 4 weeks
    });
    if (nearby.length >= 2) {
      return {
        date: nearby[0].date,
        factors: nearby.map(s => s.factor),
      };
    }
  }
  return null;
}

// ─── 回测目标定义 ───────────────────────────────────────────────

export interface BacktestTarget {
  name: string;
  eruptionDate: string;
  description: string;
  infrastructureRepos: string[];
  toolingRepos: string[];
  applicationRepos: string[];
}

export const BACKTEST_TARGETS: BacktestTarget[] = [
  {
    name: 'Stable Diffusion 爆发',
    eruptionDate: '2022-08-22',
    description: 'Stable Diffusion 开源发布，AI 图像生成浪潮',
    infrastructureRepos: [
      'CompVis/latent-diffusion',      // 潜在扩散模型论文代码
      'openai/CLIP',                   // CLIP 文本-图像对齐
      'huggingface/diffusers',         // 扩散模型工具库
    ],
    toolingRepos: [
      'huggingface/transformers',      // 模型框架（扩散模型依赖）
      'CompVis/stable-diffusion',      // SD 原始实现
      'invoke-ai/InvokeAI',           // SD 包装工具
    ],
    applicationRepos: [
      'AUTOMATIC1111/stable-diffusion-webui', // 最流行的 SD WebUI
      'cmdr2/stable-diffusion-ui',    // 另一个 SD UI
    ],
  },
  {
    name: 'ChatGPT 爆发',
    eruptionDate: '2022-11-30',
    description: 'ChatGPT 发布，Chat AI 浪潮开始',
    infrastructureRepos: [
      'huggingface/transformers',
      'pytorch/pytorch',
      'ggerganov/llama.cpp',
    ],
    toolingRepos: [
      'openai/openai-python',
      'huggingface/huggingface_hub',
      'AUTOMATIC1111/stable-diffusion-webui',
    ],
    applicationRepos: [
      'xtekky/gpt4free',
      'lencx/ChatGPT',
    ],
  },
  {
    name: 'Local LLM 爆发',
    eruptionDate: '2023-03-15',
    description: 'LLaMA 泄露 + llama.cpp，本地大模型浪潮',
    infrastructureRepos: [
      'ggerganov/llama.cpp',           // 本地推理引擎
      'ggerganov/ggml',                // 底层张量库
      'facebookresearch/llama',        // LLaMA 模型
    ],
    toolingRepos: [
      'nomic-ai/gpt4all',             // 一键本地运行
      'lm-sys/FastChat',              // 本地 Chat 框架
      'oobabooga/text-generation-webui', // 文本生成 WebUI
    ],
    applicationRepos: [
      'imartinez/privateGPT',         // 私有文档 GPT
      'mlc-ai/mlc-llm',              // 多平台 LLM 部署
    ],
  },
  {
    name: 'RAG / Vector DB 爆发',
    eruptionDate: '2023-04-01',
    description: 'RAG 范式确立，向量数据库生态爆发',
    infrastructureRepos: [
      'chroma-core/chroma',           // 向量数据库
      'qdrant/qdrant',                // Rust 向量搜索引擎
      'weaviate/weaviate',            // 向量数据库
    ],
    toolingRepos: [
      'jerryjliu/llama_index',        // RAG 框架
      'langchain-ai/langchain',       // LLM 编排（RAG 核心工具）
      'hwchase17/langchain',          // LangChain 早期 repo
    ],
    applicationRepos: [
      'imartinez/privateGPT',         // RAG 应用
      'StanGirard/quivr',            // 第二大脑 RAG 应用
    ],
  },
  {
    name: 'Cursor / AI IDE 爆发',
    eruptionDate: '2023-06-01',
    description: 'Cursor 和 Copilot 推动 AI IDE 浪潮',
    infrastructureRepos: [
      'tree-sitter/tree-sitter',
      'nomic-ai/gpt4all',
      'ggerganov/llama.cpp',
    ],
    toolingRepos: [
      'jerryjliu/llama_index',
      'chroma-core/chroma',
      'AntonOsika/gpt-engineer',
    ],
    applicationRepos: [
      'getcursor/cursor',
      'paul-gauthier/aider',
    ],
  },
  {
    name: 'Manus / 通用 Agent 爆发',
    eruptionDate: '2024-03-01',
    description: '通用 Agent 浪潮，Manus 等产品涌现',
    infrastructureRepos: [
      'microsoft/autogen',
      'openai/openai-python',
      'run-llama/llama_index',
    ],
    toolingRepos: [
      'langchain-ai/langchain',
      'Significant-Gravitas/AutoGPT',
      'joaomdmoura/crewAI',
    ],
    applicationRepos: [
      'geekan/MetaGPT',
      'OpenDevin/OpenDevin',
    ],
  },
];

// ─── 回测分析 ───────────────────────────────────────────────────

export interface RepoSignalResult {
  repo: string;
  layer: 'infrastructure' | 'tooling' | 'application';
  firstSignalDate: string | null;
  firstSignalFactor: string | null;
  strongSignalDate: string | null;
  strongSignalFactors: string[];
  peakDate: string | null;
  peakStars: number;
  avgForks: number;           // 信号期间平均周 fork 数
  avgIssues: number;          // 信号期间平均周 issue 数
  avgPRs: number;             // 信号期间平均周 PR 数
  forkStarRatio: number;      // fork/star 比（衡量实际使用率）
  leadTimeMonths: number | null;
}

export interface BacktestResult {
  target: BacktestTarget;
  repos: RepoSignalResult[];
  infraLeadTimeMedian: number | null;
  toolingLeadTimeMedian: number | null;
  summary: string;
}

function monthsBetween(d1: string, d2: string): number {
  const date1 = new Date(d1);
  const date2 = new Date(d2);
  return (date2.getTime() - date1.getTime()) / (1000 * 60 * 60 * 24 * 30);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function analyzeRepo(
  repo: string,
  layer: 'infrastructure' | 'tooling' | 'application',
  eruptionDate: string,
  lookbackMonths: number = 24,
): Promise<RepoSignalResult> {
  const fromDate = new Date(eruptionDate);
  fromDate.setMonth(fromDate.getMonth() - lookbackMonths);
  const from = fromDate.toISOString().slice(0, 10);

  const empty: RepoSignalResult = {
    repo, layer,
    firstSignalDate: null, firstSignalFactor: null,
    strongSignalDate: null, strongSignalFactors: [],
    peakDate: null, peakStars: 0,
    avgForks: 0, avgIssues: 0, avgPRs: 0, forkStarRatio: 0,
    leadTimeMonths: null,
  };

  try {
    const history = await fetchWeeklyMetrics(repo, from, eruptionDate);
    if (history.length < 6) return empty;

    const firstSignal = detectFirstSignal(history);
    const strongSignal = detectStrongSignal(history);
    const peak = history.reduce((max, h) => h.new_stars > (max?.new_stars ?? 0) ? h : max, history[0]);

    // 计算多因子统计
    const totalStars = history.reduce((s, h) => s + h.new_stars, 0);
    const totalForks = history.reduce((s, h) => s + h.new_forks, 0);

    return {
      repo,
      layer,
      firstSignalDate: firstSignal?.date ?? null,
      firstSignalFactor: firstSignal?.factor ?? null,
      strongSignalDate: strongSignal?.date ?? null,
      strongSignalFactors: strongSignal?.factors ?? [],
      peakDate: peak?.week ?? null,
      peakStars: peak?.new_stars ?? 0,
      avgForks: Math.round(avg(history.map(h => h.new_forks))),
      avgIssues: Math.round(avg(history.map(h => h.new_issues))),
      avgPRs: Math.round(avg(history.map(h => h.new_prs))),
      forkStarRatio: totalStars > 0 ? Math.round(totalForks / totalStars * 100) / 100 : 0,
      leadTimeMonths: firstSignal
        ? Math.round(monthsBetween(firstSignal.date, eruptionDate) * 10) / 10
        : null,
    };
  } catch (err) {
    console.warn(`  Warning: failed to fetch ${repo}: ${(err as Error).message}`);
    return empty;
  }
}

export async function runBacktest(target: BacktestTarget): Promise<BacktestResult> {
  console.log(`\n回测: ${target.name} (爆发日期: ${target.eruptionDate})`);
  console.log('─'.repeat(50));

  const repos: RepoSignalResult[] = [];

  const layers: { repos: string[]; layer: 'infrastructure' | 'tooling' | 'application' }[] = [
    { repos: target.infrastructureRepos, layer: 'infrastructure' },
    { repos: target.toolingRepos, layer: 'tooling' },
    { repos: target.applicationRepos, layer: 'application' },
  ];

  for (const { repos: repoList, layer } of layers) {
    for (const repo of repoList) {
      console.log(`  分析 [${layer}] ${repo}...`);
      repos.push(await analyzeRepo(repo, layer, target.eruptionDate));
    }
  }

  const infraLeads = repos
    .filter(r => r.layer === 'infrastructure' && r.leadTimeMonths !== null)
    .map(r => r.leadTimeMonths!);
  const toolingLeads = repos
    .filter(r => r.layer === 'tooling' && r.leadTimeMonths !== null)
    .map(r => r.leadTimeMonths!);

  const infraMedian = infraLeads.length > 0 ? median(infraLeads) : null;
  const toolingMedian = toolingLeads.length > 0 ? median(toolingLeads) : null;

  const summary = formatBacktestSummary(target, repos, infraMedian, toolingMedian);

  return { target, repos, infraLeadTimeMedian: infraMedian, toolingLeadTimeMedian: toolingMedian, summary };
}

// ─── 报告格式化 ─────────────────────────────────────────────────

function formatBacktestSummary(
  target: BacktestTarget,
  repos: RepoSignalResult[],
  infraMedian: number | null,
  toolingMedian: number | null,
): string {
  const lines: string[] = [];
  lines.push(`### ${target.name}`);
  lines.push(`> ${target.description}`);
  lines.push(`> 爆发日期: ${target.eruptionDate}`);
  lines.push('');

  lines.push('| 层级 | 仓库 | 首次信号 | 触发因子 | 强信号 | 峰值★/周 | Fork/Star比 | 周均Issue | 周均PR | 领先月数 |');
  lines.push('|------|------|---------|---------|--------|---------|------------|---------|-------|---------|');

  for (const r of repos) {
    const layerLabel = { infrastructure: '基础设施', tooling: '工具', application: '应用' }[r.layer];
    const signal = r.firstSignalDate ?? '-';
    const factor = r.firstSignalFactor ?? '-';
    const strong = r.strongSignalDate ? `${r.strongSignalDate} (${r.strongSignalFactors.join('+')})` : '-';
    const peakStars = r.peakStars > 0 ? r.peakStars.toLocaleString() : '-';
    const fsr = r.forkStarRatio > 0 ? r.forkStarRatio.toFixed(2) : '-';
    const issues = r.avgIssues > 0 ? String(r.avgIssues) : '-';
    const prs = r.avgPRs > 0 ? String(r.avgPRs) : '-';
    const lead = r.leadTimeMonths !== null ? `${r.leadTimeMonths.toFixed(1)}` : '-';
    lines.push(`| ${layerLabel} | ${r.repo} | ${signal} | ${factor} | ${strong} | ${peakStars} | ${fsr} | ${issues} | ${prs} | ${lead} |`);
  }

  lines.push('');
  if (infraMedian !== null) {
    lines.push(`**基础设施层领先时间中位数**: ${infraMedian.toFixed(1)} 个月`);
  }
  if (toolingMedian !== null) {
    lines.push(`**工具层领先时间中位数**: ${toolingMedian.toFixed(1)} 个月`);
  }

  return lines.join('\n');
}

export function formatFullBacktestReport(results: BacktestResult[]): string {
  const lines: string[] = [];
  lines.push('# Augur 历史回测报告');
  lines.push('');
  lines.push(`> 生成日期: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`> 信号检测方法: 滑动窗口变点检测（4 周基线，加速度 ≥2x）`);
  lines.push(`> 多因子: stars, forks, issues, PRs`);
  lines.push('');
  lines.push('验证核心假设：基础设施层信号领先于商业爆发 6~12 个月。');
  lines.push('');

  for (const result of results) {
    lines.push(result.summary);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  // Overall summary
  const allInfra = results.flatMap(r => r.repos)
    .filter(r => r.layer === 'infrastructure' && r.leadTimeMonths !== null)
    .map(r => r.leadTimeMonths!);
  const allTooling = results.flatMap(r => r.repos)
    .filter(r => r.layer === 'tooling' && r.leadTimeMonths !== null)
    .map(r => r.leadTimeMonths!);
  const allApp = results.flatMap(r => r.repos)
    .filter(r => r.layer === 'application' && r.leadTimeMonths !== null)
    .map(r => r.leadTimeMonths!);

  lines.push('## 总结');
  lines.push('');
  if (allInfra.length > 0) {
    lines.push(`- 基础设施层领先时间中位数: **${median(allInfra).toFixed(1)} 个月** (样本: ${allInfra.map(v => v.toFixed(1)).join(', ')})`);
  }
  if (allTooling.length > 0) {
    lines.push(`- 工具层领先时间中位数: **${median(allTooling).toFixed(1)} 个月** (样本: ${allTooling.map(v => v.toFixed(1)).join(', ')})`);
  }
  if (allApp.length > 0) {
    lines.push(`- 应用层领先时间中位数: **${median(allApp).toFixed(1)} 个月** (样本: ${allApp.map(v => v.toFixed(1)).join(', ')})`);
  }

  // Fork/Star ratio analysis
  const highFSR = results.flatMap(r => r.repos)
    .filter(r => r.forkStarRatio >= 0.2)
    .sort((a, b) => b.forkStarRatio - a.forkStarRatio);
  if (highFSR.length > 0) {
    lines.push('');
    lines.push('### 高 Fork/Star 比项目（实际使用率高）');
    for (const r of highFSR.slice(0, 5)) {
      lines.push(`- ${r.repo}: ${r.forkStarRatio.toFixed(2)} (${r.layer})`);
    }
  }

  lines.push('');
  lines.push('### 方法论说明');
  lines.push('- **首次信号**: 某因子周值首次达到前4周基线的 2 倍');
  lines.push('- **强信号**: 2+ 个因子在 4 周内同时出现加速');
  lines.push('- **Fork/Star 比**: 高比值（>0.2）表示项目被实际使用而非仅被收藏');

  return lines.join('\n');
}
