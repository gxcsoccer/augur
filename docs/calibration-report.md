# Augur 模型校准与验证报告

> 生成日期: 2026-04-01

## 训练阶段

搜索空间: 240 个参数组合

### 最优参数

| 参数 | 值 | 说明 |
|------|-----|------|
| accelerationThreshold | 3 | 变点检测倍数 |
| windowSize | 4 | 滑动窗口（周） |
| minBaseline | 3 | 最低基线 |
| compressionFactor | 0.6 | 压缩因子 |

**综合评分: 0.776**

### Top 5 参数组合

| 排名 | threshold | window | baseline | compression | 评分 |
|------|-----------|--------|----------|-------------|------|
| 1 | 3 | 4 | 3 | 0.6 | 0.776 |
| 2 | 3 | 4 | 3 | 0.7 | 0.776 |
| 3 | 3 | 4 | 3 | 0.75 | 0.776 |
| 4 | 3 | 4 | 3 | 0.8 | 0.776 |
| 5 | 3 | 4 | 3 | 0.85 | 0.776 |

### 训练集信号检测详情

#### Stable Diffusion 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | CompVis/latent-diffusion | 2022-04-03 | 4.7 |
| 基础设施 | openai/CLIP | 2021-03-07 | 17.8 |
| 基础设施 | huggingface/diffusers | 2022-07-17 | 1.2 |
| 工具 | huggingface/transformers | 2021-04-11 | 16.6 |
| 工具 | CompVis/stable-diffusion | - | - |
| 工具 | invoke-ai/InvokeAI | - | - |
| 应用 | AUTOMATIC1111/stable-diffusion-webui | - | - |
| 应用 | cmdr2/stable-diffusion-ui | - | - |

#### ChatGPT 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | huggingface/transformers | 2021-04-11 | 19.9 |
| 基础设施 | pytorch/pytorch | 2021-10-31 | 13.2 |
| 基础设施 | ggerganov/llama.cpp | - | - |
| 工具 | openai/openai-python | 2022-01-23 | 10.4 |
| 工具 | huggingface/huggingface_hub | 2021-05-16 | 18.8 |
| 工具 | AUTOMATIC1111/stable-diffusion-webui | 2022-10-09 | 1.7 |
| 应用 | xtekky/gpt4free | - | - |
| 应用 | lencx/ChatGPT | - | - |

#### Local LLM 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | ggerganov/llama.cpp | - | - |
| 基础设施 | ggerganov/ggml | 2022-12-04 | 3.4 |
| 基础设施 | facebookresearch/llama | - | - |
| 工具 | nomic-ai/gpt4all | - | - |
| 工具 | lm-sys/FastChat | - | - |
| 工具 | oobabooga/text-generation-webui | 2023-01-29 | 1.5 |
| 应用 | imartinez/privateGPT | - | - |
| 应用 | mlc-ai/mlc-llm | - | - |

#### RAG / Vector DB 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | weaviate/weaviate | - | - |
| 基础设施 | qdrant/qdrant | 2021-05-09 | 23.1 |
| 基础设施 | facebookresearch/faiss | 2021-09-05 | 19.1 |
| 工具 | hwchase17/langchain | 2023-01-15 | 2.5 |
| 工具 | jerryjliu/llama_index | - | - |
| 工具 | chroma-core/chroma | 2023-02-12 | 1.6 |
| 应用 | imartinez/privateGPT | - | - |
| 应用 | StanGirard/quivr | - | - |

#### Cursor / AI IDE 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | tree-sitter/tree-sitter | 2021-06-27 | 23.5 |
| 基础设施 | nomic-ai/gpt4all | 2023-05-07 | 0.8 |
| 基础设施 | ggerganov/llama.cpp | - | - |
| 工具 | jerryjliu/llama_index | 2023-04-30 | 1.1 |
| 工具 | chroma-core/chroma | 2023-02-12 | 3.6 |
| 工具 | AntonOsika/gpt-engineer | - | - |
| 应用 | getcursor/cursor | 2023-04-30 | 1.1 |
| 应用 | paul-gauthier/aider | - | - |

