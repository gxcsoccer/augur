/**
 * 参数校准器
 *
 * 用历史回测数据（训练集）优化模型参数，
 * 然后在新案例（测试集）上验证预测能力。
 *
 * 训练集: ChatGPT, Cursor, Manus
 * 测试集: OpenClaw / 专业 Agent
 */

import {
  fetchWeeklyMetrics,
  type BacktestTarget,
  BACKTEST_TARGETS,
} from './backtest.js';

// ─── 可调参数空间 ───────────────────────────────────────────────

export interface ModelParams {
  accelerationThreshold: number;   // 变点检测倍数阈值
  windowSize: number;              // 滑动窗口大小（周）
  minBaseline: number;             // 最低基线值
  layerWeight: number;             // 层级权重
  growthWeight: number;            // 增长权重
  usageWeight: number;             // 使用率权重
  activityWeight: number;          // 活跃度权重
  signalBonusWeight: number;       // 强信号权重
  compressionFactor: number;       // 领先时间压缩因子
}

const DEFAULT_PARAMS: ModelParams = {
  accelerationThreshold: 2.0,
  windowSize: 4,
  minBaseline: 3,
  layerWeight: 0.25,
  growthWeight: 0.25,
  usageWeight: 0.20,
  activityWeight: 0.15,
  signalBonusWeight: 0.15,
  compressionFactor: 0.75,
};

// ─── 参数搜索网格 ───────────────────────────────────────────────

const PARAM_GRID = {
  accelerationThreshold: [1.5, 2.0, 2.5, 3.0],
  windowSize: [3, 4, 5, 6],
  minBaseline: [2, 3, 5],
  compressionFactor: [0.6, 0.7, 0.75, 0.8, 0.85],
};

// ─── 训练：从历史数据中提取 ground truth ─────────────────────────

interface GroundTruth {
  target: BacktestTarget;
  eruptionDate: string;
  actualInfraLeadMonths: number[];
  actualToolingLeadMonths: number[];
}

interface SignalDetectionResult {
  repo: string;
  layer: 'infrastructure' | 'tooling' | 'application';
  signalDate: string | null;
  leadMonths: number | null;
}

/**
 * 用给定参数在历史数据上检测信号
 */
async function detectWithParams(
  repo: string,
  layer: 'infrastructure' | 'tooling' | 'application',
  eruptionDate: string,
  params: ModelParams,
  lookbackMonths: number = 24,
): Promise<SignalDetectionResult> {
  const fromDate = new Date(eruptionDate);
  fromDate.setMonth(fromDate.getMonth() - lookbackMonths);
  const from = fromDate.toISOString().slice(0, 10);

  try {
    const history = await fetchWeeklyMetrics(repo, from, eruptionDate);
    if (history.length < params.windowSize + 2) {
      return { repo, layer, signalDate: null, leadMonths: null };
    }

    const factors: (keyof typeof history[0])[] = ['new_stars', 'new_forks', 'new_issues', 'new_prs'];

    // Find first signal using the given params
    for (let i = params.windowSize; i < history.length; i++) {
      for (const key of factors) {
        const window = history.slice(i - params.windowSize, i);
        const baseline = window.reduce((sum, w) => sum + (w[key] as number), 0) / params.windowSize;
        if (baseline < params.minBaseline) continue;

        const current = history[i][key] as number;
        if (current / baseline >= params.accelerationThreshold) {
          const signalDate = history[i].week;
          const d1 = new Date(signalDate);
          const d2 = new Date(eruptionDate);
          const leadMonths = (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24 * 30);
          return { repo, layer, signalDate, leadMonths: Math.round(leadMonths * 10) / 10 };
        }
      }
    }

    return { repo, layer, signalDate: null, leadMonths: null };
  } catch {
    return { repo, layer, signalDate: null, leadMonths: null };
  }
}

// ─── 评分函数 ───────────────────────────────────────────────────

