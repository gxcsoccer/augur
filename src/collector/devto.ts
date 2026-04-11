/**
 * DEV.to 采集器
 *
 * 通过 Forem 公开 API 采集开发者社区热帖。
 * 追踪开源项目在 DEV.to 上的讨论热度，作为社交信号源。
 */

const DEVTO_API = 'https://dev.to/api';

export interface DevToArticle {
  id: number;
  title: string;
  url: string;
  reactionsCount: number;
  commentsCount: number;
  publishedAt: string;
  tags: string[];
  githubUser: string | null;
}

interface DevToResponse {
  id: number;
  title: string;
  url: string;
  positive_reactions_count: number;
  comments_count: number;
  published_at: string;
  tag_list: string[];
  user: { github_username: string | null };
}

async function fetchArticles(
  tag: string,
  top: number = 7,
  perPage: number = 30,
): Promise<DevToArticle[]> {
  const params = new URLSearchParams({
    tag,
    top: String(top),
    per_page: String(perPage),
  });

  const res = await fetch(`${DEVTO_API}/articles?${params}`, {
    headers: { 'User-Agent': 'Augur/1.0 (github.com/gxcsoccer/augur)' },
  });

  if (!res.ok) {
    console.warn(`  [DEV.to] Failed to fetch tag=${tag}: ${res.status}`);
    return [];
  }

  let data: DevToResponse[];
  try {
    data = (await res.json()) as DevToResponse[];
  } catch {
    console.warn(`  [DEV.to] tag=${tag} returned non-JSON response`);
    return [];
  }
  return data.map((a) => ({
    id: a.id,
    title: a.title,
    url: a.url,
    reactionsCount: a.positive_reactions_count ?? 0,
    commentsCount: a.comments_count ?? 0,
    publishedAt: a.published_at,
    tags: a.tag_list ?? [],
    githubUser: a.user?.github_username ?? null,
  }));
}

/**
 * 采集开源/GitHub 相关热帖
 */
export async function fetchOpenSourceArticles(daysBack: number = 7): Promise<DevToArticle[]> {
  const tags = ['opensource', 'github', 'ai', 'machinelearning', 'webdev'];
  const all = new Map<number, DevToArticle>();

  // DEV.to rate limit is 30/30s, 5 parallel is safe
  const results = await Promise.all(tags.map((tag) => fetchArticles(tag, daysBack)));
  for (const articles of results) {
    for (const a of articles) {
      if (!all.has(a.id) || a.reactionsCount > (all.get(a.id)!.reactionsCount)) {
        all.set(a.id, a);
      }
    }
  }

  return [...all.values()].sort((a, b) => b.reactionsCount - a.reactionsCount);
}

import { extractRepoFromUrl } from '../util/github.js';

/**
 * 获取单篇文章详情（包含正文 body_html），提取 GitHub repo 链接
 */
async function fetchArticleGitHubRepo(articleId: number): Promise<string | null> {
  const res = await fetch(`${DEVTO_API}/articles/${articleId}`, {
    headers: { 'User-Agent': 'Augur/1.0 (github.com/gxcsoccer/augur)' },
  });
  if (!res.ok) return null;

  try {
    const data = (await res.json()) as { body_html?: string; body_markdown?: string };
    const body = data.body_markdown ?? data.body_html ?? '';
    // 提取所有 GitHub repo 链接，返回第一个
    const matches = body.matchAll(/github\.com\/([^/\s"'<>)]+\/[^/\s"'<>)#?]+)/g);
    for (const m of matches) {
      const repo = extractRepoFromUrl(`https://github.com/${m[1]}`);
      if (repo) return repo;
    }
  } catch {}
  return null;
}

/**
 * 从 DEV.to 文章中提取 GitHub repo 引用
 *
 * 先从标题匹配，如果未命中则回退到文章详情 API（需额外请求）
 */
export function extractGitHubRepoFromArticle(article: DevToArticle): string | null {
  // Title pattern: look for "owner/repo" format in title
  const titleMatch = article.title.match(/\b([a-zA-Z][a-zA-Z0-9_-]{1,38}\/[a-zA-Z][a-zA-Z0-9_.-]{1,100})\b/);
  if (titleMatch && !/\.(js|ts|py|com|org|io|css|html|json)$/i.test(titleMatch[1])
    && !['node.js', 'next.js', 'vue.js', 'express.js'].some(fp => titleMatch[1].toLowerCase().includes(fp))) {
    return titleMatch[1];
  }

  return null;
}

/**
 * 一站式采集：获取所有 DEV.to 帖子并从正文提取 GitHub 关联
 */
export async function fetchAllDevToPosts(daysBack: number = 7): Promise<DevToArticle[]> {
  console.log('  [DEV.to] 采集开源相关热帖...');
  const articles = await fetchOpenSourceArticles(daysBack);

  // 对热度最高的文章，逐篇获取正文以提取 GitHub 链接
  // DEV.to rate limit: 30 req/30s，取 top 20 篇足够
  const topArticles = articles.slice(0, 20);
  let enriched = 0;
  for (const a of topArticles) {
    if (extractGitHubRepoFromArticle(a)) continue; // 标题已命中，跳过
    const repo = await fetchArticleGitHubRepo(a.id);
    if (repo) {
      // 将 repo 信息注入标题以便下游 extractGitHubRepoFromArticle 命中
      a.title = `${a.title} [${repo}]`;
      enriched++;
    }
    // courtesy delay: ~100ms between requests (well within 30/30s)
    await new Promise((r) => setTimeout(r, 100));
  }
  if (enriched > 0) {
    console.log(`  [DEV.to] 从文章正文额外提取到 ${enriched} 个 GitHub 项目`);
  }

  return articles;
}
