import type Database from 'better-sqlite3';
import { normalizeRepoId } from '../util/math.js';

export interface Project {
  id: string;
  language: string | null;
  topics: string | null;
  description: string | null;
  created_at: string | null;
  first_seen_at: string;
}

export interface Snapshot {
  project_id: string;
  captured_at: string;
  stars: number | null;
  forks: number | null;
  open_issues: number | null;
  trending_rank: number | null;
  trending_period: string | null;
  source: string;
}

export interface Readme {
  project_id: string;
  content: string;
  keywords: string | null;
  updated_at: string;
}

export function upsertProject(db: Database.Database, project: Project): void {
  project = { ...project, id: normalizeRepoId(project.id) };
  db.prepare(`
    INSERT INTO projects (id, language, topics, description, created_at, first_seen_at)
    VALUES (@id, @language, @topics, @description, @created_at, @first_seen_at)
    ON CONFLICT(id) DO UPDATE SET
      language = COALESCE(excluded.language, projects.language),
      topics = COALESCE(excluded.topics, projects.topics),
      description = COALESCE(excluded.description, projects.description),
      created_at = COALESCE(excluded.created_at, projects.created_at)
  `).run(project);
}

export function upsertSnapshot(db: Database.Database, snapshot: Snapshot): void {
  snapshot = { ...snapshot, project_id: normalizeRepoId(snapshot.project_id) };
  db.prepare(`
    INSERT INTO snapshots (project_id, captured_at, stars, forks, open_issues, trending_rank, trending_period, source)
    VALUES (@project_id, @captured_at, @stars, @forks, @open_issues, @trending_rank, @trending_period, @source)
    ON CONFLICT(project_id, captured_at) DO UPDATE SET
      stars = COALESCE(excluded.stars, snapshots.stars),
      forks = COALESCE(excluded.forks, snapshots.forks),
      open_issues = COALESCE(excluded.open_issues, snapshots.open_issues),
      trending_rank = COALESCE(excluded.trending_rank, snapshots.trending_rank),
      trending_period = COALESCE(excluded.trending_period, snapshots.trending_period),
      source = CASE WHEN excluded.source = 'api' THEN 'api' ELSE snapshots.source END
  `).run(snapshot);
}

export function upsertReadme(db: Database.Database, readme: Readme): void {
  readme = { ...readme, project_id: normalizeRepoId(readme.project_id) };
  db.prepare(`
    INSERT INTO readmes (project_id, content, keywords, updated_at)
    VALUES (@project_id, @content, @keywords, @updated_at)
    ON CONFLICT(project_id) DO UPDATE SET
      content = excluded.content,
      keywords = excluded.keywords,
      updated_at = excluded.updated_at
  `).run(readme);
}

export function getProject(db: Database.Database, id: string): Project | undefined {
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Project | undefined;
}

export function getRecentSnapshots(db: Database.Database, projectId: string, weeks: number): Snapshot[] {
  const daysAgo = weeks * 7;
  return db.prepare(`
    SELECT * FROM snapshots
    WHERE project_id = ?
      AND captured_at >= date('now', '-' || ? || ' days')
    ORDER BY captured_at ASC
  `).all(projectId, daysAgo) as Snapshot[];
}

export function getWeeklyStarDeltas(db: Database.Database, projectId: string, weeks: number): { week: string; delta: number }[] {
  const daysAgo = weeks * 7;
  return db.prepare(`
    WITH weekly AS (
      SELECT
        strftime('%Y-W%W', captured_at) AS week,
        MAX(stars) - MIN(stars) AS delta
      FROM snapshots
      WHERE project_id = ?
        AND captured_at >= date('now', '-' || ? || ' days')
      GROUP BY week
    )
    SELECT week, delta FROM weekly ORDER BY week ASC
  `).all(projectId, daysAgo) as { week: string; delta: number }[];
}

export function getAllProjectIds(db: Database.Database): string[] {
  return (db.prepare('SELECT id FROM projects').all() as { id: string }[]).map(r => r.id);
}

