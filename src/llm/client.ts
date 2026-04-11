import OpenAI from 'openai';

let _client: OpenAI | null = null;

export function getLlm(): OpenAI {
  if (!_client) {
    const apiKey = process.env.GLM_API_KEY;
    if (!apiKey) {
      throw new Error('GLM_API_KEY environment variable is required');
    }
    _client = new OpenAI({
      apiKey,
      baseURL: 'https://api.z.ai/api/coding/paas/v4',
    });
  }
  return _client;
}

export const LLM_MODEL = 'glm-5.1';

/** GLM 5.1 ultrathink（深度思考），用于复杂推理（波浪发现、深度研究） */
export const LLM_THINKING_ON = { type: 'enabled' as const };

/** GLM 5.1 关闭思考，用于简单分类任务以节省 token */
export const LLM_THINKING_OFF = { type: 'disabled' as const };
