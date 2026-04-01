# Augur 实施方案

> 基于 spec.md 的可行性分析，确定的具体技术方案和实施计划。

**日期**：2026-04

---

## 一、技术选型

| 层级 | 选型 | 说明 |
|------|------|------|
| 运行时 | Node.js + TypeScript | 与 spec 一致 |
| 数据库 | SQLite（better-sqlite3） | 本地优先，轻量高性能 |
| 网页采集 | fetch + cheerio | 轻量 HTML 解析，适合静态页面（GitHub Trending 是 SSR） |
| LLM | 百炼 qwen3.5-plus | OpenAI 兼容 API，通过 `openai` npm SDK 调用 |
| 历史回测 | ClickHouse GH Archive | 免费 HTTP 查询，数据持续更新至今（已验证） |
| 向量/聚类 | LLM 直接做摘要聚类 | MVP 阶段不引入 ChromaDB |
| CLI | commander | 命令行入口 |
| 调度 | 系统 crontab | 用 crontab 调用 CLI 命令，无需常驻进程 |

### 与 spec 的差异说明

| spec 原方案 | 调整后方案 | 原因 |
|-------------|-----------|------|
| Playwright 爬虫 | fetch + cheerio | GitHub Trending 是静态 HTML（SSR），不需要浏览器引擎；cheerio ~1MB vs Playwright ~100MB |
| ChromaDB 向量存储 | LLM 直接聚类 | ChromaDB Node.js 客户端不够成熟，MVP 规模不需要 |
| OpenRouter 多模型路由 | 百炼 DashScope | 用户已有 coding plan，成本更优 |
| Trendshift / GitCharts 数据源 | MVP 暂不接入 | 网页爬取脆弱，GitHub Trending + API + HN 已够用 |
| GH Archive + BigQuery 回测 | ClickHouse 公开实例 | 免费、无需注册、HTTP 直接查询，数据从 2011 年持续更新至今 |
| OpenClaw skill 接口 | MVP 不做 | 优先级低，先做独立 CLI |
| node-cron 定时调度 | 系统 crontab | CLI 工具不需要常驻进程，crontab 更简单可靠 |

### 未来可选方案（按需引入）

| 技术 | 适用场景 | 引入条件 |
|------|---------|---------|
| Playwright | 爬取 JS 动态渲染的页面（Trendshift 等） | v0.3+ 接入新数据源时 |
| crawl4ai | 大规模多站点爬取 + LLM 结构化提取 | 数据源超过 5 个且需要自适应解析时 |

---

## 二、数据源策略

### MVP 阶段（v0.1）

| 数据源 | 采集内容 | 频率 | 接入方式 |
|--------|---------|------|---------|
| GitHub Trending | 日/周榜项目名、描述、语言、star 增量 | 每日 | fetch + cheerio |
| GitHub REST API | 项目详情（stars, forks, issues, topics, README） | 每周 | REST API + GITHUB_TOKEN |

### v0.2 扩展

| 数据源 | 采集内容 | 频率 | 接入方式 |
|--------|---------|------|---------|
| HackerNews | Show HN / Ask HN 热帖 | 每日 | Algolia HN API（免费） |

### 后续扩展（v0.3+）

| 数据源 | 接入条件 |
|--------|---------|
| Trendshift | 需求明确后再接入，需 Playwright/crawl4ai |
| arXiv | 论文趋势分析需求确认后 |
| GitCharts | 评估替代方案后决定 |

### Star 历史数据策略

GitHub 没有直接的 "stars over time" API，采用三层策略：

1. **实时积累**：每日快照当前 star 数存入 snapshots 表，逐步积累时间序列
2. **冷启动回填**：对新发现的 trending 项目，通过 Stargazer API（带 `Accept: application/vnd.github.v3.star+json`）回填最近 8 周 star 历史，使增长分类器立即可用
3. **深度回测**：通过 ClickHouse GH Archive 查询 `WatchEvent`，获取任意仓库的完整历史 star 事件

```
ClickHouse 查询示例（已验证可用，数据 2011~至今持续更新）：
POST https://play.clickhouse.com/?user=play

SELECT
  toStartOfWeek(created_at) AS week,
  count() AS new_stars
FROM github_events
WHERE repo_name = 'langchain-ai/langchain'
  AND event_type = 'WatchEvent'
GROUP BY week
ORDER BY week
```

### GitHub API 配额管理

- 认证后速率限制：5,000 req/hr
- 策略：每日只采集 trending 列表（~1 次 fetch），每周批量调用 API 补充详情
- 冷启动回填 star 历史：每个项目约需 N/100 次调用（N=star 数），优先处理 star<10k 的项目
- 实现 token bucket + 指数退避重试

---

## 三、数据库设计

### 核心表结构

