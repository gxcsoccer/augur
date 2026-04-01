const GITHUB_API = 'https://api.github.com';

function getHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'augur-signal-intelligence',
  };
  if (process.env.GITHUB_TOKEN) {
    headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  return headers;
}

// Simple rate limiter: track remaining requests
let rateLimitRemaining = 5000;
let rateLimitReset = 0;

async function githubFetch(url: string): Promise<Response> {
  // Wait if we've hit the rate limit
  if (rateLimitRemaining <= 10) {
    const waitMs = Math.max(0, rateLimitReset * 1000 - Date.now()) + 1000;
    if (waitMs > 0 && waitMs < 3600_000) {
      console.log(`  Rate limit low (${rateLimitRemaining} remaining), waiting ${Math.ceil(waitMs / 1000)}s...`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }

  const res = await fetch(url, { headers: getHeaders() });

  // Update rate limit info from headers
  const remaining = res.headers.get('x-ratelimit-remaining');
  const reset = res.headers.get('x-ratelimit-reset');
  if (remaining) rateLimitRemaining = parseInt(remaining, 10);
  if (reset) rateLimitReset = parseInt(reset, 10);

  if (res.status === 403 && rateLimitRemaining === 0) {
    const waitMs = Math.max(0, rateLimitReset * 1000 - Date.now()) + 1000;
    console.log(`  Rate limit exceeded, waiting ${Math.ceil(waitMs / 1000)}s...`);
    await new Promise(r => setTimeout(r, waitMs));
    return githubFetch(url); // retry once
  }

  return res;
}

export interface RepoDetails {
  id: string;
  description: string | null;
  language: string | null;
  topics: string[];
  stars: number;
  forks: number;
  openIssues: number;
  createdAt: string;
}

export async function fetchRepoDetails(repoId: string): Promise<RepoDetails | null> {
  const res = await githubFetch(`${GITHUB_API}/repos/${repoId}`);
  if (!res.ok) {
    console.warn(`  Failed to fetch repo ${repoId}: ${res.status}`);
    return null;
  }

  const data = await res.json() as Record<string, unknown>;
  return {
    id: data.full_name as string,
    description: (data.description as string) ?? null,
    language: (data.language as string) ?? null,
    topics: (data.topics as string[]) ?? [],
    stars: data.stargazers_count as number,
    forks: data.forks_count as number,
    openIssues: data.open_issues_count as number,
    createdAt: data.created_at as string,
  };
}

export async function fetchReadme(repoId: string): Promise<string | null> {
  const res = await githubFetch(`${GITHUB_API}/repos/${repoId}/readme`);
  if (!res.ok) return null;

  const data = await res.json() as Record<string, unknown>;
  const content = data.content as string;
  if (!content) return null;

  return Buffer.from(content, 'base64').toString('utf-8');
}

export interface StarEvent {
  starred_at: string;
}

/**
 * Fetch recent star history using Stargazer API with timestamps.
 * Returns star events sorted by date. Used for cold-start backfill.
 * Note: Each page = 1 API call, 100 stars per page.
 */
export async function fetchStarHistory(
  repoId: string,
  maxPages: number = 5,
): Promise<StarEvent[]> {
  const events: StarEvent[] = [];
  const headers = {
    ...getHeaders(),
    'Accept': 'application/vnd.github.v3.star+json',
  };

  // Fetch from the last page backwards to get recent stars
  // First, get total count to calculate last page
  const headRes = await githubFetch(`${GITHUB_API}/repos/${repoId}/stargazers?per_page=1`);
  if (!headRes.ok) return events;

  const linkHeader = headRes.headers.get('link');
  let lastPage = 1;
  if (linkHeader) {
    const match = linkHeader.match(/page=(\d+)>;\s*rel="last"/);
    if (match) lastPage = parseInt(match[1], 10);
  }

  // Fetch the most recent pages
  const startPage = Math.max(1, lastPage - maxPages + 1);
  for (let page = startPage; page <= lastPage; page++) {
    const res = await fetch(`${GITHUB_API}/repos/${repoId}/stargazers?per_page=100&page=${page}`, {
      headers,
    });
    if (!res.ok) break;

    const data = await res.json() as { starred_at: string }[];
    for (const item of data) {
      events.push({ starred_at: item.starred_at });
    }
  }

  return events.sort((a, b) => a.starred_at.localeCompare(b.starred_at));
}

export function getRateLimitInfo(): { remaining: number; reset: Date } {
  return {
    remaining: rateLimitRemaining,
    reset: new Date(rateLimitReset * 1000),
  };
}
