/**
 * 爆发时间预测
 *
 * 基于当前相位 + 校准领先时间 + 压缩因子，
 * 预测域的商业爆发窗口。
 *
 * 压缩因子初始保守估计，通过在线学习自动校准。
 */

import type Database from 'better-sqlite3';
import type { Phase } from './phase-detector.js';
import type { DomainView } from './domain-aggregator.js';
import type { SSITrend } from './phase-detector.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEARNING_STATE_PATH = path.resolve(__dirname, '../../data/learning-state.json');

export interface DomainPrediction {
  domain: string;
  currentPhase: Phase;
  phaseLabel: string;
  ssi: number;
  ssiTrend: SSITrend;
  predictedEruptionRange: [string, string]; // ['2026-Q3', '2026-Q4']
  confidenceScore: number;
  keyEvidence: string[];
  gaps: string[];
  risks: string[];
}

// Base lead times per phase (months to eruption), from backtest calibration
const BASE_LEAD_TIMES: Record<Phase, [number, number]> = {
  1: [12, 18],  // Emergence: 12~18 months
  2: [8, 12],   // Consolidation: 8~12 months
  3: [3, 6],    // Tooling formation: 3~6 months
  4: [1, 3],    // Pre-eruption: 1~3 months
  5: [0, 0],    // Already erupted
};

interface LearningState {
  compressionFactor: {
    value: number;
    lastUpdated: string;
    calibrationHistory: Array<{
      domain: string;
      predicted: number;
      actual: number;
      date: string;
    }>;
    warmStarted: boolean;
    selfCalibratedCount: number;
  };
}

function loadCompressionFactor(): number {
  try {
    const raw = fs.readFileSync(LEARNING_STATE_PATH, 'utf-8');
    const state = JSON.parse(raw) as any;
    return state.compressionFactor?.value ?? state.signalDetection?.accelerationThreshold ?? 0.75;
  } catch {
    return 0.75; // default conservative
  }
}

