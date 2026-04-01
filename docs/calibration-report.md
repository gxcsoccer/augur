# Augur 模型校准与验证报告

> 生成日期: 2026-04-01

## 训练阶段

搜索空间: 240 个参数组合

### 最优参数

| 参数 | 值 | 说明 |
|------|-----|------|
| accelerationThreshold | 2 | 变点检测倍数 |
| windowSize | 3 | 滑动窗口（周） |
| minBaseline | 3 | 最低基线 |
| compressionFactor | 0.6 | 压缩因子 |

**综合评分: 0.770**

### Top 5 参数组合

| 排名 | threshold | window | baseline | compression | 评分 |
|------|-----------|--------|----------|-------------|------|
| 1 | 2 | 3 | 3 | 0.6 | 0.770 |
| 2 | 2 | 3 | 3 | 0.7 | 0.770 |
| 3 | 2 | 3 | 3 | 0.75 | 0.770 |
| 4 | 2 | 3 | 3 | 0.8 | 0.770 |
| 5 | 2 | 3 | 3 | 0.85 | 0.770 |

### 训练集信号检测详情

#### Stable Diffusion 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | CompVis/latent-diffusion | 2022-02-20 | 6.1 |
| 基础设施 | openai/CLIP | 2021-02-28 | 18.0 |
| 基础设施 | huggingface/diffusers | 2022-07-17 | 1.2 |
| 工具 | huggingface/transformers | 2021-02-28 | 18.0 |
| 工具 | CompVis/stable-diffusion | - | - |
| 工具 | invoke-ai/InvokeAI | - | - |
| 应用 | AUTOMATIC1111/stable-diffusion-webui | - | - |
| 应用 | cmdr2/stable-diffusion-ui | - | - |

#### ChatGPT 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | huggingface/transformers | 2021-02-28 | 21.3 |
| 基础设施 | pytorch/pytorch | 2021-10-31 | 13.2 |
| 基础设施 | ggerganov/llama.cpp | - | - |
| 工具 | openai/openai-python | 2021-04-11 | 19.9 |
| 工具 | huggingface/huggingface_hub | 2021-04-04 | 20.2 |
| 工具 | AUTOMATIC1111/stable-diffusion-webui | 2022-09-11 | 2.7 |
| 应用 | xtekky/gpt4free | - | - |
| 应用 | lencx/ChatGPT | - | - |

#### Local LLM 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | ggerganov/llama.cpp | - | - |
| 基础设施 | ggerganov/ggml | 2022-10-09 | 5.2 |
| 基础设施 | facebookresearch/llama | - | - |
| 工具 | nomic-ai/gpt4all | - | - |
| 工具 | lm-sys/FastChat | - | - |
| 工具 | oobabooga/text-generation-webui | 2023-01-08 | 2.2 |
| 应用 | imartinez/privateGPT | - | - |
| 应用 | mlc-ai/mlc-llm | - | - |

#### RAG / Vector DB 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | chroma-core/chroma | 2023-02-12 | 1.6 |
| 基础设施 | qdrant/qdrant | 2021-05-09 | 23.1 |
| 基础设施 | weaviate/weaviate | 2023-02-05 | 1.8 |
| 工具 | jerryjliu/llama_index | - | - |
| 工具 | langchain-ai/langchain | - | - |
| 工具 | hwchase17/langchain | 2022-11-06 | 4.9 |
| 应用 | imartinez/privateGPT | - | - |
| 应用 | StanGirard/quivr | - | - |

#### Cursor / AI IDE 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | tree-sitter/tree-sitter | 2021-06-27 | 23.5 |
| 基础设施 | nomic-ai/gpt4all | 2023-05-07 | 0.8 |
| 基础设施 | ggerganov/llama.cpp | 2023-04-30 | 1.1 |
| 工具 | jerryjliu/llama_index | 2023-04-30 | 1.1 |
| 工具 | chroma-core/chroma | 2023-02-12 | 3.6 |
| 工具 | AntonOsika/gpt-engineer | - | - |
| 应用 | getcursor/cursor | - | - |
| 应用 | paul-gauthier/aider | - | - |

#### Manus / 通用 Agent 爆发

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | microsoft/autogen | 2023-09-17 | 5.5 |
| 基础设施 | openai/openai-python | 2022-04-03 | 23.3 |
| 基础设施 | run-llama/llama_index | 2023-11-05 | 3.9 |
| 工具 | langchain-ai/langchain | 2023-08-06 | 6.9 |
| 工具 | Significant-Gravitas/AutoGPT | 2024-01-07 | 1.8 |
| 工具 | joaomdmoura/crewAI | 2024-01-07 | 1.8 |
| 应用 | geekan/MetaGPT | 2023-07-16 | 7.6 |
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
| 基础设施 | modelcontextprotocol/python-sdk | 2024-12-29 | 2.1 |
| 基础设施 | anthropics/anthropic-sdk-python | - | - |
| 工具 | anthropics/claude-code | - | - |
| 工具 | browser-use/browser-use | 2025-01-12 | 1.6 |
| 工具 | langchain-ai/langgraph | - | - |
| 应用 | openclaw/openclaw | - | - |
| 应用 | OpenManus/OpenManus | - | - |
| 应用 | all-hands-ai/OpenHands | - | - |

### 下载量信号（npm/PyPI）

| 仓库 | 包名 | 注册表 | 周下载量 | 趋势 |
|------|------|--------|---------|------|
| modelcontextprotocol/python-sdk | mcp | pypi | 27,114,398 | 📈 增长 |
| anthropics/anthropic-sdk-python | anthropic | pypi | 14,634,363 | 📈 增长 |
| browser-use/browser-use | browser-use | pypi | 982,728 | 🔺 加速 |


### 预测结果

| 指标 | 值 |
|------|-----|
| 预测爆发日期 | **2025-01-14** |
| 实际爆发日期 | 2025-06-01 |
| 预测误差 | 4.6 个月 |
| 站在预测时的剩余时间 | -1.5 个月 |

### 结论

模型预测误差 4.6 个月，**方向正确但精度有待提升**。

---

## Leave-one-out 交叉验证

| Fold | 留出案例 | Cutoff | 预测爆发 | 实际爆发 | 误差(月) |
|------|---------|--------|---------|---------|---------|
| 1 | Stable Diffusion 爆发 | 2022-05-22 | 2022-07-20 | 2022-08-22 | 1.1 |
| 2 | ChatGPT 爆发 | 2022-08-30 | 2022-05-01 | 2022-11-30 | 7.1 |
| 3 | Local LLM 爆发 | 2022-12-15 | 2023-02-09 | 2023-03-15 | 1.1 |
| 4 | RAG / Vector DB 爆发 | 2023-01-01 | - | 2023-04-01 | - |
| 5 | Cursor / AI IDE 爆发 | 2023-03-01 | 2023-03-12 | 2023-06-01 | 2.7 |
| 6 | Manus / 通用 Agent 爆发 | 2023-12-01 | 2023-12-05 | 2024-03-01 | 2.9 |

**平均预测误差: 3.0 个月** (5 个有效 fold)
**残差标准差: ±2.4 个月**
**预测偏差: +3.0 个月** (偏早)

### OpenClaw 预测置信区间

| 区间 | 日期范围 |
|------|---------|
| 点估计 | **2025-01-14** |
| 68% 区间 (±1σ) | 2024-11-02 ~ 2025-03-28 |
| 95% 区间 (±2σ) | 2024-08-20 ~ 2025-06-10 |
| 实际爆发 | 2025-06-01 |

实际爆发日期在 68% 置信区间外