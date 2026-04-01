# Augur 预测系统设计

> 将信号分类+评分升级为真正的前瞻性预测

**日期**：2026-04

---

## 一、问题分析

当前 Augur 的"预测"是分类+评分，不是真正的预测：

```
当前：项目 X 是基础设施层，增长模式是阶梯型，评分 0.49
目标：项目 X 所在的 local-AI 领域正处于工具层形成阶段，
      预计 2026 Q3~Q4 进入商业爆发，置信度 0.78
```

| 层面 | 当前 | 缺失 |
|------|------|------|
| 粒度 | 单个项目 | 没有**领域/生态级**聚合 |
| 时间 | 当周快照 | 没有**跨周轨迹**追踪 |
| 输出 | 评分排序 | 没有**时间线预测**（什么时候爆发） |

---

## 二、核心模型：域级信号相位检测

### 2.1 五阶段相位模型

Spec 的核心洞察"三层时序结构"转化为可操作的相位模型：

```
Phase 1: 萌芽期     — 1~2 个 infrastructure 项目开始加速
Phase 2: 凝聚期     — 3+ 项目，共现关键词网络形成，fork 增长
Phase 3: 工具化期   — tooling 层项目出现，SDK/框架引用 infrastructure
Phase 4: 爆发前夜   — application 层项目涌现，HN/媒体关注度上升
Phase 5: 商业爆发   — 商业产品上市
```

对每个技术域，检测当前处于哪个相位，基于回测校准的领先时间预测爆发窗口。

### 2.2 相位检测规则

| 相位 | 检测条件 |
|------|---------|
| Phase 1 | infrastructure 项目数 ≥ 1 且有加速信号 |
| Phase 2 | infrastructure 项目数 ≥ 3，共现密度 > 0.3，fork 增长 |
| Phase 3 | tooling/infrastructure 比 ≥ 0.5，出现 SDK/框架类项目 |
| Phase 4 | application 项目出现，HN 帖子数 > 5/周，媒体热度上升 |
| Phase 5 | 商业产品发布（手动标注或从新闻检测） |

---

## 三、域聚合层

### 3.1 域级视图数据结构

```typescript
interface DomainView {
  domain: string;                // e.g. 'local-ai'
  week: string;
  projects: {
    infrastructure: string[];
    tooling: string[];
    application: string[];
  };
  metrics: {
    totalProjects: number;
    totalStarAcceleration: number;   // 域内所有项目周 star 增量之和
    coOccurrenceDensity: number;     // 域内关键词共现网络密度 (0~1)
    crossLayerLinkage: number;       // tooling 项目 README 引用 infrastructure 的比例
    avgForkStarRatio: number;        // 域内平均 fork/star 比
    hnAttention: number;             // HN 帖子中提及该域的数量
    featureRequestVolume: number;    // 域内 infrastructure 项目的 FR 数量
  };
  phase: 1 | 2 | 3 | 4 | 5;
  ssi: number;                       // Signal Strength Index
  prediction: DomainPrediction | null;
}
```

### 3.2 域的定义

初始域列表（来自 signal-tagger 的 domains 字段）：

- agent, memory, desktop, voice, eval, local-ai, code-gen, search, data, security, devops, economy

一个项目可属于多个域。域内项目通过 signal 表的 domains 字段聚合。

---

## 四、信号强度指数（SSI）

### 4.1 定义

每周对每个域计算一个 0~1 的复合指标，用于跨周追踪趋势：

```
SSI(domain, week) =
  project_count_score × 0.15
+ star_acceleration_score × 0.20
+ co_occurrence_density × 0.15
+ cross_layer_linkage × 0.20
+ fork_star_ratio_avg × 0.10
+ hn_attention_score × 0.10
+ feature_request_volume × 0.10
```

### 4.2 各因子归一化

| 因子 | 归一化方法 |
|------|-----------|
| project_count | min(count / 20, 1.0) |
| star_acceleration | min(total_delta / 10000, 1.0) |
| co_occurrence_density | 直接使用 (已经是 0~1) |
| cross_layer_linkage | 直接使用 (已经是 0~1) |
| fork_star_ratio_avg | min(ratio / 0.3, 1.0) |
| hn_attention | min(post_count / 20, 1.0) |
| feature_request_volume | min(fr_count / 50, 1.0) |

### 4.3 SSI 趋势判断

| 趋势 | 条件 | 含义 |
|------|------|------|
| 加速上升 | 连续 3 周 SSI 增量递增 | 域在快速成型 |
| 稳定上升 | 连续 4 周 SSI > 前周 | 域在稳步发展 |
| 平台期 | SSI 波动 < 5% 持续 3 周 | 域成熟或停滞 |
| 拐头下降 | SSI 从高位连续 2 周下降 | 可能是伪信号 |

