/**
 * 域聚合层
 *
 * 将单个项目的信号数据按技术域聚合，
 * 产出域级视图：项目分布、指标汇总、层级结构。
 */

import type Database from 'better-sqlite3';

export interface DomainMetrics {
  totalStarAcceleration: number;
  coOccurrenceDensity: number;
  crossLayerLinkage: number;
  avgForkStarRatio: number;
  hnAttention: number;
  featureRequestVolume: number;
}

export interface DomainView {
  domain: string;
  week: string;
  projects: {
    infrastructure: string[];
    tooling: string[];
    application: string[];
  };
  totalProjects: number;
  metrics: DomainMetrics;
}

/**
 * 聚合所有域的视图
 */
export function aggregateDomains(db: Database.Database, week: string): DomainView[] {
  // Get all signals for this week
  const signals = db.prepare(`
    SELECT project_id, layer, domains, opportunity_score
    FROM signals WHERE week = ?
  `).all(week) as { project_id: string; layer: string; domains: string; opportunity_score: number }[];

  if (signals.length === 0) return [];

  // Group by domain
  const domainMap = new Map<string, {
    infrastructure: string[];
    tooling: string[];
    application: string[];
  }>();

  for (const sig of signals) {
    const domains: string[] = JSON.parse(sig.domains || '[]');
    for (const domain of domains) {
      if (!domainMap.has(domain)) {
        domainMap.set(domain, { infrastructure: [], tooling: [], application: [] });
      }
      const entry = domainMap.get(domain)!;
      const layer = sig.layer as 'infrastructure' | 'tooling' | 'application';
      if (entry[layer] && !entry[layer].includes(sig.project_id)) {
        entry[layer].push(sig.project_id);
      }
    }
  }

  // Compute metrics for each domain
  const results: DomainView[] = [];

  for (const [domain, projects] of domainMap) {
    const allProjectIds = [...projects.infrastructure, ...projects.tooling, ...projects.application];
    if (allProjectIds.length === 0) continue;

    const metrics = computeDomainMetrics(db, allProjectIds, domain, week);

    results.push({
      domain,
      week,
      projects,
      totalProjects: allProjectIds.length,
      metrics,
    });
  }

  return results.sort((a, b) => b.totalProjects - a.totalProjects);
}

function computeDomainMetrics(
  db: Database.Database,
  projectIds: string[],
  domain: string,
  week: string,
): DomainMetrics {
  // Star acceleration: sum of weekly star deltas for all projects
  let totalStarAccel = 0;
  let totalForkStarRatio = 0;
  let projectsWithData = 0;

  for (const pid of projectIds) {
    const latest = db.prepare(`
      SELECT stars, forks FROM snapshots
      WHERE project_id = ? ORDER BY captured_at DESC LIMIT 1
    `).get(pid) as { stars: number; forks: number } | undefined;

    const prev = db.prepare(`
      SELECT stars FROM snapshots
      WHERE project_id = ? AND captured_at < ?
      ORDER BY captured_at DESC LIMIT 1
    `).get(pid, week) as { stars: number } | undefined;

    if (latest) {
      if (prev) {
        totalStarAccel += (latest.stars - prev.stars);
      }
      if (latest.stars > 0) {
        totalForkStarRatio += latest.forks / latest.stars;
        projectsWithData++;
      }
    }
  }

  // Co-occurrence density: count keyword pairs within this domain's projects' keywords
  const readmeKeywords = db.prepare(`
    SELECT project_id, keywords FROM readmes
    WHERE project_id IN (${projectIds.map(() => '?').join(',')})
      AND keywords IS NOT NULL
  `).all(...projectIds) as { project_id: string; keywords: string }[];

  let coOccurrenceCount = 0;
  const allKeywords = new Set<string>();
  for (const r of readmeKeywords) {
    const kws: string[] = JSON.parse(r.keywords);
    kws.forEach(k => allKeywords.add(k));
  }
  // Density = pairs found / total possible pairs
  const coRows = db.prepare(`
    SELECT COUNT(*) as cnt FROM cooccurrences WHERE week = ?
  `).get(week) as { cnt: number };
  const totalPossiblePairs = allKeywords.size * (allKeywords.size - 1) / 2;
  const coOccurrenceDensity = totalPossiblePairs > 0
    ? Math.min(coRows.cnt / totalPossiblePairs, 1.0)
    : 0;

  // Cross-layer linkage: how many tooling projects reference infrastructure projects
  // Simplified: check if tooling READMEs mention infrastructure project names
  let crossLayerLinkage = 0;
  // Will be computed in phase detector where we have layer info

  // HN attention: count HN posts mentioning domain-related keywords
  const hnCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM hn_posts
    WHERE (title LIKE ? OR url LIKE ?)
      AND captured_at >= date(?, '-7 days')
  `).get(`%${domain}%`, `%${domain}%`, week) as { cnt: number };

  // Feature request volume from issues table
  const frCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM issues
    WHERE project_id IN (${projectIds.map(() => '?').join(',')})
      AND category = 'feature_request'
  `).get(...projectIds) as { cnt: number } | undefined;

  return {
    totalStarAcceleration: totalStarAccel,
    coOccurrenceDensity,
    crossLayerLinkage,
    avgForkStarRatio: projectsWithData > 0 ? totalForkStarRatio / projectsWithData : 0,
    hnAttention: hnCount.cnt,
    featureRequestVolume: frCount?.cnt ?? 0,
  };
}
