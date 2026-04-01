# Augur — 开源信号情报系统

> *通过读取 GitHub 生态的历史数据，识别技术浪潮的三层先导信号，预测 6~12 个月后的商业机会。*

**状态**：草案 v0.1  
**作者**：Peter  
**日期**：2025-04  
**定位**：OpenClaw 生态下的独立 Research Agent 模块，同时作为独立开源项目发布

---

## 一、背景与核心洞察

### 1.1 观察

AI 领域每一波商业浪潮（Chat → IDE → 通用 Agent → 专业 Agent）之前，GitHub 生态中都存在可被识别的先导信号，且这些信号遵循固定的三层时序结构：

```
基础设施层  →（领先 5~18 个月，中位数 ~13 个月，且在缩短）→  工具抽象层  →（领先 1~6 个月，中位数 ~3 个月）→  产品应用层  →  商业爆发
```

> **回测校准（2026-04）**：基于 ClickHouse GH Archive 多因子变点检测（stars/forks/issues/PRs），
> 对 ChatGPT、Cursor、Manus 三个爆发点回测，得到如下经验值。详见 docs/backtest-report.md。

| 浪潮 | 基础设施先导 | 工具层先导 | 商业爆发 | 基础设施领先 | 工具层领先 |
|------|------------|-----------|---------|------------|----------|
| Chat | transformers, pytorch | OpenAI SDK, HuggingFace Hub, SD-WebUI | ChatGPT 2022.11 | ~17 个月 | ~19 个月 |
| IDE  | tree-sitter, gpt4all, llama.cpp | llama-index, chroma | Cursor/Copilot 2023 Q2 | ~12 个月 | ~2 个月 |
| 通用 Agent | autogen, openai-python | LangChain, AutoGPT, crewAI | Manus 2024 Q1 | ~5 个月 | ~2 个月 |
| 专业 Agent | MCP, computer-use, AX API | Claude Code, OpenManus | aime/OpenClaw 2025 | ~待验证 | ~待验证 |

### 1.2 核心假设

1. **领先时间在缩短**：基础设施层领先从 ~17 个月缩短到 ~5 个月（回测验证），意味着窗口期在压缩，需要更快速的信号捕捉。
2. **信号可量化**：「阶梯型增长曲线」比「峰值型增长」更能代表真实需求，可通过增速/波动比来区分。
3. **多因子比单因子更准**：star 加速度 + fork/star 比 + issue 活跃度 + PR 活跃度，多因子同时加速（"强信号"）比单一 star 增长更有预测价值（回测验证）。
4. **共现网络比单项目更准**：同一周内在不同仓库的 README/Issues 里共现的技术词汇，代表一个生态正在形成，比单一项目的星数更有预测价值。
5. **缺口识别是商业化的捷径**：热门基础设施项目 Issues 中的 feature request 集群，就是工具层的「未满足需求地图」。
6. **Fork/Star 比区分真伪**：高 Fork/Star 比（>0.2）表示项目被真实使用而非仅被收藏，是信号质量的重要过滤器。

### 1.3 目标

- **个人使用**：每周自动输出一份「信号情报周报」，辅助 Peter 的技术方向和产品决策
- **开源项目**：以 OpenClaw 插件形式发布，吸引 Developer Infra / AI 创业方向的受众
- **方法论验证**：通过历史回测建立置信度基线，让预测有据可依

---

## 二、系统架构

```
┌─────────────────────────────────────────────────────────┐
│                        Augur                            │
│                                                         │
│  ┌───────────┐   ┌───────────┐   ┌───────────────────┐  │
│  │  Collector │   │  Analyzer │   │  Predictor        │  │
│  │  数据采集层 │──▶│  信号处理层 │──▶│  预测与报告层     │  │
│  └───────────┘   └───────────┘   └───────────────────┘  │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │              Signal Store (时序数据库)             │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
         │                                    │
    OpenClaw 技能接口              Feishu Bot / 邮件推送
```

### 模块职责

