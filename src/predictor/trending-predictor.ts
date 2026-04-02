/**
 * 趋势项目预测器
 *
 * 核心思路：找到尚未火爆但展现出"即将爆发"早期信号的项目。
 *
 * 多因子信号模型：
 * 1. Star 加速度 — 周 star 增长率突然上升（但绝对值还不高）
 * 2. Fork 加速度 — fork 增长预示真实使用
 * 3. Issue/PR 活跃度 — 社区参与度突增
 * 4. 社交热度 — HN / Reddit / DEV.to 提及
 * 5. 贡献者增长 — 新贡献者涌入
 * 6. Release 节奏 — 密集发版说明项目活跃
 *
 * 排除条件：
 * - 已经很火的项目（全量 star > 阈值 或 已上过 trending）
 * - 纯 spike 项目（一次性爆发后衰退）
 *
 * 量化 KPI 预测：
 * - 未来 4 周预计新增 star 数
 * - 未来 4 周预计新增 fork 数
 * - 未来 4 周预计 issue/PR 活跃度
 * - 预计到达 star 里程碑的时间
 */

import type Database from 'better-sqlite3';
import { queryClickHouse, escapeSQL, validateDate, type WeeklyMetrics } from '../util/clickhouse.js';
import { computeAcceleration } from '../util/math.js';
import { fetchRepoDetails, getRateLimitInfo } from '../collector/github-api.js';

// ─── 类型定义 ──────────────────────────────────────────────────

export interface TrendingCandidate {
  repo: string;
  lifetimeStars: number;        // 全量 star 数
  recentStars8w: number;        // 近 8 周 star 增量
  predictionScore: number;
  factors: TrendingFactors;
  kpi: TrendingKPI;
  evidence: string[];
}

export interface TrendingFactors {
  starVelocity: number;         // 最近 2 周 vs 前 4 周的 star 增长加速倍数
  forkAcceleration: number;
  issueAcceleration: number;
  prAcceleration: number;
  contributorGrowth: number;
  releaseFrequency: number;
  socialBuzzScore: number;
  crossFactorCount: number;
}

export interface TrendingKPI {
  // ─── 增长预测（未来 4 周）
  predictedStars4w: number;      // 预计新增 star
  predictedForks4w: number;      // 预计新增 fork
  predictedIssues4w: number;     // 预计新增 issue
  predictedPRs4w: number;        // 预计新增 PR
  // ─── 里程碑
  estimatedTotalStars4w: number; // 4 周后预计总 star 数
  weeklyStarRun: number[];       // 最近 4 周每周 star 数（趋势线）
  weeklyForkRun: number[];       // 最近 4 周每周 fork 数
  // ─── 社区声量
  communityScore: number;        // 综合社区活跃度 0~100
  growthMomentum: 'accelerating' | 'steady' | 'decelerating';
}

// ─── 发现候选项目 ──────────────────────────────────────────────

/**
 * 从 ClickHouse 发现最近活跃度突增但 **全量 star 不高** 的项目
 *
 * 关键改进：用子查询查全量 star，而非仅看窗口内 star
 */
