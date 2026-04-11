/**
 * Daily Brief 生成器
 *
 * 对比今日预测与历史数据，输出有新闻价值的增量信息。
 * 供 Crux 播客系统作为 Tier 0 数据源消费。
 *
 * 增量类型：
 * - new_entry:   首次进入预测榜的项目
 * - score_jump:  得分显著上升（>50%）的项目
 * - validated:   预测验证成功（实际上了 GitHub Trending）
 * - new_wave:    新发现的技术浪潮信号
 * - resurging:   大项目（>5k star）经历再爆发
 */

import type Database from 'better-sqlite3';
import type { TrendingCandidate } from '../predictor/trending-predictor.js';

export interface DailyBriefItem {
  type: 'new_entry' | 'score_jump' | 'validated' | 'new_wave' | 'resurging';
  repo?: string;
  title: string;
  summary: string;
  evidence: string[];
  score?: number;
  stars?: number;
  predicted_stars_4w?: number;
  url?: string;
}

export interface DailyBrief {
  date: string;
  items: DailyBriefItem[];
}

/**
 * 生成每日增量简报
 *
 * @param db SQLite 数据库
 * @param today 今日日期 YYYY-MM-DD
 * @param candidates 今日趋势预测候选
 * @param wavePredictions 今日浪潮预测（可选）
 */
export function generateDailyBrief(
  db: Database.Database,
  today: string,
  candidates: TrendingCandidate[],
  wavePredictions?: { wave: { name: string }; signalStrength: string; validation: { predictedEruptionDate: string | null; detectedSignals: { repo: string }[] } }[],
): DailyBrief {
  const items: DailyBriefItem[] = [];

  // ─── 1. 查历史预测，找增量 ───────────────────────────────────

  const previousPredictions = new Map<string, { score: number; predicted_at: string }>();
  try {
    const rows = db.prepare(`
      SELECT project_id, prediction_score, predicted_at
      FROM trending_predictions
      WHERE predicted_at < ?
      ORDER BY predicted_at DESC
    `).all(today) as { project_id: string; prediction_score: number; predicted_at: string }[];

    // 取每个项目最近一次的预测
    for (const r of rows) {
      if (!previousPredictions.has(r.project_id)) {
        previousPredictions.set(r.project_id, { score: r.prediction_score, predicted_at: r.predicted_at });
      }
    }
  } catch {
    // DB 可能为空，静默处理
  }

  for (const c of candidates) {
    const prev = previousPredictions.get(c.repo);

    // 再爆发项目（>5k star）
    if (c.lifetimeStars > 5000) {
      if (!prev) {
        items.push({
          type: 'resurging',
          repo: c.repo,
          title: `${c.repo} (${fmtStars(c.lifetimeStars)}★) 出现二次爆发信号`,
          summary: `拥有 ${fmtStars(c.lifetimeStars)} star 的成熟项目出现新一轮加速增长，预计 4 周内新增 ${fmtStars(c.kpi.predictedStars4w)} star。${c.evidence.slice(0, 2).join('，')}。`,
          evidence: c.evidence,
          score: c.predictionScore,
          stars: c.lifetimeStars,
          predicted_stars_4w: c.kpi.predictedStars4w,
          url: `https://github.com/${c.repo}`,
        });
      }
      continue;
    }

    // 全新项目（从未出现在预测中）
    if (!prev) {
      items.push({
        type: 'new_entry',
        repo: c.repo,
        title: `新发现：${c.repo} 展现爆发早期信号`,
        summary: `当前 ${fmtStars(c.lifetimeStars)} star，预测得分 ${c.predictionScore.toFixed(2)}，预计 4 周内新增 ${fmtStars(c.kpi.predictedStars4w)} star。${c.evidence.slice(0, 2).join('，')}。`,
        evidence: c.evidence,
        score: c.predictionScore,
        stars: c.lifetimeStars,
        predicted_stars_4w: c.kpi.predictedStars4w,
        url: `https://github.com/${c.repo}`,
      });
      continue;
    }

    // 得分显著跃升（>50%）
    if (prev.score > 0 && c.predictionScore / prev.score > 1.5) {
      items.push({
        type: 'score_jump',
        repo: c.repo,
        title: `${c.repo} 信号急剧增强`,
        summary: `预测得分从 ${prev.score.toFixed(2)} 跃升到 ${c.predictionScore.toFixed(2)}（+${((c.predictionScore / prev.score - 1) * 100).toFixed(0)}%），多个加速信号同时触发。`,
        evidence: c.evidence,
        score: c.predictionScore,
        stars: c.lifetimeStars,
        predicted_stars_4w: c.kpi.predictedStars4w,
        url: `https://github.com/${c.repo}`,
      });
    }
  }

  // ─── 2. 验证成功的预测 ──────────────────────────────────────

  try {
    const validated = db.prepare(`
      SELECT project_id, prediction_score, predicted_at, trended_at
      FROM trending_predictions
      WHERE actually_trended = 1
        AND trended_at >= date(?, '-3 days')
        AND trended_at <= ?
    `).all(today, today) as { project_id: string; prediction_score: number; predicted_at: string; trended_at: string }[];

    for (const v of validated) {
      items.push({
        type: 'validated',
        repo: v.project_id,
        title: `预测验证：${v.project_id} 成功登上 GitHub Trending`,
        summary: `我们在 ${v.predicted_at} 预测该项目将爆发（得分 ${v.prediction_score.toFixed(2)}），现已在 ${v.trended_at} 登上 GitHub Trending。`,
        evidence: ['预测验证成功'],
        score: v.prediction_score,
        url: `https://github.com/${v.project_id}`,
      });
    }
  } catch {
    // 静默处理
  }

  // ─── 3. 新浪潮信号 ─────────────────────────────────────────

  if (wavePredictions) {
    // 查上次的浪潮列表
    let previousWaves = new Set<string>();
    try {
      const prevWaveRows = db.prepare(`
        SELECT DISTINCT domain FROM domain_signals
        WHERE week < ?
        ORDER BY week DESC
        LIMIT 50
      `).all(today) as { domain: string }[];
      previousWaves = new Set(prevWaveRows.map((r) => r.domain));
    } catch {}

    for (const wp of wavePredictions) {
      if (wp.signalStrength === 'strong' && !previousWaves.has(wp.wave.name)) {
        const repos = wp.validation.detectedSignals.map((s) => s.repo).slice(0, 3);
        items.push({
          type: 'new_wave',
          title: `新技术浪潮信号：${wp.wave.name}`,
          summary: `检测到 "${wp.wave.name}" 浪潮的强信号，预测爆发时间 ${wp.validation.predictedEruptionDate ?? '待定'}。关键项目：${repos.join('、')}。`,
          evidence: [`信号强度: ${wp.signalStrength}`, `关键项目: ${repos.join(', ')}`],
        });
      }
    }
  }

  // 按新闻价值排序：validated > resurging > new_wave > score_jump > new_entry
  const typeOrder: Record<string, number> = { validated: 0, resurging: 1, new_wave: 2, score_jump: 3, new_entry: 4 };
  items.sort((a, b) => (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9));

  return { date: today, items };
}

function fmtStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
