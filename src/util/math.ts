/**
 * 共享数学/统计工具函数
 */

/**
 * 计算加速度：recent 周期均值 / baseline 周期均值
 * 用于检测指标突增（star、fork、issue 等）
 */
export function computeAcceleration(recent: number[], baseline: number[]): number {
  const recentAvg = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const baselineAvg = baseline.length > 0 ? baseline.reduce((a, b) => a + b, 0) / baseline.length : 0;
  if (baselineAvg < 1) return recentAvg > 3 ? Math.min(recentAvg, 10) : 0;
  return recentAvg / baselineAvg;
}