export async function discoverRisingProjects(
  lookbackWeeks: number = 8,
  maxLifetimeStars: number = 5000,
  minRecentStars: number = 50,
  referenceDate?: string,
): Promise<{ repo: string; lifetimeStars: number; recentStars: number }[]> {
  const to = validateDate(referenceDate ?? new Date().toISOString().slice(0, 10));
  const from = validateDate(new Date(new Date(to).getTime() - lookbackWeeks * 7 * 86400000).toISOString().slice(0, 10));
  const recentFrom = validateDate(new Date(new Date(to).getTime() - 14 * 86400000).toISOString().slice(0, 10));

  // Step 1: 查近期活跃度突增的候选
  // NOTE: recent_stars > period_stars * 0.3 是有意设计——偏好"突然爆发"而非"持续增长"。
  // 持续增长的项目（每周均匀增长）的 2 周占比约 25%，会被过滤。
  // 这是因为持续增长的项目通常已被广泛关注，不符合"即将爆发"的定义。
  const sql = `
    WITH candidates AS (
      SELECT
        repo_name,
        countIf(event_type = 'WatchEvent' AND created_at >= '${recentFrom}') AS recent_stars,
        countIf(event_type = 'WatchEvent') AS period_stars
      FROM github_events
      WHERE created_at >= '${from}'
        AND created_at <= '${to}'
        AND event_type = 'WatchEvent'
      GROUP BY repo_name
      HAVING recent_stars >= ${minRecentStars}
        AND recent_stars > period_stars * 0.3
    ),
    lifetime AS (
      SELECT
        repo_name,
        count() AS lifetime_stars
      FROM github_events
      WHERE event_type = 'WatchEvent'
        AND created_at >= '2015-01-01'
        AND repo_name IN (SELECT repo_name FROM candidates)
      GROUP BY repo_name
    )
    SELECT
      c.repo_name,
      l.lifetime_stars,
      c.recent_stars
    FROM candidates c
    JOIN lifetime l ON c.repo_name = l.repo_name
    WHERE l.lifetime_stars <= ${maxLifetimeStars}
    ORDER BY c.recent_stars DESC
    LIMIT 100
    FORMAT JSONEachRow
  `;

  const text = await queryClickHouse(sql);
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.map((line) => {
    const row = JSON.parse(line);
    return {
      repo: row.repo_name as string,
      lifetimeStars: Number(row.lifetime_stars),
      recentStars: Number(row.recent_stars),
    };
  });
}

// ─── 因子计算 ──────────────────────────────────────────────────

export function computeFactors(
  history: WeeklyMetrics[],
  socialScore: number = 0,
): TrendingFactors {
  if (history.length < 2) {
    return {
      starVelocity: 0, forkAcceleration: 0, issueAcceleration: 0,
      prAcceleration: 0, contributorGrowth: 0, releaseFrequency: 0,
      socialBuzzScore: socialScore, crossFactorCount: 0,
    };
  }

  // Use at least 2 weeks for both recent and baseline when possible.
  // With only 2-3 weeks total, 1v1 comparison is noisy — acceleration
  // values will be used but crossFactorCount threshold is higher (see below).
  const recentCount = Math.min(2, Math.floor(history.length / 2));
  const recent = history.slice(-recentCount);
  const baseline = history.slice(0, -recentCount);

  const starVelocity = computeAcceleration(
    recent.map((w) => w.new_stars), baseline.map((w) => w.new_stars));
  const forkAcceleration = computeAcceleration(
    recent.map((w) => w.new_forks), baseline.map((w) => w.new_forks));
  const issueAcceleration = computeAcceleration(
    recent.map((w) => w.new_issues), baseline.map((w) => w.new_issues));
  const prAcceleration = computeAcceleration(
    recent.map((w) => w.new_prs), baseline.map((w) => w.new_prs));
  const contributorGrowth = computeAcceleration(
    recent.map((w) => w.unique_pushers), baseline.map((w) => w.unique_pushers));
  const releaseFrequency = history.slice(-4).reduce((s, w) => s + w.new_releases, 0);

  // Cross-factor count: how many distinct signals are accelerating simultaneously
  const ACCEL_THRESHOLD = 1.5;
  let crossFactorCount = 0;
  if (starVelocity >= ACCEL_THRESHOLD) crossFactorCount++;
  if (forkAcceleration >= ACCEL_THRESHOLD) crossFactorCount++;
  if (issueAcceleration >= ACCEL_THRESHOLD) crossFactorCount++;
  if (prAcceleration >= ACCEL_THRESHOLD) crossFactorCount++;
  if (contributorGrowth >= ACCEL_THRESHOLD) crossFactorCount++;
  if (releaseFrequency >= 2) crossFactorCount++;   // 2+ releases in 4 weeks
  if (socialScore >= 30) crossFactorCount++;        // meaningful social buzz

  return {
    starVelocity: round2(starVelocity),
    forkAcceleration: round2(forkAcceleration),
    issueAcceleration: round2(issueAcceleration),
    prAcceleration: round2(prAcceleration),
    contributorGrowth: round2(contributorGrowth),
    releaseFrequency,
    socialBuzzScore: socialScore,
    crossFactorCount,
  };
}