interface CalibrationScore {
  params: ModelParams;
  signalDetectionRate: number;     // 检出率：检测到信号的 repo 占比
  infraBeforeTooling: number;      // 层序正确率：infra 信号早于 tooling 的比例
  leadTimeMAE: number;             // 领先时间平均绝对误差（月）
  totalScore: number;              // 综合评分
}

function scoreParams(
  results: Map<string, SignalDetectionResult[]>,
  targets: BacktestTarget[],
): CalibrationScore['totalScore'] {
  let totalDetected = 0;
  let totalRepos = 0;
  let orderCorrect = 0;
  let orderTotal = 0;
  let leadErrors: number[] = [];

  for (const target of targets) {
    const targetResults = results.get(target.name);
    if (!targetResults) continue;

    // 1. Signal detection rate
    totalRepos += targetResults.length;
    totalDetected += targetResults.filter(r => r.signalDate !== null).length;

    // 2. Layer ordering: infra signals should come before tooling
    const infraDates = targetResults.filter(r => r.layer === 'infrastructure' && r.signalDate).map(r => r.signalDate!);
    const toolingDates = targetResults.filter(r => r.layer === 'tooling' && r.signalDate).map(r => r.signalDate!);

    if (infraDates.length > 0 && toolingDates.length > 0) {
      const earliestInfra = infraDates.sort()[0];
      const earliestTooling = toolingDates.sort()[0];
      orderTotal++;
      if (earliestInfra <= earliestTooling) orderCorrect++;
    }

    // 3. Lead time accuracy: 基础设施应该在 3~18 个月范围内
    for (const r of targetResults) {
      if (r.leadMonths !== null && r.layer === 'infrastructure') {
        // Ideal range: 3~18 months
        if (r.leadMonths >= 3 && r.leadMonths <= 18) {
          leadErrors.push(0); // in range = no error
        } else if (r.leadMonths < 3) {
          leadErrors.push(3 - r.leadMonths); // too late
        } else {
          leadErrors.push(r.leadMonths - 18); // too early
        }
      }
    }
  }

  const detectionRate = totalRepos > 0 ? totalDetected / totalRepos : 0;
  const orderRate = orderTotal > 0 ? orderCorrect / orderTotal : 0.5;
  const mae = leadErrors.length > 0 ? leadErrors.reduce((a, b) => a + b, 0) / leadErrors.length : 10;
  const maeScore = Math.max(0, 1 - mae / 10); // normalize: 0 error = 1.0, 10+ months error = 0

  // Weighted total: detection 40%, order 30%, lead time 30%
  return detectionRate * 0.4 + orderRate * 0.3 + maeScore * 0.3;
}

// ─── 校准主流程 ─────────────────────────────────────────────────

export interface CalibrationResult {
  bestParams: ModelParams;
  bestScore: number;
  searchResults: { params: Partial<ModelParams>; score: number }[];
  trainingResults: Map<string, SignalDetectionResult[]>;
}

/**
 * 在训练集上做网格搜索，找到最优参数
 */
