/**
 * SSI 计算 + 五阶段相位检测
 *
 * Signal Strength Index (SSI): 0~1 的域级复合指标
 * Phase Detection: 基于 SSI 和层级分布判断域所处阶段
 */

import type Database from 'better-sqlite3';
import type { DomainView, DomainMetrics } from './domain-aggregator.js';

export type Phase = 1 | 2 | 3 | 4 | 5;

export interface PhaseInfo {
  phase: Phase;
  label: string;
  confidence: number;  // 相位判断的置信度
  evidence: string[];
}

export const PHASE_LABELS: Record<Phase, string> = {
  1: '萌芽期',
  2: '凝聚期',
  3: '工具化期',
  4: '爆发前夜',
  5: '商业爆发',
};

// ─── SSI 计算 ────────────────────────────────────────────────

const SSI_WEIGHTS = {
  projectCount: 0.15,
  starAcceleration: 0.20,
  coOccurrenceDensity: 0.15,
  crossLayerLinkage: 0.20,
  forkStarRatio: 0.10,
  hnAttention: 0.10,
  featureRequestVolume: 0.10,
};

// Normalization caps
const NORM = {
  maxProjects: 20,
  maxStarAccel: 10000,
  maxForkStarRatio: 0.3,
  maxHnPosts: 20,
  maxFeatureRequests: 50,
};

export function computeSSI(view: DomainView): number {
  const m = view.metrics;

  const scores = {
    projectCount: Math.min(view.totalProjects / NORM.maxProjects, 1.0),
    starAcceleration: Math.min(Math.max(m.totalStarAcceleration, 0) / NORM.maxStarAccel, 1.0),
    coOccurrenceDensity: Math.min(m.coOccurrenceDensity, 1.0),
    crossLayerLinkage: Math.min(m.crossLayerLinkage, 1.0),
    forkStarRatio: Math.min(m.avgForkStarRatio / NORM.maxForkStarRatio, 1.0),
    hnAttention: Math.min(m.hnAttention / NORM.maxHnPosts, 1.0),
    featureRequestVolume: Math.min(m.featureRequestVolume / NORM.maxFeatureRequests, 1.0),
  };

  return Math.round((
    scores.projectCount * SSI_WEIGHTS.projectCount +
    scores.starAcceleration * SSI_WEIGHTS.starAcceleration +
    scores.coOccurrenceDensity * SSI_WEIGHTS.coOccurrenceDensity +
    scores.crossLayerLinkage * SSI_WEIGHTS.crossLayerLinkage +
    scores.forkStarRatio * SSI_WEIGHTS.forkStarRatio +
    scores.hnAttention * SSI_WEIGHTS.hnAttention +
    scores.featureRequestVolume * SSI_WEIGHTS.featureRequestVolume
  ) * 100) / 100;
}

// ─── 相位检测 ────────────────────────────────────────────────

export function detectPhase(view: DomainView): PhaseInfo {
  const infra = view.projects.infrastructure.length;
  const tooling = view.projects.tooling.length;
  const app = view.projects.application.length;
  const total = view.totalProjects;
  const m = view.metrics;

  const evidence: string[] = [];

  // Phase 5: Commercial eruption (needs external signal or manual annotation)
  // We can't detect this automatically yet — see eruption-detector.ts

  // Phase 4: Pre-eruption — application projects emerging, HN attention
  if (app >= 2 && m.hnAttention >= 5 && tooling >= 2) {
    evidence.push(`应用层项目 ${app} 个`);
    evidence.push(`HN 关注度 ${m.hnAttention} 帖/周`);
    evidence.push(`工具层项目 ${tooling} 个`);
    return { phase: 4, label: PHASE_LABELS[4], confidence: computePhaseConfidence(4, view), evidence };
  }

  // Phase 3: Tooling formation — tooling/infra ratio >= 0.5
  if (tooling >= 2 && infra >= 1 && tooling / Math.max(infra, 1) >= 0.5) {
    evidence.push(`工具层/基础设施比 ${(tooling / Math.max(infra, 1)).toFixed(1)}`);
    evidence.push(`工具层项目 ${tooling} 个`);
    if (m.coOccurrenceDensity > 0.2) evidence.push(`共现密度 ${m.coOccurrenceDensity.toFixed(2)}`);
    return { phase: 3, label: PHASE_LABELS[3], confidence: computePhaseConfidence(3, view), evidence };
  }

  // Phase 2: Consolidation — 3+ projects, co-occurrence forming
  if (total >= 3 && (m.coOccurrenceDensity > 0.1 || m.avgForkStarRatio > 0.15)) {
    evidence.push(`域内项目 ${total} 个`);
    if (m.coOccurrenceDensity > 0.1) evidence.push(`共现密度 ${m.coOccurrenceDensity.toFixed(2)}`);
    if (m.avgForkStarRatio > 0.15) evidence.push(`平均 Fork/Star 比 ${m.avgForkStarRatio.toFixed(2)}`);
    return { phase: 2, label: PHASE_LABELS[2], confidence: computePhaseConfidence(2, view), evidence };
  }

  // Phase 1: Emergence — at least 1 infra project with growth
  if (infra >= 1) {
    evidence.push(`基础设施项目 ${infra} 个`);
    if (m.totalStarAcceleration > 0) evidence.push(`Star 加速 +${m.totalStarAcceleration}`);
    return { phase: 1, label: PHASE_LABELS[1], confidence: computePhaseConfidence(1, view), evidence };
  }

  // Default: Phase 1 with low confidence
  evidence.push(`域内项目 ${total} 个，尚无基础设施层项目`);
  return { phase: 1, label: PHASE_LABELS[1], confidence: 0.2, evidence };
}

