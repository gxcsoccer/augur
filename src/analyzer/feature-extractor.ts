/**
 * Feature Request 挖掘
 *
 * 对基础设施层/工具层热门项目的 Issues 进行分类，
 * 聚合 feature request，输出"需求-频次"排序表。
 *
 * 两阶段策略：
 * 1. 规则过滤：标题/label 关键词快速分类
 * 2. LLM 精分：对模糊项调用 LLM 判断
 */

import { getLlm, LLM_MODEL } from '../llm/client.js';

export interface GitHubIssue {
  id: number;
  title: string;
  body: string;
  labels: string[];
}

export interface ClassifiedIssue {
  id: number;
  title: string;
  category: 'feature_request' | 'bug' | 'question' | 'other';
  summary?: string;  // LLM 生成的一句话摘要
}

// ─── 规则过滤 ────────────────────────────────────────────────

const FR_LABELS = new Set([
  'enhancement', 'feature', 'feature-request', 'feature request',
  'proposal', 'suggestion', 'idea', 'rfc',
]);

const BUG_LABELS = new Set([
  'bug', 'defect', 'error', 'crash', 'regression',
]);

const QUESTION_LABELS = new Set([
  'question', 'help wanted', 'support', 'discussion',
]);

const FR_TITLE_PATTERNS = [
  /\bfeature\s*request\b/i,
  /\[feature\]/i,
  /\[enhancement\]/i,
  /\[proposal\]/i,
  /\[rfc\]/i,
  /^add\s+/i,
  /^support\s+/i,
  /^implement\s+/i,
  /^allow\s+/i,
  /^enable\s+/i,
  /\bwould be (nice|great|useful)\b/i,
  /\bshould support\b/i,
  /\bplease add\b/i,
];

const BUG_TITLE_PATTERNS = [
  /\bbug\b/i,
  /\[bug\]/i,
  /\berror\b/i,
  /\bcrash/i,
  /\bbroken\b/i,
  /\bnot working\b/i,
  /\bfails?\b/i,
  /\bregression\b/i,
];

function classifyByRules(issue: GitHubIssue): 'feature_request' | 'bug' | 'question' | null {
  // Label-based classification (highest confidence)
  for (const label of issue.labels) {
    const lower = label.toLowerCase();
    if (FR_LABELS.has(lower)) return 'feature_request';
    if (BUG_LABELS.has(lower)) return 'bug';
    if (QUESTION_LABELS.has(lower)) return 'question';
  }

  // Title pattern matching
  for (const pattern of FR_TITLE_PATTERNS) {
    if (pattern.test(issue.title)) return 'feature_request';
  }
  for (const pattern of BUG_TITLE_PATTERNS) {
    if (pattern.test(issue.title)) return 'bug';
  }

  if (issue.title.endsWith('?')) return 'question';

  return null; // ambiguous, needs LLM
}

// ─── LLM 分类 ───────────────────────────────────────────────

const ISSUE_CLASSIFY_PROMPT = `你是一个开源项目 Issue 分析专家。对每个 Issue 进行分类并提取需求摘要。

分类：
- feature_request: 用户希望添加新功能或改进
- bug: 报告问题或错误
- question: 提问或寻求帮助
- other: 其他

对 feature_request 类型，额外提供一句话摘要：用户想要什么。

输出 JSON 数组：
[{"id": 123, "category": "feature_request", "summary": "支持多语言输入"}]

只返回 JSON。`;

async function classifyByLLM(issues: GitHubIssue[]): Promise<Map<number, { category: string; summary?: string }>> {
  const result = new Map<number, { category: string; summary?: string }>();
  if (issues.length === 0) return result;

  const llm = getLlm();
  const batchSize = 20;

  for (let i = 0; i < issues.length; i += batchSize) {
    const batch = issues.slice(i, i + batchSize);
    const userContent = batch.map(issue =>
      `#${issue.id}: ${issue.title}\n${(issue.body ?? '').slice(0, 200)}`
    ).join('\n---\n');

    try {
      const response = await llm.chat.completions.create({
        model: LLM_MODEL,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: ISSUE_CLASSIFY_PROMPT },
          { role: 'user', content: userContent },
        ],
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) continue;

      const jsonStr = content.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      const parsed = JSON.parse(jsonStr) as Array<{ id: number; category: string; summary?: string }>;

      for (const item of parsed) {
        result.set(item.id, { category: item.category, summary: item.summary });
      }
    } catch {
      // Fallback: mark as other
      for (const issue of batch) {
        result.set(issue.id, { category: 'other' });
      }
    }
  }

  return result;
}

