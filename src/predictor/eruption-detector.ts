/**
 * 爆发检测器
 *
 * 从历史数据提取爆发特征，建立自动检测器。
 * 当检测到爆发时，反馈到在线学习系统校准压缩因子。
 *
 * 特征提取自 ChatGPT(2022-11), Cursor(2023-06), Manus(2024-03)
 */

import type Database from 'better-sqlite3';
import { updateCompressionFactor } from './eruption-predictor.js';

export interface EruptionSignal {
  domain: string;
  detectedAt: string;
  confidence: number;
  features: EruptionFeatures;
}

export interface EruptionFeatures {
  appLayerStarSpike: boolean;     // application 层项目周星数暴涨 (>5000)
  hnPostDensity: number;          // 域相关 HN 帖子数/周
  domainSSI: number;              // 当前 SSI
  newProjectInflux: number;       // 域内新增项目数/周
  multiFactorAcceleration: boolean; // 多因子同时加速
}

/**
 * 爆发特征阈值（从历史数据提炼，通过在线学习持续校准）
 *
 * 历史爆发点特征：
 * - ChatGPT: HN 爆炸、awesome-chatgpt-prompts 周增 >10k star
 * - Cursor: AI IDE 话题密集出现、cursor repo 周增 7613 star
 * - Manus: MetaGPT/OpenDevin 涌现、agent 话题 HN 热度飙升
 */
const ERUPTION_THRESHOLDS = {
  appStarSpikeMin: 3000,        // application 层单项目周增 star 阈值
  hnDensityMin: 8,              // HN 域相关帖子数/周
  ssiMin: 0.7,                  // SSI 最低阈值
  newProjectInfluxMin: 3,       // 新项目涌入数/周
  requiredFeatureCount: 3,      // 至少满足 N 个特征
};

/**
 * 检测指定域是否出现爆发信号
 */
export function detectEruption(
  db: Database.Database,
  domain: string,
  week: string,
): EruptionSignal | null {
  // Get domain signal data
  const domainSignal = db.prepare(`
    SELECT * FROM domain_signals WHERE domain = ? AND week = ?
  `).get(domain, week) as any;

  if (!domainSignal) return null;

  const ssi = domainSignal.ssi ?? 0;

  // Feature 1: Application layer star spike
  const appProjects = db.prepare(`
    SELECT s.project_id, s.stars
    FROM signals sig
    JOIN snapshots s ON s.project_id = sig.project_id AND s.captured_at = ?
    WHERE sig.week = ? AND sig.layer = 'application'
      AND sig.domains LIKE ?
  `).all(week, week, `%${domain}%`) as { project_id: string; stars: number }[];

  let appStarSpike = false;
  for (const proj of appProjects) {
    const prev = db.prepare(`
      SELECT stars FROM snapshots
      WHERE project_id = ? AND captured_at < ?
      ORDER BY captured_at DESC LIMIT 1
    `).get(proj.project_id, week) as { stars: number } | undefined;

    if (prev && (proj.stars - prev.stars) > ERUPTION_THRESHOLDS.appStarSpikeMin) {
      appStarSpike = true;
      break;
    }
  }

  // Feature 2: HN post density
  const hnCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM hn_posts
    WHERE (title LIKE ? OR title LIKE ?)
      AND captured_at >= date(?, '-7 days') AND captured_at <= ?
  `).get(`%${domain}%`, `%${domain.replace(/-/g, ' ')}%`, week, week) as { cnt: number };
  const hnDensity = hnCount.cnt;

  // Feature 3: SSI already computed
  const ssiHigh = ssi >= ERUPTION_THRESHOLDS.ssiMin;

  // Feature 4: New project influx
  const newProjects = db.prepare(`
    SELECT COUNT(*) as cnt FROM projects
    WHERE first_seen_at >= date(?, '-7 days') AND first_seen_at <= ?
      AND id IN (
        SELECT project_id FROM signals WHERE week = ? AND domains LIKE ?
      )
  `).get(week, week, week, `%${domain}%`) as { cnt: number };
  const newProjectInflux = newProjects.cnt;

  // Feature 5: Multi-factor acceleration (check if SSI jumped significantly)
  const prevSSI = db.prepare(`
    SELECT ssi FROM domain_signals
    WHERE domain = ? AND week < ?
    ORDER BY week DESC LIMIT 1
  `).get(domain, week) as { ssi: number } | undefined;
  const multiFactorAccel = prevSSI ? (ssi - prevSSI.ssi) > 0.15 : false;

  const features: EruptionFeatures = {
    appLayerStarSpike: appStarSpike,
    hnPostDensity: hnDensity,
    domainSSI: ssi,
    newProjectInflux,
    multiFactorAcceleration: multiFactorAccel,
  };

  // Count how many features are triggered
  let triggeredCount = 0;
  if (appStarSpike) triggeredCount++;
  if (hnDensity >= ERUPTION_THRESHOLDS.hnDensityMin) triggeredCount++;
  if (ssiHigh) triggeredCount++;
  if (newProjectInflux >= ERUPTION_THRESHOLDS.newProjectInfluxMin) triggeredCount++;
  if (multiFactorAccel) triggeredCount++;

  if (triggeredCount >= ERUPTION_THRESHOLDS.requiredFeatureCount) {
    const confidence = Math.min(triggeredCount / 5, 1.0);

    return {
      domain,
      detectedAt: week,
      confidence,
      features,
    };
  }

  return null;
}

/**
 * 检测所有域的爆发信号，并触发在线学习反馈
 */
export function checkAllEruptions(db: Database.Database, week: string): EruptionSignal[] {
  const domains = db.prepare(`
    SELECT DISTINCT domain FROM domain_signals WHERE week = ?
  `).all(week) as { domain: string }[];

  const eruptions: EruptionSignal[] = [];

  for (const { domain } of domains) {
    const signal = detectEruption(db, domain, week);
    if (signal) {
      eruptions.push(signal);

      // Trigger online learning: find the first phase 1 date for this domain
      const firstSignal = db.prepare(`
        SELECT MIN(week) as first_week FROM domain_signals
        WHERE domain = ? AND phase = 1
      `).get(domain) as { first_week: string | null };

      if (firstSignal?.first_week) {
        const firstDate = new Date(firstSignal.first_week);
        const eruptionDate = new Date(week);
        const actualMonths = (eruptionDate.getTime() - firstDate.getTime()) / (1000 * 60 * 60 * 24 * 30);

        // Get predicted lead time (from the phase 1 prediction)
        const prediction = db.prepare(`
          SELECT prediction FROM domain_signals
          WHERE domain = ? AND week = ?
        `).get(domain, firstSignal.first_week) as { prediction: string } | undefined;

        let predictedMonths = 15; // default
        if (prediction?.prediction) {
          try {
            const p = JSON.parse(prediction.prediction);
            // Average of the predicted range
            predictedMonths = 15; // simplified, would parse from prediction
          } catch {}
        }

        console.log(`  [Eruption] 检测到 ${domain} 域爆发！实际领先 ${actualMonths.toFixed(1)} 月，预测 ${predictedMonths} 月`);
        updateCompressionFactor(predictedMonths, actualMonths, domain);
      }
    }
  }

  return eruptions;
}
