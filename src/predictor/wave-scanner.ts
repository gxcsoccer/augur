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
    eruptionDate: '2027-01-01', // placeholder — model will predict actual date
    description: '语音 Agent、实时语音对话、多模态流式处理',
    infrastructureRepos: [
      'openai/whisper',                     // 语音识别基础设施
      'microsoft/VibeVoice',                // 微软语音 AI
      'fishaudio/fish-speech',              // 开源 TTS
    ],
    toolingRepos: [
      'livekit/agents',                     // 实时语音 Agent 框架
      'fixie-ai/ultravox',                  // 语音 LLM
      'myshell-ai/OpenVoice',              // 语音克隆工具
    ],
    applicationRepos: [
      'bolna-ai/bolna',                     // 语音 AI Agent 应用
      'KoljaB/RealtimeSTT',               // 实时语音转文字
    ],
  },
  {
    name: 'On-device / Edge AI',
    eruptionDate: '2027-01-01',
    description: '本地推理、端侧 AI、WebGPU/WASM 推理',
    infrastructureRepos: [
      'ggerganov/llama.cpp',               // 本地推理引擎
      'ml-explore/mlx',                    // Apple Silicon ML 框架
      'huggingface/candle',                // Rust ML 框架
    ],
    toolingRepos: [
      'ollama/ollama',                     // 本地模型管理
      'Mozilla-Ocho/llamafile',            // 单文件 LLM 部署
      'nicholasgasior/gollm',             // Go LLM 推理
    ],
    applicationRepos: [
      'open-webui/open-webui',             // 本地 AI WebUI
      'khoj-ai/khoj',                      // 本地 AI 助手
    ],
  },
  {
    name: 'AI-native DevOps',
    eruptionDate: '2027-01-01',
    description: 'AI 驱动的 CI/CD、自动测试、代码审查',
    infrastructureRepos: [
      'anthropics/claude-code',            // AI 编码工具
      'sourcegraph/cody',                  // AI 代码助手
      'TabbyML/tabby',                     // 自托管代码补全
    ],
    toolingRepos: [
      'paul-gauthier/aider',              // AI pair programming
      'all-hands-ai/OpenHands',           // 自主编码 Agent
      'stitionai/devika',                  // AI 软件工程师
    ],
    applicationRepos: [
      'plandex-ai/plandex',               // AI 项目规划
      'sweepai/sweep',                     // AI Pull Request
    ],
  },
  {
    name: 'Embodied AI / 机器人',
    eruptionDate: '2027-01-01',
    description: '具身智能、人形机器人、Sim-to-Real',
    infrastructureRepos: [
      'google-deepmind/mujoco',            // 物理模拟引擎
      'NVIDIA-Omniverse/IsaacGymEnvs',    // NVIDIA 机器人训练
      'huggingface/lerobot',               // HF 机器人学习
    ],
    toolingRepos: [
      'dora-rs/dora',                      // 机器人数据流框架
      'InternLM/InternLM-XComposer',      // 多模态理解
      'OpenRobotLab/GRUtopia',            // 具身 AI 训练平台
    ],
    applicationRepos: [
      'Genesis-Embodied-AI/Genesis',       // 通用机器人 Agent
      'unitreerobotics/unitree_rl_gym',   // Unitree 机器人 RL
    ],
  },
  {
    name: 'AI for Science',
    eruptionDate: '2027-01-01',
    description: 'AI 药物发现、蛋白质设计、材料科学',
    infrastructureRepos: [
      'google-deepmind/alphafold',         // 蛋白质折叠
      'dptech-corp/Uni-Mol',              // 分子表征学习
      'microsoft/graphormer',              // 分子图变换器
    ],
    toolingRepos: [
      'deepchem/deepchem',                 // 药物发现工具
      'mims-harvard/TDC',                  // 治疗数据库
      'Lightning-AI/litgpt',              // 高效训练框架
    ],
    applicationRepos: [
      'lucidrains/alphafold3-pytorch',     // AlphaFold3 复现
      'chao1224/BioT5',                    // 生物文本-分子桥接
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