export function getLatestSnapshot(db: Database.Database, projectId: string): Snapshot | undefined {
  return db.prepare(`
    SELECT * FROM snapshots WHERE project_id = ? ORDER BY captured_at DESC LIMIT 1
  `).get(projectId) as Snapshot | undefined;
}

export function getTrendingProjects(db: Database.Database, date: string): (Project & Snapshot)[] {
  return db.prepare(`
    SELECT p.*, s.stars, s.forks, s.open_issues, s.trending_rank, s.trending_period, s.captured_at, s.source
    FROM snapshots s
    JOIN projects p ON p.id = s.project_id
    WHERE s.captured_at = ? AND s.trending_rank IS NOT NULL
    ORDER BY s.trending_rank ASC
  `).all(date) as (Project & Snapshot)[];
}

// ─── Social Buzz ─────────────────────────────────────────────────

export interface SocialBuzzEntry {
  id: string;
  source: string;
  title: string;
  url: string | null;
  score: number;
  comments: number;
  subreddit: string | null;
  tags: string | null;
  github_repo: string | null;
  captured_at: string;
}

export function upsertSocialBuzz(db: Database.Database, entry: SocialBuzzEntry): void {
  if (entry.github_repo) entry = { ...entry, github_repo: normalizeRepoId(entry.github_repo) };
  db.prepare(`
    INSERT INTO social_buzz (id, source, title, url, score, comments, subreddit, tags, github_repo, captured_at)
    VALUES (@id, @source, @title, @url, @score, @comments, @subreddit, @tags, @github_repo, @captured_at)
    ON CONFLICT(id) DO UPDATE SET
      score = MAX(social_buzz.score, excluded.score),
      comments = MAX(social_buzz.comments, excluded.comments)
  `).run(entry);
}

/**
 * Batch insert social buzz entries in a single transaction.
 * Avoids 100+ individual fsyncs — single prepare, single transaction.
 */
export function batchUpsertSocialBuzz(db: Database.Database, entries: SocialBuzzEntry[]): void {
  if (entries.length === 0) return;
  const stmt = db.prepare(`
    INSERT INTO social_buzz (id, source, title, url, score, comments, subreddit, tags, github_repo, captured_at)
    VALUES (@id, @source, @title, @url, @score, @comments, @subreddit, @tags, @github_repo, @captured_at)
    ON CONFLICT(id) DO UPDATE SET
      score = MAX(social_buzz.score, excluded.score),
      comments = MAX(social_buzz.comments, excluded.comments)
  `);
  const tx = db.transaction((items: SocialBuzzEntry[]) => {
    for (const entry of items) {
      const normalized = entry.github_repo
        ? { ...entry, github_repo: normalizeRepoId(entry.github_repo) }
        : entry;
      stmt.run(normalized);
    }
  });
  tx(entries);
}


// ─── Trending Predictions ────────────────────────────────────────

export interface TrendingPrediction {
  project_id: string;
  predicted_at: string;
  prediction_score: number;
  factors: string;
  star_velocity: number;
  social_buzz_score: number;
  fork_acceleration: number;
  issue_acceleration: number;
  actually_trended: number;
  trended_at: string | null;
}

export function upsertTrendingPrediction(db: Database.Database, pred: TrendingPrediction): void {
  pred = { ...pred, project_id: normalizeRepoId(pred.project_id) };
  db.prepare(`
    INSERT INTO trending_predictions (project_id, predicted_at, prediction_score, factors, star_velocity, social_buzz_score, fork_acceleration, issue_acceleration, actually_trended, trended_at)
    VALUES (@project_id, @predicted_at, @prediction_score, @factors, @star_velocity, @social_buzz_score, @fork_acceleration, @issue_acceleration, @actually_trended, @trended_at)
    ON CONFLICT(project_id, predicted_at) DO UPDATE SET
      prediction_score = excluded.prediction_score,
      factors = excluded.factors,
      star_velocity = excluded.star_velocity,
      social_buzz_score = excluded.social_buzz_score,
      fork_acceleration = excluded.fork_acceleration,
      issue_acceleration = excluded.issue_acceleration,
      actually_trended = excluded.actually_trended,
      trended_at = excluded.trended_at
  `).run(pred);
}

