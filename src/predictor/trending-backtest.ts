/**
 * 趋势项目预测回测
 *
 * 用历史数据验证"项目即将火爆"预测的准确性。
 *
 * 方法：
 * 1. 选取已知的"从默默无闻到爆火"的案例
 * 2. 回到爆发前 N 周，用当时的数据运行预测模型
 * 3. 检查模型是否能提前发现这些项目
 * 4. 计算命中率、提前时间、假阳性率
 *
 * 回测目标选取标准：
 * - 项目在爆发前 star < 2000（非大厂、非已知项目）
 * - 项目在 2-4 周内 star 从 <2000 涨到 >10000（爆发式增长）
 * - 有 ClickHouse GH Archive 历史数据可查
 */

import { fetchWeeklyMetrics as fetchMetricsFromCH, type WeeklyMetrics } from '../util/clickhouse.js';
import { computeAcceleration } from '../util/math.js';
import { computeFactors, scoreTrendingCandidate } from './trending-predictor.js';

// ─── 回测目标 ──────────────────────────────────────────────────

export interface TrendingBacktestCase {
  repo: string;
  description: string;
  eruptionDate: string;        // 项目登上 trending 的日期
  preEruptionStars: number;    // 爆发前的 star 数（大约）
  postEruptionStars: number;   // 爆发后的 star 数（大约）
  category: string;
}

/**
 * 历史案例：从默默无闻到爆火的项目
 *
 * 这些都是在爆发前 star 较少、但突然走红的项目。
 * 涵盖不同领域和时间段，用于全面验证模型。
 */
export const TRENDING_BACKTEST_CASES: TrendingBacktestCase[] = [
  {
    repo: 'AUTOMATIC1111/stable-diffusion-webui',
    description: 'SD WebUI — 从零到全球最火 AI 图像工具',
    eruptionDate: '2022-09-15',
    preEruptionStars: 500,
    postEruptionStars: 30000,
    category: 'AI-Image',
  },
  {
    repo: 'Significant-Gravitas/Auto-GPT',
    description: 'AutoGPT — 首个自主 AI Agent，引爆 Agent 热潮',
    eruptionDate: '2023-05-01',
    preEruptionStars: 100,
    postEruptionStars: 100000,
    category: 'AI-Agent',
  },
  {
    repo: 'AntonOsika/gpt-engineer',
    description: 'GPT Engineer — AI 自动生成代码',
    eruptionDate: '2023-06-20',
    preEruptionStars: 100,
    postEruptionStars: 40000,
    category: 'AI-Coding',
  },
  {
    repo: 'paul-gauthier/aider',
    description: 'AI 结对编程 — AI Coding 浪潮',
    eruptionDate: '2023-07-01',
    preEruptionStars: 500,
    postEruptionStars: 15000,
    category: 'AI-Coding',
  },
  {
    repo: 'jmorganca/ollama',
    description: 'Ollama — 本地 LLM 一键运行（早期名称）',
    eruptionDate: '2023-09-01',
    preEruptionStars: 200,
    postEruptionStars: 30000,
    category: 'Local-AI',
  },
  {
    repo: 'KillianLucas/open-interpreter',
    description: 'Open Interpreter — 自然语言操控电脑',
    eruptionDate: '2023-09-15',
    preEruptionStars: 100,
    postEruptionStars: 40000,
    category: 'AI-Agent',
  },
  {
    repo: 'smol-ai/developer',
    description: 'Smol Developer — 最简 AI 开发者 Agent',
    eruptionDate: '2023-06-01',
    preEruptionStars: 100,
    postEruptionStars: 10000,
    category: 'AI-Coding',
  },
  {
    repo: 'ollama-webui/ollama-webui',
    description: 'Ollama WebUI（后更名 open-webui）— 自托管 AI 界面',
    eruptionDate: '2024-01-15',
    preEruptionStars: 200,
    postEruptionStars: 5000,
    category: 'AI-UI',
  },
  {
    repo: 'abi/screenshot-to-code',
    description: '截图转代码 — AI 前端自动化（2023-11-14 创建，一夜爆火）',
    eruptionDate: '2023-11-20',
    preEruptionStars: 0,
    postEruptionStars: 40000,
    category: 'AI-Coding',
  },
  {
    repo: 'ggerganov/llama.cpp',
    description: '本地 LLM 推理引擎 — 2023-03-10 创建，10 天内爆火',
    eruptionDate: '2023-03-25',
    preEruptionStars: 0,
    postEruptionStars: 40000,
    category: 'Local-AI',
  },
];

