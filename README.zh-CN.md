# Augur

**开源信号情报系统 -- 通过 GitHub 生态数据预测下一个技术风口。**

Augur 监测 GitHub、HackerNews、Reddit、DEV.to 和包管理器中基础设施层的加速信号，在商业爆发前 3-6 个月预测技术浪潮的到来。

同时还能**预测哪些具体项目即将爆火** -- 在项目起飞前发现它们，提供量化 KPI 预测，历史回测命中率 **80%**。

[English](./README.md)

## 核心原理

每一波技术浪潮都遵循相同的三层传导模式：

```
基础设施层  --（领先 5~18 个月）-->  工具层  --（领先 1~6 个月）-->  应用层  -->  商业爆发
```

Augur 在基础设施层检测加速信号，预测爆发何时到来。

### 历史验证

基于 6 个历史爆发案例训练（Stable Diffusion、ChatGPT、Local LLM、RAG、Cursor、Manus），在 OpenClaw 上验证：

| 案例 | 预测日期 | 实际日期 | 误差 |
|------|---------|---------|------|
| Stable Diffusion | 2022-07-20 | 2022-08-22 | 1.1 个月 |
| Local LLM | 2023-02-09 | 2023-03-15 | 1.1 个月 |
| Cursor / AI IDE | 2023-04-12 | 2023-06-01 | 2.7 个月 |
| Manus / Agent | 2024-03-01 | 2024-03-01 | **0.0 个月** |
| **OpenClaw** | **2025-01-21** | **2025-06-01** | **95% 置信区间命中** |

**LOO 交叉验证平均误差：2.6 个月**

### 当前预测（2026 年 4 月）

| 浪潮 | 信号来源 | 预测爆发 | 状态 |
|------|---------|---------|------|
| AI-native DevOps | claude-code, playwright, ragflow | 2025-07 | 正在爆发 |
| 具身智能 | IsaacLab, openpi, GR00T | 2025-08 | 正在爆发 |
| 语音 AI | TEN-framework, chatterbox, moshi | 2025-09 | 正在爆发 |
| MCP 生态 | 7 个 repo 同时加速, browser-use 下载量加速 | 2025-11 | 活跃 |
| 端侧 AI | llama.cpp, MLX, ollama | 2026-01 | **下一个** |

### 趋势项目预测（2026 年 4 月）

预测哪些**具体项目**即将爆火，附量化 KPI：

| # | 项目 | 当前★ | 4周预计+★ | 4周后总★ | 社区活跃 | 势头 |
|---|------|-------|----------|---------|---------|------|
| 1 | mauriceboe/TREK | 270 | +668 | 938 | 76/100 | 加速中 |
| 2 | chenglou/pretext | 3.9k | +8.8k | 12.6k | 70/100 | 加速中 |
| 3 | Crosstalk-Solutions/project-nomad | 3.3k | +5.2k | 8.5k | 80/100 | 加速中 |
| 4 | larksuite/cli | 841 | +2.0k | 2.8k | 73/100 | 加速中 |
| 5 | SakanaAI/AI-Scientist-v2 | 1.8k | +739 | 2.6k | 46/100 | 加速中 |

历史回测：**80% 命中率**，平均提前 **4 周** 检测到。在 Auto-GPT、Ollama、Open Interpreter、llama.cpp 等案例上验证。

## 快速开始

```bash
# 安装依赖
npm install

# 采集数据（GitHub Trending + HackerNews + 社交媒体 + watchlist + star 历史回填）
npx tsx src/cli.ts collect --backfill --social

# 信号分析（LLM 层级分类 + 共现关键词 + 评分）
npx tsx src/cli.ts analyze

# 预测下一个风口
npx tsx src/cli.ts predict-next

# 预测即将爆火的项目（附量化 KPI）
npx tsx src/cli.ts predict --trending

# 历史回测验证
npx tsx src/cli.ts backtest --trending

# 完整周度流水线（采集 + 分析 + 预测 + 进化 + 报告）
npx tsx src/cli.ts run --weekly
```

### 环境变量

```bash
# 必需
export GITHUB_TOKEN=ghp_xxx          # GitHub API Token
export DASHSCOPE_API_KEY=sk-xxx      # 百炼 API Key（Qwen）
```

## 系统架构

```
src/
  collector/                     # 数据采集层
    github-trending.ts           # GitHub Trending 爬取（Cheerio）
    github-api.ts                # GitHub REST API + star 历史回填
    hackernews.ts                # HackerNews Algolia API
    devto.ts                     # DEV.to Forem API（社交热度信号）
    reddit.ts                    # Reddit JSON API（病毒传播先导信号）
    package-downloads.ts         # npm / PyPI 下载量

  analyzer/                      # 分析层
    growth-classifier.ts         # 增长曲线分类（阶梯/峰值/稳定/下降）
    signal-tagger.ts             # LLM 信号层级分类（基础设施/工具/应用）
    cooccurrence.ts              # 技术关键词共现网络
    feature-extractor.ts         # Issue Feature Request 挖掘
    auto-researcher.ts           # LLM 深度调研报告
    wave-discoverer.ts           # LLM 自动发现新候选浪潮

  predictor/                     # 预测层
    backtest.ts                  # ClickHouse GH Archive 历史回测
    trending-predictor.ts        # 趋势项目预测 + 量化 KPI 预测
    trending-backtest.ts         # 趋势预测历史验证（80% 命中率）
    calibrator.ts                # 网格搜索 + 三模型集成 + LOO 交叉验证
    scorer.ts                    # 多因子机会评分
    wave-scanner.ts              # 候选浪潮扫描预测
    online-learner.ts            # 预测账本 + 参数进化
    outcome-detector.ts          # 自动验证预测结果
    phase-detector.ts            # 五阶段生命周期检测
    eruption-predictor.ts        # 爆发日期预测（含压缩因子）
    report-generator.ts          # Markdown 报告生成

  store/                         # 存储层
    schema.ts                    # SQLite 表结构（含 social_buzz、trending_predictions）
    queries.ts                   # 数据访问
  util/
    clickhouse.ts                # ClickHouse 客户端（fetch + curl 回退）
  llm/
    client.ts                    # OpenAI 兼容 LLM 客户端（百炼 DashScope）
```