export async function calibrate(
  trainingTargets?: BacktestTarget[],
): Promise<CalibrationResult> {
  const targets = trainingTargets ?? BACKTEST_TARGETS;

  console.log(`[Calibrate] 训练集: ${targets.map(t => t.name).join(', ')}`);

  // 先用所有参数组合跑一遍 — 但因为 ClickHouse 查询慢，
  // 我们先缓存所有 repo 的原始数据，然后在本地做参数搜索
  console.log('[Calibrate] 预加载历史数据...');
  const dataCache = new Map<string, Awaited<ReturnType<typeof fetchWeeklyMetrics>>>();

  for (const target of targets) {
    const allRepos = [...target.infrastructureRepos, ...target.toolingRepos, ...target.applicationRepos];
    for (const repo of allRepos) {
      const cacheKey = `${repo}::${target.eruptionDate}`;
      if (dataCache.has(cacheKey)) continue;

      const fromDate = new Date(target.eruptionDate);
      fromDate.setMonth(fromDate.getMonth() - 24);
      const from = fromDate.toISOString().slice(0, 10);

      console.log(`  加载 ${repo}...`);
      try {
        const data = await fetchWeeklyMetrics(repo, from, target.eruptionDate);
        dataCache.set(cacheKey, data);
      } catch {
        dataCache.set(cacheKey, []);
      }
    }
  }

  console.log(`[Calibrate] 已缓存 ${dataCache.size} 个数据集，开始网格搜索...`);

  // 本地快速信号检测（使用缓存数据）
  function detectLocal(
    repo: string, layer: 'infrastructure' | 'tooling' | 'application',
    eruptionDate: string, params: ModelParams,
  ): SignalDetectionResult {
    const cacheKey = `${repo}::${eruptionDate}`;
    const history = dataCache.get(cacheKey) ?? [];
    if (history.length < params.windowSize + 2) {
      return { repo, layer, signalDate: null, leadMonths: null };
    }

    const factors: (keyof typeof history[0])[] = ['new_stars', 'new_forks', 'new_issues', 'new_prs'];

    for (let i = params.windowSize; i < history.length; i++) {
      for (const key of factors) {
        const window = history.slice(i - params.windowSize, i);
        const baseline = window.reduce((sum, w) => sum + (w[key] as number), 0) / params.windowSize;
        if (baseline < params.minBaseline) continue;

        const current = history[i][key] as number;
        if (current / baseline >= params.accelerationThreshold) {
          const signalDate = history[i].week;
          const d1 = new Date(signalDate);
          const d2 = new Date(eruptionDate);
          const leadMonths = (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24 * 30);
          return { repo, layer, signalDate, leadMonths: Math.round(leadMonths * 10) / 10 };
        }
      }
    }

    return { repo, layer, signalDate: null, leadMonths: null };
  }

  // Grid search
  let bestScore = -1;
  let bestParams = { ...DEFAULT_PARAMS };
  const searchResults: { params: Partial<ModelParams>; score: number }[] = [];

  for (const at of PARAM_GRID.accelerationThreshold) {
    for (const ws of PARAM_GRID.windowSize) {
      for (const mb of PARAM_GRID.minBaseline) {
        for (const cf of PARAM_GRID.compressionFactor) {
          const params: ModelParams = {
            ...DEFAULT_PARAMS,
            accelerationThreshold: at,
            windowSize: ws,
            minBaseline: mb,
            compressionFactor: cf,
          };

          const results = new Map<string, SignalDetectionResult[]>();
          for (const target of targets) {
            const targetResults: SignalDetectionResult[] = [];
            for (const repo of target.infrastructureRepos) {
              targetResults.push(detectLocal(repo, 'infrastructure', target.eruptionDate, params));
            }
            for (const repo of target.toolingRepos) {
              targetResults.push(detectLocal(repo, 'tooling', target.eruptionDate, params));
            }
            for (const repo of target.applicationRepos) {
              targetResults.push(detectLocal(repo, 'application', target.eruptionDate, params));
            }
            results.set(target.name, targetResults);
          }

          const score = scoreParams(results, targets);
          searchResults.push({
            params: { accelerationThreshold: at, windowSize: ws, minBaseline: mb, compressionFactor: cf },
            score,
          });

          if (score > bestScore) {
            bestScore = score;
            bestParams = { ...params };
          }
        }
      }
    }
  }

  searchResults.sort((a, b) => b.score - a.score);

  // Get detailed results with best params
  const bestResults = new Map<string, SignalDetectionResult[]>();
  for (const target of targets) {
    const targetResults: SignalDetectionResult[] = [];
    for (const repo of target.infrastructureRepos) {
      targetResults.push(detectLocal(repo, 'infrastructure', target.eruptionDate, bestParams));
    }
    for (const repo of target.toolingRepos) {
      targetResults.push(detectLocal(repo, 'tooling', target.eruptionDate, bestParams));
    }
    for (const repo of target.applicationRepos) {
      targetResults.push(detectLocal(repo, 'application', target.eruptionDate, bestParams));
    }
    bestResults.set(target.name, targetResults);
  }

  console.log(`[Calibrate] 搜索完成，共 ${searchResults.length} 个组合`);
  console.log(`[Calibrate] 最优评分: ${bestScore.toFixed(3)}`);
  console.log(`[Calibrate] 最优参数: threshold=${bestParams.accelerationThreshold}, window=${bestParams.windowSize}, minBaseline=${bestParams.minBaseline}, compression=${bestParams.compressionFactor}`);

  return {
    bestParams,
    bestScore,
    searchResults,
    trainingResults: bestResults,
  };
}

