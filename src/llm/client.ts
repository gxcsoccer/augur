import OpenAI from 'openai';

let _client: OpenAI | null = null;

export function getLlm(): OpenAI {
  if (!_client) {
    const apiKey = process.env.DASHSCOPE_API_KEY;
    if (!apiKey) {
      throw new Error('DASHSCOPE_API_KEY environment variable is required');
    }
    _client = new OpenAI({
      apiKey,
      baseURL: 'https://coding.dashscope.aliyuncs.com/v1',
    });
  }
  return _client;
}

export const LLM_MODEL = 'qwen3.5-plus';