### 4.4 存储

```sql
CREATE TABLE domain_signals (
  domain TEXT NOT NULL,
  week TEXT NOT NULL,
  phase INTEGER,
  ssi REAL,
  project_count INTEGER,
  infra_count INTEGER,
  tooling_count INTEGER,
  app_count INTEGER,
  metrics TEXT,              -- JSON, 详细指标
  prediction TEXT,           -- JSON, 预测结果
  PRIMARY KEY (domain, week)
);
```

---

## 五、爆发时间预测

### 5.1 基础模型

```
predicted_eruption = now + remaining_lead_time

remaining_lead_time = phase_to_eruption(current_phase) × compression_factor
```

### 5.2 各相位到爆发的基础领先时间

基于回测校准数据（docs/backtest-report.md）：

| 当前相位 | 基础领先时间（月） | 说明 |
|---------|-------------------|------|
| Phase 1 | 12~18 | 还在萌芽，距离爆发远 |
| Phase 2 | 8~12 | 生态开始形成 |
| Phase 3 | 3~6 | 工具层已出现，爆发较近 |
| Phase 4 | 1~3 | 爆发前夜 |
| Phase 5 | 0 | 已爆发 |

### 5.3 压缩因子

回测显示领先时间在缩短（17→12→5 个月），建模为年度压缩：

```
compression_factor = 0.7 ^ (years_since_2022)

2022: 1.0（ChatGPT 基准）
2023: 0.7（Cursor 期）
2024: 0.49（Manus 期）
2025: 0.34
2026: 0.24
```

### 5.4 置信度计算

```
prediction_confidence =
  phase_confidence × 0.40        # 相位判断的确信程度
+ data_completeness × 0.30       # 域内数据充分度
+ ssi_trend_stability × 0.20     # SSI 趋势是否稳定
+ backtest_accuracy × 0.10       # 历史回测准确率
```

### 5.5 预测输出

```typescript
interface DomainPrediction {
  domain: string;
  currentPhase: number;
  predictedEruptionRange: [string, string];  // ['2026-Q3', '2026-Q4']
  confidence: number;
  keyEvidence: string[];          // 关键依据
  gaps: string[];                 // 机会缺口
  risks: string[];                // 预测风险因素
}
```

---

## 六、输出形态

### 6.1 周报中的预测板块

```markdown
## 预测：Local AI 基础设施 → 商业化工具

当前相位：Phase 3（工具化期）
信号强度指数：0.82（连续 6 周上升 ↑）
域内项目：18 个（基础设施 5 | 工具 8 | 应用 5）

预测爆发窗口：2026 Q3~Q4
置信度：0.76（基于 3 个历史回测校准）

关键依据：
- llama.cpp/ollama/mlx 三个基础设施项目持续阶梯型增长
- 工具层已出现 SDK 聚合现象（openai-compatible API 成为事实标准）
- HN 本周出现 12 篇 local-AI 相关帖子
- Issue 热点集中在"多模型切换"和"本地 benchmark"

机会缺口：
- 缺少统一的本地模型 benchmark CLI
- 缺少跨框架的模型格式转换工具

风险因素：
- 大厂可能直接推出闭源解决方案，压缩开源工具层空间
- 硬件变化（新芯片）可能改变技术路线
```

### 6.2 预测追踪（跨周）

每周对比上周预测 vs 本周实际：
- 相位是否前进？
- SSI 是否符合预期？
- 有无新项目加入/退出？

这些对比结果反馈到在线学习系统，校准权重和阈值。

---

## 七、实现路径

| 步骤 | 内容 | 复杂度 | 依赖 |
|------|------|--------|------|
| 1 | 域聚合 — 按域汇总项目和指标 | 低 | signals 表 |
| 2 | SSI 计算 + 存储 + 跨周追踪 | 中 | 域聚合 |
| 3 | 相位检测 — 规则引擎 | 中 | SSI |
| 4 | 爆发时间预测 — 校准领先时间 + 压缩因子 | 中 | 相位检测 |
| 5 | LLM 综合预测 — 结构化数据 → 叙事性预测 | 低 | 步骤 1-4 |
| 6 | 预测追踪 — 跨周对比 + 反馈到在线学习 | 中 | 步骤 4 |

预计总工时：1~2 周

### CLI 集成

```
augur predict              # 输出所有域的当前预测
augur predict --domain agent  # 指定域深度预测
augur predict --track      # 显示预测追踪（跨周对比）
```
