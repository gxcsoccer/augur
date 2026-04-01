/**
 * 浪潮扫描器
 *
 * 用校准后的模型扫描候选浪潮，预测下一个风口。
 * 每个候选浪潮定义为 BacktestTarget 格式，
 * 模型在当前时间点做预测并输出置信区间。
 */

import type { BacktestTarget } from './backtest.js';
import { validate, type ModelParams, type ValidationResult } from './calibrator.js';

export interface WavePrediction {
  wave: BacktestTarget;
  validation: ValidationResult;
  signalStrength: 'strong' | 'moderate' | 'weak' | 'none';
  summary: string;
}

// ─── 候选浪潮定义 ───────────────────────────────────────────────

export const CANDIDATE_WAVES: BacktestTarget[] = [
  {
    name: 'Voice AI / 实时多模态',
    eruptionDate: '2027-01-01',
    description: '语音 Agent、实时语音对话、多模态流式处理',
    infrastructureRepos: [
      'pipecat-ai/pipecat',               // 语音多模态 AI 管道框架 11k★
      'livekit/agents',                    // WebRTC 实时 AI Agent 框架 10k★
      'TEN-framework/ten-framework',       // 模块化实时对话 AI 框架
    ],
    toolingRepos: [
      'resemble-ai/chatterbox',           // SoTA 开源 TTS 11k★
      'kyutai-labs/moshi',                // 全双工语音对话模型
      'fishaudio/fish-speech',            // SoTA 文本转语音
    ],
    applicationRepos: [
      'huggingface/speech-to-speech',     // 本地语音 Agent
      'bolna-ai/bolna',                   // 语音 AI 电话 Agent
    ],
  },
  {
    name: 'On-device / Edge AI',
    eruptionDate: '2027-01-01',
    description: '本地推理、端侧 AI、WebGPU/WASM 推理',
    infrastructureRepos: [
      'ggml-org/llama.cpp',               // 本地推理引擎 100k★
      'ml-explore/mlx',                    // Apple Silicon ML 25k★
      'pytorch/executorch',                // 端侧 PyTorch 推理（GA 2025-10）
    ],
    toolingRepos: [
      'mlc-ai/web-llm',                   // 浏览器 WebGPU 推理 18k★
      'mlc-ai/mlc-llm',                   // 跨平台 LLM 部署
      'google-ai-edge/mediapipe',         // 跨平台端侧 ML
    ],
    applicationRepos: [
      'ollama/ollama',                     // 本地 LLM 管理 167k★
      'open-webui/open-webui',             // 本地 AI WebUI 129k★
    ],
  },
  {
    name: 'AI-native DevOps',
    eruptionDate: '2027-01-01',
    description: 'AI 驱动的 CI/CD、自动测试、代码审查',
    infrastructureRepos: [
      'anthropics/claude-code',            // AI 编码工具
      'qodo-ai/pr-agent',                 // 开源 AI PR 审查 10k★
      'dagger/dagger',                     // AI-native CI/CD 引擎
    ],
    toolingRepos: [
      'n8n-io/n8n',                        // AI 工作流自动化 100k★
      'microsoft/playwright',              // AI 增强的 E2E 测试
      'coderabbitai/ai-pr-reviewer',      // AI PR 审查（GitHub 安装量最大）
    ],
    applicationRepos: [
      'all-hands-ai/OpenHands',           // 自主编码 Agent
      'infiniflow/ragflow',               // 企业 AI 数据管道 70k★
    ],
  },
  {
    name: 'Autonomous Commerce / AI Economy',
    eruptionDate: '2027-01-01',
    description: 'AI Agent 自主交易、加密+AI、DAO 自治经济',
    infrastructureRepos: [
      'elizaOS/eliza',                    // 自主 AI Agent TypeScript 框架 17.6k★
      'goat-sdk/goat',                    // 链上 Agent 工具包 200+ 集成
      'sendaifun/solana-agent-kit',       // Solana AI Agent 60+ 预置操作
    ],
    toolingRepos: [
      '0xPlaygrounds/rig',               // Rust Agent + 链上开发框架
      'HKUDS/AI-Trader',                 // AI 交易研究平台
      'langchain-ai/langgraph',          // Agent 编排（交易 Agent 依赖）
    ],
    applicationRepos: [
      'alsk1992/CloddsBot',              // 开源 AI 交易 Agent
      'wen82fastik/ai-crypto-cryptocurrency-trading-bot', // LLM 交易 Bot
    ],
  },
  {
    name: 'Embodied AI / 机器人',
    eruptionDate: '2027-01-01',
    description: '具身智能、人形机器人、Sim-to-Real',
    infrastructureRepos: [
      'huggingface/lerobot',              // 端到端机器人库 20k★
      'Genesis-Embodied-AI/Genesis',      // 通用物理引擎
      'isaac-sim/IsaacLab',              // NVIDIA 机器人学习框架
    ],
    toolingRepos: [
      'Physical-Intelligence/openpi',     // pi0 视觉-语言-动作模型
      'LeCAR-Lab/HumanoidVerse',         // 人形机器人多模拟器
      'NVIDIA/Isaac-GR00T',              // GR00T 通用机器人基座模型
    ],
    applicationRepos: [
      'octo-models/octo',                // 通用机器人策略
      'OpenDriveLab/AgiBot-World',       // 大规模操作平台
    ],
  },
  {
    name: 'AI for Science',
    eruptionDate: '2027-01-01',
    description: 'AI 药物发现、蛋白质设计、材料科学',
    infrastructureRepos: [
      'google-deepmind/alphafold3',       // AlphaFold3 推理（诺奖 2024）
      'jwohlwend/boltz',                  // 生物分子交互模型 3.9k★
      'deepchem/deepchem',                // 药物发现深度学习框架
    ],
    toolingRepos: [
      'dptech-corp/Uni-Mol',             // 3D 分子表征学习
      'microsoft/mattergen',              // 无机材料生成模型
      'rdkit/rdkit',                      // 化学信息学核心工具
    ],
    applicationRepos: [
      'aqlaboratory/openfold',            // AlphaFold 开源复现
      'HannesStark/boltzgen',             // 生物分子结构生成
    ],
  },
  {
    name: 'Agentic Infrastructure / MCP 生态',
    eruptionDate: '2027-01-01',
    description: 'Agent 基础设施层成熟，MCP 生态扩展，Agent-to-Agent 协议',
    infrastructureRepos: [
      'modelcontextprotocol/modelcontextprotocol',
      'modelcontextprotocol/python-sdk',
      'modelcontextprotocol/typescript-sdk',
    ],
    toolingRepos: [
      'modelcontextprotocol/servers',
      'langchain-ai/langgraph',
      'microsoft/autogen',
    ],
    applicationRepos: [
      'browser-use/browser-use',
      'anthropics/claude-code',
    ],
  },
];