```sql
-- 项目元数据
CREATE TABLE projects (
  id TEXT PRIMARY KEY,            -- 'owner/repo'
  language TEXT,
  topics TEXT,                    -- JSON array
  description TEXT,
  created_at TEXT,
  first_seen_at TEXT              -- 首次被 Augur 采集的时间
);

-- 每日/每周快照（upsert 策略：API 数据覆盖 trending 数据）
CREATE TABLE snapshots (
  project_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,       -- ISO date, e.g. '2026-04-01'
  stars INTEGER,
  forks INTEGER,
  open_issues INTEGER,
  trending_rank INTEGER,          -- NULL if not trending that day
  trending_period TEXT,           -- 'daily' | 'weekly' | NULL
  source TEXT,                    -- 'trending' | 'api' | 'hackernews'
  PRIMARY KEY (project_id, captured_at),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
-- 写入策略：INSERT OR REPLACE，api 数据优先级高于 trending

-- README 内容缓存（共现分析、信号分类的输入）
CREATE TABLE readmes (
  project_id TEXT PRIMARY KEY,
  content TEXT,                   -- README 原文
  keywords TEXT,                  -- JSON array, 提取的技术关键词
  updated_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- 信号标签与评分
CREATE TABLE signals (
  project_id TEXT NOT NULL,
  week TEXT NOT NULL,              -- '2026-W14'
  layer TEXT,                     -- 'infrastructure' | 'tooling' | 'application'
  growth_pattern TEXT,            -- 'staircase' | 'spike' | 'steady' | 'declining'
  domains TEXT,                   -- JSON array, e.g. '["agent","memory"]'
  confidence REAL,                -- 0~1
  opportunity_score REAL,         -- 加权评分
  raw_analysis TEXT,              -- LLM 原始分析结果（JSON）
  PRIMARY KEY (project_id, week)
);

-- 共现关键词（v0.2）
CREATE TABLE cooccurrences (
  keyword1 TEXT NOT NULL,         -- 保证 keyword1 < keyword2，避免重复
  keyword2 TEXT NOT NULL,
  week TEXT NOT NULL,
  count INTEGER,
  strength REAL,                  -- TF-IDF 加权共现强度
  first_seen_at TEXT,
  PRIMARY KEY (keyword1, keyword2, week)
);

-- Issue 数据（v0.2 Feature Request 挖掘用）
CREATE TABLE issues (
  id INTEGER PRIMARY KEY,         -- GitHub issue id
  project_id TEXT NOT NULL,
  title TEXT,
  body TEXT,
  labels TEXT,                    -- JSON array
  category TEXT,                  -- 'feature_request' | 'bug' | 'question' | 'other'
  captured_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

-- HackerNews 热帖（v0.2）
CREATE TABLE hn_posts (
  id INTEGER PRIMARY KEY,
  title TEXT,
  url TEXT,
  points INTEGER,
  comments INTEGER,
  captured_at TEXT,
  keywords TEXT                   -- JSON array, 提取的技术关键词
);
```

### 注意事项

- `pr_merge_rate` 延迟到 v0.2 再加入 snapshots 表，MVP 阶段 API 配额优先用于 star/issue/README 采集
- `cooccurrences` 表强制 `keyword1 < keyword2` 排序，避免 (A,B) 和 (B,A) 重复
- v0.1 只建 `projects`、`snapshots`、`readmes` 三张表，其余 v0.2 按需建表

---

## 四、LLM 调用方案

### 接入方式

```typescript
import OpenAI from 'openai';

const llm = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: 'https://coding.dashscope.aliyuncs.com/v1',
});

// 调用示例
const response = await llm.chat.completions.create({
  model: 'qwen3.5-plus',
  temperature: 0,
  max_tokens: 4096,
  messages: [{ role: 'system', content: '...' }, { role: 'user', content: '...' }],
});
```

### LLM 使用场景与成本控制

| 场景 | 调用频率 | 输入规模 | 策略 |
|------|---------|---------|------|
| 信号层级分类 | 每周 ~50-200 个项目 | 项目名+描述+topics+README 摘要 | 批量处理，每次 5-10 个项目 |
| Feature Request 挖掘 | 每周 ~10 个重点项目 | Issue 标题+正文 | 先规则过滤（label/标题关键词），LLM 只处理模糊项 |
| 周报摘要生成 | 每周 1 次 | 结构化信号数据 | 单次调用 |
| 共现关键词提取 | 每周 ~50-200 个 README | README 全文 | 可用规则（TF-IDF）替代，LLM 仅做校验 |

---

## 五、分阶段实施计划

### Phase 1: MVP（v0.1）— 2 周

**目标**：能跑起来，能出一份基础周报

