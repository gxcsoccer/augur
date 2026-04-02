# Augur

[中文文档](./README.zh-CN.md)

**Open-source signal intelligence system that predicts technology eruptions from GitHub ecosystem data.**

Augur monitors infrastructure-layer acceleration patterns across GitHub, HackerNews, Reddit, DEV.to, and package registries to predict when the next wave of technology products will emerge -- typically 3-6 months before commercial eruption.

It can also **predict which specific projects will trend next** -- identifying rising repos before they blow up, with quantitative KPI forecasts validated at **80% hit rate** on historical data.

## How It Works

Every technology wave follows the same three-layer pattern:

```
Infrastructure layer  --( lead 5-18 months )-->  Tooling layer  --( lead 1-6 months )-->  Application layer  -->  Commercial eruption
```

Augur detects acceleration in the infrastructure layer and predicts when the eruption will happen.

### Validated Predictions

Trained on 6 historical eruptions (Stable Diffusion, ChatGPT, Local LLM, RAG, Cursor, Manus), validated on OpenClaw:

| Case | Predicted | Actual | Error |
|------|-----------|--------|-------|
| Stable Diffusion | 2022-07-20 | 2022-08-22 | 1.1 months |
| Local LLM | 2023-02-09 | 2023-03-15 | 1.1 months |
| Cursor / AI IDE | 2023-04-12 | 2023-06-01 | 2.7 months |
| Manus / Agent | 2024-03-01 | 2024-03-01 | **0.0 months** |
| **OpenClaw** | **2025-01-21** | **2025-06-01** | **95% CI hit** |

**LOO cross-validation average error: 2.6 months**

### Current Predictions (2026-04)

| Wave | Signal | Predicted Eruption | Status |
|------|--------|-------------------|--------|
| AI-native DevOps | claude-code, playwright, ragflow | 2025-07 | Erupting |
| Embodied AI | IsaacLab, openpi, GR00T | 2025-08 | Erupting |
| Voice AI | TEN-framework, chatterbox, moshi | 2025-09 | Erupting |
| MCP Ecosystem | 7 repos, browser-use accelerating | 2025-11 | Active |
| On-device / Edge AI | llama.cpp, MLX, ollama | 2026-01 | **Next up** |

### Trending Project Predictions

Also predicts which **specific projects** will blow up next, with quantitative KPI forecasts (4-week star/fork/issue projections, community score, growth momentum). See latest predictions in [`reports/`](./reports/).

Historical backtest: **80% hit rate**, average **4 weeks** early detection. Validated on Auto-GPT, Ollama, Open Interpreter, llama.cpp, SD WebUI, etc.

## Quick Start

```bash
# Install
npm install

# Collect data (GitHub Trending + HN + social media + watchlist)
npx tsx src/cli.ts collect --backfill --social

# Analyze signals (LLM classification + co-occurrence)
npx tsx src/cli.ts analyze

# Predict next wave
npx tsx src/cli.ts predict-next

# Predict trending projects (with quantitative KPIs)
npx tsx src/cli.ts predict --trending

# Historical backtest (validate prediction model)
npx tsx src/cli.ts backtest --trending

# Full weekly pipeline (collect + analyze + predict + evolve + report)
npx tsx src/cli.ts run --weekly
```

### Environment Variables

```bash
# Required
export GITHUB_TOKEN=ghp_xxx          # GitHub API token
export DASHSCOPE_API_KEY=sk-xxx      # DashScope (Qwen) API key
```

## Architecture

```
src/
  collector/
    github-trending.ts    # Fetch + Cheerio scraping
    github-api.ts         # REST API + star history backfill
    hackernews.ts         # Algolia HN API
    devto.ts              # DEV.to Forem API (social buzz)
    reddit.ts             # Reddit JSON API (viral signal)
    package-downloads.ts  # npm + PyPI download stats
  analyzer/
    growth-classifier.ts  # Staircase/spike/steady/declining patterns
    signal-tagger.ts      # LLM layer classification (infra/tooling/app)
    cooccurrence.ts       # Tech keyword co-occurrence network
    feature-extractor.ts  # Issue FR mining (rule + LLM)
    auto-researcher.ts    # Deep research report generation
    wave-discoverer.ts    # LLM-powered candidate wave discovery
  predictor/
    backtest.ts           # ClickHouse GH Archive historical backtest
    trending-predictor.ts # Rising project prediction + KPI forecasting
    trending-backtest.ts  # Trending prediction historical validation (80% hit rate)
    calibrator.ts         # Grid search + 3-model ensemble + LOO cross-validation
    scorer.ts             # Multi-factor opportunity scoring
    wave-scanner.ts       # Candidate wave prediction scanner
    online-learner.ts     # Prediction ledger + parameter evolution
    outcome-detector.ts   # Auto-verify predictions from ClickHouse data
    phase-detector.ts     # 5-phase lifecycle detection
    eruption-predictor.ts # Eruption date prediction with compression factor
    report-generator.ts   # Markdown report generation
  store/
    schema.ts             # SQLite schema (+ social_buzz, trending_predictions)
    queries.ts            # Data access layer
  util/
    clickhouse.ts         # ClickHouse client (fetch + curl fallback)
  llm/
    client.ts             # OpenAI-compatible LLM client (DashScope)
```

