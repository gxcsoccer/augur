/**
 * 在线学习 / 进化引擎
 *
 * 借鉴 autoresearch 的 keep/discard 循环：
 * 1. 记录每次预测（prediction ledger）
 * 2. 定期检查预测是否命中（outcome checker）
 * 3. 根据命中率自动调参（parameter updater）
 * 4. 刷新候选浪潮（candidate refresher）
 *
 * 核心数据结构：data/prediction-ledger.json
 */

import * as fs from 'node:fs';

const LEDGER_PATH = 'data/prediction-ledger.json';
const STATE_PATH = 'data/learning-state.json';

// ─── 预测记录 ───────────────────────────────────────────────────

export interface PredictionRecord {
  id: string;                      // unique ID
  createdAt: string;               // 预测生成日期
  wave: string;                    // 浪潮名称
  predictedEruption: string;       // 预测爆发日期
  confidenceLower: string;         // 68% CI 下界
  confidenceUpper: string;         // 68% CI 上界
  signalStrength: string;          // strong/moderate/weak
  signalCount: number;             // 检测到的信号数
  keySignals: string[];            // 关键信号 repo 列表
  params: Record<string, number>;  // 使用的模型参数
  // 验证结果（后填）
  status: 'pending' | 'hit' | 'miss' | 'expired';
  actualEruption?: string;         // 实际爆发日期
  errorMonths?: number;            // 预测误差
  verifiedAt?: string;             // 验证日期
}

export interface PredictionLedger {
  version: number;
  predictions: PredictionRecord[];
}

function loadLedger(): PredictionLedger {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf-8'));
    }
  } catch {}
  return { version: 1, predictions: [] };
}

function saveLedger(ledger: PredictionLedger): void {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2) + '\n', 'utf-8');
}

/**
 * 记录一条新预测（自动去重：同一浪潮每月只记录一次）
 */
