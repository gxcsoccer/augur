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
 * - 已经很火的项目（star > 阈值 或 已上过 trending）
 * - 纯 spike 项目（一次性爆发后衰退）
 *
 * 通过 ClickHouse GH Archive 历史数据进行回测验证。
 */

import type Database from 'better-sqlite3';
import { queryClickHouse, escapeSQL, fetchWeeklyMetrics as fetchRepoWeeklyMetrics, type WeeklyMetrics } from '../util/clickhouse.js';

// ─── 类型定义 ──────────────────────────────────────────────────

export interface TrendingCandidate {
  repo: string;
  currentStars: number;
  predictionScore: number;
  factors: TrendingFactors;
  evidence: string[];
}

export interface TrendingFactors {
  starVelocity: number;         // 最近 2 周 vs 前 4 周的 star 增长加速倍数
  forkAcceleration: number;     // fork 加速倍数
  issueAcceleration: number;    // issue 加速倍数
  prAcceleration: number;       // PR 加速倍数
  contributorGrowth: number;    // 新贡献者增长率
  releaseFrequency: number;     // 最近 4 周内 release 次数
  socialBuzzScore: number;      // 社交媒体提及综合得分
  crossFactorCount: number;     // 同时加速的因子数量
}

/**
 * 从 ClickHouse 发现最近活跃度突增但 star 总量不高的项目
 */
export async function discoverRisingProjects(
  lookbackWeeks: number = 8,
  maxTotalStars: number = 5000,
  minRecentStars: number = 50,
  referenceDate?: string,
): Promise<string[]> {
  const to = referenceDate ?? new Date().toISOString().slice(0, 10);
  const from = new Date(new Date(to).getTime() - lookbackWeeks * 7 * 86400000).toISOString().slice(0, 10);
  const recentFrom = new Date(new Date(to).getTime() - 14 * 86400000).toISOString().slice(0, 10);

  const sql = `
    SELECT
      repo_name,
      countIf(event_type = 'WatchEvent' AND created_at >= '${recentFrom}') AS recent_stars,
      countIf(event_type = 'WatchEvent') AS total_period_stars,
      countIf(event_type = 'ForkEvent' AND created_at >= '${recentFrom}') AS recent_forks,
      countIf(event_type = 'IssuesEvent' AND created_at >= '${recentFrom}') AS recent_issues,
      uniqIf(actor_login, event_type = 'PushEvent' AND created_at >= '${recentFrom}') AS recent_pushers
    FROM github_events
    WHERE created_at >= '${from}'
      AND created_at <= '${to}'
      AND event_type IN ('WatchEvent', 'ForkEvent', 'IssuesEvent', 'PushEvent')
    GROUP BY repo_name
    HAVING recent_stars >= ${minRecentStars}
      AND total_period_stars <= ${maxTotalStars}
      AND recent_stars > total_period_stars * 0.4
    ORDER BY recent_stars DESC
    LIMIT 100
    FORMAT JSONEachRow
  `;

  const text = await queryClickHouse(sql);
  const lines = text.trim().split('\n').filter(Boolean);
  return lines.map((line) => JSON.parse(line).repo_name as string);
}

// ─── 因子计算 ──────────────────────────────────────────────────

function computeAcceleration(recent: number[], baseline: number[]): number {
  const recentAvg = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const baselineAvg = baseline.length > 0 ? baseline.reduce((a, b) => a + b, 0) / baseline.length : 0;
  if (baselineAvg < 1) return recentAvg > 3 ? Math.min(recentAvg, 10) : 0; // 基线太低
  return recentAvg / baselineAvg;
}