| 天数 | 任务 | 产出 |
|------|------|------|
| Day 1 | 项目骨架搭建 | package.json, tsconfig, 目录结构, .gitignore |
| Day 1-2 | SQLite schema + 基础 CRUD | store/schema.ts, store/queries.ts |
| Day 2-4 | GitHub Trending 采集器（fetch+cheerio） | collector/github-trending.ts |
| Day 4-5 | GitHub API 数据补充 + star 历史回填 | collector/github-api.ts, rate limit 管理 |
| Day 6-7 | 增长曲线分类 | analyzer/growth-classifier.ts |
| Day 8-10 | CLI 入口 + 简单周报 | cli.ts, `augur collect`, `augur report --week` |
| Day 11-14 | ClickHouse 回测 3 个历史点 | predictor/backtest.ts |

**v0.1 交付物**：
- `augur collect` — 采集当日 trending 数据 + API 补充详情
- `augur report --week` — 输出 Markdown 格式基础周报（项目列表 + 增长模式）
- 3 个历史回测结果文档

**冷启动说明**：增长曲线分类需要 ≥4 周快照数据。MVP 通过 Stargazer API 回填最近 8 周 star 历史解决冷启动问题。

### Phase 2: 信号分析 + Auto Research（v0.2）— 2 周

| 任务 | 产出 |
|------|------|
| LLM 信号层级分类 | analyzer/signal-tagger.ts |
| Feature Request 挖掘 | analyzer/feature-extractor.ts |
| 共现关键词网络 | analyzer/cooccurrence.ts |
| HackerNews 采集 | collector/hackernews.ts |
| 机会评分模型 v1 | predictor/scorer.ts |
| Auto Research（路径 A） | analyzer/auto-researcher.ts |
| 周报升级（含信号分析 + 深度调研） | 完整格式周报 |

#### Auto Research 设计

对每周 Top 3~5 高置信信号自动生成深度调研报告，输入为已采集的项目数据（README、Issues、关联项目）。

**路径 A（v0.2）— LLM + 已采集数据**：
- 输入：目标项目的 README、近期 Issues、同域关联项目列表、共现关键词
- 输出：结构化分析（项目定位、生态关联、Issue 热点、机会缺口）
- 实现：单次 LLM 调用，prompt 模板化
- 成本：每周 3~5 次调用，可控

**路径 B（v0.3 可选升级）— LLM + 实时联网搜索**：
- 在路径 A 基础上，增加搜索 API 调用（Google/Bing），让 LLM 自主查找博客、讨论、相关项目
- 需验证 qwen3.5-plus 的 tool use / function calling 能力
- 搜索 API 有额外成本，按需引入

### Phase 3: 自动化（v0.3）— 1 周

| 任务 | 产出 |
|------|------|
| crontab 配置示例 | docs/crontab-setup.md |
| 飞书 Bot 推送 | integrations/feishu.ts |
| 回测框架 + 置信度校准 | predictor/backtest.ts 完善 |

### Phase 4: 开源发布（v0.4）— 1 周

| 任务 | 产出 |
|------|------|
| README + 使用文档 | README.md |
| GitHub Action 自动运行 | .github/workflows/augur.yml |
| 配套文章 | 掘金/公众号 |

---

## 六、项目目录结构

```
augur/
├── src/
│   ├── collector/
│   │   ├── github-trending.ts      # fetch+cheerio 爬取 Trending
│   │   ├── github-api.ts           # GitHub REST API 数据补充 + star 历史回填
│   │   └── hackernews.ts           # HN Algolia API（v0.2）
│   ├── analyzer/
│   │   ├── growth-classifier.ts    # 增长曲线分类（统计方法）
│   │   ├── signal-tagger.ts        # LLM 信号层级分类（v0.2）
│   │   ├── cooccurrence.ts         # 共现关键词网络（v0.2）
│   │   ├── feature-extractor.ts    # Issue FR 挖掘（v0.2）
│   │   └── auto-researcher.ts     # Auto Research 深度调研（v0.2）
│   ├── predictor/
│   │   ├── backtest.ts             # ClickHouse 历史回测
│   │   ├── scorer.ts               # 机会评分模型（v0.2）
│   │   └── report-generator.ts     # Markdown 周报生成
│   ├── store/
│   │   ├── schema.ts               # SQLite 建表
│   │   └── queries.ts              # 常用查询封装
│   ├── llm/
│   │   └── client.ts               # DashScope LLM 客户端封装
│   └── cli.ts                      # commander CLI 入口
├── config/
│   ├── domains.yaml                # 关注的技术域
│   └── skill-stack.yaml            # 用户能力栈（v0.2）
├── data/                           # SQLite 数据文件（gitignore）
├── docs/
│   ├── spec.md                     # 原始需求文档
│   └── plan.md                     # 本文档
├── tests/
├── package.json
├── tsconfig.json
└── .gitignore
```

---

## 七、关键依赖

```json
{
  "dependencies": {
    "better-sqlite3": "^11.0.0",
    "cheerio": "^1.0.0",
    "commander": "^13.0.0",
    "openai": "^4.0.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/better-sqlite3": "^7.0.0",
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0"
  }
}
```

注：相比 spec 去掉了 Playwright（~100MB）和 node-cron，依赖更轻量。
