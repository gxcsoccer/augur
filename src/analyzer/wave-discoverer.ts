/**
 * 浪潮候选发现
 *
 * 从已采集的数据（trending、HN、共现关键词）中自动发现新的技术浪潮候选。
 * 不依赖人工定义，让系统自主发现新机会。
 *
 * 流程：
 * 1. 从 DB 聚合当前项目的域 + 关键词 + 层级
 * 2. LLM 聚类：识别正在形成的新浪潮
 * 3. 为每个浪潮分配 infra/tooling/app 仓库
 * 4. 输出 BacktestTarget[] 格式
 */

import type Database from 'better-sqlite3';
import { getLlm, LLM_MODEL, LLM_THINKING_ON } from '../llm/client.js';
import type { BacktestTarget } from '../predictor/backtest.js';

interface ProjectSignal {
  id: string;
  description: string | null;
  language: string | null;
  layer: string;
  domains: string[];
  stars: number;
  keywords: string[];
}

function buildDiscoveryPrompt(today: string) {
  return `你是一个技术趋势分析师。当前日期是 ${today}。基于以下 GitHub 项目列表和 HackerNews 热帖，识别正在形成的新技术浪潮。

## 任务

1. 将这些项目聚类为 3-8 个"候选浪潮"（技术趋势方向）
2. 每个浪潮需要：
   - name: 简短中文名称
   - description: 一句话描述
   - 按层级分类项目：infrastructure（基础设施）、tooling（工具）、application（应用）

## 规则

- 每个浪潮至少需要 2 个项目
- 不要创建过于宽泛的浪潮（如"AI"、"开源"）
- 聚焦于**新兴**趋势，不是已经成熟的领域
- 一个项目只能属于一个浪潮
- 如果某些项目不属于任何新兴浪潮，可以忽略

## 输出格式

返回 JSON 数组：
[
  {
    "name": "Voice AI Agent",
    "description": "语音驱动的 AI Agent 和实时对话系统",
    "infrastructure": ["owner/repo1", "owner/repo2"],
    "tooling": ["owner/repo3"],
    "application": ["owner/repo4"]
  }
]

只返回 JSON，不要其他内容。`;
}

/**
 * 从数据库收集当前项目信号
 */
function collectProjectSignals(db: Database.Database): ProjectSignal[] {
  const projects = db.prepare(`
    SELECT p.id, p.description, p.language,
           s.layer, s.domains, s.opportunity_score,
           snap.stars
    FROM projects p
    LEFT JOIN signals s ON p.id = s.project_id
    LEFT JOIN (
      SELECT project_id, MAX(stars) as stars
      FROM snapshots GROUP BY project_id
    ) snap ON p.id = snap.project_id
    WHERE snap.stars > 0
    ORDER BY s.opportunity_score DESC, snap.stars DESC
    LIMIT 100
  `).all() as any[];

  const result: ProjectSignal[] = [];
  for (const p of projects) {
    const keywords: string[] = [];
    const readme = db.prepare('SELECT keywords FROM readmes WHERE project_id = ?').get(p.id) as any;
    if (readme?.keywords) {
      try { keywords.push(...JSON.parse(readme.keywords)); } catch {}
    }

    result.push({
      id: p.id,
      description: p.description,
      language: p.language,
      layer: p.layer ?? 'unknown',
      domains: p.domains ? JSON.parse(p.domains) : [],
      stars: p.stars ?? 0,
      keywords,
    });
  }
  return result;
}

/**
 * 收集 HN 热帖标题
 */
function collectHNTitles(db: Database.Database, limit: number = 30): string[] {
  const posts = db.prepare(`
    SELECT title, points FROM hn_posts
    ORDER BY points DESC LIMIT ?
  `).all(limit) as { title: string; points: number }[];

  return posts.map(p => `${p.title} (${p.points}pts)`);
}

/**
 * 收集共现关键词热点
 */
function collectHotKeywords(db: Database.Database): string[] {
  const pairs = db.prepare(`
    SELECT keyword1, keyword2, count FROM cooccurrences
    ORDER BY count DESC LIMIT 20
  `).all() as { keyword1: string; keyword2: string; count: number }[];

  const keywords = new Set<string>();
  for (const p of pairs) {
    keywords.add(p.keyword1);
    keywords.add(p.keyword2);
  }
  return [...keywords];
}