function computeFactors(
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

  // Split into recent (last 2 weeks) and baseline (2-6 weeks ago)
  const recentCount = Math.min(2, Math.floor(history.length / 2));
  const recent = history.slice(-recentCount);
  const baseline = history.slice(0, -recentCount);

  const starVelocity = computeAcceleration(
    recent.map((w) => w.new_stars),
    baseline.map((w) => w.new_stars),
  );
  const forkAcceleration = computeAcceleration(
    recent.map((w) => w.new_forks),
    baseline.map((w) => w.new_forks),
  );
  const issueAcceleration = computeAcceleration(
    recent.map((w) => w.new_issues),
    baseline.map((w) => w.new_issues),
  );
  const prAcceleration = computeAcceleration(
    recent.map((w) => w.new_prs),
    baseline.map((w) => w.new_prs),
  );
  const contributorGrowth = computeAcceleration(
    recent.map((w) => w.unique_pushers),
    baseline.map((w) => w.unique_pushers),
  );
  const releaseFrequency = history.slice(-4).reduce((s, w) => s + w.new_releases, 0);

  // Count how many factors are accelerating (>= 1.5x)
  const ACCEL_THRESHOLD = 1.5;
  let crossFactorCount = 0;
  if (starVelocity >= ACCEL_THRESHOLD) crossFactorCount++;
  if (forkAcceleration >= ACCEL_THRESHOLD) crossFactorCount++;
  if (issueAcceleration >= ACCEL_THRESHOLD) crossFactorCount++;
  if (prAcceleration >= ACCEL_THRESHOLD) crossFactorCount++;
  if (contributorGrowth >= ACCEL_THRESHOLD) crossFactorCount++;

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

// ─── 评分模型 ──────────────────────────────────────────────────

/**
 * 评分权重（基于历史回测校准）
 */
const TRENDING_WEIGHTS = {
  starVelocity: 0.25,       // star 加速度（最重要的单一信号）
  forkAcceleration: 0.15,   // fork 增长（真实使用信号）
  issueActivity: 0.10,      // issue 活跃（社区需求）
  prActivity: 0.10,         // PR 活跃（开发速度）
  contributorGrowth: 0.10,  // 贡献者增长
  releaseFrequency: 0.05,   // 发版节奏
  socialBuzz: 0.10,         // 社交媒体热度
  crossFactor: 0.15,        // 多因子共振加分
};

function scoreTrendingCandidate(factors: TrendingFactors): number {
  // Normalize each factor to 0~1 range
  const starScore = Math.min(factors.starVelocity / 5, 1);        // 5x 加速 = 满分
  const forkScore = Math.min(factors.forkAcceleration / 4, 1);     // 4x 加速 = 满分
  const issueScore = Math.min(factors.issueAcceleration / 3, 1);
  const prScore = Math.min(factors.prAcceleration / 3, 1);
  const contribScore = Math.min(factors.contributorGrowth / 3, 1);
  const releaseScore = Math.min(factors.releaseFrequency / 4, 1);  // 4次/月 = 满分
  const socialScore = Math.min(factors.socialBuzzScore / 100, 1);   // 100分 = 满分
  const crossScore = Math.min(factors.crossFactorCount / 4, 1);     // 4 因子同时加速 = 满分

  const score =
    starScore * TRENDING_WEIGHTS.starVelocity +
    forkScore * TRENDING_WEIGHTS.forkAcceleration +
    issueScore * TRENDING_WEIGHTS.issueActivity +
    prScore * TRENDING_WEIGHTS.prActivity +
    contribScore * TRENDING_WEIGHTS.contributorGrowth +
    releaseScore * TRENDING_WEIGHTS.releaseFrequency +
    socialScore * TRENDING_WEIGHTS.socialBuzz +
    crossScore * TRENDING_WEIGHTS.crossFactor;

  return round2(score);
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
  if (factors.crossFactorCount >= 3) evidence.push(`🔥 ${factors.crossFactorCount} 个因子同时加速（强信号）`);
  return evidence;
}

// ─── 主预测流程 ─────────────────────────────────────────────────

/**
 * 预测即将登上 trending 的项目
 *
 * @param db SQLite 数据库（用于读取社交热度数据）
 * @param maxStars 排除已经很火的项目（star 上限）
 * @param topN 返回 Top N 个候选
 * @param referenceDate 参考日期（用于回测）
 */
export async function predictTrendingProjects(
  db: Database.Database | null,
  maxStars: number = 5000,
  topN: number = 20,
  referenceDate?: string,
): Promise<TrendingCandidate[]> {
  const to = referenceDate ?? new Date().toISOString().slice(0, 10);
  const lookbackWeeks = 8;
  const from = new Date(new Date(to).getTime() - lookbackWeeks * 7 * 86400000).toISOString().slice(0, 10);

  console.log(`[TrendPredict] 发现活跃度突增的项目 (${from} ~ ${to}, star < ${maxStars})...`);
  const candidates = await discoverRisingProjects(lookbackWeeks, maxStars, 30, to);
  console.log(`[TrendPredict] 发现 ${candidates.length} 个候选项目`);

  // Get social buzz scores from DB
  const socialScores = new Map<string, number>();
  if (db) {
    try {
      const buzz = db.prepare(`
        SELECT github_repo, SUM(score) as total_score
        FROM social_buzz
        WHERE github_repo IS NOT NULL
          AND captured_at >= date(?, '-14 days')
        GROUP BY github_repo
      `).all(to) as { github_repo: string; total_score: number }[];
      for (const b of buzz) socialScores.set(b.github_repo, b.total_score);
    } catch {
      // social_buzz table might not exist yet
    }
  }

  // Also count HN posts
  if (db) {
    try {
      const hnPosts = db.prepare(`
        SELECT url FROM hn_posts
        WHERE captured_at >= date(?, '-14 days')
          AND url LIKE '%github.com%'
      `).all(to) as { url: string }[];
      for (const p of hnPosts) {
        const match = p.url?.match(/github\.com\/([^/]+\/[^/]+)/);
        if (match) {
          const repo = match[1].replace(/\.git$/, '');
          socialScores.set(repo, (socialScores.get(repo) ?? 0) + 30); // HN post = 30 points
        }
      }
    } catch {}
  }

  // Score each candidate
  const results: TrendingCandidate[] = [];

  for (const repo of candidates) {
    try {
      const history = await fetchRepoWeeklyMetrics(repo, from, to);
      if (history.length < 3) continue;

      const socialScore = socialScores.get(repo) ?? 0;
      const factors = computeFactors(history, socialScore);
      const score = scoreTrendingCandidate(factors);

      // Calculate approximate current stars from ClickHouse period data
      const totalPeriodStars = history.reduce((s, w) => s + w.new_stars, 0);

      if (score > 0.15) { // minimum threshold
        results.push({
          repo,
          currentStars: totalPeriodStars, // approximate
          predictionScore: score,
          factors,
          evidence: buildEvidence(factors),
        });
      }
    } catch (err) {
      console.warn(`  Warning: failed to analyze ${repo}: ${(err as Error).message}`);
    }
  }

  return results
    .sort((a, b) => b.predictionScore - a.predictionScore)
    .slice(0, topN);
}

// ─── 已火项目过滤 ──────────────────────────────────────────────

/**
 * 过滤掉已经上过 GitHub Trending 的项目
 */
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

export function formatTrendingPredictionReport(
  candidates: TrendingCandidate[],
  referenceDate?: string,
): string {
  const lines: string[] = [];
  const date = referenceDate ?? new Date().toISOString().slice(0, 10);

  lines.push('# 🔮 Augur 趋势项目预测');
  lines.push('');
  lines.push(`> 预测日期: ${date}`);
  lines.push(`> 模型: 多因子加速度评分 (Star/Fork/Issue/PR/贡献者/Release/社交热度)`);
  lines.push(`> 排除: 已上过 Trending 的项目`);
  lines.push('');
  lines.push('以下项目展现出"即将爆发"的早期信号，预测未来 1~4 周内可能登上 GitHub Trending：');
  lines.push('');

  lines.push('| # | 项目 | 预测得分 | Star加速 | Fork加速 | 多因子 | 关键证据 |');
  lines.push('|---|------|---------|---------|---------|--------|---------|');

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const topEvidence = c.evidence.slice(0, 2).join('; ') || '-';
    lines.push(
      `| ${i + 1} | **${c.repo}** | ${c.predictionScore.toFixed(2)} | ${c.factors.starVelocity}x | ${c.factors.forkAcceleration}x | ${c.factors.crossFactorCount} | ${topEvidence} |`,
    );
  }

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

  return lines.join('\n');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
