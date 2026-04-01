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

    const factors: (keyof typeof history[0])[] = ['new_stars', 'new_forks', 'new_issues', 'new_prs', 'unique_pushers', 'new_releases'];

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

    const factors: (keyof typeof history[0])[] = ['new_stars', 'new_forks', 'new_issues', 'new_prs', 'unique_pushers', 'new_releases'];

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

// ─── Leave-one-out 交叉验证 ─────────────────────────────────────

export interface LOOResult {
  heldOut: string;            // 被留出的案例名
  trainScore: number;         // 训练集评分
  bestParams: ModelParams;
  // 用训练得到的参数在留出案例上的预测
  infraLeadPredicted: number | null;
  infraLeadActual: number | null;
  error: number | null;
}

/**
 * Leave-one-out 交叉验证
 * 每次留出 1 个案例做测试，其余做训练，轮转所有案例
 */
export async function crossValidate(
  targets?: BacktestTarget[],
): Promise<LOOResult[]> {
  const allTargets = targets ?? BACKTEST_TARGETS;
  const results: LOOResult[] = [];

  // 先预加载所有数据
  console.log('[LOO] 预加载所有数据...');
  const dataCache = new Map<string, Awaited<ReturnType<typeof fetchWeeklyMetrics>>>();

  for (const target of allTargets) {
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

  console.log(`[LOO] 已缓存 ${dataCache.size} 个数据集\n`);

  // 本地检测函数
  function detectLocal(
    repo: string, layer: 'infrastructure' | 'tooling' | 'application',
    eruptionDate: string, params: ModelParams,
  ): SignalDetectionResult {
    const cacheKey = `${repo}::${eruptionDate}`;
    const history = dataCache.get(cacheKey) ?? [];
    if (history.length < params.windowSize + 2) {
      return { repo, layer, signalDate: null, leadMonths: null };
    }
    const factors: (keyof typeof history[0])[] = ['new_stars', 'new_forks', 'new_issues', 'new_prs', 'unique_pushers', 'new_releases'];
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

  function scoreOnTargets(params: ModelParams, targets: BacktestTarget[]): number {
    let totalDetected = 0, totalRepos = 0, orderCorrect = 0, orderTotal = 0;
    const leadErrors: number[] = [];
    for (const target of targets) {
      const allRepos = [
        ...target.infrastructureRepos.map(r => ({ repo: r, layer: 'infrastructure' as const })),
        ...target.toolingRepos.map(r => ({ repo: r, layer: 'tooling' as const })),
        ...target.applicationRepos.map(r => ({ repo: r, layer: 'application' as const })),
      ];
      const results = allRepos.map(({ repo, layer }) => detectLocal(repo, layer, target.eruptionDate, params));
      totalRepos += results.length;
      totalDetected += results.filter(r => r.signalDate !== null).length;
      const infraDates = results.filter(r => r.layer === 'infrastructure' && r.signalDate).map(r => r.signalDate!);
      const toolingDates = results.filter(r => r.layer === 'tooling' && r.signalDate).map(r => r.signalDate!);
      if (infraDates.length > 0 && toolingDates.length > 0) {
        orderTotal++;
        if (infraDates.sort()[0] <= toolingDates.sort()[0]) orderCorrect++;
      }
      for (const r of results) {
        if (r.leadMonths !== null && r.layer === 'infrastructure') {
          if (r.leadMonths >= 3 && r.leadMonths <= 18) leadErrors.push(0);
          else if (r.leadMonths < 3) leadErrors.push(3 - r.leadMonths);
          else leadErrors.push(r.leadMonths - 18);
        }
      }
    }
    const detectionRate = totalRepos > 0 ? totalDetected / totalRepos : 0;
    const orderRate = orderTotal > 0 ? orderCorrect / orderTotal : 0.5;
    const mae = leadErrors.length > 0 ? leadErrors.reduce((a, b) => a + b, 0) / leadErrors.length : 10;
    const maeScore = Math.max(0, 1 - mae / 10);
    return detectionRate * 0.4 + orderRate * 0.3 + maeScore * 0.3;
  }

  for (let i = 0; i < allTargets.length; i++) {
    const heldOut = allTargets[i];
    const trainSet = allTargets.filter((_, j) => j !== i);

    console.log(`[LOO] Fold ${i + 1}/${allTargets.length}: 留出 "${heldOut.name}"，训练 ${trainSet.length} 个`);

    // Grid search on training set
    let bestScore = -1;
    let bestParams = { ...DEFAULT_PARAMS };
    for (const at of PARAM_GRID.accelerationThreshold) {
      for (const ws of PARAM_GRID.windowSize) {
        for (const mb of PARAM_GRID.minBaseline) {
          for (const cf of PARAM_GRID.compressionFactor) {
            const params: ModelParams = { ...DEFAULT_PARAMS, accelerationThreshold: at, windowSize: ws, minBaseline: mb, compressionFactor: cf };
            const score = scoreOnTargets(params, trainSet);
            if (score > bestScore) { bestScore = score; bestParams = { ...params }; }
          }
        }
      }
    }

    // Evaluate on held-out case
    const heldOutResults = [
      ...heldOut.infrastructureRepos.map(r => detectLocal(r, 'infrastructure', heldOut.eruptionDate, bestParams)),
      ...heldOut.toolingRepos.map(r => detectLocal(r, 'tooling', heldOut.eruptionDate, bestParams)),
      ...heldOut.applicationRepos.map(r => detectLocal(r, 'application', heldOut.eruptionDate, bestParams)),
    ];

    const infraResults = heldOutResults.filter(r => r.layer === 'infrastructure' && r.leadMonths !== null);
    // 用 trimmed mean：去掉最高最低后取均值（比纯均值鲁棒，比中位数稳定）
    const infraLeads = infraResults.map(r => r.leadMonths!).sort((a, b) => a - b);
    let infraLeadActual: number | null = null;
    if (infraLeads.length >= 3) {
      const trimmed = infraLeads.slice(1, -1); // remove min and max
      infraLeadActual = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
    } else if (infraLeads.length > 0) {
      infraLeadActual = infraLeads.reduce((a, b) => a + b, 0) / infraLeads.length;
    }

    // 从训练集中学到的领先时间做回归预测
    const trainLeads: { date: number; lead: number }[] = [];
    for (const t of trainSet) {
      const tResults = t.infrastructureRepos.map(r => detectLocal(r, 'infrastructure', t.eruptionDate, bestParams));
      const validLeads = tResults.filter(r => r.leadMonths !== null).map(r => r.leadMonths!).sort((a, b) => a - b);
      if (validLeads.length > 0) {
        // trimmed mean: remove outliers
        let lead: number;
        if (validLeads.length >= 3) {
          const trimmed = validLeads.slice(1, -1);
          lead = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;
        } else {
          lead = validLeads.reduce((a, b) => a + b, 0) / validLeads.length;
        }
        trainLeads.push({ date: new Date(t.eruptionDate).getTime(), lead });
      }
    }

    // 三模型集成预测：线性回归 + 指数衰减 + 加权最近邻
    let infraLeadPredicted: number | null = null;
    if (trainLeads.length >= 2) {
      const heldOutDate = new Date(heldOut.eruptionDate).getTime();
      const predictions: number[] = [];

      // Model 1: 线性回归
      const n = trainLeads.length;
      const sumX = trainLeads.reduce((s, p) => s + p.date, 0);
      const sumY = trainLeads.reduce((s, p) => s + p.lead, 0);
      const sumXY = trainLeads.reduce((s, p) => s + p.date * p.lead, 0);
      const sumX2 = trainLeads.reduce((s, p) => s + p.date * p.date, 0);
      const denom = n * sumX2 - sumX * sumX;
      if (Math.abs(denom) > 0) {
        const a = (n * sumXY - sumX * sumY) / denom;
        const b = (sumY - a * sumX) / n;
        predictions.push(Math.max(1, a * heldOutDate + b));
      }

      // Model 2: 指数衰减 lead = A * exp(-B * t)
      // 在 log 空间做线性回归：log(lead) = log(A) - B*t
      const logLeads = trainLeads.filter(p => p.lead > 0).map(p => ({ date: p.date, logLead: Math.log(p.lead) }));
      if (logLeads.length >= 2) {
        const ln = logLeads.length;
        const lsumX = logLeads.reduce((s, p) => s + p.date, 0);
        const lsumY = logLeads.reduce((s, p) => s + p.logLead, 0);
        const lsumXY = logLeads.reduce((s, p) => s + p.date * p.logLead, 0);
        const lsumX2 = logLeads.reduce((s, p) => s + p.date * p.date, 0);
        const ldenom = ln * lsumX2 - lsumX * lsumX;
        if (Math.abs(ldenom) > 0) {
          const la = (ln * lsumXY - lsumX * lsumY) / ldenom;
          const lb = (lsumY - la * lsumX) / ln;
          predictions.push(Math.max(1, Math.exp(la * heldOutDate + lb)));
        }
      }

      // Model 3: 距离加权最近邻（时间越近权重越高）
      const weights = trainLeads.map(p => 1 / (1 + Math.abs(p.date - heldOutDate) / (365.25 * 24 * 3600 * 1000)));
      const totalWeight = weights.reduce((a, b) => a + b, 0);
      if (totalWeight > 0) {
        const weightedLead = trainLeads.reduce((s, p, idx) => s + p.lead * weights[idx], 0) / totalWeight;
        predictions.push(Math.max(1, weightedLead));
      }

      // 集成：加权平均（指数衰减权重最高，因为它最能捕捉"领先时间在缩短"的趋势）
      if (predictions.length > 0) {
        const ensembleWeights = [0.25, 0.45, 0.30]; // [linear, exponential, knn]
        let weightedSum = 0;
        let totalW = 0;
        for (let j = 0; j < predictions.length; j++) {
          const w = ensembleWeights[j] ?? (1 / predictions.length);
          weightedSum += predictions[j] * w;
          totalW += w;
        }
        infraLeadPredicted = Math.round(weightedSum / totalW * 10) / 10;
      }
    }
    if (infraLeadPredicted === null && infraLeadActual !== null) {
      const leads = trainLeads.map(p => p.lead).sort((a, b) => a - b);
      infraLeadPredicted = leads.length > 0 ? leads[Math.floor(leads.length / 2)] : 5 * bestParams.compressionFactor;
      infraLeadPredicted = Math.round(infraLeadPredicted * 10) / 10;
    }

    const error = (infraLeadActual !== null && infraLeadPredicted !== null)
      ? Math.abs(infraLeadActual - infraLeadPredicted)
      : null;

    console.log(`  训练评分: ${bestScore.toFixed(3)} | 实际领先: ${infraLeadActual?.toFixed(1) ?? '-'}m | 预测: ${infraLeadPredicted?.toFixed(1) ?? '-'}m | 误差: ${error?.toFixed(1) ?? '-'}m`);

    results.push({
      heldOut: heldOut.name,
      trainScore: bestScore,
      bestParams,
      infraLeadPredicted: infraLeadPredicted ? Math.round(infraLeadPredicted * 10) / 10 : null,
      infraLeadActual: infraLeadActual ? Math.round(infraLeadActual * 10) / 10 : null,
      error: error ? Math.round(error * 10) / 10 : null,
    });
  }

  return results;
}

// ─── 验证：在新案例上预测 ───────────────────────────────────────

export interface DownloadSignal {
  repo: string;
  packageName: string;
  registry: 'npm' | 'pypi';
  weeklyDownloads: number;
  trend: 'accelerating' | 'growing' | 'stable' | 'unknown';
}

export interface ValidationResult {
  target: BacktestTarget;
  params: ModelParams;
  detectedSignals: SignalDetectionResult[];
  downloadSignals: DownloadSignal[];
  predictedEruptionDate: string | null;
  predictedLeadMonths: number | null;
  actualEruptionDate: string;
  predictionError: number | null;  // months
  confidenceInterval?: { lower: string; upper: string }; // ±1σ date range
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

  // ─── 多源融合预测 ────────────────────────────────────────────

  const recentInfra = signals.filter(s => s.layer === 'infrastructure' && s.signalDate !== null);
  const recentTooling = signals.filter(s => s.layer === 'tooling' && s.signalDate !== null);

  let predictedEruptionDate: string | null = null;
  let predictedLeadMonths: number | null = null;

  // Base expected lead times (from training data regression)
  // Historical infra leads: SD ~6m, ChatGPT ~17m, LocalLLM ~0, RAG ~3.6, Cursor ~12m, Manus ~5m
  // Median recent: ~5m, compressed: 5 * compression
  let expectedInfraLead = 5 * params.compressionFactor;
  let expectedToolingLead = 1.8 * params.compressionFactor;

  // ─── 下载量 + HN 多信号修正 ───
  // 收集下载量后再修正（此时 downloadSignals 还没有，先标记多信号数）
  const infraSignalCount = recentInfra.length;
  const toolingSignalCount = recentTooling.length;
  const totalGitHubSignals = infraSignalCount + toolingSignalCount;

  // 多信号聚合修正：
  // - 基础设施 + 工具层同时有信号 → 已进入工具化期，缩短 30%
  // - 3+ 个 repo 同时有信号 → 强信号，缩短 20%
  let accelerationFactor = 1.0;
  if (infraSignalCount > 0 && toolingSignalCount > 0) {
    accelerationFactor *= 0.7; // 跨层信号确认
    console.log('  [融合] 基础设施+工具层同时有信号 → 领先时间 ×0.7');
  }
  if (totalGitHubSignals >= 3) {
    accelerationFactor *= 0.8; // 多 repo 信号强化
    console.log(`  [融合] ${totalGitHubSignals} 个 repo 同时有信号 → 领先时间 ×0.8`);
  }

  expectedInfraLead *= accelerationFactor;
  expectedToolingLead *= accelerationFactor;

  // 预测策略
  if (recentInfra.length > 0) {
    const latestInfra = recentInfra.sort((a, b) => b.signalDate!.localeCompare(a.signalDate!))[0];
    const signalDate = new Date(latestInfra.signalDate!);
    const eruptionDate = new Date(signalDate);
    eruptionDate.setMonth(eruptionDate.getMonth() + Math.round(expectedInfraLead));

    predictedEruptionDate = eruptionDate.toISOString().slice(0, 10);
    const cutoffD = new Date(cutoff);
    predictedLeadMonths = (eruptionDate.getTime() - cutoffD.getTime()) / (1000 * 60 * 60 * 24 * 30);
    predictedLeadMonths = Math.round(predictedLeadMonths * 10) / 10;
  } else if (recentTooling.length > 0) {
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
  let predError = predictedEruptionDate
    ? Math.abs(new Date(predictedEruptionDate).getTime() - actualD.getTime()) / (1000 * 60 * 60 * 24 * 30)
    : null;

  // ─── 下载量信号（额外因子）───
  const { fetchNpmWeeklyDownloads, fetchPyPIMonthlyDownloads, guessPackageName } = await import('../collector/package-downloads.js');

  const downloadSignals: DownloadSignal[] = [];
  console.log('\n  [Downloads] 采集下载量数据...');

  for (const { repo, layer } of allRepos) {
    const pkg = guessPackageName(repo, null);
    if (pkg.pypi) {
      const months = await fetchPyPIMonthlyDownloads(pkg.pypi);
      if (months.length >= 2) {
        const recent = months.slice(-3);
        const totalRecent = recent.reduce((s, m) => s + m.downloads, 0);
        const avgRecent = totalRecent / recent.length;
        const older = months.slice(-6, -3);
        const avgOlder = older.length > 0 ? older.reduce((s, m) => s + m.downloads, 0) / older.length : avgRecent;
        const trend = avgRecent > avgOlder * 2 ? 'accelerating' : avgRecent > avgOlder * 1.2 ? 'growing' : 'stable';

        downloadSignals.push({
          repo, packageName: pkg.pypi, registry: 'pypi',
          weeklyDownloads: Math.round(avgRecent / 4), trend,
        });
        console.log(`    ${pkg.pypi} (PyPI): ${Math.round(avgRecent).toLocaleString()}/月 [${trend}]`);
      }
    }
    if (pkg.npm) {
      const weeks = await fetchNpmWeeklyDownloads(pkg.npm, 8);
      if (weeks.length >= 4) {
        const recent = weeks.slice(-4);
        const avgRecent = recent.reduce((s, w) => s + w.downloads, 0) / recent.length;
        const older = weeks.slice(0, 4);
        const avgOlder = older.reduce((s, w) => s + w.downloads, 0) / older.length;
        const trend = avgRecent > avgOlder * 2 ? 'accelerating' : avgRecent > avgOlder * 1.2 ? 'growing' : 'stable';

        downloadSignals.push({
          repo, packageName: pkg.npm, registry: 'npm',
          weeklyDownloads: Math.round(avgRecent), trend,
        });
        console.log(`    ${pkg.npm} (npm): ${Math.round(avgRecent).toLocaleString()}/周 [${trend}]`);
      }
    }
  }

  // ─── 下载量加速修正 ────────────────────────────────────────
  // 如果有包下载量在"加速"状态，说明采用率正在爆发，缩短预测时间
  const acceleratingDownloads = downloadSignals.filter(d => d.trend === 'accelerating');
  if (acceleratingDownloads.length > 0 && predictedEruptionDate) {
    const adjustmentMonths = acceleratingDownloads.length * 0.5; // 每个加速包缩短 0.5 个月
    const predicted = new Date(predictedEruptionDate);
    predicted.setDate(predicted.getDate() - Math.round(adjustmentMonths * 30));
    const oldPrediction = predictedEruptionDate;
    predictedEruptionDate = predicted.toISOString().slice(0, 10);

    const cutoffD = new Date(cutoff);
    predictedLeadMonths = (predicted.getTime() - cutoffD.getTime()) / (1000 * 60 * 60 * 24 * 30);
    predictedLeadMonths = Math.round(predictedLeadMonths * 10) / 10;

    console.log(`  [下载量修正] ${acceleratingDownloads.length} 个包加速中 → 预测前移 ${adjustmentMonths} 月 (${oldPrediction} → ${predictedEruptionDate})`);

    // Recalculate error
    const actualD2 = new Date(validationTarget.eruptionDate);
    const newError = Math.abs(predicted.getTime() - actualD2.getTime()) / (1000 * 60 * 60 * 24 * 30);
    predError = Math.round(newError * 10) / 10;
  }

  return {
    target: validationTarget,
    params,
    detectedSignals: signals,
    downloadSignals,
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

    lines.push('### 检测到的信号（6 因子：stars/forks/issues/PRs/contributors/releases）');
    lines.push('');
    lines.push('| 层级 | 仓库 | 信号日期 | 领先月数 |');
    lines.push('|------|------|---------|---------|');
    for (const r of val.detectedSignals) {
      const layerLabel = { infrastructure: '基础设施', tooling: '工具', application: '应用' }[r.layer];
      lines.push(`| ${layerLabel} | ${r.repo} | ${r.signalDate ?? '-'} | ${r.leadMonths?.toFixed(1) ?? '-'} |`);
    }
    lines.push('');

    // Download signals
    if (val.downloadSignals.length > 0) {
      lines.push('### 下载量信号（npm/PyPI）');
      lines.push('');
      lines.push('| 仓库 | 包名 | 注册表 | 周下载量 | 趋势 |');
      lines.push('|------|------|--------|---------|------|');
      for (const d of val.downloadSignals) {
        const trendLabel = { accelerating: '🔺 加速', growing: '📈 增长', stable: '➡️ 稳定', unknown: '?' }[d.trend];
        lines.push(`| ${d.repo} | ${d.packageName} | ${d.registry} | ${d.weeklyDownloads.toLocaleString()} | ${trendLabel} |`);
      }
      lines.push('');
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
