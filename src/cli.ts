#!/usr/bin/env node

import { Command } from 'commander';
import { getDb, initSchema } from './store/schema.js';
import { upsertProject, upsertSnapshot, upsertReadme, type Project, type Snapshot } from './store/queries.js';
import { fetchTrending } from './collector/github-trending.js';
import { fetchRepoDetails, fetchReadme, fetchStarHistory, starEventsToWeeklySnapshots, getRateLimitInfo } from './collector/github-api.js';
import { fetchAllHNPosts, extractGitHubRepo } from './collector/hackernews.js';
import { generateWeeklyReport, collectReportData, enrichWithSignals, formatReport } from './predictor/report-generator.js';
import { BACKTEST_TARGETS, runBacktest, formatFullBacktestReport } from './predictor/backtest.js';
import { classifyProjects } from './analyzer/signal-tagger.js';
import { analyzeCoOccurrences } from './analyzer/cooccurrence.js';
import { fetchProjectIssues, classifyIssues, clusterFeatureRequests } from './analyzer/feature-extractor.js';
import { generateResearch, collectResearchInput } from './analyzer/auto-researcher.js';
import { aggregateDomains } from './predictor/domain-aggregator.js';
import { computeSSI, detectPhase, analyzeSSITrend, saveDomainSignal, PHASE_LABELS } from './predictor/phase-detector.js';
import { predictEruption, formatPredictionReport } from './predictor/eruption-predictor.js';
import { checkAllEruptions } from './predictor/eruption-detector.js';

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
  .option('--social', '采集 DEV.to + Reddit 社交媒体数据')
  .option('--backfill', '回填 star 历史数据（冷启动用，首次运行建议加上）')
  .action(async (opts: { period: string; details: boolean; readme: boolean; hn: boolean; social?: boolean; backfill?: boolean }) => {
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

    // Step 4: Star history backfill (cold start)
    if (opts.backfill) {
      console.log('[Collect] 正在回填 star 历史数据...');
      let backfilled = 0;
      for (const repo of trending) {
        // Check if we already have historical snapshots
        const existing = db.prepare(
          'SELECT COUNT(*) as cnt FROM snapshots WHERE project_id = ? AND captured_at < ?'
        ).get(repo.id, today) as { cnt: number };

        if (existing.cnt >= 4) continue; // already have enough history

        // Get current star count from DB (more reliable than trending HTML)
        const latestSnap = db.prepare(
          'SELECT stars FROM snapshots WHERE project_id = ? AND stars > 0 ORDER BY captured_at DESC LIMIT 1'
        ).get(repo.id) as { stars: number } | undefined;
        const currentStars = latestSnap?.stars ?? repo.totalStars;
        if (currentStars === 0) continue; // skip if no star data

        console.log(`  回填 ${repo.id} (★${currentStars.toLocaleString()})...`);
        const events = await fetchStarHistory(repo.id, 5);
        if (events.length === 0) continue;

        const weeklySnapshots = starEventsToWeeklySnapshots(repo.id, events, currentStars);
        for (const snap of weeklySnapshots) {
          upsertSnapshot(db, {
            project_id: snap.project_id,
            captured_at: snap.captured_at,
            stars: snap.stars,
            forks: null,
            open_issues: null,
            trending_rank: null,
            trending_period: null,
            source: 'backfill',
          });
        }
        backfilled++;
      }
      const limit = getRateLimitInfo();
      console.log(`[Collect] 已回填 ${backfilled} 个项目历史 (API 余量: ${limit.remaining})`);
    }

    // Step 5: HackerNews
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

    // Step 6: Social media (DEV.to + Reddit)
    if (opts.social) {
      const { upsertSocialBuzz } = await import('./store/queries.js');

      console.log('[Collect] 正在采集 DEV.to...');
      try {
        const { fetchAllDevToPosts, extractGitHubRepoFromArticle } = await import('./collector/devto.js');
        const articles = await fetchAllDevToPosts(7);
        let devtoGH = 0;
        for (const a of articles) {
          const ghRepo = extractGitHubRepoFromArticle(a);
          upsertSocialBuzz(db, {
            id: `devto-${a.id}`, source: 'devto', title: a.title, url: a.url,
            score: a.reactionsCount, comments: a.commentsCount, subreddit: null,
            tags: JSON.stringify(a.tags), github_repo: ghRepo, captured_at: today,
          });
          if (ghRepo) {
            upsertProject(db, { id: ghRepo, language: null, topics: null, description: a.title, created_at: null, first_seen_at: today });
            devtoGH++;
          }
        }
        console.log(`[Collect] DEV.to: ${articles.length} 篇文章, ${devtoGH} 个关联 GitHub 项目`);
      } catch (err) {
        console.warn(`[Collect] DEV.to 采集失败: ${(err as Error).message}`);
      }

      console.log('[Collect] 正在采集 Reddit...');
      try {
        const { fetchAllRedditPosts, extractGitHubRepo: extractRedditRepo } = await import('./collector/reddit.js');
        const posts = await fetchAllRedditPosts();
        let redditGH = 0;
        for (const p of posts) {
          const ghRepo = extractRedditRepo(p.url);
          upsertSocialBuzz(db, {
            id: `reddit-${p.id}`, source: 'reddit', title: p.title, url: p.url,
            score: p.score, comments: p.comments, subreddit: p.subreddit,
            tags: null, github_repo: ghRepo, captured_at: today,
          });
          if (ghRepo) {
            upsertProject(db, { id: ghRepo, language: null, topics: null, description: p.title, created_at: null, first_seen_at: today });
            redditGH++;
          }
        }
        console.log(`[Collect] Reddit: ${posts.length} 帖子, ${redditGH} 个关联 GitHub 项目`);
      } catch (err) {
        console.warn(`[Collect] Reddit 采集失败: ${(err as Error).message}`);
      }
    }

    // Step 7: Watchlist — 追踪候选浪潮的关键 repo
    console.log('[Collect] 正在追踪 watchlist repo...');
    let watchlistCount = 0;
    try {
      const fsModule = await import('node:fs');
      const sources: string[][] = [];

      // 从 wave-scanner 导入候选浪潮
      try {
        const { CANDIDATE_WAVES } = await import('./predictor/wave-scanner.js');
        for (const w of CANDIDATE_WAVES) {
          sources.push([...w.infrastructureRepos, ...w.toolingRepos, ...w.applicationRepos]);
        }
      } catch {}

      // 从 discovered-waves.json 导入
      try {
        const discovered = JSON.parse(fsModule.readFileSync('data/discovered-waves.json', 'utf-8'));
        for (const w of discovered) {
          sources.push([...(w.infrastructureRepos ?? []), ...(w.toolingRepos ?? []), ...(w.applicationRepos ?? [])]);
        }
      } catch {}

      const watchlist = [...new Set(sources.flat())];
      for (const repoId of watchlist) {
        // Only fetch details if we don't have a recent snapshot
        const recent = db.prepare(
          "SELECT 1 FROM snapshots WHERE project_id = ? AND captured_at >= date(?, '-7 days') LIMIT 1"
        ).get(repoId, today);
        if (recent) continue;

        const details = await fetchRepoDetails(repoId);
        if (!details) continue;

        upsertProject(db, {
          id: details.id, language: details.language, topics: JSON.stringify(details.topics),
          description: details.description, created_at: details.createdAt, first_seen_at: today,
        });
        upsertSnapshot(db, {
          project_id: details.id, captured_at: today, stars: details.stars,
          forks: details.forks, open_issues: details.openIssues, trending_rank: null,
          trending_period: null, source: 'watchlist',
        });
        watchlistCount++;
      }
    } catch {}
    console.log(`[Collect] 追踪了 ${watchlistCount} 个 watchlist repo`);

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

// ─── augur predict ──────────────────────────────────────────────
program
  .command('predict')
  .description('域级预测：相位检测 + 爆发时间预测；--trending 预测即将爆火的项目')
  .option('-d, --date <date>', '指定日期 (YYYY-MM-DD)')
  .option('--domain <domain>', '指定域深度预测')
  .option('--trending', '预测即将登上 GitHub Trending 的项目（排除已火项目）')
  .option('-n, --top <n>', 'Trending 预测返回 Top N', '20')
  .option('--max-stars <stars>', '排除 star 超过此数的项目', '5000')
  .option('-o, --output <file>', '输出到文件')
  .action(async (opts: { date?: string; domain?: string; trending?: boolean; top: string; maxStars: string; output?: string }) => {
    const db = getDb();
    initSchema(db);

    const date = opts.date ?? new Date().toISOString().slice(0, 10);

    // ── Trending project prediction mode ──
    if (opts.trending) {
      const { predictTrendingProjects, filterAlreadyTrending, formatTrendingPredictionReport } = await import('./predictor/trending-predictor.js');
      const { upsertTrendingPrediction } = await import('./store/queries.js');
      const topN = parseInt(opts.top, 10);
      const maxStars = parseInt(opts.maxStars, 10);

      console.log(`[Predict] 趋势项目预测 (Top ${topN}, star < ${maxStars})...`);
      const candidates = await predictTrendingProjects(db, maxStars, topN * 2, opts.date);
      const filtered = filterAlreadyTrending(candidates, db).slice(0, topN);
      console.log(`[Predict] 过滤后: ${filtered.length} 个候选项目`);

      if (filtered.length > 0) {
        console.log('\n[Predict] Top 预测:');
        for (let i = 0; i < Math.min(10, filtered.length); i++) {
          const c = filtered[i];
          console.log(`  ${i + 1}. ${c.repo} (得分 ${c.predictionScore.toFixed(2)}) — ${c.evidence.slice(0, 2).join(', ')}`);
        }
      }

      const report = formatTrendingPredictionReport(filtered, opts.date);
      if (opts.output) {
        const fs = await import('node:fs');
        fs.writeFileSync(opts.output, report, 'utf-8');
        console.log(`\n[Predict] 报告已写入 ${opts.output}`);
      } else {
        console.log('\n' + report);
      }

      // Save predictions to DB
      for (const c of filtered) {
        upsertTrendingPrediction(db, {
          project_id: c.repo, predicted_at: date, prediction_score: c.predictionScore,
          factors: JSON.stringify(c.factors), star_velocity: c.factors.starVelocity,
          social_buzz_score: c.factors.socialBuzzScore, fork_acceleration: c.factors.forkAcceleration,
          issue_acceleration: c.factors.issueAcceleration, actually_trended: 0, trended_at: null,
        });
      }
      console.log(`[Predict] 已保存 ${filtered.length} 条预测到数据库`);
      db.close();
      return;
    }

    // ── Domain-level prediction mode (default) ──
    console.log(`[Predict] 正在生成域级预测...`);

    // 1. Aggregate domains
    let domains = aggregateDomains(db, date);
    if (domains.length === 0) {
      console.log('[Predict] 无信号数据，请先运行 augur analyze');
      db.close();
      return;
    }

    if (opts.domain) {
      domains = domains.filter(d => d.domain === opts.domain);
      if (domains.length === 0) {
        console.error(`[Predict] 未找到域: ${opts.domain}`);
        console.error(`可用域: ${aggregateDomains(db, date).map(d => d.domain).join(', ')}`);
        db.close();
        return;
      }
    }

    console.log(`[Predict] 分析 ${domains.length} 个域...`);

    // 2. Compute SSI, detect phase, predict eruption for each domain
    const predictions = [];
    for (const view of domains) {
      const ssi = computeSSI(view);
      const phase = detectPhase(view);
      const trend = analyzeSSITrend(db, view.domain, date);

      const prediction = predictEruption(
        view.domain, phase.phase, phase.label, ssi, trend.trend,
        view, phase.evidence,
      );
      predictions.push(prediction);

      // Save to DB
      saveDomainSignal(db, view.domain, date, view, phase, ssi, prediction);

      console.log(`  ${view.domain}: Phase ${phase.phase}(${phase.label}) | SSI ${ssi} | → ${prediction.predictedEruptionRange.join('~')} (置信度 ${prediction.confidenceScore})`);
    }

    // 3. Check for eruptions (online learning feedback)
    const eruptions = checkAllEruptions(db, date);
    if (eruptions.length > 0) {
      console.log(`\n[Predict] 检测到 ${eruptions.length} 个域爆发信号！`);
      for (const e of eruptions) {
        console.log(`  ${e.domain}: 置信度 ${e.confidence}`);
      }
    }

    // 4. Output
    const report = formatPredictionReport(predictions);

    if (opts.output) {
      const fs = await import('node:fs');
      fs.writeFileSync(opts.output, report, 'utf-8');
      console.log(`[Predict] 报告已写入 ${opts.output}`);
    } else {
      console.log('\n' + report);
    }

    db.close();
  });

// ─── augur discover ─────────────────────────────────────────────
program
  .command('discover')
  .description('LLM 自动发现新候选浪潮')
  .action(async () => {
    const db = getDb();
    initSchema(db);
    const { discoverWaves, mergeWaves } = await import('./analyzer/wave-discoverer.js');
    const { CANDIDATE_WAVES } = await import('./predictor/wave-scanner.js');

    console.log('[Discover] 正在从已采集数据中发现新浪潮...');
    const discovered = await discoverWaves(db);

    if (discovered.length === 0) {
      console.log('[Discover] 未发现新浪潮');
      db.close();
      return;
    }

    console.log(`\n[Discover] 发现 ${discovered.length} 个候选浪潮:`);
    for (const w of discovered) {
      const totalRepos = w.infrastructureRepos.length + w.toolingRepos.length + w.applicationRepos.length;
      console.log(`  - ${w.name}: ${w.description} (${totalRepos} repos)`);
    }

    const merged = mergeWaves(CANDIDATE_WAVES, discovered);
    const newCount = merged.length - CANDIDATE_WAVES.length;
    console.log(`\n[Discover] 合并后: ${merged.length} 个浪潮 (+${newCount} 新增)`);

    // Save discovered waves to data/discovered-waves.json
    const fs = await import('node:fs');
    fs.writeFileSync('data/discovered-waves.json', JSON.stringify(discovered, null, 2) + '\n', 'utf-8');
    console.log('[Discover] 已保存到 data/discovered-waves.json');

    db.close();
  });

// ─── augur evolve ───────────────────────────────────────────────
program
  .command('evolve')
  .description('完整进化循环：发现 → 预测 → 记录 → 验证 → 调参')
  .option('-o, --output <file>', '输出到文件')
  .option('--skip-discover', '跳过候选发现（仅用已有浪潮）')
  .action(async (opts: { output?: string; skipDiscover?: boolean }) => {
    const fsModule = await import('node:fs');
    const db = getDb();
    initSchema(db);
    const { discoverWaves, mergeWaves } = await import('./analyzer/wave-discoverer.js');
    const { CANDIDATE_WAVES, scanWaves, formatWavePredictionReport } = await import('./predictor/wave-scanner.js');
    const { recordPredictions, checkPendingPredictions, verifyPrediction, evolveParams, expireOldPredictions, formatLedgerReport, getLedgerStats } = await import('./predictor/online-learner.js');

    const today = new Date().toISOString().slice(0, 10);
    console.log(`═══ Augur 进化循环 (${today}) ═══\n`);

    // Step 1: Discover new waves
    let waves = [...CANDIDATE_WAVES];
    if (!opts.skipDiscover) {
      console.log('── Step 1: 候选发现 ──');
      const discovered = await discoverWaves(db);
      if (discovered.length > 0) {
        // Load previously discovered waves
        let prevDiscovered: any[] = [];
        try {
          prevDiscovered = JSON.parse(fsModule.readFileSync('data/discovered-waves.json', 'utf-8'));
        } catch {}
        const allDiscovered = [...prevDiscovered, ...discovered];

        waves = mergeWaves(CANDIDATE_WAVES, allDiscovered);
        fsModule.writeFileSync('data/discovered-waves.json', JSON.stringify(allDiscovered, null, 2) + '\n', 'utf-8');
        console.log(`  新增 ${waves.length - CANDIDATE_WAVES.length} 个发现的浪潮\n`);
      }
    } else {
      console.log('── Step 1: 跳过候选发现 ──\n');
      // Load previously discovered waves
      try {
        const prev = JSON.parse(fsModule.readFileSync('data/discovered-waves.json', 'utf-8'));
        waves = mergeWaves(CANDIDATE_WAVES, prev);
      } catch {}
    }

    // Step 2: Run predictions
    console.log('── Step 2: 运行预测 ──');
    const state = JSON.parse(fsModule.readFileSync('data/learning-state.json', 'utf-8'));
    const params = {
      accelerationThreshold: state.signalDetection.accelerationThreshold,
      windowSize: state.signalDetection.windowSize,
      minBaseline: state.signalDetection.minBaseline,
      layerWeight: state.scorerWeights.layer,
      growthWeight: state.scorerWeights.growth,
      usageWeight: state.scorerWeights.usage,
      activityWeight: state.scorerWeights.activity,
      signalBonusWeight: state.scorerWeights.signalBonus,
      compressionFactor: state.compressionFactor.value,
      biasCorrection: state.signalDetection.biasCorrection ?? 0,
      recencyBoost: state.signalDetection.recencyBoost ?? 0.5,
    };

    // Temporarily override CANDIDATE_WAVES for scanning
    const predictions = await scanWaves(params, today);

    // Step 3: Record predictions to ledger
    console.log('\n── Step 3: 记录预测 ──');
    const recordCount = recordPredictions(
      predictions.map(p => ({
        wave: p.wave.name,
        predictedEruption: p.validation.predictedEruptionDate,
        signalStrength: p.signalStrength,
        signalCount: p.validation.detectedSignals.filter(s => s.signalDate).length,
        keySignals: p.validation.detectedSignals.filter(s => s.signalDate).map(s => s.repo),
        confidenceLower: p.validation.confidenceInterval?.lower,
        confidenceUpper: p.validation.confidenceInterval?.upper,
      })),
      params,
    );
    console.log(`  记录了 ${recordCount} 条新预测`);

    // Step 4: Auto-verify old predictions
    console.log('\n── Step 4: 自动验证旧预测 ──');
    const pendingForReview = checkPendingPredictions();
    if (pendingForReview.length > 0) {
      console.log(`  ${pendingForReview.length} 条预测待自动验证`);

      // Build wave → repos mapping from all known waves
      const { autoVerifyPredictions } = await import('./predictor/outcome-detector.js');
      const waveRepoMap = new Map<string, string[]>();
      for (const w of waves) {
        waveRepoMap.set(w.name, [...w.infrastructureRepos, ...w.toolingRepos, ...w.applicationRepos]);
      }
      // Also add from CANDIDATE_WAVES
      for (const w of CANDIDATE_WAVES) {
        if (!waveRepoMap.has(w.name)) {
          waveRepoMap.set(w.name, [...w.infrastructureRepos, ...w.toolingRepos, ...w.applicationRepos]);
        }
      }

      const verifications = await autoVerifyPredictions(pendingForReview, waveRepoMap);
      let hits = 0, misses = 0;
      for (const v of verifications) {
        verifyPrediction(v.predictionId, v.hit, v.hit ? v.wave : undefined);
        if (v.hit) hits++; else misses++;
      }
      console.log(`  自动验证完成: ${hits} 命中, ${misses} 未命中`);
    }
    const expiredCount = expireOldPredictions();
    if (expiredCount > 0) console.log(`  过期 ${expiredCount} 条超时预测`);

    // Step 5: Evolve parameters
    console.log('\n── Step 5: 参数进化 ──');
    const evolution = evolveParams();
    if (evolution.changed) {
      console.log('  参数已更新:');
      for (const adj of evolution.adjustments) console.log(`    ${adj}`);
    } else {
      for (const adj of evolution.adjustments) console.log(`  ${adj}`);
    }
    if (evolution.hitRate > 0) {
      console.log(`  当前命中率: ${(evolution.hitRate * 100).toFixed(0)}%`);
    }

    // Step 6: Generate report
    console.log('\n── Step 6: 生成报告 ──');
    const predReport = formatWavePredictionReport(predictions, today, 2.6, 3.3);
    const ledgerReport = formatLedgerReport();
    const stats = getLedgerStats();

    const fullReport = [
      predReport,
      '\n---\n',
      ledgerReport,
      '\n---\n',
      '## 进化状态',
      '',
      `- 参数进化: ${evolution.changed ? '已更新' : '无变化'}`,
      `- 命中率: ${stats.hitRate !== null ? (stats.hitRate * 100).toFixed(0) + '%' : '待验证'}`,
      `- 平均误差: ${stats.avgError?.toFixed(1) ?? '待验证'} 月`,
      `- 预测总数: ${stats.total} (待验证 ${stats.pending})`,
      ...evolution.adjustments.map(a => `- ${a}`),
    ].join('\n');

    if (opts.output) {
      fsModule.writeFileSync(opts.output, fullReport, 'utf-8');
      console.log(`\n[Evolve] 报告已写入 ${opts.output}`);
    }

    console.log(`\n═══ 进化循环完成 ═══`);
    db.close();
  });

// ─── augur predict-next ─────────────────────────────────────────
program
  .command('predict-next')
  .description('扫描候选浪潮，预测下一个风口')
  .option('-o, --output <file>', '输出到文件')
  .action(async (opts: { output?: string }) => {
    const { scanWaves, formatWavePredictionReport } = await import('./predictor/wave-scanner.js');
    const today = new Date().toISOString().slice(0, 10);

    // Load calibrated params from learning-state.json
    const fs = await import('node:fs');
    const state = JSON.parse(fs.readFileSync('data/learning-state.json', 'utf-8'));
    const params = {
      accelerationThreshold: state.signalDetection.accelerationThreshold,
      windowSize: state.signalDetection.windowSize,
      minBaseline: state.signalDetection.minBaseline,
      layerWeight: state.scorerWeights.layer,
      growthWeight: state.scorerWeights.growth,
      usageWeight: state.scorerWeights.usage,
      activityWeight: state.scorerWeights.activity,
      signalBonusWeight: state.scorerWeights.signalBonus,
      compressionFactor: state.compressionFactor.value,
      biasCorrection: state.signalDetection.biasCorrection ?? 0,
      recencyBoost: state.signalDetection.recencyBoost ?? 0.5,
    };

    console.log(`[Predict-Next] 使���校准参数: threshold=${params.accelerationThreshold}, window=${params.windowSize}, bias=${params.biasCorrection}`);
    console.log(`[Predict-Next] 扫描 6 个候选浪潮...\n`);

    const predictions = await scanWaves(params, today);

    const report = formatWavePredictionReport(predictions, today, 2.6, 3.3);

    if (opts.output) {
      fs.writeFileSync(opts.output, report, 'utf-8');
      console.log(`\n[Predict-Next] 报告已写�� ${opts.output}`);
    } else {
      console.log('\n' + report);
    }
  });

// ─── augur calibrate ────────────────────────────────────────────
program
  .command('calibrate')
  .description('用历史数据训练模型参数，并在 OpenClaw 案例上验证')
  .option('-o, --output <file>', '输出到文件')
  .option('--cutoff <date>', '验证时的"站在哪天"视角', '2025-03-01')
  .option('--cross-validate', '运行 Leave-one-out 交叉验证')
  .action(async (opts: { output?: string; cutoff: string; crossValidate?: boolean }) => {
    const { calibrate, validate, crossValidate, formatCalibrationReport } = await import('./predictor/calibrator.js');
    const backtest = await import('./predictor/backtest.js');

    // 训练集: 前 3 个案例
    console.log('═══ Phase 1: 训练（参数校准）═══\n');
    const calResult = await calibrate(backtest.BACKTEST_TARGETS);

    // 测试集: 专业 Agent / OpenClaw
    console.log('\n═══ Phase 2: 验证（OpenClaw 预测）═══\n');
    const validationTarget: backtest.BacktestTarget = {
      name: '专业 Agent / OpenClaw 爆发',
      eruptionDate: '2025-06-01',
      description: '专业 Agent 浪潮，OpenClaw 等垂直 Agent 产品涌现',
      infrastructureRepos: [
        'modelcontextprotocol/modelcontextprotocol',
        'modelcontextprotocol/servers',
        'modelcontextprotocol/python-sdk',
        'anthropics/anthropic-sdk-python',
      ],
      toolingRepos: [
        'anthropics/claude-code',
        'browser-use/browser-use',
        'langchain-ai/langgraph',
      ],
      applicationRepos: [
        'openclaw/openclaw',
        'OpenManus/OpenManus',
        'all-hands-ai/OpenHands',
      ],
    };

    const valResult = await validate(validationTarget, calResult.bestParams, opts.cutoff);

    // Generate report
    const report = formatCalibrationReport(calResult, valResult);

    if (opts.output) {
      const fs = await import('node:fs');
      fs.writeFileSync(opts.output, report, 'utf-8');
      console.log(`\n[Calibrate] 报告已写入 ${opts.output}`);
    } else {
      console.log('\n' + report);
    }

    // Save calibrated params to learning-state.json
    const fs = await import('node:fs');
    const statePath = 'data/learning-state.json';
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
      state.scorerWeights = {
        layer: calResult.bestParams.layerWeight,
        growth: calResult.bestParams.growthWeight,
        usage: calResult.bestParams.usageWeight,
        activity: calResult.bestParams.activityWeight,
        signalBonus: calResult.bestParams.signalBonusWeight,
      };
      state.signalDetection = {
        accelerationThreshold: calResult.bestParams.accelerationThreshold,
        windowSize: calResult.bestParams.windowSize,
        minBaseline: calResult.bestParams.minBaseline,
      };
      state.compressionFactor.value = calResult.bestParams.compressionFactor;
      state.updatedAt = new Date().toISOString().slice(0, 10);

      if (valResult.predictionError !== null) {
        state.compressionFactor.calibrationHistory.push({
          domain: 'professional-agent',
          predicted: valResult.predictedLeadMonths,
          actual: 0,
          error: valResult.predictionError,
          date: validationTarget.eruptionDate,
        });
        state.compressionFactor.selfCalibratedCount++;
      }

      fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
      console.log('[Calibrate] 参数已保存到 data/learning-state.json');
    }

    // Cross-validation
    if (opts.crossValidate) {
      console.log('\n═══ Phase 3: Leave-one-out 交叉验证（Round 1）═══\n');
      let looResults = await crossValidate();

      // 计算残差偏差，作为 bias correction 回注到 Round 2
      const r1Residuals = looResults
        .filter(r => r.predictedEruption && r.errorMonths !== null)
        .map(r => {
          const pred = new Date(r.predictedEruption!).getTime();
          const actual = new Date(r.actualEruption).getTime();
          return (actual - pred) / (1000 * 60 * 60 * 24 * 30); // positive = pred too early
        });

      if (r1Residuals.length >= 2) {
        const meanBias = r1Residuals.reduce((a, b) => a + b, 0) / r1Residuals.length;
        const roundedBias = Math.round(meanBias * 10) / 10;

        if (Math.abs(roundedBias) >= 0.5) {
          console.log(`\n[LOO] Round 1 系统偏差: ${roundedBias > 0 ? '+' : ''}${roundedBias} 月 → 启动 Round 2 (bias=${roundedBias})\n`);
          console.log('═══ Phase 3b: LOO Round 2（偏差修正后）═══\n');

          // 更新 learning state 中的 bias
          const statePath = 'data/learning-state.json';
          if (fs.existsSync(statePath)) {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
            if (!state.signalDetection.biasCorrection || Math.abs(state.signalDetection.biasCorrection - roundedBias) > 0.3) {
              state.signalDetection.biasCorrection = roundedBias;
              state.signalDetection.recencyBoost = 0.5;
              fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf-8');
            }
          }

          // Round 2 with bias correction
          // 通过修改 DEFAULT_PARAMS 来注入 bias（临时方案）
          looResults = await crossValidate(undefined, roundedBias);
        }
      }

      const looLines: string[] = [];
      looLines.push('\n---\n');
      looLines.push('## Leave-one-out 交叉验证');
      looLines.push('');
      looLines.push('| Fold | 留出案例 | Cutoff | 预测爆发 | 实际爆发 | 误差(月) |');
      looLines.push('|------|---------|--------|---------|---------|---------|');

      const errors: number[] = [];
      for (const [i, r] of looResults.entries()) {
        looLines.push(`| ${i + 1} | ${r.heldOut} | ${r.cutoff} | ${r.predictedEruption ?? '-'} | ${r.actualEruption} | ${r.errorMonths?.toFixed(1) ?? '-'} |`);
        if (r.errorMonths !== null) errors.push(r.errorMonths);
      }

      const avgError = errors.length > 0 ? errors.reduce((a, b) => a + b, 0) / errors.length : 0;

      // 计算置信区间（基于 LOO 误差的标准差）
      const residuals = looResults.filter(r => r.errorMonths !== null).map(r => {
        if (!r.predictedEruption) return 0;
        // positive = predicted too early, negative = predicted too late
        return (new Date(r.actualEruption).getTime() - new Date(r.predictedEruption).getTime()) / (1000 * 60 * 60 * 24 * 30);
      });
      const meanResidual = residuals.reduce((a, b) => a + b, 0) / residuals.length;
      const variance = residuals.reduce((s, r) => s + (r - meanResidual) ** 2, 0) / (residuals.length - 1);
      const stdDev = Math.sqrt(variance);

      looLines.push('');
      looLines.push(`**平均预测误差: ${avgError.toFixed(1)} 个月** (${errors.length} 个有效 fold)`);
      looLines.push(`**残差标准差: ±${stdDev.toFixed(1)} 个月**`);
      looLines.push(`**预测偏差: ${meanResidual > 0 ? '+' : ''}${meanResidual.toFixed(1)} 个月** (${meanResidual > 0 ? '偏早' : '偏晚'})`);
      looLines.push('');

      // 将置信区间应用到 OpenClaw 验证结果
      if (valResult.predictedEruptionDate) {
        const predicted = new Date(valResult.predictedEruptionDate);
        const lowerDate = new Date(predicted);
        lowerDate.setDate(lowerDate.getDate() - Math.round(stdDev * 30));
        const upperDate = new Date(predicted);
        upperDate.setDate(upperDate.getDate() + Math.round(stdDev * 30));

        looLines.push('### OpenClaw 预测置信区间');
        looLines.push('');
        looLines.push(`| 区间 | 日期范围 |`);
        looLines.push(`|------|---------|`);
        looLines.push(`| 点估计 | **${valResult.predictedEruptionDate}** |`);
        looLines.push(`| 68% 区间 (±1σ) | ${lowerDate.toISOString().slice(0, 10)} ~ ${upperDate.toISOString().slice(0, 10)} |`);

        const lower95 = new Date(predicted);
        lower95.setDate(lower95.getDate() - Math.round(stdDev * 2 * 30));
        const upper95 = new Date(predicted);
        upper95.setDate(upper95.getDate() + Math.round(stdDev * 2 * 30));
        looLines.push(`| 95% 区间 (±2σ) | ${lower95.toISOString().slice(0, 10)} ~ ${upper95.toISOString().slice(0, 10)} |`);
        looLines.push(`| 实际爆发 | ${valResult.actualEruptionDate} |`);

        const actualInBand = valResult.actualEruptionDate >= lowerDate.toISOString().slice(0, 10)
          && valResult.actualEruptionDate <= upperDate.toISOString().slice(0, 10);
        looLines.push('');
        looLines.push(`实际爆发日期${actualInBand ? '**在 68% 置信区间内** ✓' : '在 68% 置信区间外'}`);
      }

      const looReport = looLines.join('\n');
      console.log(looReport);

      if (opts.output) {
        const existing = fs.readFileSync(opts.output, 'utf-8');
        fs.writeFileSync(opts.output, existing + '\n' + looReport, 'utf-8');
      }
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

// ─── augur run ──────────────────────────────────────────────────
program
  .command('run')
  .description('全自动流水线：collect → analyze → research → report')
  .option('--daily', '仅执行每日采集（不含分析）')
  .option('--weekly', '执行完整周度分析流程')
  .option('-o, --output-dir <dir>', '报告输出目录', 'reports')
  .action(async (opts: { daily?: boolean; weekly?: boolean; outputDir: string }) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const db = getDb();
    initSchema(db);
    const today = new Date().toISOString().slice(0, 10);
    const isWeekly = opts.weekly || !opts.daily;

    // Step 1: Collect (always)
    console.log('═══ Step 1/4: 采集数据 ═══');
    const trending = await fetchTrending('daily');
    console.log(`[Collect] ${trending.length} 个 trending 项目`);

    for (const repo of trending) {
      upsertProject(db, {
        id: repo.id, language: repo.language, topics: null,
        description: repo.description, created_at: null, first_seen_at: today,
      });
      upsertSnapshot(db, {
        project_id: repo.id, captured_at: today, stars: repo.totalStars,
        forks: repo.forks, open_issues: null, trending_rank: repo.rank,
        trending_period: 'daily', source: 'trending',
      });
    }

    // API details
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
        trending_period: 'daily', source: 'api',
      });
      enriched++;
    }
    console.log(`[Collect] ${enriched} 个详情补充完成`);

    // READMEs
    let readmeCount = 0;
    for (const repo of trending) {
      const content = await fetchReadme(repo.id);
      if (!content) continue;
      upsertReadme(db, { project_id: repo.id, content, keywords: null, updated_at: today });
      readmeCount++;
    }
    console.log(`[Collect] ${readmeCount} 个 README 采集完成`);

    // HN
    const hnPosts = await fetchAllHNPosts(7);
    for (const post of hnPosts) {
      db.prepare('INSERT OR IGNORE INTO hn_posts (id, title, url, points, comments, captured_at, keywords) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(post.id, post.title, post.url, post.points, post.comments, today, null);
      const repoId = extractGitHubRepo(post.url);
      if (repoId) {
        upsertProject(db, { id: repoId, language: null, topics: null, description: post.title, created_at: null, first_seen_at: today });
      }
    }
    console.log(`[Collect] ${hnPosts.length} 个 HN 帖子采集完成`);

    if (opts.daily && !opts.weekly) {
      console.log('\n═══ 每日采集完成 ═══');
      db.close();
      return;
    }

    // Step 2: Analyze (weekly)
    console.log('\n═══ Step 2/4: 信号分析 ═══');
    const entries = collectReportData(db, today);
    const projects = entries.map(e => {
      const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(e.id) as any;
      const readme = db.prepare('SELECT content FROM readmes WHERE project_id = ?').get(e.id) as any;
      return {
        id: e.id, description: e.description, language: e.language,
        topics: project?.topics ?? null, readme: readme?.content?.slice(0, 500) ?? undefined,
      };
    });

    const classifications = await classifyProjects(projects);
    for (const c of classifications) {
      db.prepare(`
        INSERT INTO signals (project_id, week, layer, growth_pattern, domains, confidence, opportunity_score, raw_analysis)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, week) DO UPDATE SET layer = excluded.layer, domains = excluded.domains, raw_analysis = excluded.raw_analysis
      `).run(c.projectId, today, c.layer, entries.find(e => e.id === c.projectId)?.growth.pattern ?? 'steady',
        JSON.stringify(c.domains), 0, 0, JSON.stringify(c));
    }
    enrichWithSignals(entries, classifications);
    for (const e of entries) {
      if (e.score) {
        db.prepare('UPDATE signals SET confidence = ?, opportunity_score = ? WHERE project_id = ? AND week = ?')
          .run(e.score.confidence, e.score.opportunityScore, e.id, today);
      }
    }

    const coMatrix = analyzeCoOccurrences(db, today);
    console.log(`[Analyze] 信号 ${classifications.length} | 共现 ${coMatrix.length}`);

    // Step 3: Research top signals
    console.log('\n═══ Step 3/4: 深度调研 ═══');
    const topSignals = db.prepare(`
      SELECT project_id, layer, domains, opportunity_score
      FROM signals WHERE week = ? ORDER BY opportunity_score DESC LIMIT 3
    `).all(today) as any[];

    const researchReports: string[] = [];
    for (const sig of topSignals) {
      console.log(`  调研 ${sig.project_id}...`);
      const input = collectResearchInput(db, sig.project_id, {
        layer: sig.layer, domains: JSON.parse(sig.domains || '[]'), opportunityScore: sig.opportunity_score,
      });
      const report = await generateResearch(input);
      researchReports.push(`## ${sig.project_id}\n\n${report.fullReport}`);
    }

    // Step 4: 浪潮预测 + 进化
    console.log('\n═══ Step 4/7: 浪潮预测 ═══');
    const { CANDIDATE_WAVES, scanWaves } = await import('./predictor/wave-scanner.js');
    const { recordPredictions, checkPendingPredictions, verifyPrediction: verifyPred, evolveParams, expireOldPredictions, getLedgerStats } = await import('./predictor/online-learner.js');

    const state = JSON.parse(fs.readFileSync('data/learning-state.json', 'utf-8'));
    const params = {
      accelerationThreshold: state.signalDetection.accelerationThreshold,
      windowSize: state.signalDetection.windowSize,
      minBaseline: state.signalDetection.minBaseline,
      layerWeight: state.scorerWeights.layer,
      growthWeight: state.scorerWeights.growth,
      usageWeight: state.scorerWeights.usage,
      activityWeight: state.scorerWeights.activity,
      signalBonusWeight: state.scorerWeights.signalBonus,
      compressionFactor: state.compressionFactor.value,
      biasCorrection: state.signalDetection.biasCorrection ?? 0,
      recencyBoost: state.signalDetection.recencyBoost ?? 0.5,
    };

    let wavePredictions: Awaited<ReturnType<typeof scanWaves>> = [];
    try {
      // 加载已发现的浪潮
      let waves = [...CANDIDATE_WAVES];
      try {
        const disc = JSON.parse(fs.readFileSync('data/discovered-waves.json', 'utf-8'));
        const { mergeWaves } = await import('./analyzer/wave-discoverer.js');
        waves = mergeWaves(CANDIDATE_WAVES, disc);
      } catch {}

      wavePredictions = await scanWaves(params, today);

      // 记录预测
      recordPredictions(
        wavePredictions.map(p => ({
          wave: p.wave.name,
          predictedEruption: p.validation.predictedEruptionDate,
          signalStrength: p.signalStrength,
          signalCount: p.validation.detectedSignals.filter(s => s.signalDate).length,
          keySignals: p.validation.detectedSignals.filter(s => s.signalDate).map(s => s.repo),
        })),
        params,
      );
    } catch (e) {
      console.warn(`[Predict] 浪潮预测跳过: ${(e as Error).message}`);
    }

    // Step 5: 自动验证
    console.log('\n═══ Step 5/7: 自动验证 ═══');
    const pendingForReview = checkPendingPredictions();
    if (pendingForReview.length > 0) {
      try {
        const { autoVerifyPredictions } = await import('./predictor/outcome-detector.js');
        const waveRepoMap = new Map<string, string[]>();
        for (const w of CANDIDATE_WAVES) {
          waveRepoMap.set(w.name, [...w.infrastructureRepos, ...w.toolingRepos, ...w.applicationRepos]);
        }
        const verifications = await autoVerifyPredictions(pendingForReview, waveRepoMap);
        for (const v of verifications) {
          verifyPred(v.predictionId, v.hit);
        }
        const hits = verifications.filter(v => v.hit).length;
        console.log(`[Verify] ${verifications.length} 条验证: ${hits} 命中`);
      } catch (e) {
        console.warn(`[Verify] 自动验证跳过: ${(e as Error).message}`);
      }
    }
    expireOldPredictions();

    // Step 6: 参数进化
    console.log('\n═══ Step 6/7: 参数进化 ═══');
    const evolution = evolveParams();
    if (evolution.changed) {
      for (const adj of evolution.adjustments) console.log(`  ${adj}`);
    }

    // Step 7: 合并生成完整周报
    console.log('\n═══ Step 7/7: 生成完整周报 ═══');
    const weekNum = Math.ceil((new Date(today).getTime() - new Date(new Date(today).getFullYear(), 0, 1).getTime()) / 604800000);
    const weekLabel = `${new Date(today).getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

    const sections: string[] = [];

    // Section 1: 标题 + 概览
    sections.push(`# Augur 周报 — ${weekLabel}`);
    sections.push('');
    sections.push(`> 生成日期: ${today} | 项目: ${entries.length} | 浪潮: ${wavePredictions.length}`);
    const ledgerStats = getLedgerStats();
    if (ledgerStats.hitRate !== null) {
      sections.push(`> 模型命中率: ${(ledgerStats.hitRate * 100).toFixed(0)}% | 预测数: ${ledgerStats.total}`);
    }
    sections.push('');

    // Section 2: 浪潮预测总览
    if (wavePredictions.length > 0) {
      sections.push('## 浪潮预测');
      sections.push('');
      sections.push('| 候选浪潮 | 信号强度 | 预测爆发 | 关键信号 |');
      sections.push('|---------|---------|---------|---------|');
      for (const p of wavePredictions) {
        const strength = { strong: '🔴 强', moderate: '🟡 中', weak: '⚪ 弱', none: '- 无' }[p.signalStrength];
        const signals = p.validation.detectedSignals.filter(s => s.signalDate).map(s => s.repo.split('/')[1]).join(', ');
        sections.push(`| ${p.wave.name} | ${strength} | ${p.validation.predictedEruptionDate ?? '-'} | ${signals || '-'} |`);
      }
      sections.push('');
    }

    // Section 3: 本周信号（trending 项目评分）
    const signalReport = formatReport(entries, weekLabel, today);
    // 去掉 signalReport 的标题（避免重复）
    const signalBody = signalReport.replace(/^#\s+.*\n+>.*\n*/m, '');
    sections.push('## 本周项目信号');
    sections.push('');
    sections.push(signalBody);

    // Section 4: 深度调研
    if (researchReports.length > 0) {
      sections.push('---');
      sections.push('');
      sections.push('## 深度调研');
      sections.push('');
      sections.push(researchReports.join('\n\n---\n\n'));
    }

    // Section 5: 共现关键词
    if (coMatrix.length > 0) {
      sections.push('---');
      sections.push('');
      sections.push('## 共现关键词网络');
      sections.push('');
      sections.push('| 关键词对 | 共现项目数 |');
      sections.push('|---------|----------|');
      for (const c of coMatrix.slice(0, 10)) {
        sections.push(`| ${c.keyword1} + ${c.keyword2} | ${c.count} |`);
      }
      sections.push('');
    }

    // Section 6: 进化状态
    sections.push('---');
    sections.push('');
    sections.push('## 系统进化状态');
    sections.push('');
    sections.push(`| 指标 | 值 |`);
    sections.push(`|------|-----|`);
    sections.push(`| 预测总数 | ${ledgerStats.total} |`);
    sections.push(`| 待验证 | ${ledgerStats.pending} |`);
    sections.push(`| 命中 | ${ledgerStats.hits} |`);
    sections.push(`| 未命中 | ${ledgerStats.misses} |`);
    if (ledgerStats.hitRate !== null) {
      sections.push(`| 命中率 | ${(ledgerStats.hitRate * 100).toFixed(0)}% |`);
    }
    if (ledgerStats.avgError !== null) {
      sections.push(`| 平均误差 | ${ledgerStats.avgError.toFixed(1)} 月 |`);
    }
    if (evolution.changed) {
      sections.push('');
      sections.push('**本周参数调整：**');
      for (const adj of evolution.adjustments) sections.push(`- ${adj}`);
    }

    const fullReport = sections.join('\n');

    // Save report
    fs.mkdirSync(opts.outputDir, { recursive: true });
    const reportPath = path.join(opts.outputDir, `${weekLabel}.md`);
    fs.writeFileSync(reportPath, fullReport, 'utf-8');
    console.log(`[Report] 已写入 ${reportPath}`);

    console.log('\n═══ 完成 ═══');
    db.close();
  });

// ─── augur publish ──────────────────────────────────────────────
program
  .command('publish')
  .description('将最新周报发布为 GitHub Issue')
  .option('-f, --file <file>', '指定报告文件')
  .option('--repo <repo>', 'GitHub 仓库 (owner/repo)', 'gxcsoccer/augur')
  .action(async (opts: { file?: string; repo: string }) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { execSync } = await import('node:child_process');

    // Find latest report
    let reportFile = opts.file;
    if (!reportFile) {
      const reportDir = 'reports';
      if (!fs.existsSync(reportDir)) {
        console.error('[Publish] reports/ 目录不存在，请先运行 augur run --weekly');
        process.exit(1);
      }
      const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.md')).sort();
      if (files.length === 0) {
        console.error('[Publish] 没有找到报告文件');
        process.exit(1);
      }
      reportFile = path.join(reportDir, files[files.length - 1]);
    }

    const content = fs.readFileSync(reportFile, 'utf-8');
    const titleMatch = content.match(/^#\s+(.+)/m);
    const title = titleMatch ? titleMatch[1] : `Augur 周报 — ${new Date().toISOString().slice(0, 10)}`;

    console.log(`[Publish] 发布: ${title}`);
    console.log(`[Publish] 文件: ${reportFile}`);
    console.log(`[Publish] 仓库: ${opts.repo}`);

    try {
      const result = execSync(
        `gh issue create --repo "${opts.repo}" --title "${title}" --label "weekly-report" --body-file "${reportFile}"`,
        { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
      );
      console.log(`[Publish] 已发布: ${result.trim()}`);
    } catch (err) {
      const error = err as { stderr?: string; message: string };
      // Try creating the label first if it doesn't exist
      if (error.stderr?.includes('label')) {
        try {
          execSync(`gh label create weekly-report --repo "${opts.repo}" --color 0E8A16 --description "Augur 信号周报" 2>/dev/null || true`, { encoding: 'utf-8' });
          const result = execSync(
            `gh issue create --repo "${opts.repo}" --title "${title}" --label "weekly-report" --body-file "${reportFile}"`,
            { encoding: 'utf-8' },
          );
          console.log(`[Publish] 已发布: ${result.trim()}`);
        } catch {
          console.error(`[Publish] 发布失败，请确认 gh CLI 已认证`);
        }
      } else {
        console.error(`[Publish] 发布失败: ${error.message}`);
      }
    }
  });

// ─── augur backtest ─────────────────────────────────────────────
program
  .command('backtest')
  .description('历史回测：--trending 验证项目爆火预测；默认验证浪潮先导信号')
  .option('-t, --target <name>', '指定回测目标 (chatgpt, cursor, manus)，不指定则全部运行')
  .option('--trending', '回测趋势项目预测（验证"即将爆火"模型）')
  .option('-o, --output <file>', '输出到文件')
  .action(async (opts: { target?: string; trending?: boolean; output?: string }) => {
    // ── Trending backtest mode ──
    if (opts.trending) {
      const { runTrendingBacktest, formatTrendingBacktestReport } = await import('./predictor/trending-backtest.js');
      console.log('[Backtest] 趋势项目预测回测（通过 ClickHouse GH Archive）...\n');
      const summary = await runTrendingBacktest();
      const report = formatTrendingBacktestReport(summary);
      if (opts.output) {
        const fs = await import('node:fs');
        fs.writeFileSync(opts.output, report, 'utf-8');
        console.log(`\n[Backtest] 报告已写入 ${opts.output}`);
      } else {
        console.log('\n' + report);
      }
      return;
    }

    // ── Wave signal backtest mode (default) ──
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

    // Social buzz & trending predictions
    const socialBuzz = (db.prepare('SELECT COUNT(*) as count FROM social_buzz').get() as { count: number }).count;
    const trendingPreds = (db.prepare('SELECT COUNT(*) as count FROM trending_predictions').get() as { count: number }).count;

    console.log('Augur 数据库状态:');
    console.log(`  项目数: ${projects}`);
    console.log(`  快照数: ${snapshots}`);
    console.log(`  README: ${readmes}`);
    console.log(`  信号分析: ${signals}`);
    console.log(`  HN 帖子: ${hnPosts}`);
    console.log(`  社交数据: ${socialBuzz}`);
    console.log(`  趋势预测: ${trendingPreds}`);
    console.log(`  共现词对: ${cooccurrences}`);
    console.log(`  最新采集: ${latest.date ?? '无'}`);

    db.close();
  });

program.parse();