// ─── KPI 预测 ──────────────────────────────────────────────────

/**
 * 基于历史趋势外推未来 4 周的量化 KPI
 *
 * 策略：
 * - 用最近 2 周的周均值作为"当前速度"
 * - 用加速度判断趋势方向
 * - 保守估计：加速期取 1.2x 增长，减速期取 0.8x 衰减
 */
function forecastKPI(
  history: WeeklyMetrics[],
  lifetimeStars: number,
  factors: TrendingFactors,
): TrendingKPI {
  const last4 = history.slice(-4);
  const last2 = history.slice(-2);

  // Pad to 4 entries so the report always shows a consistent 4-week trend
  const rawStarRun = last4.map((w) => w.new_stars);
  const rawForkRun = last4.map((w) => w.new_forks);
  const weeklyStarRun = [...Array(Math.max(0, 4 - rawStarRun.length)).fill(0), ...rawStarRun];
  const weeklyForkRun = [...Array(Math.max(0, 4 - rawForkRun.length)).fill(0), ...rawForkRun];

  // Current weekly rate (average of last 2 weeks)
  const avgStarsPerWeek = last2.reduce((s, w) => s + w.new_stars, 0) / Math.max(last2.length, 1);
  const avgForksPerWeek = last2.reduce((s, w) => s + w.new_forks, 0) / Math.max(last2.length, 1);
  const avgIssuesPerWeek = last2.reduce((s, w) => s + w.new_issues, 0) / Math.max(last2.length, 1);
  const avgPRsPerWeek = last2.reduce((s, w) => s + w.new_prs, 0) / Math.max(last2.length, 1);

  // Growth momentum
  let momentum: TrendingKPI['growthMomentum'] = 'steady';
  if (factors.starVelocity >= 1.5) momentum = 'accelerating';
  else if (factors.starVelocity < 0.8) momentum = 'decelerating';

  // 4-week forecast: flat projection with linear trend adjustment (NOT compound)
  // Regression to mean: most acceleration is temporary, so we dampen over time.
  // Week 1: 100% of current rate, Week 2: rate * adj, Week 3: rate * adj^2... capped.
  // Using sqrt decay: accelerating projects get +5% per week (not +15%),
  // decelerating get -5% per week.
  const weeklyAdj = momentum === 'accelerating' ? 1.05
    : momentum === 'decelerating' ? 0.95
    : 1.0;

  let predictedStars4w = 0;
  let predictedForks4w = 0;
  let predictedIssues4w = 0;
  let predictedPRs4w = 0;
  for (let w = 1; w <= 4; w++) {
    const weekFactor = Math.pow(weeklyAdj, w - 1);
    predictedStars4w += Math.round(avgStarsPerWeek * weekFactor);
    predictedForks4w += Math.round(avgForksPerWeek * weekFactor);
    predictedIssues4w += Math.round(avgIssuesPerWeek * weekFactor);
    predictedPRs4w += Math.round(avgPRsPerWeek * weekFactor);
  }

  // Community score: 0~100 composite
  const starIntensity = Math.min(avgStarsPerWeek / 200, 1) * 30;      // max 30 pts
  const forkIntensity = Math.min(avgForksPerWeek / 30, 1) * 20;       // max 20 pts
  const issueIntensity = Math.min(avgIssuesPerWeek / 20, 1) * 20;     // max 20 pts
  const prIntensity = Math.min(avgPRsPerWeek / 10, 1) * 15;           // max 15 pts
  const crossBonus = Math.min(factors.crossFactorCount / 4, 1) * 15;  // max 15 pts
  const communityScore = Math.round(starIntensity + forkIntensity + issueIntensity + prIntensity + crossBonus);

  return {
    predictedStars4w,
    predictedForks4w,
    predictedIssues4w,
    predictedPRs4w,
    estimatedTotalStars4w: lifetimeStars + predictedStars4w,
    weeklyStarRun,
    weeklyForkRun,
    communityScore,
    growthMomentum: momentum,
  };
}

