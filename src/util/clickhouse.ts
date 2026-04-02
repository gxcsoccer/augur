/**
 * ClickHouse 查询工具
 *
 * 优先使用 Node.js fetch，若超时则回退到 curl。
 * 解决部分网络环境下 Node.js undici 无法连接 ClickHouse 的问题。
 */

import { execSync } from 'node:child_process';

const CLICKHOUSE_URL = 'https://play.clickhouse.com/?user=play';
const FETCH_TIMEOUT = 15000;

export async function queryClickHouse(sql: string): Promise<string> {
  // Try fetch first
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    const res = await fetch(CLICKHOUSE_URL, {
      method: 'POST',
      body: sql,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ClickHouse: ${res.status} — ${text.slice(0, 200)}`);
    }
    return res.text();
  } catch (fetchErr) {
    // Fallback to curl (fetch often fails in restricted network environments)
    console.debug?.(`[ClickHouse] fetch failed (${(fetchErr as Error).message?.slice(0, 80)}), falling back to curl`);
    return queryClickHouseCurl(sql);
  }
}

function queryClickHouseCurl(sql: string): string {
  try {
    return execSync(`curl -s --max-time 60 "${CLICKHOUSE_URL}" --data-binary @-`, {
      input: sql,
      encoding: 'utf-8',
      timeout: 90000,
    });
  } catch (err) {
    throw new Error(`ClickHouse curl failed: ${(err as Error).message?.slice(0, 200)}`);
  }
}

/**
 * ClickHouse SQL 转义
 * - 单引号用 '' 转义（ClickHouse 标准）
 * - 只允许 repo name 合法字符: 字母、数字、-_./
 */
export function escapeSQL(s: string): string {
  // Strict allowlist: only valid GitHub repo name characters
  if (!/^[a-zA-Z0-9_.\-/]+$/.test(s)) {
    throw new Error(`Invalid repo name for SQL: ${s}`);
  }
  return s.replace(/'/g, "''");
}

/**
 * 校验日期格式，防止 SQL 注入
 */
export function validateDate(s: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`Invalid date format for SQL: "${s}" (expected YYYY-MM-DD)`);
  }
  return s;
}

export interface WeeklyMetrics {
  week: string;
  new_stars: number;
  new_forks: number;
  new_issues: number;
  new_prs: number;
  unique_pushers: number;
  new_releases: number;
}

export async function fetchWeeklyMetrics(
  repoName: string,
  fromDate: string,
  toDate: string,
): Promise<WeeklyMetrics[]> {
  const sql = `
    SELECT
      toStartOfWeek(created_at) AS week,
      countIf(event_type = 'WatchEvent') AS new_stars,
      countIf(event_type = 'ForkEvent') AS new_forks,
      countIf(event_type = 'IssuesEvent') AS new_issues,
      countIf(event_type = 'PullRequestEvent') AS new_prs,
      uniqIf(actor_login, event_type = 'PushEvent') AS unique_pushers,
      countIf(event_type = 'ReleaseEvent') AS new_releases
    FROM github_events
    WHERE repo_name = '${escapeSQL(repoName)}'
      AND created_at >= '${validateDate(fromDate)}'
      AND created_at <= '${validateDate(toDate)}'
    GROUP BY week
    ORDER BY week ASC
    FORMAT JSONEachRow
  `;

  const text = await queryClickHouse(sql);
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.map((line) => {
    const row = JSON.parse(line);
    return {
      week: row.week.slice(0, 10),
      new_stars: Number(row.new_stars),
      new_forks: Number(row.new_forks),
      new_issues: Number(row.new_issues),
      new_prs: Number(row.new_prs),
      unique_pushers: Number(row.unique_pushers ?? 0),
      new_releases: Number(row.new_releases ?? 0),
    };
  });
}
