import type Database from 'better-sqlite3';
import { getTrendingProjects, getWeeklyStarDeltas } from '../store/queries.js';
import { analyzeGrowth, type GrowthPattern } from '../analyzer/growth-classifier.js';

interface ReportEntry {
  id: string;
  description: string | null;
  language: string | null;
  stars: number;
  forks: number;
  trendingRank: number;
  growth: {
    pattern: GrowthPattern;
    meanDelta: number;
    totalGrowth: number;
    volatility: number;
  };
}

function getISOWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

export function generateWeeklyReport(db: Database.Database, date?: string): string {
  const today = date ?? new Date().toISOString().slice(0, 10);
  const weekLabel = getISOWeek(new Date(today));

  // Get all snapshots from the last 7 days
  const recentDays = db.prepare(`
    SELECT DISTINCT captured_at FROM snapshots
    WHERE captured_at >= date(?, '-7 days') AND captured_at <= ?
    ORDER BY captured_at DESC
  `).all(today, today) as { captured_at: string }[];

  // Collect all trending projects from the past week
  const projectMap = new Map<string, ReportEntry>();
  for (const { captured_at } of recentDays) {
    const trending = getTrendingProjects(db, captured_at);
    for (const p of trending) {
      if (projectMap.has(p.id)) continue;

      const deltas = getWeeklyStarDeltas(db, p.id, 8);
      const deltaValues = deltas.map(d => d.delta);
      const growth = analyzeGrowth(deltaValues);

      projectMap.set(p.id, {
        id: p.id,
        description: p.description,
        language: p.language,
        stars: p.stars ?? 0,
        forks: p.forks ?? 0,
        trendingRank: p.trending_rank ?? 99,
        growth: {
          pattern: growth.pattern,
          meanDelta: growth.meanDelta,
          totalGrowth: growth.totalGrowth,
          volatility: growth.volatility,
        },
      });
    }
  }

  const entries = [...projectMap.values()].sort((a, b) => a.trendingRank - b.trendingRank);

  // Build markdown report
  const lines: string[] = [];
  lines.push(`# Augur 周报 — ${weekLabel}`);
  lines.push('');
  lines.push(`> 生成日期：${today} | 项目数量：${entries.length}`);
  lines.push('');

  if (entries.length === 0) {
    lines.push('本周暂无采集数据。请先运行 `augur collect` 采集数据。');
    return lines.join('\n');
  }

  // Group by growth pattern
  const staircase = entries.filter(e => e.growth.pattern === 'staircase');
  const steady = entries.filter(e => e.growth.pattern === 'steady');
  const spike = entries.filter(e => e.growth.pattern === 'spike');
  const declining = entries.filter(e => e.growth.pattern === 'declining');

  if (staircase.length > 0) {
    lines.push('## 阶梯型增长（高关注）');
    lines.push('');
    for (const e of staircase) {
      lines.push(formatEntry(e));
    }
    lines.push('');
  }

  if (steady.length > 0) {
    lines.push('## 稳定增长');
    lines.push('');
    for (const e of steady) {
      lines.push(formatEntry(e));
    }
    lines.push('');
  }

  if (spike.length > 0) {
    lines.push('## 峰值型（短期热度）');
    lines.push('');
    for (const e of spike) {
      lines.push(formatEntry(e));
    }
    lines.push('');
  }

  if (declining.length > 0) {
    lines.push('## 下降趋势');
    lines.push('');
    for (const e of declining) {
      lines.push(formatEntry(e));
    }
    lines.push('');
  }

  // Summary stats
  lines.push('---');
  lines.push('');
  lines.push('## 统计');
  lines.push('');
  lines.push(`| 增长模式 | 数量 |`);
  lines.push(`|----------|------|`);
  lines.push(`| 阶梯型 | ${staircase.length} |`);
  lines.push(`| 稳定型 | ${steady.length} |`);
  lines.push(`| 峰值型 | ${spike.length} |`);
  lines.push(`| 下降型 | ${declining.length} |`);
  lines.push('');

  return lines.join('\n');
}

function formatEntry(e: ReportEntry): string {
  const lang = e.language ? ` \`${e.language}\`` : '';
  const desc = e.description ? ` — ${e.description}` : '';
  const growth = e.growth.totalGrowth > 0
    ? ` (近期 +${e.growth.totalGrowth}★, 周均 +${e.growth.meanDelta}★)`
    : '';
  return `- **[${e.id}](https://github.com/${e.id})**${lang} ★${e.stars.toLocaleString()}${growth}${desc}`;
}