| 模块 | 职责 | 实现方式 |
|------|------|---------|
| Collector | 定时采集多源数据 | GitHub API + Playwright 爬虫 |
| Analyzer | 信号分类、增长曲线判断、共现分析 | LLM + 统计方法 |
| Predictor | 时序回溯验证、置信度评分、机会识别 | LLM + 规则引擎 |
| Signal Store | 存储项目历史星数、Issue 数、标签、共现关系 | SQLite（本地）/ PostgreSQL（服务器）|
| Reporter | 生成周报、Slack/Feishu 推送 | Markdown 模板 + Bot API |

---

## 三、数据层（Collector）

### 3.1 数据源

| 数据源 | 采集内容 | 频率 | 接入方式 |
|--------|---------|------|---------|
| GitHub Trending | 日/周/月榜项目 | 每日 | Playwright 爬取（无官方 API）|
| GitHub API | 星数历史、Issue 列表、PR 列表、README | 每周 | REST API v3 + GraphQL |
| Trendshift | 项目增长曲线数据 | 每周 | 网页爬取 |
| HackerNews | Show HN / Ask HN 热帖 | 每日 | Algolia HN API |
| arXiv | AI/ML 领域论文提交量 | 每周 | arXiv API |
| GitCharts | 历史贡献节奏 | 每月 | 网页爬取 |

### 3.2 核心数据结构

```typescript
interface ProjectSnapshot {
  id: string;                  // github: owner/repo
  capturedAt: Date;
  stars: number;
  starsDelta7d: number;        // 7 日增量
  starsDelta30d: number;       // 30 日增量
  forks: number;
  forkStarRatio: number;       // fork/star 比，衡量真实使用
  openIssues: number;
  issueDelta7d: number;
  prMergeRate: number;         // PR 合并率，衡量维护活跃度
  topics: string[];            // GitHub topics
  language: string;
  readmeKeywords: string[];    // 提取的技术关键词
  trendingDays: number;        // 连续上榜天数
}

interface SignalTag {
  projectId: string;
  layer: 'infrastructure' | 'tooling' | 'application';
  domain: string[];            // e.g. ['agent', 'memory', 'desktop']
  growthPattern: 'staircase' | 'spike' | 'steady' | 'declining';
  confidence: number;          // 0~1
}

interface CoOccurrence {
  keyword1: string;
  keyword2: string;
  count: number;               // 同一周内共现次数
  firstSeenAt: Date;
  strength: number;            // TF-IDF 加权共现强度
}
```

---

## 四、信号处理层（Analyzer）

### 4.1 增长曲线分类

区分「阶梯型」（真实需求驱动）和「峰值型」（媒体/营销驱动）是核心判断：

```python
def classify_growth_pattern(star_history: list[int]) -> str:
    """
    阶梯型：每隔一段时间有新台阶，波动率低
    峰值型：单周暴涨后回落，波动率高
    """
    weekly_deltas = np.diff(star_history)
    volatility = np.std(weekly_deltas) / (np.mean(weekly_deltas) + 1)
    
    if volatility < 0.8 and has_multiple_steps(star_history):
        return 'staircase'   # 持续型，值得关注
    elif max(weekly_deltas) > 5 * np.median(weekly_deltas):
        return 'spike'       # 事件驱动，短期热度
    else:
        return 'steady'
```

### 4.2 信号层级分类（LLM）

```
System Prompt:
你是一个技术趋势分析专家。给定一个开源项目的信息，将其分类为三层信号之一：

- infrastructure（基础设施层）：协议、运行时、数据格式、底层 API、模型训练工具
- tooling（工具抽象层）：SDK、框架、开发工具、集成库
- application（产品应用层）：面向终端用户的产品、SaaS、桌面应用

同时识别其所属的技术域（agent / memory / desktop / voice / eval / local-ai / economy / other）
输出 JSON。
```

### 4.3 共现关键词网络

每周从所有采集项目的 README + Issues 中提取技术关键词，构建共现矩阵：

- 窗口：7 天内在不同项目中同时出现的词对
- 权重：TF-IDF 加权，过滤通用词
- 阈值：共现次数 ≥ 5 次才记录
- 目的：找「正在形成的技术生态」，而不是单个热门项目

