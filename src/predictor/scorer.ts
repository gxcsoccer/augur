/**
 * 机会评分模型
 *
 * 多因子加权评分，基于回测校准后的权重：
 * - 信号层级（infrastructure 得分最高）
 * - 增长质量（staircase > steady > spike）
 * - Fork/Star 比（衡量实际使用率）
 * - Issue 活跃度（衡量社区需求）
 * - 多因子加速（强信号加分）
 */

import type { GrowthPattern } from '../analyzer/growth-classifier.js';

export interface ScoringInput {
  projectId: string;
  layer: 'infrastructure' | 'tooling' | 'application';
  growthPattern: GrowthPattern;
  forkStarRatio: number;       // fork/star 比
  weeklyIssueDelta: number;    // 周均 issue 增量
  weeklyStarDelta: number;     // 周均 star 增量
  hasStrongSignal: boolean;    // 多因子同时加速
  domains: string[];
}

export interface ScoringResult {
  projectId: string;
  opportunityScore: number;    // 0~1
  confidence: number;          // 0~1
  breakdown: {
    layerScore: number;
    growthScore: number;
    usageScore: number;
    activityScore: number;
    signalBonus: number;
  };
}

// 权重基于回测结果校准
const WEIGHTS = {
  layer: 0.25,
  growth: 0.25,
  usage: 0.20,
  activity: 0.15,
  signalBonus: 0.15,
};

const LAYER_SCORES: Record<string, number> = {
  infrastructure: 1.0,
  tooling: 0.6,
  application: 0.2,
};

const GROWTH_SCORES: Record<string, number> = {
  staircase: 1.0,
  steady: 0.6,
  spike: 0.2,
  declining: 0.0,
};

export function scoreOpportunity(input: ScoringInput): ScoringResult {
  const layerScore = LAYER_SCORES[input.layer] ?? 0.2;
  const growthScore = GROWTH_SCORES[input.growthPattern] ?? 0.3;

  // Fork/Star ratio: 0.2~0.4 is ideal (real usage), >0.5 may indicate abandoned forks
  const usageScore = input.forkStarRatio >= 0.15 && input.forkStarRatio <= 0.5
    ? Math.min(input.forkStarRatio / 0.3, 1.0)
    : input.forkStarRatio > 0.5
      ? 0.5 // 过高的 fork 比可能是 fork-and-abandon
      : input.forkStarRatio / 0.15 * 0.5;

  // Issue activity: normalize, cap at 1.0
  const activityScore = Math.min(input.weeklyIssueDelta / 50, 1.0);

  // Strong signal bonus
  const signalBonus = input.hasStrongSignal ? 1.0 : 0.0;

  const opportunityScore =
    layerScore * WEIGHTS.layer +
    growthScore * WEIGHTS.growth +
    usageScore * WEIGHTS.usage +
    activityScore * WEIGHTS.activity +
    signalBonus * WEIGHTS.signalBonus;

  // Confidence based on data completeness
  let dataPoints = 0;
  if (input.growthPattern !== 'steady') dataPoints++; // has enough data for classification
  if (input.forkStarRatio > 0) dataPoints++;
  if (input.weeklyIssueDelta > 0) dataPoints++;
  if (input.weeklyStarDelta > 0) dataPoints++;
  if (input.hasStrongSignal) dataPoints++;
  const confidence = Math.min(dataPoints / 4, 1.0);

  return {
    projectId: input.projectId,
    opportunityScore: Math.round(opportunityScore * 100) / 100,
    confidence: Math.round(confidence * 100) / 100,
    breakdown: {
      layerScore: Math.round(layerScore * 100) / 100,
      growthScore: Math.round(growthScore * 100) / 100,
      usageScore: Math.round(usageScore * 100) / 100,
      activityScore: Math.round(activityScore * 100) / 100,
      signalBonus: Math.round(signalBonus * 100) / 100,
    },
  };
}
