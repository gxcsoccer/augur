# Augur 历史回测报告

> 生成日期: 2026-04-01
> 信号检测方法: 滑动窗口变点检测（4 周基线，加速度 ≥2x）
> 多因子: stars, forks, issues, PRs

验证核心假设：基础设施层信号领先于商业爆发 6~12 个月。

### ChatGPT 爆发
> ChatGPT 发布，Chat AI 浪潮开始
> 爆发日期: 2022-11-30

| 层级 | 仓库 | 首次信号 | 触发因子 | 强信号 | 峰值★/周 | Fork/Star比 | 周均Issue | 周均PR | 领先月数 |
|------|------|---------|---------|--------|---------|------------|---------|-------|---------|
| 基础设施 | huggingface/transformers | 2021-02-28 | issues | 2021-10-31 (forks+prs) | 1,349 | 0.24 | 100 | 111 | 21.3 |
| 基础设施 | pytorch/pytorch | 2021-10-31 | stars | 2021-10-31 (stars+forks+issues+prs) | 286 | 0.38 | 185 | 530 | 13.2 |
| 基础设施 | ggerganov/llama.cpp | - | - | - | - | - | - | - | - |
| 工具 | openai/openai-python | 2021-01-24 | stars | 2021-12-05 (forks+prs) | 24 | 0.32 | 1 | 2 | 22.5 |
| 工具 | huggingface/huggingface_hub | 2021-05-16 | prs | - | 44 | 0.27 | 7 | 14 | 18.8 |
| 工具 | AUTOMATIC1111/stable-diffusion-webui | 2022-09-18 | forks | 2022-09-18 (forks+issues+prs+stars) | 5,385 | 0.18 | 269 | 128 | 2.4 |
| 应用 | xtekky/gpt4free | - | - | - | - | - | - | - | - |
| 应用 | lencx/ChatGPT | - | - | - | - | - | - | - | - |

**基础设施层领先时间中位数**: 17.3 个月
**工具层领先时间中位数**: 18.8 个月

---

### Cursor / AI IDE 爆发
> Cursor 和 Copilot 推动 AI IDE 浪潮
> 爆发日期: 2023-06-01

| 层级 | 仓库 | 首次信号 | 触发因子 | 强信号 | 峰值★/周 | Fork/Star比 | 周均Issue | 周均PR | 领先月数 |
|------|------|---------|---------|--------|---------|------------|---------|-------|---------|
| 基础设施 | tree-sitter/tree-sitter | 2021-06-27 | issues | - | 159 | 0.07 | 7 | 6 | 23.5 |
| 基础设施 | nomic-ai/gpt4all | 2023-05-07 | prs | 2023-05-07 (prs+issues) | 14,295 | 0.10 | 84 | 31 | 0.8 |
| 基础设施 | ggerganov/llama.cpp | - | - | - | 7,719 | 0.11 | 82 | 83 | - |
| 工具 | jerryjliu/llama_index | 2023-04-30 | issues | - | 1,367 | 0.12 | 281 | 86 | 1.1 |
| 工具 | chroma-core/chroma | 2023-02-12 | stars | 2023-02-12 (stars+issues+prs+forks) | 1,302 | 0.06 | 16 | 20 | 3.6 |
| 工具 | AntonOsika/gpt-engineer | - | - | - | - | - | - | - | - |
| 应用 | getcursor/cursor | 2023-04-30 | prs | - | 7,613 | 0.08 | 76 | 13 | 1.1 |
| 应用 | paul-gauthier/aider | - | - | - | - | - | - | - | - |

**基础设施层领先时间中位数**: 12.2 个月
**工具层领先时间中位数**: 2.4 个月

---

### Manus / 通用 Agent 爆发
> 通用 Agent 浪潮，Manus 等产品涌现
> 爆发日期: 2024-03-01

| 层级 | 仓库 | 首次信号 | 触发因子 | 强信号 | 峰值★/周 | Fork/Star比 | 周均Issue | 周均PR | 领先月数 |
|------|------|---------|---------|--------|---------|------------|---------|-------|---------|
| 基础设施 | microsoft/autogen | 2023-09-24 | stars | 2023-09-24 (stars+forks+issues+prs) | 4,086 | 0.14 | 44 | 48 | 5.3 |
| 基础设施 | openai/openai-python | 2022-04-03 | stars | 2022-12-04 (forks+issues+prs) | 1,755 | 0.14 | 10 | 9 | 23.3 |
| 基础设施 | run-llama/llama_index | 2024-02-11 | issues | 2024-02-11 (issues+prs) | 441 | 0.18 | 107 | 157 | 0.6 |
| 工具 | langchain-ai/langchain | 2023-09-10 | issues | - | 990 | 0.22 | 207 | 337 | 5.8 |
| 工具 | Significant-Gravitas/AutoGPT | 2024-01-07 | prs | - | 830 | 0.90 | 17 | 107 | 1.8 |
| 工具 | joaomdmoura/crewAI | 2024-02-25 | prs | - | 2,391 | 0.12 | 28 | 11 | 0.2 |
| 应用 | geekan/MetaGPT | 2023-07-23 | prs | 2023-07-23 (prs+stars+forks+issues) | 9,159 | 0.12 | 14 | 31 | 7.4 |
| 应用 | OpenDevin/OpenDevin | - | - | - | - | - | - | - | - |

**基础设施层领先时间中位数**: 5.3 个月
**工具层领先时间中位数**: 1.8 个月

---

## 总结

- 基础设施层领先时间中位数: **13.2 个月** (样本: 21.3, 13.2, 23.5, 0.8, 5.3, 23.3, 0.6)
- 工具层领先时间中位数: **3.0 个月** (样本: 22.5, 18.8, 2.4, 1.1, 3.6, 5.8, 1.8, 0.2)
- 应用层领先时间中位数: **4.3 个月** (样本: 1.1, 7.4)

### 高 Fork/Star 比项目（实际使用率高）
- Significant-Gravitas/AutoGPT: 0.90 (tooling)
- pytorch/pytorch: 0.38 (infrastructure)
- openai/openai-python: 0.32 (tooling)
- huggingface/huggingface_hub: 0.27 (tooling)
- huggingface/transformers: 0.24 (infrastructure)

### 方法论说明
- **首次信号**: 某因子周值首次达到前4周基线的 2 倍
- **强信号**: 2+ 个因子在 4 周内同时出现加速
- **Fork/Star 比**: 高比值（>0.2）表示项目被实际使用而非仅被收藏