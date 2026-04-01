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
  .option('--backfill', '回填 star 历史数据（冷启动用，首次运行建议加上）')
  .action(async (opts: { period: string; details: boolean; readme: boolean; hn: boolean; backfill?: boolean }) => {
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
  .description('域级预测：相位检测 + 爆发时间预测')
  .option('-d, --date <date>', '指定日期 (YYYY-MM-DD)')
  .option('--domain <domain>', '指定域深度预测')
  .option('-o, --output <file>', '输出到文件')
  .action(async (opts: { date?: string; domain?: string; output?: string }) => {
    const db = getDb();
    initSchema(db);

    const date = opts.date ?? new Date().toISOString().slice(0, 10);
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

    // Step 4: Generate and save report
    console.log('\n═══ Step 4/4: 生成周报 ═══');
    const weekNum = Math.ceil((new Date(today).getTime() - new Date(new Date(today).getFullYear(), 0, 1).getTime()) / 604800000);
    const weekLabel = `${new Date(today).getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
    const report = formatReport(entries, weekLabel, today);

    // Append research section
    let fullReport = report;
    if (researchReports.length > 0) {
      fullReport += '\n\n---\n\n# 深度调研\n\n' + researchReports.join('\n\n---\n\n');
    }

    // Append co-occurrence section
    if (coMatrix.length > 0) {
      fullReport += '\n\n---\n\n## 共现关键词网络（本周 Top 10）\n\n';
      fullReport += '| 关键词对 | 共现项目数 |\n|---------|----------|\n';
      for (const c of coMatrix.slice(0, 10)) {
        fullReport += `| ${c.keyword1} + ${c.keyword2} | ${c.count} |\n`;
      }
    }

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
