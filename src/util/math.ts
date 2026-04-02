/**
 * 共享数学/统计工具函数
 */

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
