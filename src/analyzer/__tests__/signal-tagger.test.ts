import { beforeEach, describe, expect, it, vi } from 'vitest';
const create = vi.hoisted(() => vi.fn());
vi.mock('../../llm/client.js', () => ({ getLlm: () => ({ chat: { completions: { create } } }), LLM_MODEL: 'glm-test', LLM_THINKING_OFF: { type: 'disabled' } }));
import { classifyProjects, classifyProjectsWithLlm } from '../signal-tagger.js';
import { classifyWithJev, type LlmClassifier } from '../signal-tagger-experiment.js';
import { buildJevRequest, createJevClassifier, JEV_ENDPOINT, JEV_MODEL, parseJevResponse } from '../jev-classifier.js';
import { DOMAINS, type CallMetric, type ProjectInput } from '../signal-types.js';
import { summarize } from '../../benchmarks/signal-metrics.js';
import { createRequire } from 'node:module';
import type FixtureData from '../../benchmarks/fixtures/signal-samples.json';
const dataset: typeof FixtureData = createRequire(import.meta.url)('../../benchmarks/fixtures/signal-samples.json');
import { offlineJev, offlineLlm } from '../../benchmarks/signal-offline.js';

const project: ProjectInput = { id: 'fixture/example', description: 'An agent SDK', topics: '["agent"]', language: 'TypeScript', readme: 'x'.repeat(900) };
function response() {
  const answers: Record<string, { type: string; choice: string; confidence: number; probabilities: Record<string, number> }> = {
    layer: { type: 'choice', choice: 'tooling', confidence: 0.95, probabilities: { infrastructure: 0.02, tooling: 0.97, application: 0.01 } },
  };
  for (const d of DOMAINS.filter(d => d !== 'other')) {
    const yes = ['agent', 'memory'].includes(d);
    answers[`domain_${d.replace('-', '_')}`] = { type: 'choice', choice: yes ? 'yes' : 'no', confidence: 0.96,
      probabilities: { yes: yes ? 0.99 : 0.01, no: yes ? 0.01 : 0.99 } };
  }
  return { model: JEV_MODEL, answers, usage: { input_tokens: 1000, output_tokens: 200 } };
}
const fallback: LlmClassifier = async projects => projects.map(p => ({ projectId: p.id, layer: 'tooling', domains: ['agent'], reasoning: 'SDK for agents' }));
function jev(raw = response()) { return createJevClassifier({ apiKey: 'test-key', fetch: vi.fn(async () => Response.json(raw)) }); }
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('TYPESAFE_API_KEY', ''); });

describe('official Jev REST contract', () => {
  it('uses the official endpoint, pinned model, shared state and binary domain choices', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json(response()));
    const calls: CallMetric[] = [];
    const result = await createJevClassifier({ apiKey: 'test-key', fetch: fetcher })(project, c => calls.push(c));
    expect(fetcher.mock.calls[0][0]).toBe(JEV_ENDPOINT);
    const init = (fetcher.mock.calls as unknown as [string, RequestInit][])[0][1];
    expect(init.headers).toMatchObject({ Authorization: 'Bearer test-key' });
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(JEV_MODEL);
    expect(body.state.topics).toEqual(['agent']);
    expect(body.state.readme).toHaveLength(500);
    expect(Object.keys(body.questions)).toHaveLength(13);
    expect(body.questions.domain_local_ai.criteria).toHaveProperty('yes');
    expect(result.domains).toEqual(['agent', 'memory']);
    expect(result.confidence).toBe(0.95);
    expect(calls[0]).toMatchObject({ ok: true, inputTokens: 1000, outputTokens: 200 });
  });
  it('uses negative domain confidence in the gate', () => {
    const raw = response(); raw.answers.domain_voice.confidence = 0.2;
    expect(parseJevResponse(raw).confidence).toBe(0.2);
  });
  it('derives other only if every named domain is absent', () => {
    const raw = response();
    for (const [key, value] of Object.entries(raw.answers)) if (key !== 'layer') {
      value.choice = 'no'; value.probabilities = { yes: 0.01, no: 0.99 };
    }
    expect(parseJevResponse(raw).domains).toEqual(['other']);
  });
  it.each(['missing', 'bad-label', 'nan', 'range', 'distribution', 'type', 'wrong-winner'])('rejects %s rather than inventing a prediction', kind => {
    const raw = response();
    if (kind === 'missing') delete raw.answers.domain_agent;
    if (kind === 'bad-label') raw.answers.layer.choice = 'banana';
    if (kind === 'nan') raw.answers.layer.confidence = NaN;
    if (kind === 'range') raw.answers.layer.confidence = 1.1;
    if (kind === 'distribution') raw.answers.layer.probabilities.tooling = 0.5;
    if (kind === 'type') raw.answers.domain_agent.type = 'noul';
    if (kind === 'wrong-winner') raw.answers.layer.choice = 'application';
    expect(() => parseJevResponse(raw)).toThrow('invalid_response');
  });
  it.each([401, 422, 429, 529])('records HTTP %s without retrying or leaking response bodies', async status => {
    const fetcher = vi.fn(async () => new Response('secret provider body', { status }));
    const calls: CallMetric[] = [];
    await expect(createJevClassifier({ apiKey: 'secret-key', fetch: fetcher })(project, c => calls.push(c))).rejects.toThrow(`http_${status}`);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls)).not.toContain('secret');
    expect(calls[0].ok).toBe(false);
  });
  it('bounds timeout and routes request failures', async () => {
    const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timeout')));
    });
    await expect(createJevClassifier({ apiKey: 'test-key', timeoutMs: 5, fetch: fetcher })(project)).rejects.toThrow('request_failed');
  });
  it('does not call the network without a key', async () => {
    const fetcher = vi.fn();
    await expect(createJevClassifier({ fetch: fetcher })(project)).rejects.toThrow('missing_key');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not change results if telemetry throws', async () => {
    await expect(jev()(project, () => { throw new Error('observer'); })).resolves.toMatchObject({ layer: 'tooling' });
  });
});