// ─── 回测逻辑 ──────────────────────────────────────────────────

/**
 * 计算"突然涌现"信号 — 适用于从零开始的新项目
 * 基于绝对活跃度而非加速度
 */
function computeEmergenceScore(history: WeeklyMetrics[]): number {
  if (history.length === 0) return 0;

  const lastWeek = history[history.length - 1];
  const totalStars = history.reduce((s, w) => s + w.new_stars, 0);
  const totalForks = history.reduce((s, w) => s + w.new_forks, 0);

  let score = 0;
  // Absolute star activity: 50+ stars/week for a small project is very significant
  if (lastWeek.new_stars >= 100) score += 0.3;
  else if (lastWeek.new_stars >= 50) score += 0.2;
  else if (lastWeek.new_stars >= 20) score += 0.1;

  // Growing week over week
  if (history.length >= 2) {
    const prev = history[history.length - 2];
    if (lastWeek.new_stars > prev.new_stars * 1.5 && lastWeek.new_stars >= 20) {
      score += 0.2;
    }
  }

  // Multi-signal: stars + forks + issues
  if (lastWeek.new_forks >= 5 && lastWeek.new_issues >= 3) score += 0.15;

  // Short history but high activity = new project gaining traction
  if (history.length <= 4 && totalStars >= 100) score += 0.15;

  // Forks indicate real usage
  if (totalForks >= 20) score += 0.1;

  return Math.min(score, 1);
}

export interface BacktestCaseResult {
  repo: string;
  description: string;
  eruptionDate: string;
  category: string;
  // Signal detection at different lookback points
  signalAtWeeks: {
    weeksBeforeEruption: number;
    starVelocity: number;
    forkAcceleration: number;
    issueAcceleration: number;
    contributorGrowth: number;
    crossFactorCount: number;
    predictionScore: number;
    wouldHaveDetected: boolean;   // 得分 > 阈值
  }[];
  // Summary
  earliestDetection: number | null;  // 最早能检测到的周数
  peakScore: number;
  detected: boolean;
}

/**
 * 对单个案例进行回测
 *
 * 在爆发前 2/4/6/8 周的时间点分别运行模型，
 * 检查是否能提前发现"即将爆火"的信号。
 */