// ─── 主流程 ──────────────────────────────────────────────────

export async function classifyIssues(issues: GitHubIssue[]): Promise<ClassifiedIssue[]> {
  const results: ClassifiedIssue[] = [];
  const ambiguous: GitHubIssue[] = [];

  // Phase 1: Rule-based classification
  for (const issue of issues) {
    const category = classifyByRules(issue);
    if (category) {
      results.push({ id: issue.id, title: issue.title, category });
    } else {
      ambiguous.push(issue);
    }
  }

  // Phase 2: LLM for ambiguous issues
  if (ambiguous.length > 0) {
    console.log(`  [FR] 规则分类 ${results.length} 个，LLM 分类 ${ambiguous.length} 个...`);
    const llmResults = await classifyByLLM(ambiguous);
    for (const issue of ambiguous) {
      const llmResult = llmResults.get(issue.id);
      results.push({
        id: issue.id,
        title: issue.title,
        category: (llmResult?.category as ClassifiedIssue['category']) ?? 'other',
        summary: llmResult?.summary,
      });
    }
  }

  return results;
}

/**
 * 从 GitHub API 获取项目的 Issues
 */
export async function fetchProjectIssues(
  repoId: string,
  maxPages: number = 3,
): Promise<GitHubIssue[]> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'augur-signal-intelligence',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }

  const issues: GitHubIssue[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${repoId}/issues?state=open&per_page=100&page=${page}&sort=created&direction=desc`,
      { headers },
    );
    if (!res.ok) break;

    const data = await res.json() as Array<{
      id: number;
      title: string;
      body: string | null;
      labels: Array<{ name: string }>;
      pull_request?: unknown;
    }>;

    if (data.length === 0) break;

    for (const item of data) {
      // Skip pull requests (GitHub API returns PRs as issues too)
      if (item.pull_request) continue;

      issues.push({
        id: item.id,
        title: item.title,
        body: item.body ?? '',
        labels: item.labels.map(l => l.name),
      });
    }
  }

  return issues;
}

export interface FeatureRequestCluster {
  theme: string;
  count: number;
  issues: { id: number; title: string; summary?: string }[];
}

/**
 * 聚合 feature requests 为主题集群
 * 简单版：按关键词聚合。v0.3 可升级为 embedding 聚类。
 */
export function clusterFeatureRequests(classified: ClassifiedIssue[]): FeatureRequestCluster[] {
  const frs = classified.filter(c => c.category === 'feature_request');
  if (frs.length === 0) return [];

  // Simple keyword-based clustering
  const clusters = new Map<string, ClassifiedIssue[]>();

  for (const fr of frs) {
    const titleLower = fr.title.toLowerCase();
    let theme = 'other';

    // Match common themes
    const themePatterns: [RegExp, string][] = [
      [/\b(api|endpoint|rest|graphql)\b/i, 'API 扩展'],
      [/\b(plugin|extension|addon|integration)\b/i, '插件/集成'],
      [/\b(ui|ux|interface|dashboard|frontend)\b/i, 'UI/UX'],
      [/\b(performance|speed|fast|optimize|cache)\b/i, '性能优化'],
      [/\b(doc|documentation|example|tutorial)\b/i, '文档'],
      [/\b(auth|security|permission|token)\b/i, '安全/认证'],
      [/\b(config|setting|option|customize)\b/i, '配置/自定义'],
      [/\b(export|import|format|convert)\b/i, '数据格式'],
      [/\b(multi|parallel|concurrent|batch)\b/i, '并发/批量'],
      [/\b(local|self.hosted|private|offline)\b/i, '本地化/私有化'],
    ];

    for (const [pattern, label] of themePatterns) {
      if (pattern.test(titleLower)) {
        theme = label;
        break;
      }
    }

    const list = clusters.get(theme) ?? [];
    list.push(fr);
    clusters.set(theme, list);
  }

  return [...clusters.entries()]
    .map(([theme, issues]) => ({
      theme,
      count: issues.length,
      issues: issues.map(i => ({ id: i.id, title: i.title, summary: i.summary })),
    }))
    .sort((a, b) => b.count - a.count);
}
