import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, '../../data');

export function getDb(dbPath?: string): Database.Database {
  const resolvedPath = dbPath ?? path.join(DATA_DIR, 'augur.db');
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      language TEXT,
      topics TEXT,
      description TEXT,
      created_at TEXT,
      first_seen_at TEXT
    );

    CREATE TABLE IF NOT EXISTS snapshots (
      project_id TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      stars INTEGER,
      forks INTEGER,
      open_issues INTEGER,
      trending_rank INTEGER,
      trending_period TEXT,
      source TEXT,
      PRIMARY KEY (project_id, captured_at),
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS readmes (
      project_id TEXT PRIMARY KEY,
      content TEXT,
      keywords TEXT,
      updated_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS signals (
      project_id TEXT NOT NULL,
      week TEXT NOT NULL,
      layer TEXT,
      growth_pattern TEXT,
      domains TEXT,
      confidence REAL,
      opportunity_score REAL,
      raw_analysis TEXT,
      PRIMARY KEY (project_id, week)
    );

    CREATE TABLE IF NOT EXISTS cooccurrences (
      keyword1 TEXT NOT NULL,
      keyword2 TEXT NOT NULL,
      week TEXT NOT NULL,
      count INTEGER,
      strength REAL,
      first_seen_at TEXT,
      PRIMARY KEY (keyword1, keyword2, week)
    );

    CREATE TABLE IF NOT EXISTS issues (
      id INTEGER PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT,
      body TEXT,
      labels TEXT,
      category TEXT,
      captured_at TEXT,
      FOREIGN KEY (project_id) REFERENCES projects(id)
    );

    CREATE TABLE IF NOT EXISTS hn_posts (
      id INTEGER PRIMARY KEY,
      title TEXT,
      url TEXT,
      points INTEGER,
      comments INTEGER,
      captured_at TEXT,
      keywords TEXT
    );

    CREATE TABLE IF NOT EXISTS domain_signals (
      domain TEXT NOT NULL,
      week TEXT NOT NULL,
      phase INTEGER,
      ssi REAL,
      project_count INTEGER,
      infra_count INTEGER,
      tooling_count INTEGER,
      app_count INTEGER,
      metrics TEXT,
      prediction TEXT,
      PRIMARY KEY (domain, week)
    );

    CREATE TABLE IF NOT EXISTS social_buzz (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT,
      url TEXT,
      score INTEGER,
      comments INTEGER,
      subreddit TEXT,
      tags TEXT,
      github_repo TEXT,
      captured_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trending_predictions (
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

    CREATE INDEX IF NOT EXISTS idx_snapshots_date ON snapshots(captured_at);
    CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_domain_signals_week ON domain_signals(week);
    CREATE INDEX IF NOT EXISTS idx_social_buzz_repo ON social_buzz(github_repo);
    CREATE INDEX IF NOT EXISTS idx_social_buzz_date ON social_buzz(captured_at);
    CREATE INDEX IF NOT EXISTS idx_trending_predictions_date ON trending_predictions(predicted_at);
  `);
}