async function backtestCase(testCase: TrendingBacktestCase): Promise<BacktestCaseResult> {
  const checkpoints = [2, 4, 6, 8]; // 在爆发前 N 周检查
  const signalAtWeeks: BacktestCaseResult['signalAtWeeks'] = [];

  const eruptionTime = new Date(testCase.eruptionDate).getTime();

  for (const weeksBefore of checkpoints) {
    // 假设我们在爆发前 N 周运行模型
    const checkDate = new Date(eruptionTime - weeksBefore * 7 * 86400000);
    const checkDateStr = checkDate.toISOString().slice(0, 10);
    const lookbackDate = new Date(checkDate.getTime() - 8 * 7 * 86400000);
    const lookbackStr = lookbackDate.toISOString().slice(0, 10);

    try {
      const history = await fetchMetricsFromCH(testCase.repo, lookbackStr, checkDateStr);

      if (history.length < 1) {
        signalAtWeeks.push({
          weeksBeforeEruption: weeksBefore,
          starVelocity: 0, forkAcceleration: 0,
          issueAcceleration: 0, contributorGrowth: 0,
          crossFactorCount: 0, predictionScore: 0,
          wouldHaveDetected: false,
        });
        continue;
      }

      // Use production scoring model (same weights as predict --trending)
      const factors = computeFactors(history, 0); // 0 for social score (unavailable in backtest)
      const accelerationScore = scoreTrendingCandidate(factors);

      // Emergence score — handles cold-start projects with no baseline
      const emergenceScore = computeEmergenceScore(history);

      // Take the best of acceleration or emergence signal
      const predictionScore = Math.max(accelerationScore, emergenceScore);

      const { starVelocity, forkAcceleration, issueAcceleration, contributorGrowth, crossFactorCount } = factors;

      const DETECTION_THRESHOLD = 0.15;

      signalAtWeeks.push({
        weeksBeforeEruption: weeksBefore,
        starVelocity: round2(starVelocity),
        forkAcceleration: round2(forkAcceleration),
        issueAcceleration: round2(issueAcceleration),
        contributorGrowth: round2(contributorGrowth),
        crossFactorCount,
        predictionScore: round2(predictionScore),
        wouldHaveDetected: predictionScore >= DETECTION_THRESHOLD,
      });
    } catch (err) {
      console.warn(`    Warning: ${testCase.repo} @-${weeksBefore}w: ${(err as Error).message}`);
      signalAtWeeks.push({
        weeksBeforeEruption: weeksBefore,
        starVelocity: 0, forkAcceleration: 0,
        issueAcceleration: 0, contributorGrowth: 0,
        crossFactorCount: 0, predictionScore: 0,
        wouldHaveDetected: false,
      });
    }
  }

  const detectedPoints = signalAtWeeks.filter((s) => s.wouldHaveDetected);
  const peakScore = Math.max(...signalAtWeeks.map((s) => s.predictionScore), 0);
  const earliestDetection = detectedPoints.length > 0
    ? Math.max(...detectedPoints.map((s) => s.weeksBeforeEruption))
    : null;

  return {
    repo: testCase.repo,
    description: testCase.description,
    eruptionDate: testCase.eruptionDate,
    category: testCase.category,
    signalAtWeeks,
    earliestDetection,
    peakScore,
    detected: detectedPoints.length > 0,
  };
}

// ─── 完整回测 ──────────────────────────────────────────────────

export interface TrendingBacktestSummary {
  totalCases: number;
  detectedCases: number;
  hitRate: number;
  avgEarliestDetection: number;
  avgPeakScore: number;
  results: BacktestCaseResult[];
}

export async function runTrendingBacktest(
  cases?: TrendingBacktestCase[],
): Promise<TrendingBacktestSummary> {
  const testCases = cases ?? TRENDING_BACKTEST_CASES;
  const results: BacktestCaseResult[] = [];

  for (const tc of testCases) {
    console.log(`  回测 ${tc.repo} (爆发: ${tc.eruptionDate})...`);
    const result = await backtestCase(tc);
    results.push(result);
    console.log(
      `    ${result.detected ? '✓ 检测到' : '✗ 未检测到'} | ` +
      `最早提前 ${result.earliestDetection ?? '-'} 周 | ` +
      `峰值得分 ${result.peakScore.toFixed(2)}`
    );
  }

  const detected = results.filter((r) => r.detected);
  const earliestDetections = detected.map((r) => r.earliestDetection!);

  return {
    totalCases: results.length,
    detectedCases: detected.length,
    hitRate: round2(detected.length / results.length),
    avgEarliestDetection: earliestDetections.length > 0
      ? round2(earliestDetections.reduce((a, b) => a + b, 0) / earliestDetections.length)
      : 0,
    avgPeakScore: round2(results.reduce((s, r) => s + r.peakScore, 0) / results.length),
    results,
  };
}

// ─── 报告格式化 ─────────────────────────────────────────────────