// ─── 扫描所有候选浪潮 ───────────────────────────────────────────

export async function scanWaves(
  params: ModelParams,
  cutoff: string,
): Promise<WavePrediction[]> {
  const predictions: WavePrediction[] = [];

  for (const wave of CANDIDATE_WAVES) {
    console.log(`\n━━━ 扫描: ${wave.name} ━━━`);
    const result = await validate(wave, params, cutoff);

    // Determine signal strength
    const detectedCount = result.detectedSignals.filter(s => s.signalDate !== null).length;
    const hasInfra = result.detectedSignals.some(s => s.layer === 'infrastructure' && s.signalDate);
    const hasTooling = result.detectedSignals.some(s => s.layer === 'tooling' && s.signalDate);
    const hasAcceleratingDownloads = result.downloadSignals.some(d => d.trend === 'accelerating');

    let signalStrength: WavePrediction['signalStrength'] = 'none';
    if (hasInfra && hasTooling && hasAcceleratingDownloads) signalStrength = 'strong';
    else if (hasInfra && hasTooling) signalStrength = 'moderate';
    else if (detectedCount >= 2) signalStrength = 'moderate';
    else if (detectedCount >= 1) signalStrength = 'weak';

    let summary = '';
    if (result.predictedEruptionDate) {
      summary = `预测爆发: ${result.predictedEruptionDate}`;
      if (result.predictedLeadMonths !== null) {
        summary += ` (距今 ${result.predictedLeadMonths.toFixed(1)} 个月)`;
      }
    } else {
      summary = '信号不足，暂无法预测';
    }

    predictions.push({ wave, validation: result, signalStrength, summary });
  }

  // Sort by signal strength
  const order = { strong: 0, moderate: 1, weak: 2, none: 3 };
  predictions.sort((a, b) => order[a.signalStrength] - order[b.signalStrength]);

  return predictions;
}

