/**
 * HackerNews 采集器
 *
 * 通过 Algolia HN Search API 采集技术相关的热帖。
 * 重点关注 Show HN / Ask HN，以及包含 GitHub 链接的帖子。
 */

const HN_SEARCH_API = 'https://hn.algolia.com/api/v1';

export interface HNPost {
  id: number;
  title: string;
  url: string | null;
  points: number;
  comments: number;
  createdAt: string;
  tags: string[];
}

interface AlgoliaHit {
  objectID: string;
  title: string;
  url: string | null;
  points: number;
  num_comments: number;
  created_at: string;
  _tags: string[];
}

interface AlgoliaResponse {
  hits: AlgoliaHit[];
  nbHits: number;
}

/**
 * 搜索 HN 帖子
 */
async function searchHN(query: string, tags?: string, numericFilters?: string, hitsPerPage = 50): Promise<HNPost[]> {
  const params = new URLSearchParams({
    query,
    hitsPerPage: String(hitsPerPage),
  });
  if (tags) params.set('tags', tags);
  if (numericFilters) params.set('numericFilters', numericFilters);

  const res = await fetch(`${HN_SEARCH_API}/search?${params}`);
  if (!res.ok) {
    throw new Error(`HN API failed: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as AlgoliaResponse;
  return data.hits.map(hit => ({
    id: parseInt(hit.objectID, 10),
    title: hit.title,
    url: hit.url,
    points: hit.points ?? 0,
    comments: hit.num_comments ?? 0,
    createdAt: hit.created_at,
    tags: hit._tags ?? [],
  }));
}

/**
 * 获取最近的 Show HN 热帖（按分数排序）
 */
export async function fetchShowHN(daysBack = 7, minPoints = 20): Promise<HNPost[]> {
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;
  return searchHN('', 'show_hn', `points>${minPoints},created_at_i>${since}`);
}

/**
 * 获取最近的 Ask HN 热帖
 */
export async function fetchAskHN(daysBack = 7, minPoints = 20): Promise<HNPost[]> {
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;
  return searchHN('', 'ask_hn', `points>${minPoints},created_at_i>${since}`);
}

/**
 * 搜索含 GitHub 链接的热帖（AI/开源/开发工具相关）
 */
export async function fetchGitHubPosts(daysBack = 7, minPoints = 10): Promise<HNPost[]> {
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;
  return searchHN('github.com', 'story', `points>${minPoints},created_at_i>${since}`);
}

/**
 * 搜索 AI/LLM 相关热帖
 */
export async function fetchAIPosts(daysBack = 7, minPoints = 20): Promise<HNPost[]> {
  const since = Math.floor(Date.now() / 1000) - daysBack * 86400;
  const queries = ['LLM', 'AI agent', 'open source AI'];
  const allPosts = new Map<number, HNPost>();

  for (const q of queries) {
    const posts = await searchHN(q, 'story', `points>${minPoints},created_at_i>${since}`, 30);
    for (const p of posts) {
      allPosts.set(p.id, p);
    }
  }

  return [...allPosts.values()].sort((a, b) => b.points - a.points);
}

/**
 * 从 HN 帖子 URL 中提取 GitHub repo ID
 */
export function extractGitHubRepo(url: string | null): string | null {
  if (!url) return null;
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) return null;
  // Clean up trailing .git, /tree/xxx, etc.
  return match[1].replace(/\.git$/, '').split('/').slice(0, 2).join('/');
}

/**
 * 一站式采集：合并所有 HN 源，去重，按分数排序
 */
export async function fetchAllHNPosts(daysBack = 7): Promise<HNPost[]> {
  console.log('  [HN] 采集 Show HN...');
  const showHN = await fetchShowHN(daysBack);

  console.log('  [HN] 采集 GitHub 相关帖子...');
  const githubPosts = await fetchGitHubPosts(daysBack);

  console.log('  [HN] 采集 AI 相关帖子...');
  const aiPosts = await fetchAIPosts(daysBack);

  // Dedupe
  const all = new Map<number, HNPost>();
  for (const p of [...showHN, ...githubPosts, ...aiPosts]) {
    all.set(p.id, p);
  }

  return [...all.values()].sort((a, b) => b.points - a.points);
}