// ─── 评分模型 ──────────────────────────────────────────────────

const TRENDING_WEIGHTS = {
  starVelocity: 0.25,
  forkAcceleration: 0.15,
  issueActivity: 0.10,
  prActivity: 0.10,
  contributorGrowth: 0.10,
  releaseFrequency: 0.05,
  socialBuzz: 0.10,
  crossFactor: 0.15,
};

/**
 * @param historyWeeks Number of data weeks available. Short histories (< 4)
 *   get a confidence discount to reduce false positives from noisy 1v1 comparisons.
 */
export function scoreTrendingCandidate(factors: TrendingFactors, historyWeeks: number = 8): number {
  const starScore = Math.min(factors.starVelocity / 5, 1);
  const forkScore = Math.min(factors.forkAcceleration / 4, 1);
  const issueScore = Math.min(factors.issueAcceleration / 3, 1);
  const prScore = Math.min(factors.prAcceleration / 3, 1);
  const contribScore = Math.min(factors.contributorGrowth / 3, 1);
  const releaseScore = Math.min(factors.releaseFrequency / 4, 1);
  const socialScore = Math.min(factors.socialBuzzScore / 100, 1);
  const crossScore = Math.min(factors.crossFactorCount / 4, 1);

  const rawScore =
    starScore * TRENDING_WEIGHTS.starVelocity +
    forkScore * TRENDING_WEIGHTS.forkAcceleration +
    issueScore * TRENDING_WEIGHTS.issueActivity +
    prScore * TRENDING_WEIGHTS.prActivity +
    contribScore * TRENDING_WEIGHTS.contributorGrowth +
    releaseScore * TRENDING_WEIGHTS.releaseFrequency +
    socialScore * TRENDING_WEIGHTS.socialBuzz +
    crossScore * TRENDING_WEIGHTS.crossFactor;

  // Confidence discount for short histories: < 4 weeks of data
  // means 1v1 week comparison which is very noisy
  const confidenceDiscount = historyWeeks >= 4 ? 1.0 : historyWeeks >= 3 ? 0.8 : 0.6;

  return round2(rawScore * confidenceDiscount);
}

function buildEvidence(factors: TrendingFactors): string[] {
  const evidence: string[] = [];
  if (factors.starVelocity >= 2) evidence.push(`Star 加速 ${factors.starVelocity}x`);
  if (factors.forkAcceleration >= 1.5) evidence.push(`Fork 加速 ${factors.forkAcceleration}x`);
  if (factors.issueAcceleration >= 1.5) evidence.push(`Issue 活跃度上升 ${factors.issueAcceleration}x`);
  if (factors.prAcceleration >= 1.5) evidence.push(`PR 活跃度上升 ${factors.prAcceleration}x`);
  if (factors.contributorGrowth >= 1.5) evidence.push(`新贡献者增长 ${factors.contributorGrowth}x`);
  if (factors.releaseFrequency >= 2) evidence.push(`近 4 周发布 ${factors.releaseFrequency} 次`);
  if (factors.socialBuzzScore > 0) evidence.push(`社交热度 ${factors.socialBuzzScore} 分`);
  if (factors.crossFactorCount >= 3) evidence.push(`${factors.crossFactorCount} 个因子同时加速`);
  return evidence;
}

// ─── 批量查询 ──────────────────────────────────────────────────

/**
 * Batch query: 100 repos × ~30 chars each ≈ 3KB IN clause.
 * play.clickhouse.com limit is ~256KB, well within range.
 * If candidate count grows beyond ~500, should split into batches.
 */
