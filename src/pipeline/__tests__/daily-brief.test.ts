import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { generateDailyBrief, type DailyBriefItem } from '../daily-brief.js';
import type { TrendingCandidate } from '../../predictor/trending-predictor.js';

function makeCandidate(overrides: Partial<TrendingCandidate> & { repo: string }): TrendingCandidate {
  return {
    lifetimeStars: 1000,
    recentStars8w: 200,
    predictionScore: 0.5,
    factors: {
      starVelocity: 2.0, forkAcceleration: 1.5, issueAcceleration: 1.0,
      prAcceleration: 1.0, contributorGrowth: 1.0, releaseFrequency: 1,
      socialBuzzScore: 20, crossFactorCount: 3,
    },
    kpi: {
      predictedStars4w: 500, predictedForks4w: 50, predictedIssues4w: 30,
      predictedPRs4w: 10, estimatedTotalStars4w: 1500,
      weeklyStarRun: [100, 120, 140, 160], weeklyForkRun: [10, 12, 14, 16],
      communityScore: 60, growthMomentum: 'accelerating',
    },
    evidence: ['Star 加速 2.0x', 'Fork 加速 1.5x', '3 个因子同时加速'],
    ...overrides,
  };
}

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE trending_predictions (
      project_id TEXT NOT NULL,
      predicted_at TEXT NOT NULL,
      prediction_score REAL,
      factors TEXT,
      star_velocity REAL,
      social_buzz_score REAL,
      fork_acceleration REAL,
      issue_acceleration REAL,
      actually_trended INTEGER DEFAULT 0,
      trended_at TEXT,
      PRIMARY KEY (project_id, predicted_at)
    );
    CREATE TABLE domain_signals (
      domain TEXT NOT NULL,
      week TEXT NOT NULL,
      infra_count INTEGER,
      tooling_count INTEGER,
      app_count INTEGER,
      metrics TEXT,
      prediction TEXT,
      PRIMARY KEY (domain, week)
    );
  `);
  return db;
}

describe('generateDailyBrief', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('空候选列表应返回空 items', () => {
    const brief = generateDailyBrief(db, '2026-04-11', []);
    expect(brief.date).toBe('2026-04-11');
    expect(brief.items).toEqual([]);
  });

  it('全新项目应标记为 new_entry', () => {
    const candidates = [makeCandidate({ repo: 'foo/bar', lifetimeStars: 800 })];
    const brief = generateDailyBrief(db, '2026-04-11', candidates);

    expect(brief.items.length).toBe(1);
    expect(brief.items[0].type).toBe('new_entry');
    expect(brief.items[0].repo).toBe('foo/bar');
    expect(brief.items[0].title).toContain('foo/bar');
    expect(brief.items[0].url).toBe('https://github.com/foo/bar');
    expect(brief.items[0].summary).toContain('800');
  });

  it('已有历史预测且得分无显著变化的项目不应出现', () => {
    db.prepare(`
      INSERT INTO trending_predictions (project_id, predicted_at, prediction_score)
      VALUES ('foo/bar', '2026-04-10', 0.5)
    `).run();

    const candidates = [makeCandidate({ repo: 'foo/bar', predictionScore: 0.55 })];
    const brief = generateDailyBrief(db, '2026-04-11', candidates);

    expect(brief.items.length).toBe(0);
  });

  it('得分跃升 >50% 应标记为 score_jump', () => {
    db.prepare(`
      INSERT INTO trending_predictions (project_id, predicted_at, prediction_score)
      VALUES ('foo/bar', '2026-04-10', 0.3)
    `).run();

    const candidates = [makeCandidate({ repo: 'foo/bar', predictionScore: 0.6 })];
    const brief = generateDailyBrief(db, '2026-04-11', candidates);

    expect(brief.items.length).toBe(1);
    expect(brief.items[0].type).toBe('score_jump');
    expect(brief.items[0].summary).toContain('0.30');
    expect(brief.items[0].summary).toContain('0.60');
  });

  it('>5000 star 的项目首次出现应标记为 resurging', () => {
    const candidates = [makeCandidate({ repo: 'big/project', lifetimeStars: 53000 })];
    const brief = generateDailyBrief(db, '2026-04-11', candidates);

    expect(brief.items.length).toBe(1);
    expect(brief.items[0].type).toBe('resurging');
    expect(brief.items[0].title).toContain('二次爆发');
    expect(brief.items[0].stars).toBe(53000);
  });

  it('>5000 star 但已有历史预测的项目不应重复输出', () => {
    db.prepare(`
      INSERT INTO trending_predictions (project_id, predicted_at, prediction_score)
      VALUES ('big/project', '2026-04-10', 0.4)
    `).run();

    const candidates = [makeCandidate({ repo: 'big/project', lifetimeStars: 53000 })];
    const brief = generateDailyBrief(db, '2026-04-11', candidates);

    expect(brief.items.length).toBe(0);
  });

  it('验证成功的预测应标记为 validated', () => {
    db.prepare(`
      INSERT INTO trending_predictions (project_id, predicted_at, prediction_score, actually_trended, trended_at)
      VALUES ('hot/repo', '2026-04-05', 0.7, 1, '2026-04-10')
    `).run();

    const brief = generateDailyBrief(db, '2026-04-11', []);

    expect(brief.items.length).toBe(1);
    expect(brief.items[0].type).toBe('validated');
    expect(brief.items[0].repo).toBe('hot/repo');
    expect(brief.items[0].summary).toContain('2026-04-05');
    expect(brief.items[0].summary).toContain('GitHub Trending');
  });

  it('超过 3 天前的验证不应出现', () => {
    db.prepare(`
      INSERT INTO trending_predictions (project_id, predicted_at, prediction_score, actually_trended, trended_at)
      VALUES ('old/validated', '2026-04-01', 0.7, 1, '2026-04-05')
    `).run();

    const brief = generateDailyBrief(db, '2026-04-11', []);
    expect(brief.items.length).toBe(0);
  });

  it('新浪潮信号应标记为 new_wave', () => {
    const wavePredictions = [{
      wave: { name: 'Embodied AI' },
      signalStrength: 'strong' as const,
      validation: {
        predictedEruptionDate: '2026-06-15',
        detectedSignals: [{ repo: 'robot/arm' }, { repo: 'sim/env' }],
      },
    }];

    const brief = generateDailyBrief(db, '2026-04-11', [], wavePredictions);

    expect(brief.items.length).toBe(1);
    expect(brief.items[0].type).toBe('new_wave');
    expect(brief.items[0].title).toContain('Embodied AI');
    expect(brief.items[0].summary).toContain('2026-06-15');
  });

  it('弱信号浪潮不应出现', () => {
    const wavePredictions = [{
      wave: { name: 'Weak Wave' },
      signalStrength: 'weak' as const,
      validation: {
        predictedEruptionDate: null,
        detectedSignals: [{ repo: 'a/b' }],
      },
    }];

    const brief = generateDailyBrief(db, '2026-04-11', [], wavePredictions);
    expect(brief.items.length).toBe(0);
  });

  it('多种类型混合时应按新闻价值排序', () => {
    // validated
    db.prepare(`
      INSERT INTO trending_predictions (project_id, predicted_at, prediction_score, actually_trended, trended_at)
      VALUES ('v/repo', '2026-04-05', 0.7, 1, '2026-04-10')
    `).run();

    const candidates = [
      makeCandidate({ repo: 'new/project', lifetimeStars: 500 }),       // new_entry
      makeCandidate({ repo: 'big/one', lifetimeStars: 20000 }),          // resurging
    ];

    const wavePredictions = [{
      wave: { name: 'New Wave' },
      signalStrength: 'strong' as const,
      validation: { predictedEruptionDate: '2026-07-01', detectedSignals: [{ repo: 'w/r' }] },
    }];

    const brief = generateDailyBrief(db, '2026-04-11', candidates, wavePredictions);

    expect(brief.items.length).toBe(4);
    // 排序: validated → resurging → new_wave → new_entry
    expect(brief.items[0].type).toBe('validated');
    expect(brief.items[1].type).toBe('resurging');
    expect(brief.items[2].type).toBe('new_wave');
    expect(brief.items[3].type).toBe('new_entry');
  });

  it('evidence 和 url 应正确填充', () => {
    const candidates = [makeCandidate({
      repo: 'test/repo',
      lifetimeStars: 2000,
      evidence: ['Star 加速 3.0x', 'Fork 加速 2.0x'],
    })];
    const brief = generateDailyBrief(db, '2026-04-11', candidates);

    const item = brief.items[0];
    expect(item.evidence).toEqual(['Star 加速 3.0x', 'Fork 加速 2.0x']);
    expect(item.url).toBe('https://github.com/test/repo');
    expect(item.predicted_stars_4w).toBe(500);
  });
});
