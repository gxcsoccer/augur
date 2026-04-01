export type GrowthPattern = 'staircase' | 'spike' | 'steady' | 'declining';

/**
 * Classify growth pattern based on weekly star deltas.
 *
 * - staircase: Multiple growth steps with low volatility → real demand
 * - spike: Single large peak → media/marketing driven
 * - steady: Consistent moderate growth
 * - declining: Negative trend
 */
export function classifyGrowthPattern(weeklyDeltas: number[]): GrowthPattern {
  if (weeklyDeltas.length < 2) return 'steady';

  const mean = weeklyDeltas.reduce((a, b) => a + b, 0) / weeklyDeltas.length;

  // Declining: overall negative trend
  if (mean < 0) return 'declining';

  const std = Math.sqrt(
    weeklyDeltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / weeklyDeltas.length
  );
  const volatility = std / (Math.abs(mean) + 1);

  const maxDelta = Math.max(...weeklyDeltas);
  const medianDelta = median(weeklyDeltas);

  // Spike: one huge week, then drop off
  if (maxDelta > 5 * (medianDelta + 1)) {
    return 'spike';
  }

  // Staircase: low volatility + evidence of multiple growth steps
  if (volatility < 0.8 && hasMultipleSteps(weeklyDeltas)) {
    return 'staircase';
  }

  return 'steady';
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Detect if the growth curve has multiple "steps" —
 * periods of acceleration separated by plateaus.
 */
function hasMultipleSteps(deltas: number[]): boolean {
  if (deltas.length < 4) return false;

  const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  let steps = 0;
  let aboveAvg = false;

  for (const d of deltas) {
    const nowAbove = d > avg * 1.2;
    if (nowAbove && !aboveAvg) {
      steps++;
    }
    aboveAvg = nowAbove;
  }

  return steps >= 2;
}

export interface GrowthAnalysis {
  pattern: GrowthPattern;
  weeklyDeltas: number[];
  meanDelta: number;
  volatility: number;
  totalGrowth: number;
}

export function analyzeGrowth(weeklyDeltas: number[]): GrowthAnalysis {
  const mean = weeklyDeltas.length > 0
    ? weeklyDeltas.reduce((a, b) => a + b, 0) / weeklyDeltas.length
    : 0;

  const std = weeklyDeltas.length > 1
    ? Math.sqrt(weeklyDeltas.reduce((sum, d) => sum + (d - mean) ** 2, 0) / weeklyDeltas.length)
    : 0;

  return {
    pattern: classifyGrowthPattern(weeklyDeltas),
    weeklyDeltas,
    meanDelta: Math.round(mean),
    volatility: Math.round(std / (Math.abs(mean) + 1) * 100) / 100,
    totalGrowth: weeklyDeltas.reduce((a, b) => a + b, 0),
  };
}