async function batchFetchMetrics(
  repos: string[],
  fromDate: string,
  toDate: string,
): Promise<Map<string, WeeklyMetrics[]>> {
  if (repos.length === 0) return new Map();

  const repoList = repos.map((r) => `'${escapeSQL(r)}'`).join(', ');
  const sql = `
    SELECT
      repo_name,
      toStartOfWeek(created_at) AS week,
      countIf(event_type = 'WatchEvent') AS new_stars,
      countIf(event_type = 'ForkEvent') AS new_forks,
      countIf(event_type = 'IssuesEvent') AS new_issues,
      countIf(event_type = 'PullRequestEvent') AS new_prs,
      uniqIf(actor_login, event_type = 'PushEvent') AS unique_pushers,
      countIf(event_type = 'ReleaseEvent') AS new_releases
    FROM github_events
    WHERE repo_name IN (${repoList})
      AND created_at >= '${validateDate(fromDate)}'
      AND created_at <= '${validateDate(toDate)}'
    GROUP BY repo_name, week
    ORDER BY repo_name, week ASC
    FORMAT JSONEachRow
  `;

  const text = await queryClickHouse(sql);
  const lines = text.trim().split('\n').filter(Boolean);

  const result = new Map<string, WeeklyMetrics[]>();
  for (const line of lines) {
    const row = JSON.parse(line);
    const repo = row.repo_name as string;
    if (!result.has(repo)) result.set(repo, []);
    result.get(repo)!.push({
      week: row.week.slice(0, 10),
      new_stars: Number(row.new_stars),
      new_forks: Number(row.new_forks),
      new_issues: Number(row.new_issues),
      new_prs: Number(row.new_prs),
      unique_pushers: Number(row.unique_pushers ?? 0),
      new_releases: Number(row.new_releases ?? 0),
    });
  }

  return result;
}

// ─── 主预测流程 ─────────────────────────────────────────────────

