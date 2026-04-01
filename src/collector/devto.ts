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

  const data = (await res.json()) as DevToResponse[];
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

  for (const tag of tags) {
    const articles = await fetchArticles(tag, daysBack);
    for (const a of articles) {
      if (!all.has(a.id) || a.reactionsCount > (all.get(a.id)!.reactionsCount)) {
        all.set(a.id, a);
      }
    }
  }

  return [...all.values()].sort((a, b) => b.reactionsCount - a.reactionsCount);
}

/**
 * 从 DEV.to 文章中提取 GitHub repo 引用
 * 匹配标题和 URL 中的 github.com 链接
 */
export function extractGitHubRepoFromArticle(article: DevToArticle): string | null {
  // Check if URL itself is a GitHub repo
  const urlMatch = article.url.match(/github\.com\/([^/]+\/[^/]+)/);
  if (urlMatch) return cleanRepoId(urlMatch[1]);

  // Check title for GitHub repo patterns like "owner/repo"
  // Strict: require at least 2 chars each side, exclude common false positives
  const titleMatch = article.title.match(/\b([a-zA-Z][a-zA-Z0-9_-]{1,38}\/[a-zA-Z][a-zA-Z0-9_.-]{1,100})\b/);
  if (titleMatch && !/\.(js|ts|py|com|org|io|css|html|json)$/i.test(titleMatch[1])
    && !['node.js', 'next.js', 'vue.js', 'express.js'].some(fp => titleMatch[1].toLowerCase().includes(fp))) {
    return titleMatch[1];
  }

  return null;
}

function cleanRepoId(id: string): string {
  return id.replace(/\.git$/, '').split('/').slice(0, 2).join('/');
}

/**
 * 一站式采集：获取所有 DEV.to 帖子并提取 GitHub 关联
 */
export async function fetchAllDevToPosts(daysBack: number = 7): Promise<DevToArticle[]> {
  console.log('  [DEV.to] 采集开源相关热帖...');
  return fetchOpenSourceArticles(daysBack);
}
