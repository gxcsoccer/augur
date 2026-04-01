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

**综合评分: 0.815**

### Top 5 参数组合

| 排名 | threshold | window | baseline | compression | 评分 |
|------|-----------|--------|----------|-------------|------|
| 1 | 3 | 4 | 3 | 0.6 | 0.815 |
| 2 | 3 | 4 | 3 | 0.7 | 0.815 |
| 3 | 3 | 4 | 3 | 0.75 | 0.815 |
| 4 | 3 | 4 | 3 | 0.8 | 0.815 |
| 5 | 3 | 4 | 3 | 0.85 | 0.815 |

### 训练集信号检测详情

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
| 基础设施 | run-llama/llama_index | 2024-02-11 | 0.6 |
| 工具 | langchain-ai/langchain | 2023-09-10 | 5.8 |
| 工具 | Significant-Gravitas/AutoGPT | 2024-01-07 | 1.8 |
| 工具 | joaomdmoura/crewAI | - | - |
| 应用 | geekan/MetaGPT | 2023-08-06 | 6.9 |
| 应用 | OpenDevin/OpenDevin | - | - |

---

## 验证阶段

**测试集: 专业 Agent / OpenClaw 爆发**
**实际爆发日期: 2025-06-01**

### 检测到的信号

| 层级 | 仓库 | 信号日期 | 领先月数 |
|------|------|---------|---------|
| 基础设施 | modelcontextprotocol/specification | - | - |
| 基础设施 | modelcontextprotocol/servers | - | - |
| 基础设施 | anthropics/anthropic-sdk-python | - | - |
| 工具 | anthropics/claude-code | - | - |
| 工具 | browser-use/browser-use | 2025-01-19 | 1.4 |
| 工具 | langchain-ai/langgraph | 2024-04-21 | 10.5 |
| 应用 | OpenManus/OpenManus | - | - |
| 应用 | all-hands-ai/OpenHands | - | - |

### 预测结果

| 指标 | 值 |
|------|-----|
| 预测爆发日期 | **2025-02-19** |
| 实际爆发日期 | 2025-06-01 |
| 预测误差 | 3.4 个月 |
| 站在预测时的剩余时间 | -0.3 个月 |

### 结论

模型预测误差 3.4 个月，**方向正确但精度有待提升**。