### 4.4 Feature Request 挖掘

对基础设施层项目的 Issues，自动分类 feature request vs bug report，并聚类：

```
对 Issue 列表执行：
1. LLM 分类：feature_request / bug / question / other
2. 对 feature_request 提取「用户想要什么」（1 句话摘要）
3. 用 embedding 聚类，找高频需求主题
4. 输出：「需求-频次」排序表 → 这就是工具层机会地图
```

---

## 五、预测层（Predictor）

### 5.1 历史回测框架

**目的**：用已知浪潮校准「领先时间」参数，建立置信度基线。

**回测方法**：

1. 选取 5 个已知爆发点（ChatGPT、Cursor、Manus 等）
2. 从爆发时间往前 18 个月，提取每个月的 Trending 数据
3. 找最早出现「基础设施层」标签项目的时间点
4. 计算 `领先时间 = 爆发月 - 首次出现月`
5. 建立置信区间

**预期输出**：

```json
{
  "domain": "local-ai",
  "lead_time_median": 7.2,  // 月
  "lead_time_std": 1.8,
  "first_signal_date": "2024-09",
  "predicted_eruption": "2025-Q2~Q3",
  "confidence": 0.78
}
```

### 5.2 机会评分模型

每周对所有识别到的「信号集群」打分：

```
机会得分 = 
  信号层级权重 × 0.30    # infrastructure=1.0, tooling=0.6, application=0.2
+ 增长质量得分 × 0.25    # staircase=1.0, steady=0.6, spike=0.2
+ 共现强度得分 × 0.20    # 关联词汇共现网络密度
+ 需求缺口得分 × 0.15    # Issue feature request 频次
+ 能力匹配度   × 0.10    # 与用户预设技能栈的重合度（可配置）
```

### 5.3 预测报告结构

```markdown
# Augur 周报 — 2025-W18

## 本周高置信信号（3 个）

### 🔴 本地 AI 基础设施（置信度 0.82）
- 触发项目：MLX-LM ↑2400★, llama.cpp ↑1800★
- 信号特征：连续 6 周阶梯型增长，fork/star 比 0.34（高）
- 共现词汇：quantization, edge-inference, gguf, private-deployment
- 领先时间估计：已进入工具层形成阶段，距爆发约 3~5 个月
- 工具层缺口：缺少统一的本地模型 benchmark CLI 和多模型切换层

### 🟡 Agent 评估基础设施（置信度 0.71）
...

## 本周 Feature Request 热点（Top 5）
1. [browser-use] 多账号并发调度（37 次提及）
2. [mem0] 跨 session 记忆检索 API（29 次提及）
...

## 共现网络新兴词对（本周新增）
- mcp + a2a（出现 12 次，首次共现）
- local-llm + tts（出现 8 次）
...
```

---

## 六、技术栈

| 层级 | 选型 | 原因 |
|------|------|------|
| 运行时 | Node.js + TypeScript | 与 OpenClaw 生态一致 |
| 爬虫 | Playwright | 处理动态页面 |
| 数据库 | SQLite（本地）/ PostgreSQL（服务器） | 轻量优先，可升级 |
| 向量存储 | ChromaDB | Issue 聚类、embedding 检索 |
| LLM 调用 | OpenRouter（Qwen3.5 / Claude）| 多模型路由，成本优化 |
| 调度 | node-cron | 定时任务 |
| 推送 | Feishu Webhook + 邮件 | 与现有 OpenClaw 集成对齐 |
| 可观测性 | OTEL（与 OpenClaw 统一）| 便于接入 Arbiter 评估框架 |

---

## 七、项目结构

