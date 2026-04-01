#!/usr/bin/env node

import { Command } from 'commander';
import { getDb, initSchema } from './store/schema.js';
import { upsertProject, upsertSnapshot, upsertReadme, type Project, type Snapshot } from './store/queries.js';
import { fetchTrending } from './collector/github-trending.js';
import { fetchRepoDetails, fetchReadme, getRateLimitInfo } from './collector/github-api.js';
import { fetchAllHNPosts, extractGitHubRepo } from './collector/hackernews.js';
import { generateWeeklyReport, collectReportData, enrichWithSignals, formatReport } from './predictor/report-generator.js';
import { BACKTEST_TARGETS, runBacktest, formatFullBacktestReport } from './predictor/backtest.js';
import { classifyProjects } from './analyzer/signal-tagger.js';
import { analyzeCoOccurrences } from './analyzer/cooccurrence.js';
import { fetchProjectIssues, classifyIssues, clusterFeatureRequests } from './analyzer/feature-extractor.js';
import { generateResearch, collectResearchInput } from './analyzer/auto-researcher.js';

const program = new Command();

program
  .name('augur')
  .description('开源信号情报系统 — 识别技术浪潮先导信号')
  .version('0.2.0');

// ─── augur collect ──────────────────────────────────────────────
program
  .command('collect')
  .description('采集 GitHub Trending + HackerNews 数据')
  .option('-p, --period <period>', 'Trending 周期: daily, weekly, monthly', 'daily')
  .option('--no-details', '跳过 GitHub API 详情补充')
  .option('--no-readme', '跳过 README 采集')
  .option('--no-hn', '跳过 HackerNews 采集')
  .action(async (opts: { period: string; details: boolean; readme: boolean; hn: boolean }) => {
    const db = getDb();
    initSchema(db);
    const today = new Date().toISOString().slice(0, 10);
    const period = opts.period as 'daily' | 'weekly' | 'monthly';

    // Step 1: Fetch trending
    console.log(`[Collect] 正在采集 GitHub Trending (${period})...`);
    const trending = await fetchTrending(period);
    console.log(`[Collect] 发现 ${trending.length} 个项目`);

    for (const repo of trending) {
      upsertProject(db, {
        id: repo.id, language: repo.language, topics: null,
        description: repo.description, created_at: null, first_seen_at: today,
      });
      upsertSnapshot(db, {
        project_id: repo.id, captured_at: today, stars: repo.totalStars,
        forks: repo.forks, open_issues: null, trending_rank: repo.rank,
        trending_period: period, source: 'trending',
      });
    }
    console.log(`[Collect] 已保存 ${trending.length} 个项目快照`);

    // Step 2: GitHub API details
    if (opts.details) {
      console.log('[Collect] 正在补充项目详情...');
      let enriched = 0;
      for (const repo of trending) {
        const details = await fetchRepoDetails(repo.id);
        if (!details) continue;
        upsertProject(db, {
          id: details.id, language: details.language, topics: JSON.stringify(details.topics),
          description: details.description, created_at: details.createdAt, first_seen_at: today,
        });
        upsertSnapshot(db, {
          project_id: details.id, captured_at: today, stars: details.stars,
          forks: details.forks, open_issues: details.openIssues, trending_rank: repo.rank,
          trending_period: period, source: 'api',
        });
        enriched++;
      }
      const limit = getRateLimitInfo();
      console.log(`[Collect] 已补充 ${enriched} 个项目详情 (API 余量: ${limit.remaining})`);
    }

    // Step 3: READMEs
    if (opts.readme) {
      console.log('[Collect] 正在采集 README...');
      let fetched = 0;
      for (const repo of trending) {
        const content = await fetchReadme(repo.id);
        if (!content) continue;
        upsertReadme(db, { project_id: repo.id, content, keywords: null, updated_at: today });
        fetched++;
      }
      console.log(`[Collect] 已采集 ${fetched} 个 README`);
    }

    // Step 4: HackerNews
    if (opts.hn) {
      console.log('[Collect] 正在采集 HackerNews...');
      const hnPosts = await fetchAllHNPosts(7);
      let saved = 0;
      for (const post of hnPosts) {
        db.prepare(`
          INSERT OR IGNORE INTO hn_posts (id, title, url, points, comments, captured_at, keywords)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(post.id, post.title, post.url, post.points, post.comments, today, null);

        // If HN post links to a GitHub repo, add it to our tracking
        const repoId = extractGitHubRepo(post.url);
        if (repoId) {
          upsertProject(db, {
            id: repoId, language: null, topics: null,
            description: post.title, created_at: null, first_seen_at: today,
          });
        }
        saved++;
      }
      console.log(`[Collect] 已保存 ${saved} 个 HN 帖子`);
    }

    const limit = getRateLimitInfo();
    console.log(`[Collect] 完成! GitHub API 余量: ${limit.remaining}, 重置时间: ${limit.reset.toLocaleTimeString()}`);
    db.close();
  });

// ─── augur analyze ──────────────────────────────────────────────
program
  .command('analyze')
  .description('LLM 信号分类 + 共现分析 + 机会评分')
  .option('-d, --date <date>', '指定日期 (YYYY-MM-DD)')
  .action(async (opts: { date?: string }) => {
    const db = getDb();
    initSchema(db);

    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    console.log(`[Analyze] 正在分析项目信号...`);

    const entries = collectReportData(db, date);
    if (entries.length === 0) {
      console.log('[Analyze] 无数据，请先运行 augur collect');
      db.close();
      return;
    }

    // 1. LLM classification
    const projects = entries.map(e => {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(e.id) as any;
      const readme = db.prepare('SELECT content FROM readmes WHERE project_id = ?').get(e.id) as any;
      return {
        id: e.id, description: e.description, language: e.language,
        topics: project?.topics ?? null, readme: readme?.content?.slice(0, 500) ?? undefined,
      };
    });

    console.log(`[Analyze] 正在调用 LLM 分类 ${projects.length} 个项目...`);
    const classifications = await classifyProjects(projects);
    console.log(`[Analyze] 分类完成`);

    // Save signals
    for (const c of classifications) {
      db.prepare(`
        INSERT INTO signals (project_id, week, layer, growth_pattern, domains, confidence, opportunity_score, raw_analysis)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, week) DO UPDATE SET
          layer = excluded.layer, domains = excluded.domains, raw_analysis = excluded.raw_analysis
      `).run(c.projectId, date, c.layer,
        entries.find(e => e.id === c.projectId)?.growth.pattern ?? 'steady',
        JSON.stringify(c.domains), 0, 0, JSON.stringify(c));
    }

    enrichWithSignals(entries, classifications);
    for (const e of entries) {
      if (e.score) {
        db.prepare('UPDATE signals SET confidence = ?, opportunity_score = ? WHERE project_id = ? AND week = ?')
          .run(e.score.confidence, e.score.opportunityScore, e.id, date);
      }
    }

    // 2. Co-occurrence analysis
    console.log(`[Analyze] 正在分析共现关键词...`);
    const coMatrix = analyzeCoOccurrences(db, date);

    // Print summary
    const infra = classifications.filter(c => c.layer === 'infrastructure');
    const tooling = classifications.filter(c => c.layer === 'tooling');
    const app = classifications.filter(c => c.layer === 'application');
    console.log(`[Analyze] 信号层级: 基础设施 ${infra.length} | 工具 ${tooling.length} | 应用 ${app.length}`);
    console.log(`[Analyze] 共现词对: ${coMatrix.length} 个`);

    if (coMatrix.length > 0) {
      console.log(`[Analyze] Top 5 共现词对:`);
      for (const c of coMatrix.slice(0, 5)) {
        console.log(`  ${c.keyword1} + ${c.keyword2} (${c.count} 个项目)`);
      }
    }

    const topScored = entries.filter(e => e.score).sort((a, b) => b.score!.opportunityScore - a.score!.opportunityScore).slice(0, 5);
    if (topScored.length > 0) {
      console.log(`[Analyze] Top 5 机会:`);
      for (const e of topScored) {
        console.log(`  ${e.score!.opportunityScore.toFixed(2)} | ${e.signal?.layer} | ${e.id} [${e.signal?.domains.join(', ')}]`);
      }
    }

    db.close();
  });

// ─── augur research ─────────────────────────────────────────────
program
  .command('research')
  .description('对 Top N 高置信信号进行深度调研')
  .option('-n, --top <n>', '调研 Top N 个项目', '3')
  .option('-d, --date <date>', '指定日期 (YYYY-MM-DD)')
  .option('-o, --output <file>', '输出到文件')
  .action(async (opts: { top: string; date?: string; output?: string }) => {
    const db = getDb();
    initSchema(db);

    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const topN = parseInt(opts.top, 10);

    // Get top scored signals
    const signals = db.prepare(`
      SELECT project_id, layer, domains, opportunity_score
      FROM signals WHERE week = ?
      ORDER BY opportunity_score DESC
      LIMIT ?
    `).all(date, topN) as any[];

    if (signals.length === 0) {
      console.log('[Research] 无信号数据，请先运行 augur analyze');
      db.close();
      return;
    }

    console.log(`[Research] 正在深度调研 Top ${signals.length} 项目...`);
    const reports: string[] = [];

    for (const sig of signals) {
      console.log(`  调研 ${sig.project_id}...`);
      const input = collectResearchInput(db, sig.project_id, {
        layer: sig.layer,
        domains: JSON.parse(sig.domains || '[]'),
        opportunityScore: sig.opportunity_score,
      });
      const report = await generateResearch(input);
      reports.push(`# ${sig.project_id}\n\n${report.fullReport}`);
    }

    const fullReport = `# Augur 深度调研报告\n\n> 生成日期: ${date} | 调研项目: ${signals.length}\n\n---\n\n${reports.join('\n\n---\n\n')}`;

    if (opts.output) {
      const fs = await import('node:fs');
      fs.writeFileSync(opts.output, fullReport, 'utf-8');
      console.log(`[Research] 报告已写入 ${opts.output}`);
    } else {
      console.log('\n' + fullReport);
    }

    db.close();
  });

// ─── augur feature-requests ─────────────────────────────────────
program
  .command('feature-requests')
  .description('挖掘指定项目的 Feature Request 热点')
  .argument('<repo>', '仓库 ID (owner/repo)')
  .option('-o, --output <file>', '输出到文件')
  .action(async (repo: string, opts: { output?: string }) => {
    console.log(`[FR] 正在采集 ${repo} 的 Issues...`);
    const issues = await fetchProjectIssues(repo);
    console.log(`[FR] 获取 ${issues.length} 个 Issues`);

    if (issues.length === 0) {
      console.log('[FR] 未找到 Issues');
      return;
    }

    console.log(`[FR] 正在分类...`);
    const classified = await classifyIssues(issues);

    const frs = classified.filter(c => c.category === 'feature_request');
    const bugs = classified.filter(c => c.category === 'bug');
    const questions = classified.filter(c => c.category === 'question');

    console.log(`[FR] 分类结果: FR ${frs.length} | Bug ${bugs.length} | Question ${questions.length} | Other ${classified.length - frs.length - bugs.length - questions.length}`);

    const clusters = clusterFeatureRequests(classified);

    const lines: string[] = [];
    lines.push(`# Feature Request 分析: ${repo}`);
    lines.push('');
    lines.push(`> Issues 总数: ${issues.length} | Feature Requests: ${frs.length}`);
    lines.push('');

    if (clusters.length > 0) {
      lines.push('## 需求主题聚类');
      lines.push('');
      for (const c of clusters) {
        lines.push(`### ${c.theme} (${c.count} 个)`);
        for (const issue of c.issues.slice(0, 5)) {
          const summary = issue.summary ? ` — ${issue.summary}` : '';
          lines.push(`- ${issue.title}${summary}`);
        }
        lines.push('');
      }
    }

    const report = lines.join('\n');
    if (opts.output) {
      const fs = await import('node:fs');
      fs.writeFileSync(opts.output, report, 'utf-8');
      console.log(`[FR] 报告已写入 ${opts.output}`);
    } else {
      console.log('\n' + report);
    }
  });

// ─── augur report ───────────────────────────────────────────────
program
  .command('report')
  .description('生成信号周报')
  .option('-w, --week', '生成周报')
  .option('-d, --date <date>', '指定日期 (YYYY-MM-DD)')
  .option('-o, --output <file>', '输出到文件')
  .option('--with-llm', '包含 LLM 信号分析（如未运行 analyze 则自动触发）')
  .action(async (opts: { week?: boolean; date?: string; output?: string; withLlm?: boolean }) => {
    const db = getDb();
    initSchema(db);

    const date = opts.date ?? new Date().toISOString().slice(0, 10);
    const weekLabel = `${new Date(date).getFullYear()}-W${String(Math.ceil((new Date(date).getTime() - new Date(new Date(date).getFullYear(), 0, 1).getTime()) / 604800000)).padStart(2, '0')}`;

    console.log(`[Report] 生成周报，基准日期: ${date}`);

    const entries = collectReportData(db, date);

    if (opts.withLlm && entries.length > 0) {
      const existingSignals = db.prepare('SELECT COUNT(*) as count FROM signals WHERE week = ?').get(date) as { count: number };

      if (existingSignals.count === 0) {
        console.log('[Report] 正在调用 LLM 分析...');
        const projects = entries.map(e => {
          const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(e.id) as any;
          const readme = db.prepare('SELECT content FROM readmes WHERE project_id = ?').get(e.id) as any;
          return {
            id: e.id, description: e.description, language: e.language,
            topics: project?.topics ?? null, readme: readme?.content?.slice(0, 500) ?? undefined,
          };
        });
        const classifications = await classifyProjects(projects);
        enrichWithSignals(entries, classifications);
      } else {
        const rows = db.prepare('SELECT * FROM signals WHERE week = ?').all(date) as any[];
        const classifications = rows.map(r => ({
          projectId: r.project_id,
          layer: r.layer as 'infrastructure' | 'tooling' | 'application',
          domains: JSON.parse(r.domains || '[]'),
          reasoning: '',
        }));
        enrichWithSignals(entries, classifications);
      }
    }

    const report = formatReport(entries, weekLabel, date);

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
    const signals = (db.prepare('SELECT COUNT(*) as count FROM signals').get() as { count: number }).count;
    const hnPosts = (db.prepare('SELECT COUNT(*) as count FROM hn_posts').get() as { count: number }).count;
    const cooccurrences = (db.prepare('SELECT COUNT(*) as count FROM cooccurrences').get() as { count: number }).count;
    const latest = db.prepare('SELECT MAX(captured_at) as date FROM snapshots').get() as { date: string | null };

    console.log('Augur 数据库状态:');
    console.log(`  项目数: ${projects}`);
    console.log(`  快照数: ${snapshots}`);
    console.log(`  README: ${readmes}`);
    console.log(`  信号分析: ${signals}`);
    console.log(`  HN 帖子: ${hnPosts}`);
    console.log(`  共现词对: ${cooccurrences}`);
    console.log(`  最新采集: ${latest.date ?? '无'}`);

    db.close();
  });

program.parse();