// ─── 格式化预测报告 ─────────────────────────────────────────────

export function formatWavePredictionReport(
  predictions: WavePrediction[],
  cutoff: string,
  looError: number,
  looStd: number,
): string {
  const lines: string[] = [];
  lines.push('# Augur 下一波浪潮预测');
  lines.push('');
  lines.push(`> 预测日期: ${cutoff}`);
  lines.push(`> 模型精度: LOO 平均误差 ${looError.toFixed(1)} 个月 (±${looStd.toFixed(1)})`);
  lines.push(`> 扫描域: ${predictions.length} 个候选浪潮`);
  lines.push('');

  // Summary table
  lines.push('## 总览');
  lines.push('');
  lines.push('| 排名 | 候选浪潮 | 信号强度 | 预测爆发 | 关键信号 |');
  lines.push('|------|---------|---------|---------|---------|');

  for (const [i, p] of predictions.entries()) {
    const strength = { strong: '🔴 强', moderate: '🟡 中', weak: '⚪ 弱', none: '- 无' }[p.signalStrength];
    const detected = p.validation.detectedSignals.filter(s => s.signalDate).map(s => s.repo.split('/')[1]).join(', ');
    const eruption = p.validation.predictedEruptionDate ?? '-';
    lines.push(`| ${i + 1} | ${p.wave.name} | ${strength} | ${eruption} | ${detected || '-'} |`);
  }
  lines.push('');

  // Detailed analysis for strong/moderate signals
  const actionable = predictions.filter(p => p.signalStrength === 'strong' || p.signalStrength === 'moderate');

  if (actionable.length > 0) {
    lines.push('## 重点关注');
    lines.push('');

    for (const p of actionable) {
      lines.push(`### ${p.wave.name}`);
      lines.push(`> ${p.wave.description}`);
      lines.push('');

      // Signals
      lines.push('**检测到的信号：**');
      for (const s of p.validation.detectedSignals) {
        if (s.signalDate) {
          const layerLabel = { infrastructure: '基础设施', tooling: '工具', application: '应用' }[s.layer];
          lines.push(`- [${layerLabel}] ${s.repo} — 信号 ${s.signalDate} (${s.leadMonths?.toFixed(1)}月前)`);
        }
      }
      lines.push('');

      // Downloads
      if (p.validation.downloadSignals.length > 0) {
        lines.push('**下载量趋势：**');
        for (const d of p.validation.downloadSignals) {
          const trend = { accelerating: '🔺 加速', growing: '📈 增长', stable: '➡️ 稳定', unknown: '?' }[d.trend];
          lines.push(`- ${d.packageName} (${d.registry}): ${d.weeklyDownloads.toLocaleString()}/周 ${trend}`);
        }
        lines.push('');
      }

      // Prediction
      if (p.validation.predictedEruptionDate) {
        lines.push('**预测：**');
        lines.push(`- 点估计: **${p.validation.predictedEruptionDate}**`);

        // Confidence interval
        const predicted = new Date(p.validation.predictedEruptionDate);
        const lower = new Date(predicted);
        lower.setDate(lower.getDate() - Math.round(looStd * 30));
        const upper = new Date(predicted);
        upper.setDate(upper.getDate() + Math.round(looStd * 30));
        lines.push(`- 68% 区间: ${lower.toISOString().slice(0, 10)} ~ ${upper.toISOString().slice(0, 10)}`);
      }
      lines.push('');

      // Action recommendation
      lines.push('**建议动作：**');
      if (p.signalStrength === 'strong') {
        lines.push('- 立即深入调研，该领域可能在 6 个月内爆发');
        lines.push('- 关注基础设施层项目的 Issues，寻找工具层机会');
      } else {
        lines.push('- 持续监测，每周检查信号变化');
        lines.push('- 当信号升级为"强"时再深入');
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    }
  }

  // Weak/none signals brief mention
  const dormant = predictions.filter(p => p.signalStrength === 'weak' || p.signalStrength === 'none');
  if (dormant.length > 0) {
    lines.push('## 早期观察');
    lines.push('');
    for (const p of dormant) {
      const detected = p.validation.detectedSignals.filter(s => s.signalDate).length;
      lines.push(`- **${p.wave.name}**: ${detected} 个信号, ${p.summary}`);
    }
  }

  return lines.join('\n');
}