```
augur/
├── src/
│   ├── collector/
│   │   ├── github-trending.ts     # Trending 日榜采集
│   │   ├── github-api.ts          # 星数历史、Issues 采集
│   │   ├── hackernews.ts          # HN 热帖采集
│   │   └── scheduler.ts           # cron 调度
│   ├── analyzer/
│   │   ├── growth-classifier.ts   # 阶梯型 vs 峰值型判断
│   │   ├── signal-tagger.ts       # LLM 信号层级分类
│   │   ├── cooccurrence.ts        # 共现关键词网络
│   │   └── feature-extractor.ts   # Issue feature request 挖掘
│   ├── predictor/
│   │   ├── backtest.ts            # 历史回测框架
│   │   ├── scorer.ts              # 机会评分模型
│   │   └── report-generator.ts    # 周报生成
│   ├── store/
│   │   ├── schema.ts              # 数据库 schema
│   │   └── queries.ts             # 常用查询
│   └── integrations/
│       ├── feishu.ts              # 飞书推送
│       ├── openclaw-skill.ts      # OpenClaw 技能接口
│       └── cli.ts                 # 独立 CLI 入口
├── config/
│   ├── domains.yaml               # 关注的技术域配置
│   ├── skill-stack.yaml           # 用户能力栈（影响匹配度评分）
│   └── backtest-targets.yaml      # 回测基准爆发点
├── data/
│   └── augur.db                   # SQLite 数据文件
├── tests/
│   └── backtest/                  # 历史回测验证脚本
└── README.md
```

---

## 八、OpenClaw 集成接口

Augur 作为 OpenClaw 的一个 Research Agent 技能，支持以下调用：

```typescript
// skill 定义
{
  name: 'augur',
  description: '分析 GitHub 开源趋势，识别技术信号，预测商业机会',
  actions: [
    'weekly_report',          // 生成本周信号周报
    'domain_deep_dive',       // 对某个技术域做深度分析
    'project_signal',         // 分析单个项目的信号层级和增长质量
    'backtest',               // 对历史爆发点做回测验证
    'gap_analysis',           // 分析某技术域的工具层缺口
  ]
}

// 示例调用
augur.weeklyReport({ topN: 5, minConfidence: 0.65 })
augur.domainDeepDive({ domain: 'local-ai', lookback: '6m' })
augur.gapAnalysis({ project: 'browser-use/browser-use' })
```

---

## 九、Roadmap

### v0.1 — MVP（2 周）
- [ ] GitHub Trending 采集 + SQLite 存储
- [ ] 基础增长曲线分类（staircase vs spike）
- [ ] 简单 CLI：`augur report --week`
- [ ] 手动验证 3 个历史回测点

### v0.2 — 信号分析（2 周）
- [ ] LLM 信号层级分类（infrastructure / tooling / application）
- [ ] Feature Request 挖掘（Issue 分类 + 聚类）
- [ ] 共现关键词网络
- [ ] 机会评分模型 v1

### v0.3 — 自动化报告（1 周）
- [ ] 飞书 Bot 周报推送
- [ ] OpenClaw skill 接口
- [ ] 回测框架完整实现 + 置信度校准

### v0.4 — 开源发布（1 周）
- [ ] README + 文档完善
- [ ] GitHub Action 自动运行示例
- [ ] 第一篇配套文章（掘金/微信公众号）

---

## 十、成功指标

| 指标 | 目标 |
|------|------|
| 历史回测准确率 | ≥ 70%（预测的领先时间在实际值 ±2 个月内）|
| 周报覆盖度 | 每周识别 ≥ 3 个高置信信号 |
| 噪音过滤率 | 峰值型热度项目占输出比 ≤ 20% |
| 开源指标（6 个月）| GitHub ≥ 500 stars |
| 个人决策价值 | 至少 1 个项目/产品方向来自 Augur 的建议 |

---

## 附：当前高确信信号（2025-04）

基于现有数据，以下信号已进入工具层形成阶段，预计 3~6 个月内爆发：

1. **本地 AI 基础设施**（MLX、llama.cpp、Ollama 持续增长）→ 本地开发工具 / 私有化部署
2. **桌面/OS 级 Agent**（AX API、computer-use、AXon 类项目）→ macOS 自动化产品
3. **Agent 评估编排**（OTEL for AI、skill eval 框架）→ Arbiter / Skill Marketplace

这三个方向与 Peter 当前的 AXon、OpenClaw、Arbiter 项目高度重合——Augur 本身就是在这些项目上做验证的最好工具。