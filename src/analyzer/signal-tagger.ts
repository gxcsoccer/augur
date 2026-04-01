/**
 * LLM 信号层级分类
 *
 * 将项目分类为 infrastructure / tooling / application，
 * 并识别所属技术域。支持批量处理以降低 LLM 调用次数。
 */

import { getLlm, LLM_MODEL } from '../llm/client.js';

export interface SignalClassification {
  projectId: string;
  layer: 'infrastructure' | 'tooling' | 'application';
  domains: string[];
  reasoning: string;
}

const SYSTEM_PROMPT = `你是一个技术趋势分析专家。给定一组开源项目的信息，将每个项目分类为三层信号之一，并识别技术域。

## 信号层级定义

- **infrastructure**（基础设施层）：协议、运行时、数据格式、底层 API、模型训练/推理引擎、编译器/解析器
  - 例：pytorch, llama.cpp, tree-sitter, protobuf, MCP protocol
- **tooling**（工具抽象层）：SDK、框架、开发工具、集成库、CLI 工具
  - 例：langchain, openai-python, chroma, vite, webpack
- **application**（产品应用层）：面向终端用户的产品、SaaS、桌面应用、移动应用
  - 例：cursor, chatgpt, notion, figma

## 技术域（可多选）

agent, memory, desktop, voice, eval, local-ai, code-gen, search, data, security, devops, economy, other

## 输出格式

返回 JSON 数组，每个元素：
{
  "id": "owner/repo",
  "layer": "infrastructure" | "tooling" | "application",
  "domains": ["domain1", "domain2"],
  "reasoning": "一句话理由"
}

只返回 JSON，不要其他内容。`;

export async function classifyProjects(
  projects: { id: string; description: string | null; language: string | null; topics: string | null; readme?: string }[],
): Promise<SignalClassification[]> {
  if (projects.length === 0) return [];

  const llm = getLlm();
  const results: SignalClassification[] = [];

  // Batch: up to 10 projects per LLM call
  const batchSize = 10;
  for (let i = 0; i < projects.length; i += batchSize) {
    const batch = projects.slice(i, i + batchSize);
    const userContent = batch.map(p => {
      const topics = p.topics ? JSON.parse(p.topics) : [];
      const readmeSnippet = p.readme ? p.readme.slice(0, 500) : '';
      return `- ${p.id} (${p.language ?? 'unknown'})\n  Topics: ${topics.join(', ') || 'none'}\n  Description: ${p.description ?? 'none'}\n  README: ${readmeSnippet || 'none'}`;
    }).join('\n\n');

    try {
      const response = await llm.chat.completions.create({
        model: LLM_MODEL,
        temperature: 0,
        max_tokens: 4096,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `请分类以下 ${batch.length} 个项目：\n\n${userContent}` },
        ],
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) continue;

      // Parse JSON from response (handle markdown code blocks)
      const jsonStr = content.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
      const parsed = JSON.parse(jsonStr) as Array<{
        id: string;
        layer: string;
        domains: string[];
        reasoning: string;
      }>;

      for (const item of parsed) {
        const layer = (['infrastructure', 'tooling', 'application'] as const).includes(item.layer as any)
          ? item.layer as 'infrastructure' | 'tooling' | 'application'
          : 'application';

        results.push({
          projectId: item.id,
          layer,
          domains: item.domains ?? [],
          reasoning: item.reasoning ?? '',
        });
      }
    } catch (err) {
      console.warn(`  LLM classification failed for batch ${i / batchSize + 1}: ${(err as Error).message}`);
      // Fallback: mark as application
      for (const p of batch) {
        results.push({
          projectId: p.id,
          layer: 'application',
          domains: ['other'],
          reasoning: 'LLM classification failed, defaulting to application',
        });
      }
    }
  }

  return results;
}
