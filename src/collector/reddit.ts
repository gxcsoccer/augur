/**
 * Reddit 采集器
 *
 * 通过 Reddit 公开 JSON API 采集编程/开源相关帖子。
 * Reddit 帖子是 GitHub 项目病毒式传播的强先导信号，
 * 通常在 star 暴涨前 24-48 小时出现。
 */

const REDDIT_BASE = 'https://www.reddit.com';

export interface RedditPost {
  id: string;
  title: string;
  url: string;
  permalink: string;
  score: number;
  comments: number;
  subreddit: string;
  createdAt: string;
}

interface RedditListingChild {
  data: {
    id: string;
    title: string;
    url: string;
    permalink: string;
    score: number;
    num_comments: number;
    subreddit: string;
    created_utc: number;
  };
}

interface RedditListingResponse {
  data: {
    children: RedditListingChild[];
  };
}

async function fetchSubreddit(
  subreddit: string,
  sort: 'hot' | 'top' | 'new' = 'hot',
  limit: number = 50,
  t: string = 'week',
): Promise<RedditPost[]> {
  const params = new URLSearchParams({ limit: String(limit), t });
  const url = `${REDDIT_BASE}/r/${subreddit}/${sort}.json?${params}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Augur/1.0 (github.com/gxcsoccer/augur; open-source signal intelligence)',
    },
  });

  if (!res.ok) {
    console.warn(`  [Reddit] Failed to fetch r/${subreddit}: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as RedditListingResponse;
  return data.data.children.map((c) => ({
    id: c.data.id,
    title: c.data.title,
    url: c.data.url,
    permalink: `https://reddit.com${c.data.permalink}`,
    score: c.data.score,
    comments: c.data.num_comments,
    subreddit: c.data.subreddit,
    createdAt: new Date(c.data.created_utc * 1000).toISOString(),
  }));
}

/**
 * 搜索 Reddit 帖子（含 GitHub 链接）
 */
async function searchReddit(query: string, limit: number = 30): Promise<RedditPost[]> {
  const params = new URLSearchParams({
    q: query,
    sort: 'relevance',
    t: 'week',
    limit: String(limit),
    type: 'link',
  });

  const url = `${REDDIT_BASE}/search.json?${params}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Augur/1.0 (github.com/gxcsoccer/augur; open-source signal intelligence)',
    },
  });

  if (!res.ok) {
    console.warn(`  [Reddit] Search failed: ${res.status}`);
    return [];
  }

  const data = (await res.json()) as RedditListingResponse;
  return data.data.children.map((c) => ({
    id: c.data.id,
    title: c.data.title,
    url: c.data.url,
    permalink: `https://reddit.com${c.data.permalink}`,
    score: c.data.score,
    comments: c.data.num_comments,
    subreddit: c.data.subreddit,
    createdAt: new Date(c.data.created_utc * 1000).toISOString(),
  }));
}

/**
 * 从 Reddit 帖子 URL 中提取 GitHub repo ID
 */
export function extractGitHubRepo(url: string): string | null {
  const match = url.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) return null;
  return match[1].replace(/\.git$/, '').split('/').slice(0, 2).join('/');
}

/**
 * 采集编程/开源相关子版块
 */
export async function fetchProgrammingPosts(): Promise<RedditPost[]> {
  const subreddits = ['programming', 'opensource', 'github', 'MachineLearning', 'LocalLLaMA'];
  const all = new Map<string, RedditPost>();

  for (const sub of subreddits) {
    console.log(`  [Reddit] 采集 r/${sub}...`);
    const posts = await fetchSubreddit(sub, 'hot', 30);
    for (const p of posts) {
      if (!all.has(p.id)) all.set(p.id, p);
    }
    // Rate limit courtesy: 1 second between requests
    await new Promise((r) => setTimeout(r, 1000));
  }

  return [...all.values()].sort((a, b) => b.score - a.score);
}

/**
 * 搜索 GitHub 相关帖子
 */
export async function fetchGitHubRedditPosts(): Promise<RedditPost[]> {
  console.log('  [Reddit] 搜索 GitHub 相关帖子...');
  return searchReddit('site:github.com');
}

/**
 * 一站式采集：合并所有 Reddit 源，去重
 */
export async function fetchAllRedditPosts(): Promise<RedditPost[]> {
  // Sequential to avoid Reddit rate limiting (429)
  const programming = await fetchProgrammingPosts();
  await new Promise((r) => setTimeout(r, 2000)); // extra gap before search
  const github = await fetchGitHubRedditPosts();

  const all = new Map<string, RedditPost>();
  for (const p of [...programming, ...github]) {
    if (!all.has(p.id)) all.set(p.id, p);
  }

  return [...all.values()].sort((a, b) => b.score - a.score);
}