export function updateCompressionFactor(
  predictedMonths: number,
  actualMonths: number,
  domain: string,
): void {
  try {
    const raw = fs.readFileSync(LEARNING_STATE_PATH, 'utf-8');
    const state = JSON.parse(raw);

    if (!state.compressionFactor) {
      state.compressionFactor = {
        value: 0.75,
        lastUpdated: new Date().toISOString().slice(0, 10),
        calibrationHistory: [],
        warmStarted: true,
        selfCalibratedCount: 0,
      };
    }

    const alpha = 0.3; // learning rate
    const actualRatio = actualMonths / Math.max(predictedMonths, 1);
    state.compressionFactor.value =
      alpha * actualRatio + (1 - alpha) * state.compressionFactor.value;
    state.compressionFactor.value = Math.round(state.compressionFactor.value * 1000) / 1000;
    state.compressionFactor.lastUpdated = new Date().toISOString().slice(0, 10);
    state.compressionFactor.selfCalibratedCount++;
    state.compressionFactor.calibrationHistory.push({
      domain,
      predicted: predictedMonths,
      actual: actualMonths,
      date: new Date().toISOString().slice(0, 10),
    });

    fs.writeFileSync(LEARNING_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // silently fail if state file not writable
  }
}

function monthsToQuarter(now: Date, months: number): string {
  const target = new Date(now);
  target.setMonth(target.getMonth() + months);
  const q = Math.ceil((target.getMonth() + 1) / 3);
  return `${target.getFullYear()}-Q${q}`;
}

export function predictEruption(
  domain: string,
  phase: Phase,
  phaseLabel: string,
  ssi: number,
  ssiTrend: SSITrend,
  view: DomainView,
  phaseEvidence: string[],
): DomainPrediction {
  const compressionFactor = loadCompressionFactor();
  const now = new Date();

  const [minMonths, maxMonths] = BASE_LEAD_TIMES[phase];
  const adjustedMin = Math.round(minMonths * compressionFactor * 10) / 10;
  const adjustedMax = Math.round(maxMonths * compressionFactor * 10) / 10;

  // SSI trend adjustment
  let trendAdjustment = 0;
  if (ssiTrend === 'accelerating') trendAdjustment = -1; // faster
  if (ssiTrend === 'declining') trendAdjustment = 2; // slower or maybe not happening

  const finalMin = Math.max(0, adjustedMin + trendAdjustment);
  const finalMax = Math.max(finalMin, adjustedMax + trendAdjustment);

  const rangeStart = monthsToQuarter(now, finalMin);
  const rangeEnd = monthsToQuarter(now, finalMax);

  // Confidence
  const phaseConfidence = Math.min(0.5 + view.totalProjects * 0.03 + ssi * 0.3, 0.95);
  const trendConfidence = ssiTrend === 'accelerating' ? 0.9 : ssiTrend === 'rising' ? 0.7 : ssiTrend === 'plateau' ? 0.5 : 0.3;
  const dataConfidence = Math.min(view.totalProjects / 15, 1.0);

  const confidence = Math.round((
    phaseConfidence * 0.40 +
    trendConfidence * 0.30 +
    dataConfidence * 0.30
  ) * 100) / 100;

  // Evidence
  const evidence = [...phaseEvidence];
  evidence.push(`SSI: ${ssi} (${({ accelerating: '加速上升 ↑↑', rising: '稳定上升 ↑', plateau: '平台期 →', declining: '下降 ↓' })[ssiTrend]})`);
  evidence.push(`压缩因子: ${compressionFactor}`);

  // Gaps (from feature requests and missing layers)
  const gaps: string[] = [];
  if (view.projects.tooling.length === 0 && phase <= 2) {
    gaps.push('工具层尚未出现 — 首个 SDK/框架将填补此空白');
  }
  if (view.projects.application.length === 0 && phase <= 3) {
    gaps.push('应用层尚未出现 — 面向终端用户的产品机会');
  }
  if (view.metrics.featureRequestVolume > 10) {
    gaps.push(`基础设施层有 ${view.metrics.featureRequestVolume} 个未满足需求（Feature Requests）`);
  }

  // Risks
  const risks: string[] = [];
  if (ssiTrend === 'declining') {
    risks.push('SSI 呈下降趋势，域可能是伪信号或已过热');
  }
  if (view.totalProjects < 3) {
    risks.push('域内项目过少（<3），样本不足，预测置信度低');
  }
  if (confidence < 0.5) {
    risks.push('综合置信度低于 0.5，预测仅供参考');
  }
  risks.push('大厂闭源方案可能压缩开源工具层空间');

  return {
    domain,
    currentPhase: phase,
    phaseLabel,
    ssi,
    ssiTrend,
    predictedEruptionRange: [rangeStart, rangeEnd],
    confidenceScore: confidence,
    keyEvidence: evidence,
    gaps,
    risks,
  };
}

// ─── 格式化输出 ──────────────────────────────────────────────

export function formatPredictionReport(predictions: DomainPrediction[]): string {
  const lines: string[] = [];
  lines.push('# Augur 预测报告');
  lines.push('');
  lines.push(`> 生成日期: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');

  // Sort by confidence desc
  const sorted = [...predictions].sort((a, b) => b.confidenceScore - a.confidenceScore);

  for (const p of sorted) {
    const trendIcon = { accelerating: '↑↑', rising: '↑', plateau: '→', declining: '↓' }[p.ssiTrend];
    lines.push(`## ${p.domain}`);
    lines.push('');
    lines.push(`| 指标 | 值 |`);
    lines.push(`|------|-----|`);
    lines.push(`| 当前相位 | Phase ${p.currentPhase}（${p.phaseLabel}） |`);
    lines.push(`| 信号强度 | SSI ${p.ssi} ${trendIcon} |`);
    lines.push(`| 预测爆发 | **${p.predictedEruptionRange[0]} ~ ${p.predictedEruptionRange[1]}** |`);
    lines.push(`| 置信度 | ${p.confidenceScore} |`);
    lines.push('');

    if (p.keyEvidence.length > 0) {
      lines.push('**依据：**');
      for (const e of p.keyEvidence) lines.push(`- ${e}`);
      lines.push('');
    }

    if (p.gaps.length > 0) {
      lines.push('**机会缺口：**');
      for (const g of p.gaps) lines.push(`- ${g}`);
      lines.push('');
    }

    if (p.risks.length > 0) {
      lines.push('**风险：**');
      for (const r of p.risks) lines.push(`- ${r}`);
      lines.push('');
    }

    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}