describe('opt-in routing and existing behavior', () => {
  it('default calls the original LLM in batches of ten with unchanged output', async () => {
    const projects = Array.from({ length: 11 }, (_, i) => ({ ...project, id: `fixture/${i}` }));
    const resultFor = (p: ProjectInput) => ({ id: p.id, layer: 'tooling', domains: ['agent'], reasoning: 'SDK' });
    create.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(projects.slice(0, 10).map(resultFor)) } }] })
      .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(projects.slice(10).map(resultFor)) } }] });
    const unusedJev = vi.fn();
    const results = await classifyProjects(projects, { jevClassifier: unusedJev });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[0][0]).toMatchObject({ temperature: 0, max_tokens: 4096, thinking: { type: 'disabled' } });
    expect(unusedJev).not.toHaveBeenCalled();
    expect(results).toHaveLength(11);
    expect(results[0]).toEqual({ projectId: 'fixture/0', layer: 'tooling', domains: ['agent'], reasoning: 'SDK' });
  });
  it('accepts high confidence without initializing or invoking the LLM', async () => {
    const llm = vi.fn(fallback);
    const result = await classifyWithJev([project], { requireReasoning: false, jevClassifier: jev() }, llm);
    expect(result[0]).toMatchObject({ reasoning: '', experiment: { source: 'jev' } });
    expect(llm).not.toHaveBeenCalled();
  });
  it('preserves default reasoning requirement and skips unnecessary Jev calls', async () => {
    const classifier = vi.fn(jev());
    const result = await classifyWithJev([project], { jevClassifier: classifier }, fallback);
    expect(classifier).not.toHaveBeenCalled();
    expect(result[0]).toMatchObject({ reasoning: 'SDK for agents', experiment: { source: 'llm', fallbackReason: 'reasoning_required' } });
  });
  it('batches mixed fallback reasons, retaining order despite concurrency', async () => {
    const projects = ['slow', 'low', 'error', 'reason'].map(id => ({ ...project, id }));
    const classifier = vi.fn(async (p: ProjectInput) => {
      if (p.id === 'error') throw new Error('HTTP');
      if (p.id === 'slow') await new Promise(r => setTimeout(r, 10));
      return { ...parseJevResponse(response()), confidence: p.id === 'low' ? 0.1 : 0.95 };
    });
    const llm = vi.fn(fallback);
    const result = await classifyWithJev(projects, { jevClassifier: classifier, requireReasoning: p => p.id === 'reason' }, llm);
    expect(result.map(r => r.projectId)).toEqual(['slow', 'low', 'error', 'reason']);
    expect(llm).toHaveBeenCalledTimes(1);
    expect(llm.mock.calls[0][0].map(p => p.id)).toEqual(['low', 'error', 'reason']);
    expect(result.map(r => r.experiment?.fallbackReason)).toEqual([undefined, 'low_confidence', 'jev_error', 'reasoning_required']);
  });
  it('bounds concurrency and isolates project errors', async () => {
    let active = 0, maximum = 0;
    const classifier = async () => { active++; maximum = Math.max(maximum, active); await new Promise(r => setTimeout(r, 2)); active--; return parseJevResponse(response()); };
    const projects = Array.from({ length: 9 }, (_, i) => ({ ...project, id: String(i) }));
    await classifyWithJev(projects, { requireReasoning: false, concurrency: 2, jevClassifier: classifier }, fallback);
    expect(maximum).toBe(2);
  });
  it.each(['missing', 'duplicate', 'invalid', 'throw', 'legacy-failure'])('marks %s LLM fallback as failed', async mode => {
    const llm: LlmClassifier = async projects => {
      const result = (await fallback(projects))[0];
      if (mode === 'missing') return [];
      if (mode === 'duplicate') return [result, result];
      if (mode === 'invalid') return [{ ...result, domains: ['illegal'] }];
      if (mode === 'legacy-failure') return [{ ...result, reasoning: 'LLM classification failed, defaulting to application' }];
      throw new Error('no credentials');
    };
    const result = await classifyWithJev([project], {}, llm);
    expect(result[0].experiment?.source).toBe('failed');
  });
  it('does not silently accept invalid confidence configuration', async () => {
    await expect(classifyWithJev([project], { minConfidence: NaN }, fallback)).rejects.toThrow();
    await expect(classifyWithJev([project], { concurrency: 0 }, fallback)).rejects.toThrow();
    await expect(classifyWithJev([project, project], {}, fallback)).rejects.toThrow('Duplicate');
  });
  it('handles empty input without API calls', async () => {
    expect(await classifyProjects([])).toEqual([]);
    expect(await classifyWithJev([], {}, fallback)).toEqual([]);
    expect(create).not.toHaveBeenCalled();
  });
  it('marks raw invalid LLM labels before legacy coercion without changing default output', async () => {
    create.mockResolvedValue({ choices: [{ message: { content: JSON.stringify([
      { id: project.id, layer: 'invalid-layer', domains: ['agent'], reasoning: 'bad layer' },
    ]) } }] });
    const calls: CallMetric[] = [];
    const legacy = await classifyProjects([project], { onCall: c => calls.push(c) });
    expect(legacy[0].layer).toBe('application');
    expect(calls[0].invalidProjectIds).toEqual([project.id]);
    const experimental = await classifyProjects([project], { provider: 'jev' });
    expect(experimental[0].experiment?.source).toBe('failed');
  });
  it('does not hide missing rows or malformed JSON from the benchmark', async () => {
    const calls: CallMetric[] = [];
    create.mockResolvedValue({ choices: [{ message: { content: '[]' } }] });
    expect(await classifyProjects([project], { onCall: c => calls.push(c) })).toEqual([]);
    expect(calls[0].invalidProjectIds).toEqual([project.id]);
  });
  it('records legacy LLM failures while preserving its default fallback', async () => {
    create.mockRejectedValue(new Error('offline failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: CallMetric[] = [];
    const result = await classifyProjectsWithLlm([project], c => calls.push(c));
    expect(result[0]).toMatchObject({ layer: 'application', domains: ['other'] });
    expect(calls[0].ok).toBe(false);
    warn.mockRestore();
  });
});