export function recordPrediction(record: Omit<PredictionRecord, 'id' | 'status'>): string | null {
  const ledger = loadLedger();

  // 去重：同一浪潮在同一个月内不重复记录
  const month = record.createdAt.slice(0, 7); // YYYY-MM
  const duplicate = ledger.predictions.find(
    p => p.wave === record.wave && p.createdAt.slice(0, 7) === month && p.status === 'pending',
  );
  if (duplicate) {
    // 更新已有预测而非新增
    duplicate.predictedEruption = record.predictedEruption;
    duplicate.signalStrength = record.signalStrength;
    duplicate.signalCount = record.signalCount;
    duplicate.keySignals = record.keySignals;
    duplicate.params = record.params;
    saveLedger(ledger);
    return null; // 表示更新而非新增
  }

  const id = `pred_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  ledger.predictions.push({
    ...record,
    id,
    status: 'pending',
  });
  saveLedger(ledger);
  return id;
}

/**
 * 批量记录多条预测（从 predict-next 输出）
 */
export function recordPredictions(
  predictions: Array<{
    wave: string;
    predictedEruption: string | null;
    signalStrength: string;
    signalCount: number;
    keySignals: string[];
    confidenceLower?: string;
    confidenceUpper?: string;
  }>,
  params: Record<string, number>,
): number {
  let count = 0;
  for (const p of predictions) {
    if (!p.predictedEruption) continue;
    recordPrediction({
      createdAt: new Date().toISOString().slice(0, 10),
      wave: p.wave,
      predictedEruption: p.predictedEruption,
      confidenceLower: p.confidenceLower ?? '',
      confidenceUpper: p.confidenceUpper ?? '',
      signalStrength: p.signalStrength,
      signalCount: p.signalCount,
      keySignals: p.keySignals,
      params,
    });
    count++;
  }
  return count;
}

// ─── 结果验证 ───────────────────────────────────────────────────

/**
 * 检查一条预测是否已经可以验证
 *
 * 验证逻辑：
 * - 如果当前日期已超过预测日期 + 3 个月 → 需要验证
 * - 通过检查相关 repo 的 star 增长来判断是否爆发
 */
export function checkPendingPredictions(): PredictionRecord[] {
  const ledger = loadLedger();
  const today = new Date();
  const pendingForReview: PredictionRecord[] = [];

  for (const pred of ledger.predictions) {
    if (pred.status !== 'pending') continue;

    const predictedDate = new Date(pred.predictedEruption);
    const monthsSince = (today.getTime() - predictedDate.getTime()) / (1000 * 60 * 60 * 24 * 30);

    // 如果已超过预测日期 3 个月，标记为需要验证
    if (monthsSince >= 3) {
      pendingForReview.push(pred);
    }
  }

  return pendingForReview;
}

/**
 * 标记一条预测为命中或未命中
 */
export function verifyPrediction(
  predictionId: string,
  hit: boolean,
  actualEruption?: string,
): void {
  const ledger = loadLedger();
  const pred = ledger.predictions.find(p => p.id === predictionId);
  if (!pred) return;

  pred.status = hit ? 'hit' : 'miss';
  pred.verifiedAt = new Date().toISOString().slice(0, 10);
  if (actualEruption) {
    pred.actualEruption = actualEruption;
    const predicted = new Date(pred.predictedEruption);
    const actual = new Date(actualEruption);
    pred.errorMonths = Math.round(
      Math.abs(predicted.getTime() - actual.getTime()) / (1000 * 60 * 60 * 24 * 30) * 10
    ) / 10;
  }

  saveLedger(ledger);
}

/**
 * 过期过于古老的未验证预测（超过 18 个月）
 */
export function expireOldPredictions(): number {
  const ledger = loadLedger();
  const today = new Date();
  let expired = 0;

  for (const pred of ledger.predictions) {
    if (pred.status !== 'pending') continue;
    const created = new Date(pred.createdAt);
    const monthsSince = (today.getTime() - created.getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (monthsSince >= 18) {
      pred.status = 'expired';
      expired++;
    }
  }

  if (expired > 0) saveLedger(ledger);
  return expired;
}

// ─── 参数进化 ───────────────────────────────────────────────────

interface LearningState {
  scorerWeights: Record<string, number>;
  signalDetection: Record<string, number>;
  compressionFactor: { value: number; calibrationHistory: any[] };
  [key: string]: any;
}

function loadState(): LearningState {
  return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
}

function saveState(state: LearningState): void {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

/**
 * 根据已验证的预测自动调整模型参数
 *
 * 进化策略：
 * - 如果 hit rate < 50% → 放宽参数（降低 threshold，增加 bias）
 * - 如果 hit rate > 70% → 收紧参数（更激进的预测）
 * - 如果系统性偏早 → 增加 bias correction
 * - 如果系统性偏晚 → 减少 bias correction
 */
export function evolveParams(): {
  changed: boolean;
  hitRate: number;
  adjustments: string[];
} {
  const ledger = loadLedger();
  const verified = ledger.predictions.filter(p => p.status === 'hit' || p.status === 'miss');

  if (verified.length < 3) {
    return { changed: false, hitRate: 0, adjustments: ['需要至少 3 条已验证预测才能进化'] };
  }

  const hits = verified.filter(p => p.status === 'hit');
  const hitRate = hits.length / verified.length;
  const adjustments: string[] = [];

  const state = loadState();
  let changed = false;

  // 1. Hit rate adjustment
  if (hitRate < 0.5 && verified.length >= 5) {
    // Too many misses → widen parameters
    if (state.signalDetection.accelerationThreshold > 1.5) {
      state.signalDetection.accelerationThreshold -= 0.5;
      adjustments.push(`threshold ${state.signalDetection.accelerationThreshold + 0.5} → ${state.signalDetection.accelerationThreshold} (放宽，命中率低)`);
      changed = true;
    }
  } else if (hitRate > 0.7 && verified.length >= 5) {
    // Good hit rate → try tighter parameters
    if (state.signalDetection.accelerationThreshold < 4) {
      state.signalDetection.accelerationThreshold += 0.25;
      adjustments.push(`threshold ${state.signalDetection.accelerationThreshold - 0.25} → ${state.signalDetection.accelerationThreshold} (收紧，命中率高)`);
      changed = true;
    }
  }

  // 2. Bias correction from errors
  const errors = verified
    .filter(p => p.errorMonths !== undefined)
    .map(p => {
      const pred = new Date(p.predictedEruption).getTime();
      const actual = new Date(p.actualEruption!).getTime();
      return (actual - pred) / (1000 * 60 * 60 * 24 * 30); // positive = pred too early
    });

  if (errors.length >= 3) {
    const meanError = errors.reduce((a, b) => a + b, 0) / errors.length;
    if (Math.abs(meanError) >= 1.0) {
      const oldBias = state.signalDetection.biasCorrection ?? 0;
      // Move bias halfway toward the error
      const newBias = Math.round((oldBias + meanError * 0.5) * 10) / 10;
      state.signalDetection.biasCorrection = newBias;
      adjustments.push(`bias ${oldBias} → ${newBias} (平均偏差 ${meanError > 0 ? '+' : ''}${meanError.toFixed(1)} 月)`);
      changed = true;
    }
  }

  // 3. Compression factor from recent predictions
  const recentHits = hits.filter(p => p.errorMonths !== undefined && p.errorMonths <= 6);
  if (recentHits.length >= 2) {
    // If recent hits have small errors, the compression factor is good
    const avgError = recentHits.reduce((s, p) => s + p.errorMonths!, 0) / recentHits.length;
    if (avgError < 2) {
      adjustments.push(`compression factor ${state.compressionFactor.value} 保持不变 (近期命中精度好: ${avgError.toFixed(1)} 月)`);
    }
  }

  if (changed) {
    state.updatedAt = new Date().toISOString().slice(0, 10);
    saveState(state);
  }

  return { changed, hitRate: Math.round(hitRate * 100) / 100, adjustments };
}

// ─── 状态报告 ───────────────────────────────────────────────────

export function getLedgerStats(): {
  total: number;
  pending: number;
  hits: number;
  misses: number;
  expired: number;
  hitRate: number | null;
  avgError: number | null;
} {
  const ledger = loadLedger();
  const total = ledger.predictions.length;
  const pending = ledger.predictions.filter(p => p.status === 'pending').length;
  const hits = ledger.predictions.filter(p => p.status === 'hit').length;
  const misses = ledger.predictions.filter(p => p.status === 'miss').length;
  const expired = ledger.predictions.filter(p => p.status === 'expired').length;

  const verified = ledger.predictions.filter(p => p.status === 'hit' || p.status === 'miss');
  const hitRate = verified.length > 0 ? hits / verified.length : null;

  const errors = verified.filter(p => p.errorMonths !== undefined).map(p => p.errorMonths!);
  const avgError = errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : null;

  return { total, pending, hits, misses, expired, hitRate, avgError };
}

export function formatLedgerReport(): string {
  const ledger = loadLedger();
  const stats = getLedgerStats();
  const lines: string[] = [];

  lines.push('# 预测记录 (Prediction Ledger)');
  lines.push('');
  lines.push(`> 总预测: ${stats.total} | 待验证: ${stats.pending} | 命中: ${stats.hits} | 未命中: ${stats.misses} | 过期: ${stats.expired}`);
  if (stats.hitRate !== null) {
    lines.push(`> 命中率: ${(stats.hitRate * 100).toFixed(0)}% | 平均误差: ${stats.avgError?.toFixed(1) ?? '-'} 月`);
  }
  lines.push('');

  // Pending predictions
  const pending = ledger.predictions.filter(p => p.status === 'pending');
  if (pending.length > 0) {
    lines.push('## 待验证预测');
    lines.push('');
    lines.push('| 浪潮 | 预测爆发 | 信号强度 | 信号数 | 创建日期 |');
    lines.push('|------|---------|---------|--------|---------|');
    for (const p of pending) {
      lines.push(`| ${p.wave} | ${p.predictedEruption} | ${p.signalStrength} | ${p.signalCount} | ${p.createdAt} |`);
    }
    lines.push('');
  }

  // Verified predictions
  const verified = ledger.predictions.filter(p => p.status === 'hit' || p.status === 'miss');
  if (verified.length > 0) {
    lines.push('## 已验证预测');
    lines.push('');
    lines.push('| 浪潮 | 预测 | 实际 | 误差 | 结果 |');
    lines.push('|------|------|------|------|------|');
    for (const p of verified) {
      const result = p.status === 'hit' ? '✓ 命中' : '✗ 未命中';
      lines.push(`| ${p.wave} | ${p.predictedEruption} | ${p.actualEruption ?? '-'} | ${p.errorMonths?.toFixed(1) ?? '-'}m | ${result} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