## Signal Detection

**8 core factors** from ClickHouse GH Archive + **2 social sources** for viral signal detection:

| Factor | Source | Signal |
|--------|--------|--------|
| Stars | WatchEvent | Attention surge |
| Forks | ForkEvent | Real usage intent |
| Issues | IssuesEvent | Community demand |
| PRs | PullRequestEvent | Development velocity |
| Contributors | PushEvent (unique) | Team growth |
| Releases | ReleaseEvent | Shipping cadence |
| npm downloads | api.npmjs.org | JS/TS adoption |
| PyPI downloads | pypistats.org | Python adoption |
| Social buzz | Reddit + DEV.to | Viral leading indicator (24-48h before star surge) |
| HN attention | Algolia HN API | Developer community buzz |

**Change-point detection**: Sliding window (4 weeks) baseline, 3x acceleration threshold, multi-factor cross-validation.

## Prediction Model

**Three-model weighted ensemble**:
- Linear regression (0.25) -- baseline trend
- Exponential decay (0.45) -- captures "lead times are shrinking" pattern
- Distance-weighted KNN (0.30) -- adapts to nearest historical case

**Corrections**:
- Multi-signal fusion: infra + tooling cross-layer confirmation -> lead time x0.7
- Signal recency: newest signal within 2 months -> lead time x0.5
- Download acceleration: each accelerating package -> prediction -0.5 months
- Bias correction: auto-calibrated from LOO residuals

## Self-Bootstrapping Evolution

The system runs autonomously via GitHub Actions with zero human intervention:

```
Weekly cycle (GitHub Actions cron):
  collect (trending + HN + watchlist repos)
  -> analyze (LLM classification + co-occurrence)
  -> predict (scan 7 candidate waves)
  -> record (prediction ledger, dedup by wave+month)
  -> auto-verify (ClickHouse eruption detection on past predictions)
  -> evolve (adjust threshold/bias based on hit rate)
  -> report (unified Markdown, publish as GitHub Issue)
```

**Evolution rules**:
- Hit rate < 50% -> widen detection threshold
- Hit rate > 70% -> tighten parameters
- Systematic bias -> auto-correct via bias adjustment
- Stale predictions (>18 months) -> auto-expire

## CLI Commands

| Command | Description |
|---------|-------------|
| `augur collect --backfill` | Collect Trending + API + HN + star history |
| `augur collect --social` | Also collect DEV.to + Reddit social data |
| `augur analyze` | LLM signal classification + co-occurrence + scoring |
| `augur predict-next` | Scan candidate waves, predict eruptions |
| `augur predict --trending` | Predict rising projects + quantitative KPIs |
| `augur discover` | LLM-powered new wave candidate discovery |
| `augur evolve` | Full evolution cycle (discover -> predict -> verify -> evolve) |
| `augur calibrate --cross-validate` | Train on history, LOO validation |
| `augur research` | Deep research on top signals |
| `augur feature-requests <repo>` | Mine feature requests from Issues |
| `augur run --weekly` | Full pipeline: collect + analyze + predict + evolve + report |
| `augur run --daily` | Daily data collection only |
| `augur publish` | Post latest report as GitHub Issue |
| `augur backtest` | Historical backtest via ClickHouse (wave signals) |
| `augur backtest --trending` | Backtest trending project predictions (80% hit rate) |
| `augur status` | Database status |

## GitHub Actions Setup

1. Add repository secrets:
   - `GH_PAT` -- GitHub Personal Access Token
   - `DASHSCOPE_API_KEY` -- DashScope API key

2. The workflow runs automatically:
   - **Daily 08:00 CST** -- data collection
   - **Weekly Monday 10:00 CST** -- full analysis + prediction + report + Issue

3. Manual trigger: Actions tab -> "Augur Signal Intelligence" -> Run workflow

## Data Storage

All data persists in the repository:

| File | Content |
|------|---------|
| `data/augur.db` | SQLite database (projects, snapshots, signals, HN) |
| `data/learning-state.json` | Calibrated model parameters |
| `data/prediction-ledger.json` | Prediction history + verification results |
| `data/ch-cache.json` | ClickHouse query cache (7-day TTL for recent data) |
| `data/discovered-waves.json` | LLM-discovered candidate waves |
| `reports/*.md` | Weekly reports archive |

## License

MIT