describe('benchmark accounting', () => {
  it('penalizes missing results, compares unordered domain sets and includes fallback cost', () => {
    const samples = [{ project: { id: 'a' }, expected: { layer: 'tooling', domains: ['agent', 'memory'] }, slice: 'en' },
      { project: { id: 'b' }, expected: { layer: 'application', domains: ['desktop'] }, slice: 'en' }];
    const calls: CallMetric[] = [{ provider: 'jev', projectIds: ['a'], model: 'jev', ok: true, elapsedMs: 10, inputTokens: 1000 },
      { provider: 'llm', projectIds: ['a'], model: 'llm', ok: true, elapsedMs: 20, inputTokens: 1000, outputTokens: 100 }];
    const stats = summarize(samples, [{ projectId: 'a', layer: 'tooling', domains: ['memory', 'agent'], reasoning: 'yes', experiment: { source: 'llm', fallbackReason: 'low_confidence' } }], calls, 1000, { jevInputPerMillion: 0.042, llmInputPerMillion: 1, llmOutputPerMillion: 2 });
    expect(stats.jointAccuracy).toBe(0.5);
    expect(stats.domainsMicroF1).toBe(0.8);
    expect(stats.failureRate).toBe(0.5);
    expect(stats.successfulProjectsPerSecond).toBe(1);
    expect(stats.estimatedCostUsd).toBeCloseTo(0.001242);
  });
  it('reports unknown cost instead of silently treating missing usage/rates as free', () => {
    const stats = summarize([], [], [{ provider: 'jev', projectIds: [], model: 'jev', ok: false, elapsedMs: 1 }], 1, { jevInputPerMillion: 0.042 });
    expect(stats.estimatedCostUsd).toBeNull();
    expect(stats.unknownCostCalls).toBe(1);
  });
  it('replays all frozen samples without credentials and exercises errors, fallback and disagreements', async () => {
    const calls: CallMetric[] = [];
    const results = await classifyWithJev(dataset.samples.map(s => s.project), { requireReasoning: false, jevClassifier: offlineJev, onCall: c => calls.push(c) }, offlineLlm);
    const stats = summarize(dataset.samples, results, calls, 100, { jevInputPerMillion: 0.042 });
    expect(stats.samples).toBe(24);
    expect(stats.fallbackReasons).toEqual({ low_confidence: 3, jev_error: 2 });
    expect(stats.failureRate).toBe(1 / 24);
    expect(stats.jointAccuracy).toBe(22 / 24);
    expect(stats.providers.find(p => p.provider === 'jev')?.failures).toBe(2);
  });
  it('uses the same evidence budget on both paths', () => {
    expect(buildJevRequest(project).state.readme).toHaveLength(500);
  });
});