// ─── 验证：在新案例上预测 ───────────────────────────────────────

export interface ValidationResult {
  target: BacktestTarget;
  params: ModelParams;
  detectedSignals: SignalDetectionResult[];
  predictedEruptionDate: string | null;
  predictedLeadMonths: number | null;
  actualEruptionDate: string;
  predictionError: number | null;  // months
}

/**
 * 用校准后的参数在测试集上做预测
 *
 * cutoffDate: 假设我们"站在这个时间点"做预测，只用 cutoff 之前的数据
 */
export async function validate(
  validationTarget: BacktestTarget,
  params: ModelParams,
  cutoffDate?: string,
): Promise<ValidationResult> {
  const cutoff = cutoffDate ?? new Date().toISOString().slice(0, 10);

  console.log(`[Validate] 测试集: ${validationTarget.name}`);
  console.log(`[Validate] 预测视角: 站在 ${cutoff} 看`);
  console.log(`[Validate] 使用参数: threshold=${params.accelerationThreshold}, window=${params.windowSize}, compression=${params.compressionFactor}`);

  const allRepos = [
    ...validationTarget.infrastructureRepos.map(r => ({ repo: r, layer: 'infrastructure' as const })),
    ...validationTarget.toolingRepos.map(r => ({ repo: r, layer: 'tooling' as const })),
    ...validationTarget.applicationRepos.map(r => ({ repo: r, layer: 'application' as const })),
  ];

  const signals: SignalDetectionResult[] = [];

  // 关键改进：只看 cutoff 前 12 个月内的信号，过滤旧周期噪声
  const recencyWindow = 12; // months
  const recencyCutoff = new Date(cutoff);
  recencyCutoff.setMonth(recencyCutoff.getMonth() - recencyWindow);
  const recencyCutoffStr = recencyCutoff.toISOString().slice(0, 10);

  for (const { repo, layer } of allRepos) {
    console.log(`  检测 [${layer}] ${repo}...`);
    const result = await detectWithParams(repo, layer, cutoff, params);

    // 过滤：信号必须在 recency window 内
    if (result.signalDate && result.signalDate < recencyCutoffStr) {
      console.log(`    → 信号 ${result.signalDate} (太早，属于上一轮周期，已过滤)`);
      signals.push({ ...result, signalDate: null, leadMonths: null });
    } else {
      signals.push(result);
      if (result.signalDate) {
        console.log(`    → 信号 ${result.signalDate} (距cutoff ${result.leadMonths?.toFixed(1)} 月)`);
      } else {
        console.log(`    → 无信号`);
      }
    }
  }

  // Predict eruption date
  const recentInfra = signals.filter(s => s.layer === 'infrastructure' && s.signalDate !== null);
  const recentTooling = signals.filter(s => s.layer === 'tooling' && s.signalDate !== null);

  let predictedEruptionDate: string | null = null;
  let predictedLeadMonths: number | null = null;

  // 预测策略：
  // 1. 如果有基础设施信号 → 用最近的基础设施信号 + 压缩后的领先时间
  // 2. 如果只有工具层信号 → 用工具层信号 + 更短的领先时间
  // 3. 如果无信号 → 无法预测

  // 历史基础设施领先时间: ChatGPT ~17m, Cursor ~12m, Manus ~5m
  // 压缩趋势: 17 → 12 → 5，每轮 ×compression
  // 下一轮预期: 5 × compression = 3~4 个月
  const expectedInfraLead = 5 * params.compressionFactor;
  // 工具层历史: ~19m, ~2.4m, ~1.8m → 下一轮 ~1 个月
  const expectedToolingLead = 1.8 * params.compressionFactor;

  if (recentInfra.length > 0) {
    // 用最近的基础设施信号（而非最早的）
    const latestInfra = recentInfra.sort((a, b) => b.signalDate!.localeCompare(a.signalDate!))[0];
    const signalDate = new Date(latestInfra.signalDate!);
    const eruptionDate = new Date(signalDate);
    eruptionDate.setMonth(eruptionDate.getMonth() + Math.round(expectedInfraLead));

    predictedEruptionDate = eruptionDate.toISOString().slice(0, 10);
    const cutoffD = new Date(cutoff);
    predictedLeadMonths = (eruptionDate.getTime() - cutoffD.getTime()) / (1000 * 60 * 60 * 24 * 30);
    predictedLeadMonths = Math.round(predictedLeadMonths * 10) / 10;
  } else if (recentTooling.length > 0) {
    // 退而用工具层信号
    const latestTooling = recentTooling.sort((a, b) => b.signalDate!.localeCompare(a.signalDate!))[0];
    const signalDate = new Date(latestTooling.signalDate!);
    const eruptionDate = new Date(signalDate);
    eruptionDate.setMonth(eruptionDate.getMonth() + Math.round(expectedToolingLead));

    predictedEruptionDate = eruptionDate.toISOString().slice(0, 10);
    const cutoffD = new Date(cutoff);
    predictedLeadMonths = (eruptionDate.getTime() - cutoffD.getTime()) / (1000 * 60 * 60 * 24 * 30);
    predictedLeadMonths = Math.round(predictedLeadMonths * 10) / 10;
  }

  const actualD = new Date(validationTarget.eruptionDate);
  const predError = predictedEruptionDate
    ? Math.abs(new Date(predictedEruptionDate).getTime() - actualD.getTime()) / (1000 * 60 * 60 * 24 * 30)
    : null;

  return {
    target: validationTarget,
    params,
    detectedSignals: signals,
    predictedEruptionDate,
    predictedLeadMonths,
    actualEruptionDate: validationTarget.eruptionDate,
    predictionError: predError ? Math.round(predError * 10) / 10 : null,
  };
}

