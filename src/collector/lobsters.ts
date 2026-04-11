/**
 * Lobste.rs 采集器
 *
 * 替代 Reddit 作为技术社区信号源。
 * Lobste.rs 是高质量技术社区，JSON API 完全公开无需认证，
 * 且社区成员与开源开发者高度重叠。
 */

import { extractRepoFromUrl } from '../util/github.js';

export interface LobstersPost {
  id: string;
  title: string;
  url: string;
  permalink: string;
  score: number;
  comments: number;
  tags: string[];
  createdAt: string;
}

interface LobstersResponse {
  short_id: string;
  title: string;
  url: string;
  comments_url: string;
  score: number;
  comment_count: number;
  tags: string[];
  created_at: string;
}

const LOBSTERS_BASE = 'https://lobste.rs';

async function fetchPage(path: string): Promise<LobstersPost[]> {
  const url = `${LOBSTERS_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Augur/1.0 (github.com/gxcsoccer/augur; open-source signal intelligence)' },
  });

  if (!res.ok) {
    console.warn(`  [Lobsters] Failed to fetch ${path}: ${res.status}`);
    return [];
  }

  let data: LobstersResponse[];
  try {
    data = (await res.json()) as LobstersResponse[];
  } catch {
    console.warn(`  [Lobsters] ${path} returned non-JSON response`);
    return [];
  }

  return data.map((p) => ({
    id: p.short_id,
    title: p.title,
    url: p.url,
    permalink: p.comments_url,
    score: p.score,
    comments: p.comment_count,
    tags: p.tags,
    createdAt: p.created_at,
  }));
}

/**
 * 从 Lobsters 帖子 URL 中提取 GitHub repo ID
 */
export function extractGitHubRepo(url: string): string | null {
  return extractRepoFromUrl(url);
}

/**
 * 采集 Lobsters 热帖 + 最新帖
 */
export async function fetchAllLobstersPosts(): Promise<LobstersPost[]> {
  console.log('  [Lobsters] 采集热帖...');
  const hottest = await fetchPage('/hottest.json');

  // 1s courtesy delay
  await new Promise((r) => setTimeout(r, 1000));

  console.log('  [Lobsters] 采集最新帖...');
  const newest = await fetchPage('/newest.json');

  const all = new Map<string, LobstersPost>();
  for (const p of [...hottest, ...newest]) {
    if (!all.has(p.id)) all.set(p.id, p);
  }

  return [...all.values()].sort((a, b) => b.score - a.score);
}
