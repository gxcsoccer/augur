/**
 * Auto Research — 自动深度调研
 *
 * 路径 A：LLM + 已采集数据
 * 对 Top N 高置信信号，基于项目的 README、Issues、同域关联项目、共现关键词，
 * 自动生成结构化深度调研报告。
 */

import { getLlm, LLM_MODEL, LLM_THINKING_ON } from '../llm/client.js';
import type Database from 'better-sqlite3';

export interface ResearchInput {
  projectId: string;
  description: string | null;
  language: string | null;
  layer: string;
  domains: string[];
  stars: number;
  forks: number;
  readme: string | null;
  recentIssues: string[];         // Issue 标题列表
  relatedProjects: string[];      // 同域项目 ID 列表
  cooccurrenceKeywords: string[]; // 共现关键词
  opportunityScore: number;
}

export interface ResearchReport {
  projectId: string;
  positioning: string;      // 项目定位分析
  ecosystem: string;        // 生态关联分析
  issueHotspots: string;    // Issue 热点
  gaps: string;             // 机会缺口
  prediction: string;       // 趋势预测
  fullReport: string;       // 完整 Markdown 报告
}

const RESEARCH_PROMPT = `你是一个技术趋势研究分析师。基于提供的开源项目信息，生成一份简洁的深度调研报告。

## 输出结构（Markdown）

### 项目定位
一段话：这个项目在做什么，解决什么问题，处于技术栈的哪个层级。

### 生态分析
- 列出 2-3 个直接竞品或互补项目
- 分析该项目在生态中的位置（是龙头、挑战者还是跟随者？）
- 判断该技术生态的成熟度（萌芽、成长、成熟、衰退）

### Issue 热点
基于 Issue 标题，总结社区最关心的 3 个方向

### 机会缺口
基于以上分析，指出 1-2 个未被满足的需求，即"工具层机会"

### 趋势预测
一段话：未来 3-6 个月可能的发展方向

请直接输出 Markdown，不要包裹在代码块中。`;

export async function generateResearch(input: ResearchInput): Promise<ResearchReport> {
  const llm = getLlm();

  const forkStarRatio = input.stars > 0 ? (input.forks / input.stars).toFixed(2) : '0';
  const readmeSnippet = input.readme?.slice(0, 1500) ?? '无';
  const issueList = input.recentIssues.length > 0
    ? input.recentIssues.slice(0, 20).map(t => `- ${t}`).join('\n')
    : '无';
  const related = input.relatedProjects.length > 0
    ? input.relatedProjects.join(', ')
    : '无';
  const keywords = input.cooccurrenceKeywords.length > 0
    ? input.cooccurrenceKeywords.join(', ')
    : '无';

  const userContent = `## 项目信息

- **ID**: ${input.projectId}
- **描述**: ${input.description ?? '无'}
- **语言**: ${input.language ?? '未知'}
- **信号层级**: ${input.layer}
- **技术域**: ${input.domains.join(', ')}
- **Stars**: ${input.stars.toLocaleString()} | **Forks**: ${input.forks.toLocaleString()} | **Fork/Star**: ${forkStarRatio}
- **机会评分**: ${input.opportunityScore}

## README 摘要
${readmeSnippet}

## 近期 Issue 标题
${issueList}

## 同域关联项目
${related}

## 共现关键词
${keywords}`;

  try {
    const response = await llm.chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.3,  // slightly creative for research
      max_tokens: 4096,
      messages: [
        { role: 'system', content: RESEARCH_PROMPT },
        { role: 'user', content: userContent },
      ],
      // @ts-expect-error GLM 5.1 ultrathink extension
      thinking: LLM_THINKING_ON,
    });

    const fullReport = response.choices[0]?.message?.content?.trim() ?? '';

    // Parse sections from the report
    const sections = parseSections(fullReport);

    return {
      projectId: input.projectId,
      positioning: sections['项目定位'] ?? '',
      ecosystem: sections['生态分析'] ?? '',
      issueHotspots: sections['issue 热点'] ?? sections['Issue 热点'] ?? '',
      gaps: sections['机会缺口'] ?? '',
      prediction: sections['趋势预测'] ?? '',
      fullReport,
    };
  } catch (err) {
    return {
      projectId: input.projectId,
      positioning: `分析失败: ${(err as Error).message}`,
      ecosystem: '',
      issueHotspots: '',
      gaps: '',
      prediction: '',
      fullReport: `# ${input.projectId}\n\n分析失败: ${(err as Error).message}`,
    };
  }
}

function parseSections(markdown: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const lines = markdown.split('\n');
  let currentSection = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^###\s+(.+)/);
    if (headingMatch) {
      if (currentSection) {
        sections[currentSection] = currentContent.join('\n').trim();
      }
      currentSection = headingMatch[1].trim();
      currentContent = [];
    } else {
      currentContent.push(line);
    }
  }
  if (currentSection) {
    sections[currentSection] = currentContent.join('\n').trim();
  }

  return sections;
}

/**
 * 从数据库中收集 Auto Research 所需的输入数据
 */
export function collectResearchInput(
  db: Database.Database,
  projectId: string,
  signal: { layer: string; domains: string[]; opportunityScore: number },
): ResearchInput {
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId) as any;
  const readme = db.prepare('SELECT content FROM readmes WHERE project_id = ?').get(projectId) as any;
  const latestSnapshot = db.prepare(
    'SELECT * FROM snapshots WHERE project_id = ? ORDER BY captured_at DESC LIMIT 1'
  ).get(projectId) as any;

  // Get issues if available
  const issues = db.prepare(
    'SELECT title FROM issues WHERE project_id = ? ORDER BY captured_at DESC LIMIT 20'
  ).all(projectId) as { title: string }[];

  // Get related projects in same domains
  const domains = signal.domains;
  let relatedProjects: string[] = [];
  if (domains.length > 0) {
    const allSignals = db.prepare('SELECT DISTINCT project_id, domains FROM signals').all() as any[];
    relatedProjects = allSignals
      .filter(s => {
        if (s.project_id === projectId) return false;
        const sDomains: string[] = JSON.parse(s.domains || '[]');
        return sDomains.some(d => domains.includes(d));
      })
      .map(s => s.project_id);
  }

  // Get co-occurrence keywords
  const coKeywords = db.prepare(`
    SELECT keyword1, keyword2 FROM cooccurrences
    WHERE keyword1 IN (SELECT value FROM json_each((SELECT keywords FROM readmes WHERE project_id = ?)))
       OR keyword2 IN (SELECT value FROM json_each((SELECT keywords FROM readmes WHERE project_id = ?)))
    ORDER BY count DESC LIMIT 10
  `).all(projectId, projectId) as { keyword1: string; keyword2: string }[];

  const keywordSet = new Set<string>();
  for (const { keyword1, keyword2 } of coKeywords) {
    keywordSet.add(keyword1);
    keywordSet.add(keyword2);
  }

  return {
    projectId,
    description: project?.description ?? null,
    language: project?.language ?? null,
    layer: signal.layer,
    domains: signal.domains,
    stars: latestSnapshot?.stars ?? 0,
    forks: latestSnapshot?.forks ?? 0,
    readme: readme?.content ?? null,
    recentIssues: issues.map(i => i.title),
    relatedProjects,
    cooccurrenceKeywords: [...keywordSet],
    opportunityScore: signal.opportunityScore,
  };
}