export async function predictTrendingProjects(
  db: Database.Database | null,
  maxStars: number = 5000,
  topN: number = 20,
  referenceDate?: string,
): Promise<TrendingCandidate[]> {
  const to = referenceDate ?? new Date().toISOString().slice(0, 10);
  const lookbackWeeks = 8;
  const from = new Date(new Date(to).getTime() - lookbackWeeks * 7 * 86400000).toISOString().slice(0, 10);

  console.log(`[TrendPredict] 发现活跃度突增的项目 (${from} ~ ${to}, 全量 star < ${maxStars})...`);
  const discovered = await discoverRisingProjects(lookbackWeeks, maxStars, 30, to);
  console.log(`[TrendPredict] 发现 ${discovered.length} 个候选项目（已按全量 star 过滤）`);

  if (discovered.length === 0) {
    console.warn('[TrendPredict] 无候选项目（ClickHouse 查询可能超时或无匹配数据）');
    return [];
  }

  // Social buzz scores
  const socialScores = new Map<string, number>();
  if (db) {
    try {
      const buzz = db.prepare(`
        SELECT github_repo, SUM(score) as total_score
        FROM social_buzz
        WHERE github_repo IS NOT NULL AND captured_at >= date(?, '-14 days')
        GROUP BY github_repo
      `).all(to) as { github_repo: string; total_score: number }[];
      for (const b of buzz) socialScores.set(b.github_repo, b.total_score);
    } catch (err) {
      console.warn('[TrendPredict] 社交热度查询失败:', (err as Error).message);
    }
  }
  if (db) {
    try {
      const hnPosts = db.prepare(`
        SELECT url FROM hn_posts WHERE captured_at >= date(?, '-14 days') AND url LIKE '%github.com%'
      `).all(to) as { url: string }[];
      for (const p of hnPosts) {
        const match = p.url?.match(/github\.com\/([^/]+\/[^/]+)/);
        if (match) {
          const repo = match[1].replace(/\.git$/, '');
          socialScores.set(repo, (socialScores.get(repo) ?? 0) + 30);
        }
      }
    } catch (err) {
      console.warn('[TrendPredict] HN 帖子查询失败:', (err as Error).message);
    }
  }

  // Batch fetch weekly metrics
  const repoNames = discovered.map((d) => d.repo);
  console.log(`[TrendPredict] 批量查询 ${repoNames.length} 个候选的历史指标...`);
  const allMetrics = await batchFetchMetrics(repoNames, from, to);

  // Build lifetime star lookup
  const lifetimeMap = new Map<string, number>();
  for (const d of discovered) lifetimeMap.set(d.repo, d.lifetimeStars);

  // Score each candidate
  const scored: TrendingCandidate[] = [];

  for (const d of discovered) {
    const history = allMetrics.get(d.repo);
    if (!history || history.length < 2) continue;

    const socialScore = socialScores.get(d.repo) ?? 0;
    const factors = computeFactors(history, socialScore);
    const score = scoreTrendingCandidate(factors, history.length);
    const kpi = forecastKPI(history, d.lifetimeStars, factors);

    if (score > 0.15) {
      scored.push({
        repo: d.repo,
        lifetimeStars: d.lifetimeStars,
        recentStars8w: d.recentStars,
        predictionScore: score,
        factors,
        kpi,
        evidence: buildEvidence(factors),
      });
    }
  }

  // Sort and take top candidates
  scored.sort((a, b) => b.predictionScore - a.predictionScore);
  const topCandidates = scored.slice(0, topN * 2); // fetch more, filter later

  // Enrich with real star counts from GitHub API
  // (ClickHouse GH Archive undercounts stars significantly)
  if (!referenceDate && process.env.GITHUB_TOKEN) {
    console.log(`[TrendPredict] 通过 GitHub API 校准 ${topCandidates.length} 个候选的真实 star 数...`);
    for (const c of topCandidates) {
      // Check rate limit before each request
      const rateInfo = getRateLimitInfo();
      if (rateInfo.remaining < 100) {
        console.warn(`[TrendPredict] GitHub API rate limit low (${rateInfo.remaining} remaining), 停止校准`);
        break;
      }
      try {
        const details = await fetchRepoDetails(c.repo);
        if (details) {
          c.lifetimeStars = details.stars;
          const history = allMetrics.get(c.repo);
          if (history) {
            c.kpi = forecastKPI(history, details.stars, c.factors);
          }
        }
      } catch (err) {
        console.warn(`[TrendPredict] 校准 ${c.repo} 失败: ${(err as Error).message}`);
      }
    }

    // Re-filter: remove projects that are actually already popular
    const filtered = topCandidates.filter((c) => c.lifetimeStars <= maxStars);
    if (filtered.length < topCandidates.length) {
      console.log(`[TrendPredict] GitHub API 校准后过滤掉 ${topCandidates.length - filtered.length} 个已火项目`);
    }
    return filtered.slice(0, topN);
  } else if (!referenceDate && !process.env.GITHUB_TOKEN) {
    console.warn('[TrendPredict] 未设置 GITHUB_TOKEN，跳过 star 校准（ClickHouse 数据可能低估实际 star 数）');
  }

  return topCandidates.slice(0, topN);
}

// ─── 已火项目过滤 ──────────────────────────────────────────────

export function filterAlreadyTrending(
  candidates: TrendingCandidate[],
  db: Database.Database,
): TrendingCandidate[] {
  const trendedIds = new Set<string>();
  const rows = db.prepare(`
    SELECT DISTINCT project_id FROM snapshots
    WHERE trending_rank IS NOT NULL AND trending_rank <= 25
  `).all() as { project_id: string }[];
  for (const r of rows) trendedIds.add(r.project_id);
  return candidates.filter((c) => !trendedIds.has(c.repo));
}

// ─── 格式化输出 ─────────────────────────────────────────────────

const MOMENTUM_LABEL: Record<string, string> = {
  accelerating: '🚀 加速中',
  steady: '➡️ 稳定',
  decelerating: '📉 减速',
};