#### Manus / 通用 Agent 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | microsoft/autogen | 2023-09-24 | 5.3 |
| 基础设施 | openai/openai-python | 2022-12-04 | 15.1 |
| 基础设施 | run-llama/llama_index | 2023-11-05 | 3.9 |
| 工具 | langchain-ai/langchain | 2023-09-10 | 5.8 |
| 工具 | Significant-Gravitas/AutoGPT | 2024-01-07 | 1.8 |
| 工具 | joaomdmoura/crewAI | - | - |
| 应用 | geekan/MetaGPT | 2023-08-06 | 6.9 |
| 应用 | OpenDevin/OpenDevin | - | - |

---

## 验证阶段

**测试集: 专业 Agent / OpenClaw 爆发**
**实际爆发日期: 2025-06-01**

### 检测到的信号（6 因子：stars/forks/issues/PRs/contributors/releases）

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | modelcontextprotocol/modelcontextprotocol | - | - |
| 基础设施 | modelcontextprotocol/servers | - | - |
| 基础设施 | modelcontextprotocol/python-sdk | 2025-01-05 | 1.8 |
| 基础设施 | anthropics/anthropic-sdk-python | - | - |
| 工具 | anthropics/claude-code | - | - |
| 工具 | browser-use/browser-use | 2025-01-19 | 1.4 |
| 工具 | langchain-ai/langgraph | 2024-04-21 | 10.5 |
| 应用 | openclaw/openclaw | - | - |
| 应用 | OpenManus/OpenManus | - | - |
| 应用 | all-hands-ai/OpenHands | - | - |

### 下载量信号（npm/PyPI）

| 仓库 | 包名 | 注册表 | 周下载量 | 趋势 |
|------|------|--------|---------|------|
| modelcontextprotocol/python-sdk | mcp | pypi | 27,114,398 | 📈 增长 |
| browser-use/browser-use | browser-use | pypi | 982,728 | 🔺 加速 |
| langchain-ai/langgraph | langgraph | pypi | 8,804,247 | 📈 增长 |


### 预测结果

| 指标 | 值 |
|------|-----|
| 预测爆发日期 | **2025-01-21** |
| 实际爆发日期 | 2025-06-01 |
| 预测误差 | 4.4 个月 |
| 站在预测时的剩余时间 | -1.3 个月 |

### 结论

模型预测误差 4.4 个月，**方向正确但精度有待提升**。

---

## Leave-one-out 交叉验证

| Fold | 留出案例 | Cutoff | 预测爆发 | 实际爆发 | 误差(月) |
|------|---------|--------|---------|---------|---------|
| 1 | Stable Diffusion 爆发 | 2022-05-22 | 2022-11-03 | 2022-08-22 | 2.4 |
| 2 | ChatGPT 爆发 | 2022-08-30 | 2022-07-01 | 2022-11-30 | 5.1 |
| 3 | Local LLM 爆发 | 2022-12-15 | 2023-06-04 | 2023-03-15 | 2.7 |
| 4 | RAG / Vector DB 爆发 | 2023-01-01 | - | 2023-04-01 | - |
| 5 | Cursor / AI IDE 爆发 | 2023-03-01 | 2023-04-12 | 2023-06-01 | 1.7 |
| 6 | Manus / 通用 Agent 爆发 | 2023-12-01 | 2024-04-01 | 2024-03-01 | 1.0 |

**平均预测误差: 2.6 个月** (5 个有效 fold)
**残差标准差: ±3.3 个月**
**预测偏差: +0.1 个月** (偏早)

### OpenClaw 预测置信区间

| 区间 | 日期范围 |
|------|---------|
| 点估计 | **2025-01-21** |
| 68% 区间 (±1σ) | 2024-10-15 ~ 2025-04-29 |
| 95% 区间 (±2σ) | 2024-07-09 ~ 2025-08-05 |
| 实际爆发 | 2025-06-01 |

实际爆发日期在 68% 置信区间外