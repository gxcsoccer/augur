#!/usr/bin/env node

import { Command } from 'commander';
import { getDb, initSchema } from './store/schema.js';
import { upsertProject, upsertSnapshot, upsertReadme, type Project, type Snapshot } from './store/queries.js';
import { fetchTrending } from './collector/github-trending.js';
import { fetchRepoDetails, fetchReadme, getRateLimitInfo } from './collector/github-api.js';
import { generateWeeklyReport } from './predictor/report-generator.js';
import { BACKTEST_TARGETS, runBacktest, formatFullBacktestReport } from './predictor/backtest.js';

const program = new Command();

program
  .name('augur')
  .description('开源信号情报系统 — 识别技术浪潮先导信号')
  .version('0.1.0');

// ─── augur collect ──────────────────────────────────────────────
program
  .command('collect')
  .description('采集 GitHub Trending 数据并补充项目详情')
  .option('-p, --period <period>', 'Trending 周期: daily, weekly, monthly', 'daily')
  .option('--no-details', '跳过 GitHub API 详情补充')
  .option('--no-readme', '跳过 README 采集')
  .action(async (opts: { period: string; details: boolean; readme: boolean }) => {
    const db = getDb();
    initSchema(db);
    const today = new Date().toISOString().slice(0, 10);
    const period = opts.period as 'daily' | 'weekly' | 'monthly';

    // Step 1: Fetch trending
    console.log(`[Collect] 正在采集 GitHub Trending (${period})...`);
    const trending = await fetchTrending(period);
    console.log(`[Collect] 发现 ${trending.length} 个项目`);

    for (const repo of trending) {
      const project: Project = {
        id: repo.id,
        language: repo.language,
        topics: null,
        description: repo.description,
        created_at: null,
        first_seen_at: today,
      };
      upsertProject(db, project);

      const snapshot: Snapshot = {
        project_id: repo.id,
        captured_at: today,
        stars: repo.totalStars,
        forks: repo.forks,
        open_issues: null,
        trending_rank: repo.rank,
        trending_period: period,
        source: 'trending',
      };
      upsertSnapshot(db, snapshot);
    }

    console.log(`[Collect] 已保存 ${trending.length} 个项目快照`);

    // Step 2: Fetch details from GitHub API
    if (opts.details) {
      console.log('[Collect] 正在补充项目详情...');
      let enriched = 0;
      for (const repo of trending) {
        const details = await fetchRepoDetails(repo.id);
        if (!details) continue;

        upsertProject(db, {
          id: details.id,
          language: details.language,
          topics: JSON.stringify(details.topics),
          description: details.description,
          created_at: details.createdAt,
          first_seen_at: today,
        });

        upsertSnapshot(db, {
          project_id: details.id,
          captured_at: today,
          stars: details.stars,
          forks: details.forks,
          open_issues: details.openIssues,
          trending_rank: repo.rank,
          trending_period: period,
          source: 'api',
        });

        enriched++;
      }

      const limit = getRateLimitInfo();
      console.log(`[Collect] 已补充 ${enriched} 个项目详情 (API 余量: ${limit.remaining})`);
    }

    // Step 3: Fetch READMEs
    if (opts.readme) {
      console.log('[Collect] 正在采集 README...');
      let fetched = 0;
      for (const repo of trending) {
        const content = await fetchReadme(repo.id);
        if (!content) continue;

        upsertReadme(db, {
          project_id: repo.id,
          content,
          keywords: null, // TODO: extract keywords in v0.2
          updated_at: today,
        });
        fetched++;
      }
      console.log(`[Collect] 已采集 ${fetched} 个 README`);
    }

    const limit = getRateLimitInfo();
    console.log(`[Collect] 完成! GitHub API 余量: ${limit.remaining}, 重置时间: ${limit.reset.toLocaleTimeString()}`);
    db.close();
  });

// ─── augur report ───────────────────────────────────────────────
program
  .command('report')
  .description('生成信号周报')
  .option('-w, --week', '生成周报')
  .option('-d, --date <date>', '指定日期 (YYYY-MM-DD)')
  .option('-o, --output <file>', '输出到文件')
  .action(async (opts: { week?: boolean; date?: string; output?: string }) => {
    const db = getDb();
    initSchema(db);

    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    console.log(`[Report] 生成周报，基准日期: ${date}`);

    const report = generateWeeklyReport(db, date);

    if (opts.output) {
      const fs = await import('node:fs');
      fs.writeFileSync(opts.output, report, 'utf-8');
      console.log(`[Report] 已写入 ${opts.output}`);
    } else {
      console.log('');
      console.log(report);
    }

    db.close();
  });

// ─── augur backtest ─────────────────────────────────────────────
program
  .command('backtest')
  .description('历史回测：验证先导信号→爆发的时间差')
  .option('-t, --target <name>', '指定回测目标 (chatgpt, cursor, manus)，不指定则全部运行')
  .option('-o, --output <file>', '输出到文件')
  .action(async (opts: { target?: string; output?: string }) => {
    let targets = BACKTEST_TARGETS;
    if (opts.target) {
      const filtered = targets.filter(t => t.name.toLowerCase().includes(opts.target!.toLowerCase()));
      if (filtered.length === 0) {
        console.error(`未找到匹配的回测目标: ${opts.target}`);
        console.error(`可用目标: ${targets.map(t => t.name).join(', ')}`);
        process.exit(1);
      }
      targets = filtered;
    }

    console.log(`[Backtest] 开始回测 ${targets.length} 个目标（通过 ClickHouse GH Archive）...`);
    const results = [];
    for (const target of targets) {
      results.push(await runBacktest(target));
    }

    const report = formatFullBacktestReport(results);

    if (opts.output) {
      const fs = await import('node:fs');
      fs.writeFileSync(opts.output, report, 'utf-8');
      console.log(`\n[Backtest] 报告已写入 ${opts.output}`);
    } else {
      console.log('\n' + report);
    }
  });

// ─── augur status ───────────────────────────────────────────────
program
  .command('status')
  .description('查看数据库状态')
  .action(() => {
    const db = getDb();
    initSchema(db);

    const projects = (db.prepare('SELECT COUNT(*) as count FROM projects').get() as { count: number }).count;
    const snapshots = (db.prepare('SELECT COUNT(*) as count FROM snapshots').get() as { count: number }).count;
    const readmes = (db.prepare('SELECT COUNT(*) as count FROM readmes').get() as { count: number }).count;
    const latest = db.prepare('SELECT MAX(captured_at) as date FROM snapshots').get() as { date: string | null };

    console.log('Augur 数据库状态:');
    console.log(`  项目数: ${projects}`);
    console.log(`  快照数: ${snapshots}`);
    console.log(`  README: ${readmes}`);
    console.log(`  最新采集: ${latest.date ?? '无'}`);

    db.close();
  });

program.parse();