// ─── 报告格式化 ─────────────────────────────────────────────────

export function formatCalibrationReport(
  cal: CalibrationResult,
  val?: ValidationResult,
): string {
  const lines: string[] = [];
  lines.push('# Augur 模型校准与验证报告');
  lines.push('');
  lines.push(`> 生成日期: ${new Date().toISOString().slice(0, 10)}`);
  lines.push('');

  // Training results
  lines.push('## 训练阶段');
  lines.push('');
  lines.push(`搜索空间: ${cal.searchResults.length} 个参数组合`);
  lines.push('');
  lines.push('### 最优参数');
  lines.push('');
  lines.push('| 参数 | 值 | 说明 |');
  lines.push('|------|-----|------|');
  lines.push(`| accelerationThreshold | ${cal.bestParams.accelerationThreshold} | 变点检测倍数 |`);
  lines.push(`| windowSize | ${cal.bestParams.windowSize} | 滑动窗口（周） |`);
  lines.push(`| minBaseline | ${cal.bestParams.minBaseline} | 最低基线 |`);
  lines.push(`| compressionFactor | ${cal.bestParams.compressionFactor} | 压缩因子 |`);
  lines.push('');
  lines.push(`**综合评分: ${cal.bestScore.toFixed(3)}**`);
  lines.push('');

  // Top 5 parameter combinations
  lines.push('### Top 5 参数组合');
  lines.push('');
  lines.push('| 排名 | threshold | window | baseline | compression | 评分 |');
  lines.push('|------|-----------|--------|----------|-------------|------|');
  for (const [i, r] of cal.searchResults.slice(0, 5).entries()) {
    const p = r.params as any;
    lines.push(`| ${i + 1} | ${p.accelerationThreshold} | ${p.windowSize} | ${p.minBaseline} | ${p.compressionFactor} | ${r.score.toFixed(3)} |`);
  }
  lines.push('');

  // Training set detail
  lines.push('### 训练集信号检测详情');
  lines.push('');

  for (const [targetName, results] of cal.trainingResults) {
    lines.push(`#### ${targetName}`);
    lines.push('');
    lines.push('| 层级 | 仓库 | 信号日期 | 领先月数 |');
    lines.push('|------|------|---------|---------|');
    for (const r of results) {
      const layerLabel = { infrastructure: '基础设施', tooling: '工具', application: '应用' }[r.layer];
      lines.push(`| ${layerLabel} | ${r.repo} | ${r.signalDate ?? '-'} | ${r.leadMonths?.toFixed(1) ?? '-'} |`);
    }
    lines.push('');
  }

  // Validation results
  if (val) {
    lines.push('---');
    lines.push('');
    lines.push('## 验证阶段');
    lines.push('');
    lines.push(`**测试集: ${val.target.name}**`);
    lines.push(`**实际爆发日期: ${val.actualEruptionDate}**`);
    lines.push('');

    lines.push('### 检测到的信号');
    lines.push('');
    lines.push('| 层级 | 仓库 | 信号日期 | 领先月数 |');
    lines.push('|------|------|---------|---------|');
    for (const r of val.detectedSignals) {
      const layerLabel = { infrastructure: '基础设施', tooling: '工具', application: '应用' }[r.layer];
      lines.push(`| ${layerLabel} | ${r.repo} | ${r.signalDate ?? '-'} | ${r.leadMonths?.toFixed(1) ?? '-'} |`);
    }
    lines.push('');

    lines.push('### 预测结果');
    lines.push('');
    if (val.predictedEruptionDate) {
      lines.push(`| 指标 | 值 |`);
      lines.push(`|------|-----|`);
      lines.push(`| 预测爆发日期 | **${val.predictedEruptionDate}** |`);
      lines.push(`| 实际爆发日期 | ${val.actualEruptionDate} |`);
      lines.push(`| 预测误差 | ${val.predictionError?.toFixed(1)} 个月 |`);
      lines.push(`| 站在预测时的剩余时间 | ${val.predictedLeadMonths?.toFixed(1)} 个月 |`);
    } else {
      lines.push('**未检测到足够信号，无法做出预测。**');
    }
    lines.push('');

    // Verdict
    lines.push('### 结论');
    lines.push('');
    if (val.predictionError !== null && val.predictionError <= 3) {
      lines.push(`模型预测误差 ${val.predictionError.toFixed(1)} 个月，**预测有效**。`);
    } else if (val.predictionError !== null && val.predictionError <= 6) {
      lines.push(`模型预测误差 ${val.predictionError.toFixed(1)} 个月，**方向正确但精度有待提升**。`);
    } else if (val.predictionError !== null) {
      lines.push(`模型预测误差 ${val.predictionError.toFixed(1)} 个月，**精度不足**，需要更多训练数据或更多特征。`);
    } else {
      lines.push('模型未能产生有效预测，可能原因：测试集项目的 GitHub 信号不够显著。');
    }
  }

  return lines.join('\n');
}