export function formatTrendingBacktestReport(summary: TrendingBacktestSummary): string {
  const lines: string[] = [];

  lines.push('# Augur 趋势项目预测 — 历史回测报告');
  lines.push('');
  lines.push(`> 生成日期: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`> 回测案例: ${summary.totalCases} 个（已知的"从默默无闻到爆火"的项目）`);
  lines.push(`> 方法: 在爆发前 2/4/6/8 周分别运行预测模型，检查是否能提前发现`);
  lines.push('');

  // Summary stats
  lines.push('## 总结');
  lines.push('');
  lines.push(`| 指标 | 值 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 命中率 | **${(summary.hitRate * 100).toFixed(0)}%** (${summary.detectedCases}/${summary.totalCases}) |`);
  lines.push(`| 平均最早检测 | 提前 **${summary.avgEarliestDetection.toFixed(1)}** 周 |`);
  lines.push(`| 平均峰值得分 | ${summary.avgPeakScore.toFixed(2)} |`);
  lines.push('');

  // Detailed results table
  lines.push('## 详细结果');
  lines.push('');
  lines.push('| 项目 | 类别 | 爆发日期 | 检测? | 最早提前 | 峰值得分 |');
  lines.push('|------|------|---------|-------|---------|---------|');

  for (const r of summary.results) {
    lines.push(
      `| ${r.repo} | ${r.category} | ${r.eruptionDate} | ` +
      `${r.detected ? '✅' : '❌'} | ${r.earliestDetection ? r.earliestDetection + '周' : '-'} | ${r.peakScore.toFixed(2)} |`
    );
  }

  // Per-case detailed signal analysis
  lines.push('');
  lines.push('## 各案例信号详情');
  lines.push('');

  for (const r of summary.results) {
    lines.push(`### ${r.repo}`);
    lines.push(`> ${r.description} | 爆发: ${r.eruptionDate}`);
    lines.push('');
    lines.push('| 检查点 | Star加速 | Fork加速 | Issue加速 | 贡献者增长 | 多因子 | 得分 | 检测? |');
    lines.push('|--------|---------|---------|---------|-----------|--------|------|-------|');

    for (const s of r.signalAtWeeks) {
      lines.push(
        `| 爆发前${s.weeksBeforeEruption}周 | ${s.starVelocity}x | ${s.forkAcceleration}x | ` +
        `${s.issueAcceleration}x | ${s.contributorGrowth}x | ${s.crossFactorCount} | ` +
        `${s.predictionScore.toFixed(2)} | ${s.wouldHaveDetected ? '✅' : '-'} |`
      );
    }
    lines.push('');
  }

  // Method note
  lines.push('---');
  lines.push('');
  lines.push('### 方法论');
  lines.push('- **数据源**: ClickHouse GH Archive（公开 GitHub 事件数据）');
  lines.push('- **检测阈值**: 预测得分 ≥ 0.15（多因子加权）');
  lines.push('- **因子**: Star 加速度、Fork 加速度、Issue 活跃度、贡献者增长、多因子共振');
  lines.push('- **基线**: 回测时间点前 4-8 周的平均活跃度');
  lines.push('');
  lines.push('### 局限性说明');
  lines.push('- **Emergence Score**: 部分案例（如 SD WebUI、llama.cpp）在 ClickHouse 中首次出现时已有大量活跃度，');
  lines.push('  模型通过"绝对活跃度"（emergence score）而非"加速度"检测到。这更接近"确认已开始起飞"，');
  lines.push('  而非"在起飞前预测"。加速度因子全为 0x 但仍标记"检测到"的案例属于此类。');
  lines.push('- **幸存者偏差**: 回测只选取了最终成功爆火的项目，未评估假阳性率（模型同期预测了多少未爆火的项目）。');
  lines.push('- **社交媒体信号无法回测**: HN/Reddit/DEV.to 的历史数据不可用，实际系统的信号更丰富。');
  lines.push('- **ClickHouse 数据不完整**: GH Archive 的 WatchEvent 计数显著低于 GitHub API 实际 star 数。');

  return lines.join('\n');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
