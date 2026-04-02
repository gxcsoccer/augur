/**
 * 共享数学/统计工具函数
 */

/**
 * 标准化 GitHub repo ID 为小写
 *
 * GitHub repo 名不区分大小写 (Foo/Bar == foo/bar)，但不同数据源返回的大小写不一致：
 * - GitHub Trending HTML: 原始大小写
 * - GitHub API full_name: 规范大小写
 * - ClickHouse repo_name: 事件时的大小写
 * - Reddit/HN URL 提取: URL 中的大小写
 *
 * 统一为小写，确保跨数据源的 join/lookup 不会因大小写而失效。
 */
export function normalizeRepoId(id: string): string {
  return id.toLowerCase();
}

/**
 * Get today's date in YYYY-MM-DD format, always in UTC.
 * Avoids timezone-dependent behavior where toISOString().slice(0,10)
 * can return "yesterday" in UTC when called from UTC+ timezones near midnight.
 */
export function todayUTC(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/**
 * 计算加速度：recent 周期均值 / baseline 周期均值
 *
 * 特殊情况处理：
 * - baseline 接近 0 但 recent 有明显活跃 → 视为"涌现"信号，返回 recent 均值（封顶 10x）
 * - baseline 和 recent 都接近 0 → 返回 0（无信号）
 * - 正常情况 → recentAvg / baselineAvg
 */
export function computeAcceleration(recent: number[], baseline: number[]): number {
  const recentAvg = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const baselineAvg = baseline.length > 0 ? baseline.reduce((a, b) => a + b, 0) / baseline.length : 0;

  if (baselineAvg < 1) {
    // Baseline near-zero: can't compute meaningful ratio.
    // If recent has any meaningful activity, treat as emergence signal.
    // Threshold: recentAvg >= 2 (at least 2 events/week average)
    if (recentAvg >= 2) return Math.min(recentAvg / Math.max(baselineAvg, 0.1), 10);
    return 0;
  }

  return recentAvg / baselineAvg;
}
