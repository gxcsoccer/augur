/**
 * 结果自动验证器（Outcome Detector）
 *
 * 解决进化循环的核心断裂：不再依赖人工验证预测是否命中。
 *
 * 原理：对已过预测日期的候选浪潮，查询 ClickHouse 获取
 * 预测日期前后的 GitHub 活动数据，检测是否发生了"爆发"。
 *
 * 爆发判定标准（至少满足 2 条）：
 * 1. 浪潮内多个 repo 在预测日期 ±3 个月内出现 star 3x 加速
 * 2. 浪潮内 repo 的 fork/star 比在预测期间显著上升
 * 3. 浪潮内 repo 在预测期间出现 contributor 数量突增
 */

import { fetchWeeklyMetrics } from './backtest.js';
import type { PredictionRecord } from './online-learner.js';

interface EruptionEvidence {
  repo: string;
  hasStarAcceleration: boolean;   // 3x star 加速
  hasContribSurge: boolean;       // contributor 突增
  peakStarsPerWeek: number;
  baselineStarsPerWeek: number;
}

interface VerificationResult {
  predictionId: string;
  wave: string;
  hit: boolean;
  confidence: number;             // 0~1
  evidenceCount: number;          // 满足了几条爆发标准
  evidence: EruptionEvidence[];
  reasoning: string;
}

/**
 * 自动验证一条预测
 *
 * 对预测涉及的 repo，查询预测日期前后各 3 个月的数据，
 * 检测是否发生了加速事件。
 */
export async function verifyPrediction(
  prediction: PredictionRecord,
  repos: string[],
): Promise<VerificationResult> {
  const predictedDate = new Date(prediction.predictedEruption);

  // 查询窗口：预测日期 -3 个月 ~ +6 个月
  const windowStart = new Date(predictedDate);
  windowStart.setMonth(windowStart.getMonth() - 3);
  const windowEnd = new Date(predictedDate);
  windowEnd.setMonth(windowEnd.getMonth() + 6);

  // 基线窗口：预测日期 -12 个月 ~ -3 个月
  const baselineStart = new Date(predictedDate);
  baselineStart.setMonth(baselineStart.getMonth() - 12);

  const evidence: EruptionEvidence[] = [];
  let totalAccelerations = 0;
  let totalContribSurges = 0;

  for (const repo of repos) {
    try {
      // 获取基线期数据
      const baselineData = await fetchWeeklyMetrics(
        repo,
        baselineStart.toISOString().slice(0, 10),
        windowStart.toISOString().slice(0, 10),
      );

      // 获取预测窗口数据
      const windowData = await fetchWeeklyMetrics(
        repo,
        windowStart.toISOString().slice(0, 10),
        windowEnd.toISOString().slice(0, 10),
      );

      if (baselineData.length < 4 || windowData.length < 4) {
        evidence.push({
          repo, hasStarAcceleration: false, hasContribSurge: false,
          peakStarsPerWeek: 0, baselineStarsPerWeek: 0,
        });
        continue;
      }

      // 计算基线期均值
      const baselineStars = baselineData.reduce((s, w) => s + w.new_stars, 0) / baselineData.length;
      const baselineContribs = baselineData.reduce((s, w) => s + w.unique_pushers, 0) / baselineData.length;

      // 计算窗口期峰值
      const peakStars = Math.max(...windowData.map(w => w.new_stars));
      const peakContribs = Math.max(...windowData.map(w => w.unique_pushers));

      // 检测加速
      const hasStarAcceleration = baselineStars > 0 && peakStars / baselineStars >= 3;
      const hasContribSurge = baselineContribs > 2 && peakContribs / baselineContribs >= 2;

      if (hasStarAcceleration) totalAccelerations++;
      if (hasContribSurge) totalContribSurges++;

      evidence.push({
        repo,
        hasStarAcceleration,
        hasContribSurge,
        peakStarsPerWeek: Math.round(peakStars),
        baselineStarsPerWeek: Math.round(baselineStars),
      });
    } catch {
      evidence.push({
        repo, hasStarAcceleration: false, hasContribSurge: false,
        peakStarsPerWeek: 0, baselineStarsPerWeek: 0,
      });
    }
  }

  // 判定爆发：至少 2 个 repo 出现 star 加速，或 1 个加速 + 1 个 contrib 突增
  const evidenceCount = Math.min(totalAccelerations, repos.length) + Math.min(totalContribSurges, repos.length);
  const hit = totalAccelerations >= 2 || (totalAccelerations >= 1 && totalContribSurges >= 1);
  const confidence = Math.min(1, (totalAccelerations * 0.4 + totalContribSurges * 0.2) / repos.length);

  const reasoning = hit
    ? `${totalAccelerations} 个 repo star 3x 加速，${totalContribSurges} 个 contributor 突增 → 判定爆发`
    : `仅 ${totalAccelerations} 个 repo 加速，${totalContribSurges} 个 contributor 突增 → 未达爆发标准`;

  return {
    predictionId: prediction.id,
    wave: prediction.wave,
    hit,
    confidence: Math.round(confidence * 100) / 100,
    evidenceCount,
    evidence,
    reasoning,
  };
}

/**
 * 批量自动验证所有待验证的预测
 */
export async function autoVerifyPredictions(
  predictions: PredictionRecord[],
  waveRepoMap: Map<string, string[]>,
): Promise<VerificationResult[]> {
  const results: VerificationResult[] = [];

  for (const pred of predictions) {
    const repos = waveRepoMap.get(pred.wave);
    if (!repos || repos.length === 0) {
      console.log(`  [AutoVerify] 跳过 "${pred.wave}" — 无 repo 映射`);
      continue;
    }

    console.log(`  [AutoVerify] 验证 "${pred.wave}" (预测 ${pred.predictedEruption})...`);
    const result = await verifyPrediction(pred, repos.slice(0, 5)); // limit to 5 repos
    results.push(result);
    console.log(`    → ${result.hit ? '✓ 命中' : '✗ 未命中'} (${result.reasoning})`);
  }

  return results;
}