/**
 * LLM 驱动的浪潮发现
 */
export async function discoverWaves(db: Database.Database, today?: string): Promise<BacktestTarget[]> {
  const currentDate = today ?? new Date().toISOString().slice(0, 10);
  const projects = collectProjectSignals(db);
  const hnTitles = collectHNTitles(db);
  const hotKeywords = collectHotKeywords(db);

  if (projects.length === 0) {
    console.log('[Discover] 无项目数据，请先运行 augur collect + augur analyze');
    return [];
  }

  console.log(`[Discover] 输入: ${projects.length} 个项目, ${hnTitles.length} 条 HN, ${hotKeywords.length} 个热词`);

  // Build LLM input
  const projectList = projects.slice(0, 60).map(p => {
    const domains = p.domains.length > 0 ? ` [${p.domains.join(',')}]` : '';
    const kw = p.keywords.length > 0 ? ` | 关键词: ${p.keywords.slice(0, 5).join(',')}` : '';
    return `- ${p.id} (${p.language ?? '?'}, ★${p.stars}, ${p.layer})${domains}${kw}\n  ${p.description ?? ''}`;
  }).join('\n');

  const hnSection = hnTitles.length > 0
    ? `\n## HackerNews 热帖\n${hnTitles.map(t => `- ${t}`).join('\n')}`
    : '';

  const keywordSection = hotKeywords.length > 0
    ? `\n## 共现热词\n${hotKeywords.join(', ')}`
    : '';

  const userContent = `## GitHub 项目（按信号强度排序）\n${projectList}${hnSection}${keywordSection}`;

  const llm = getLlm();

  try {
    const response = await llm.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.3,
      max_tokens: 4096,
      messages: [
        { role: 'system', content: buildDiscoveryPrompt(currentDate) },
        { role: 'user', content: userContent },
      ],
      // @ts-expect-error GLM 5.1 ultrathink extension
      thinking: LLM_THINKING_ON,
    });

    const content = response.choices[0]?.message?.content?.trim();
    if (!content) return [];

    const jsonStr = content.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    const waves = JSON.parse(jsonStr) as Array<{
      name: string;
      description: string;
      infrastructure: string[];
      tooling: string[];
      application: string[];
    }>;

    console.log(`[Discover] LLM 发现 ${waves.length} 个候选浪潮`);

    return waves.map(w => ({
      name: w.name,
      eruptionDate: '2027-01-01', // placeholder for future prediction
      description: w.description,
      infrastructureRepos: w.infrastructure ?? [],
      toolingRepos: w.tooling ?? [],
      applicationRepos: w.application ?? [],
    }));
  } catch (err) {
    console.error(`[Discover] LLM 调用失败: ${(err as Error).message}`);
    return [];
  }
}

/**
 * 合并已知浪潮和新发现的浪潮（去重）
 */
export function mergeWaves(
  existing: BacktestTarget[],
  discovered: BacktestTarget[],
): BacktestTarget[] {
  const existingNames = new Set(existing.map(w => w.name));
  const merged = [...existing];

  for (const wave of discovered) {
    // Check if similar wave already exists (by name overlap or repo overlap)
    const existingRepos = new Set(existing.flatMap(w => [...w.infrastructureRepos, ...w.toolingRepos, ...w.applicationRepos]));
    const newRepos = [...wave.infrastructureRepos, ...wave.toolingRepos, ...wave.applicationRepos];
    const overlapCount = newRepos.filter(r => existingRepos.has(r)).length;
    const overlapRatio = newRepos.length > 0 ? overlapCount / newRepos.length : 0;

    if (overlapRatio > 0.5) {
      console.log(`  [Merge] 跳过 "${wave.name}" (与已有浪潮重叠 ${Math.round(overlapRatio * 100)}%)`);
      continue;
    }

    if (existingNames.has(wave.name)) {
      console.log(`  [Merge] 跳过 "${wave.name}" (名称已存在)`);
      continue;
    }

    console.log(`  [Merge] 新增 "${wave.name}" (${newRepos.length} repos)`);
    merged.push(wave);
  }

  return merged;
}
