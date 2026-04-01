import type Database from 'better-sqlite3';
import { getTrendingProjects, getWeeklyStarDeltas, type Snapshot, type Project } from '../store/queries.js';
import { analyzeGrowth, type GrowthPattern } from '../analyzer/growth-classifier.js';
import type { SignalClassification } from '../analyzer/signal-tagger.js';
import { scoreOpportunity, type ScoringResult } from './scorer.js';

export interface ReportEntry {
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
  signal?: SignalClassification;
  score?: ScoringResult;
}

function getISOWeek(date: Date): string {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * 收集周报数据（不含 LLM 分析）
 */
export function collectReportData(db: Database.Database, date?: string): ReportEntry[] {
  const today = date ?? new Date().toISOString().slice(0, 10);

  const recentDays = db.prepare(`
    SELECT DISTINCT captured_at FROM snapshots
    WHERE captured_at >= date(?, '-7 days') AND captured_at <= ?
    ORDER BY captured_at DESC
  `).all(today, today) as { captured_at: string }[];

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

  return [...projectMap.values()].sort((a, b) => a.trendingRank - b.trendingRank);
}

/**
 * 将 LLM 分类结果注入到报告条目中
 */
export function enrichWithSignals(
  entries: ReportEntry[],
  classifications: SignalClassification[],
): void {
  const classMap = new Map(classifications.map(c => [c.projectId, c]));
  for (const entry of entries) {
    const signal = classMap.get(entry.id);
    if (signal) {
      entry.signal = signal;

      // Compute opportunity score
      const forkStarRatio = entry.stars > 0 ? entry.forks / entry.stars : 0;
      entry.score = scoreOpportunity({
        projectId: entry.id,
        layer: signal.layer,
        growthPattern: entry.growth.pattern,
        forkStarRatio,
        weeklyIssueDelta: 0, // TODO: enrich from snapshots
        weeklyStarDelta: entry.growth.meanDelta,
        hasStrongSignal: false, // TODO: multi-factor detection
        domains: signal.domains,
      });
    }
  }
}

/**
 * 生成 Markdown 周报
 */
export function generateWeeklyReport(db: Database.Database, date?: string): string {
  const today = date ?? new Date().toISOString().slice(0, 10);
  const weekLabel = getISOWeek(new Date(today));
  const entries = collectReportData(db, today);

  return formatReport(entries, weekLabel, today);
}

export function formatReport(entries: ReportEntry[], weekLabel: string, date: string): string {
  const lines: string[] = [];
  lines.push(`# Augur 周报 — ${weekLabel}`);
  lines.push('');
  lines.push(`> 生成日期：${date} | 项目数量：${entries.length}`);
  lines.push('');

  if (entries.length === 0) {
    lines.push('本周暂无采集数据。请先运行 `augur collect` 采集数据。');
    return lines.join('\n');
  }

  const hasSignals = entries.some(e => e.signal);

  if (hasSignals) {
    // ─── 按评分排序的完整报告 ───
    const scored = entries.filter(e => e.score).sort((a, b) => (b.score!.opportunityScore - a.score!.opportunityScore));
    const unscored = entries.filter(e => !e.score);

    if (scored.length > 0) {
      // Top signals
      const top = scored.slice(0, 5);
      lines.push('## 本周高价值信号');
      lines.push('');
      for (const e of top) {
        lines.push(formatRichEntry(e));
        lines.push('');
      }

      // By layer
      for (const [layer, label] of [['infrastructure', '基础设施层'], ['tooling', '工具层'], ['application', '应用层']] as const) {
        const layerEntries = scored.filter(e => e.signal?.layer === layer);
        if (layerEntries.length > 0) {
          lines.push(`## ${label}`);
          lines.push('');
          for (const e of layerEntries) {
            lines.push(formatSimpleEntry(e));
          }
          lines.push('');
        }
      }
    }

    if (unscored.length > 0) {
      lines.push('## 未分类项目');
      lines.push('');
      for (const e of unscored) {
        lines.push(formatBasicEntry(e));
      }
      lines.push('');
    }
  } else {
    // ─── 基础报告（无 LLM 分析）───
    const grouped = groupByGrowth(entries);
    for (const [pattern, label] of [
      ['staircase', '阶梯型增长（高关注）'],
      ['steady', '稳定增长'],
      ['spike', '峰值型（短期热度）'],
      ['declining', '下降趋势'],
    ] as const) {
      const group = grouped.get(pattern);
      if (group && group.length > 0) {
        lines.push(`## ${label}`);
        lines.push('');
        for (const e of group) {
          lines.push(formatBasicEntry(e));
        }
        lines.push('');
      }
    }
  }

  // Stats
  lines.push('---');
  lines.push('');
  lines.push('## 统计');
  lines.push('');

  if (hasSignals) {
    const layers = { infrastructure: 0, tooling: 0, application: 0 };
    for (const e of entries) {
      if (e.signal) layers[e.signal.layer]++;
    }
    lines.push('| 信号层级 | 数量 |');
    lines.push('|----------|------|');
    lines.push(`| 基础设施 | ${layers.infrastructure} |`);
    lines.push(`| 工具层 | ${layers.tooling} |`);
    lines.push(`| 应用层 | ${layers.application} |`);
  } else {
    const patterns = { staircase: 0, steady: 0, spike: 0, declining: 0 };
    for (const e of entries) {
      patterns[e.growth.pattern]++;
    }
    lines.push('| 增长模式 | 数量 |');
    lines.push('|----------|------|');
    lines.push(`| 阶梯型 | ${patterns.staircase} |`);
    lines.push(`| 稳定型 | ${patterns.steady} |`);
    lines.push(`| 峰值型 | ${patterns.spike} |`);
    lines.push(`| 下降型 | ${patterns.declining} |`);
  }
  lines.push('');

  return lines.join('\n');
}

function formatRichEntry(e: ReportEntry): string {
  const lines: string[] = [];
  const lang = e.language ? ` \`${e.language}\`` : '';
  const score = e.score ? ` | 机会评分: **${e.score.opportunityScore}** (置信度 ${e.score.confidence})` : '';
  const layer = e.signal ? ` | ${({ infrastructure: '基础设施', tooling: '工具', application: '应用' })[e.signal.layer]}层` : '';
  const domains = e.signal?.domains.length ? ` | 域: ${e.signal.domains.join(', ')}` : '';

  lines.push(`### [${e.id}](https://github.com/${e.id})${lang} ★${e.stars.toLocaleString()}`);
  lines.push(`${layer}${score}${domains}`);
  if (e.description) lines.push(`> ${e.description}`);
  if (e.signal?.reasoning) lines.push(`> 分类理由: ${e.signal.reasoning}`);

  const growth = e.growth.totalGrowth > 0
    ? `增长模式: ${e.growth.pattern} | 近期 +${e.growth.totalGrowth}★ | 周均 +${e.growth.meanDelta}★`
    : `增长模式: ${e.growth.pattern}`;
  lines.push(`- ${growth}`);

  const fsr = e.stars > 0 ? (e.forks / e.stars).toFixed(2) : '0';
  lines.push(`- Fork/Star 比: ${fsr}`);

  return lines.join('\n');
}

function formatSimpleEntry(e: ReportEntry): string {
  const lang = e.language ? ` \`${e.language}\`` : '';
  const score = e.score ? ` (评分 ${e.score.opportunityScore})` : '';
  const domains = e.signal?.domains.length ? ` [${e.signal.domains.join(', ')}]` : '';
  const desc = e.description ? ` — ${e.description}` : '';
  return `- **[${e.id}](https://github.com/${e.id})**${lang} ★${e.stars.toLocaleString()}${score}${domains}${desc}`;
}

function formatBasicEntry(e: ReportEntry): string {
  const lang = e.language ? ` \`${e.language}\`` : '';
  const desc = e.description ? ` — ${e.description}` : '';
  const growth = e.growth.totalGrowth > 0
    ? ` (近期 +${e.growth.totalGrowth}★, 周均 +${e.growth.meanDelta}★)`
    : '';
  return `- **[${e.id}](https://github.com/${e.id})**${lang} ★${e.stars.toLocaleString()}${growth}${desc}`;
}

function groupByGrowth(entries: ReportEntry[]): Map<GrowthPattern, ReportEntry[]> {
  const map = new Map<GrowthPattern, ReportEntry[]>();
  for (const e of entries) {
    const list = map.get(e.growth.pattern) ?? [];
    list.push(e);
    map.set(e.growth.pattern, list);
  }
  return map;
}