function computePhaseConfidence(phase: Phase, view: DomainView): number {
  let confidence = 0.5; // base

  // More projects = more confidence
  confidence += Math.min(view.totalProjects / 20, 0.2);

  // SSI strength adds confidence
  const ssi = computeSSI(view);
  confidence += ssi * 0.2;

  // Multi-layer presence adds confidence
  const layerCount = [
    view.projects.infrastructure.length > 0 ? 1 : 0,
    view.projects.tooling.length > 0 ? 1 : 0,
    view.projects.application.length > 0 ? 1 : 0,
  ].reduce((a, b) => a + b, 0);
  confidence += layerCount * 0.05;

  return Math.min(Math.round(confidence * 100) / 100, 1.0);
}

// ─── SSI 趋势分析 ───────────────────────────────────────────

export type SSITrend = 'accelerating' | 'rising' | 'plateau' | 'declining';

export function analyzeSSITrend(db: Database.Database, domain: string, currentWeek: string): {
  trend: SSITrend;
  recentSSI: { week: string; ssi: number }[];
} {
  const rows = db.prepare(`
    SELECT week, ssi FROM domain_signals
    WHERE domain = ? AND week <= ?
    ORDER BY week DESC LIMIT 8
  `).all(domain, currentWeek) as { week: string; ssi: number }[];

  const recent = rows.reverse(); // chronological order

  if (recent.length < 2) {
    return { trend: 'plateau', recentSSI: recent };
  }

  const deltas = [];
  for (let i = 1; i < recent.length; i++) {
    deltas.push(recent[i].ssi - recent[i - 1].ssi);
  }

  const allPositive = deltas.every(d => d > 0);
  const allNegative = deltas.every(d => d < 0);
  const deltasIncreasing = deltas.length >= 3 &&
    deltas.slice(-3).every((d, i, arr) => i === 0 || d > arr[i - 1]);

  if (deltasIncreasing && allPositive) return { trend: 'accelerating', recentSSI: recent };
  if (allPositive) return { trend: 'rising', recentSSI: recent };
  if (allNegative) return { trend: 'declining', recentSSI: recent };
  return { trend: 'plateau', recentSSI: recent };
}

// ─── 持久化 ─────────────────────────────────────────────────

export function saveDomainSignal(
  db: Database.Database,
  domain: string,
  week: string,
  view: DomainView,
  phase: PhaseInfo,
  ssi: number,
  prediction?: object,
): void {
  db.prepare(`
    INSERT INTO domain_signals (domain, week, phase, ssi, project_count, infra_count, tooling_count, app_count, metrics, prediction)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain, week) DO UPDATE SET
      phase = excluded.phase, ssi = excluded.ssi,
      project_count = excluded.project_count,
      infra_count = excluded.infra_count,
      tooling_count = excluded.tooling_count,
      app_count = excluded.app_count,
      metrics = excluded.metrics,
      prediction = excluded.prediction
  `).run(
    domain, week, phase.phase, ssi,
    view.totalProjects,
    view.projects.infrastructure.length,
    view.projects.tooling.length,
    view.projects.application.length,
    JSON.stringify(view.metrics),
    prediction ? JSON.stringify(prediction) : null,
  );
}