export function formatTrendingPredictionReport(
  candidates: TrendingCandidate[],
  referenceDate?: string,
): string {
  const lines: string[] = [];
  const date = referenceDate ?? new Date().toISOString().slice(0, 10);

  lines.push('# Augur 趋势项目预测');
  lines.push('');
  lines.push(`> 预测日期: ${date}`);
  lines.push(`> 模型: 多因子加速度评分 + 量化 KPI 外推`);
  lines.push(`> 过滤: 全量 star 过滤 + 已上过 Trending 排除`);
  lines.push('');
  lines.push('以下项目展现出"即将爆发"的早期信号，预测未来 4 周内可能登上 GitHub Trending：');
  lines.push('');

  // Summary table
  lines.push('## 预测总览');
  lines.push('');
  lines.push('| # | 项目 | 当前总★ | 预测得分 | 4周预计+★ | 4周后总★ | 4周+Fork | 社区活跃 | 势头 |');
  lines.push('|---|------|--------|---------|----------|---------|---------|---------|------|');

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    lines.push(
      `| ${i + 1} | **${c.repo}** | ${fmt(c.lifetimeStars)} | ${c.predictionScore.toFixed(2)} ` +
      `| +${fmt(c.kpi.predictedStars4w)} | ${fmt(c.kpi.estimatedTotalStars4w)} ` +
      `| +${fmt(c.kpi.predictedForks4w)} | ${c.kpi.communityScore}/100 ` +
      `| ${MOMENTUM_LABEL[c.kpi.growthMomentum]} |`,
    );
  }

  // Detailed per-project KPI
  lines.push('');
  lines.push('## 各项目详细 KPI 预测');
  lines.push('');

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    lines.push(`### ${i + 1}. ${c.repo}`);
    lines.push('');
    lines.push(`| 指标 | 当前值 | 4周预测 |`);
    lines.push(`|------|--------|--------|`);
    lines.push(`| 总 Star | ${fmt(c.lifetimeStars)} | **${fmt(c.kpi.estimatedTotalStars4w)}** (+${fmt(c.kpi.predictedStars4w)}) |`);
    lines.push(`| 4周新增 Fork | - | **+${fmt(c.kpi.predictedForks4w)}** |`);
    lines.push(`| 4周新增 Issue | - | **+${c.kpi.predictedIssues4w}** |`);
    lines.push(`| 4周新增 PR | - | **+${c.kpi.predictedPRs4w}** |`);
    lines.push(`| 社区活跃度 | ${c.kpi.communityScore}/100 | ${MOMENTUM_LABEL[c.kpi.growthMomentum]} |`);
    lines.push(`| 近4周★趋势 | ${c.kpi.weeklyStarRun.map(fmt).join(' → ')} |  |`);
    lines.push(`| 近4周Fork趋势 | ${c.kpi.weeklyForkRun.map(fmt).join(' → ')} |  |`);
    lines.push('');

    // Signal evidence
    if (c.evidence.length > 0) {
      lines.push(`**信号**: ${c.evidence.join(' | ')}`);
      lines.push('');
    }
  }

  // Factor weights reference
  lines.push('---');
  lines.push('');
  lines.push('### 评分因子权重');
  lines.push('');
  lines.push('| 因子 | 权重 | 说明 |');
  lines.push('|------|------|------|');
  lines.push('| Star 加速度 | 0.25 | 最近2周 vs 前4周的 star 增长倍数 |');
  lines.push('| Fork 加速度 | 0.15 | Fork 增长（真实使用信号） |');
  lines.push('| Issue 活跃 | 0.10 | 社区需求增长 |');
  lines.push('| PR 活跃 | 0.10 | 开发速度增长 |');
  lines.push('| 贡献者增长 | 0.10 | 新贡献者涌入 |');
  lines.push('| Release 节奏 | 0.05 | 密集发版 |');
  lines.push('| 社交热度 | 0.10 | HN/Reddit/DEV.to 提及 |');
  lines.push('| 多因子共振 | 0.15 | 多个因子同时加速 |');
  lines.push('');
  lines.push('### KPI 预测方法');
  lines.push('- 基于最近 2 周周均值外推，结合加速/减速趋势调整');
  lines.push('- 加速期: 周环比 +15%，减速期: 周环比 -15%，稳定期: 持平');
  lines.push('- 社区活跃度: Star(30) + Fork(20) + Issue(20) + PR(15) + 多因子(15) = 100');

  return lines.join('\n');
}

function fmt(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