## 信号检测

**8 个因子**，来自 ClickHouse GH Archive 和包管理器：

| 因子 | 数据源 | 信号含义 |
|------|--------|---------|
| Stars | WatchEvent | 关注度激增 |
| Forks | ForkEvent | 实际使用意图 |
| Issues | IssuesEvent | 社区需求 |
| PRs | PullRequestEvent | 开发速度 |
| Contributors | PushEvent (去重) | 团队增长 |
| Releases | ReleaseEvent | 发版频率 |
| npm 下载量 | api.npmjs.org | JS/TS 生态采用 |
| PyPI 下载量 | pypistats.org | Python 生态采用 |

**变点检测算法**：滑动窗口（4 周）基线，3 倍加速阈值，多因子交叉验证。

## 预测模型

**三模型加权集成**：
- 线性回归（权重 0.25）-- 基线趋势
- 指数衰减（权重 0.45）-- 捕捉「领先时间在缩短」的趋势
- 距离加权 KNN（权重 0.30）-- 适应最近的历史案例

**修正机制**：
- 多信号融合：基础设施 + 工具层跨层确认 -> 领先时间 x0.7
- 信号新鲜度：最新信号在 2 个月内 -> 领先时间 x0.5
- 下载量加速：每个加速中的包 -> 预测提前 0.5 个月
- 偏差修正：从 LOO 残差自动校准

## 自举进化

系统通过 GitHub Actions 完全自主运行，无需人工干预：

```
每周循环（GitHub Actions cron）：
  采集（trending + HN + watchlist repos）
  -> 分析（LLM 分类 + 共现关键词）
  -> 预测（扫描 7 个候选浪潮）
  -> 记录（预测账本，按浪潮+月份去重）
  -> 自动验证（ClickHouse 检测过去预测是否爆发）
  -> 进化（根据命中率调整阈值/偏差）
  -> 报告（统一 Markdown，发布为 GitHub Issue）
```

```
┌────────────────────────────────────────────────────────┐
│  collect → analyze → predict → record → verify → evolve│
│     ^                                            │     │
│     │       <-- 根据验证结果自动调参 <-----------┘     │
│     └──────────── 每周 GitHub Actions cron ────────────┘
└────────────────────────────────────────────────────────┘
```

**进化规则**：
- 命中率 < 50%：放宽检测阈值（降低 threshold）
- 命中率 > 70%：收紧参数（更激进的预测）
- 系统性偏差：通过 bias adjustment 自动修正
- 超时预测（>18 个月）：自动过期

## CLI 命令

| 命令 | 说明 |
|------|------|
| `augur collect --backfill` | 采集 Trending + API + HN + star 历史回填 |
| `augur collect --social` | 同时采集 DEV.to + Reddit 社交数据 |
| `augur analyze` | LLM 信号分类 + 共现分析 + 机会评分 |
| `augur predict-next` | 扫描候选浪潮，预测爆发 |
| `augur predict --trending` | 预测即将爆火的项目 + 量化 KPI |
| `augur discover` | LLM 自动发现新候选浪潮 |
| `augur evolve` | 完整进化循环（发现 -> 预测 -> 验证 -> 调参）|
| `augur calibrate --cross-validate` | 历史数据训练 + LOO 交叉验证 |
| `augur research` | 对 Top N 信号深度调研 |
| `augur feature-requests <repo>` | 挖掘项目的 Feature Request |
| `augur run --weekly` | 完整流水线：采集 + 分析 + 预测 + 进化 + 报告 |
| `augur run --daily` | 仅每日数据采集 |
| `augur publish` | 将最新报告发布为 GitHub Issue |
| `augur backtest` | ClickHouse 历史回测（浪潮信号）|
| `augur backtest --trending` | 回测趋势项目预测（80% 命中率）|
| `augur status` | 查看数据库状态 |

## GitHub Actions 配置

1. 添加仓库 Secrets：
   - `GH_PAT` -- GitHub Personal Access Token
   - `DASHSCOPE_API_KEY` -- 百炼 API Key

2. 自动运行计划：
   - **每日 08:00（北京时间）** -- 数据采集
   - **每周一 10:00（北京时间）** -- 完整分析 + 预测 + 报告 + Issue 发布

3. 手动触发：Actions 标签页 -> "Augur Signal Intelligence" -> Run workflow

## 数据存储

所有数据持久化在仓库中：

| 文件 | 内容 |
|------|------|
| `data/augur.db` | SQLite 数据库（项目、快照、信号、HN） |
| `data/learning-state.json` | 校准后的模型参数 |
| `data/prediction-ledger.json` | 预测历史 + 验证结果 |
| `data/ch-cache.json` | ClickHouse 查询缓存（近期数据 7 天 TTL） |
| `data/discovered-waves.json` | LLM 发现的候选浪潮 |
| `reports/*.md` | 周报归档 |

## License

MIT
