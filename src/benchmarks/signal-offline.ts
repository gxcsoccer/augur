import { createRequire } from 'node:module';
import type FixtureData from './fixtures/offline-responses.json';
const fixture: typeof FixtureData = createRequire(import.meta.url)('./fixtures/offline-responses.json');
import { createJevClassifier, JEV_MODEL } from '../analyzer/jev-classifier.js';
import { DOMAINS, LAYERS, observe } from '../analyzer/signal-types.js';
import type { LlmClassifier } from '../analyzer/signal-tagger-experiment.js';
import type { Layer } from '../analyzer/signal-types.js';
const table: Record<string, { llm: { layer: string; domains: string[] } | null; jev: { layer: string; domains: string[]; confidence: number; error?: string } }> = fixture.responses;
export const offlineJev = createJevClassifier({ apiKey: 'offline-test-only', fetch: async (_url, init) => {
  const request = JSON.parse(String(init?.body));
  const scripted = table[request.state.id]?.jev;
  if (!scripted) throw new Error('Unscripted input');
  if (scripted.error === 'http_429') return new Response('{}', { status: 429 });
  if (scripted.error) return Response.json({ model: JEV_MODEL, answers: {} });
  const answers: Record<string, unknown> = {
    layer: { type: 'choice', choice: scripted.layer, confidence: scripted.confidence,
      probabilities: Object.fromEntries(LAYERS.map(l => [l, l === scripted.layer ? 0.98 : 0.01])) },
  };
  for (const domain of DOMAINS.filter(d => d !== 'other')) {
    const yes = scripted.domains.includes(domain);
    answers[`domain_${domain.replace('-', '_')}`] = { type: 'choice', choice: yes ? 'yes' : 'no', confidence: scripted.confidence, probabilities: { yes: yes ? 0.99 : 0.01, no: yes ? 0.01 : 0.99 } };
  }
  return Response.json({ model: JEV_MODEL, answers, usage: { input_tokens: 700, output_tokens: 180 } });
} });
export const offlineLlm: LlmClassifier = async (projects, observer) => {
  const results = [];
  for (let i = 0; i < projects.length; i += 10) {
    const batch = projects.slice(i, i + 10);
    const start = performance.now();
    for (const p of batch) {
      const scripted = table[p.id]?.llm;
      if (scripted) results.push({ projectId: p.id, layer: scripted.layer as Layer, domains: scripted.domains, reasoning: 'Scripted offline response; not model output' });
    }
    observe(observer, { provider: 'llm', projectIds: batch.map(p => p.id), model: 'mock-llm', ok: true,
      elapsedMs: performance.now() - start, inputTokens: 200 + batch.length * 160, outputTokens: batch.length * 40 });
  }
  return results;
};
