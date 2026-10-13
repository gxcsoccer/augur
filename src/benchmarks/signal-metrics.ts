import { validLabels, type CallMetric } from '../analyzer/signal-types.js';
import type { SignalClassification } from '../analyzer/signal-tagger.js';
export interface GoldSample { project: { id: string }; expected: { layer: string; domains: string[] }; slice: string }
export interface Prices { jevInputPerMillion: number; llmInputPerMillion?: number; llmOutputPerMillion?: number }
export function summarize(samples: GoldSample[], results: SignalClassification[], calls: CallMetric[], wallMs: number, prices: Prices) {
  let valid = 0, layerCorrect = 0, domainExact = 0, joint = 0, tp = 0, fp = 0, fn = 0;
  const callFailures = new Set(calls.filter(c => c.provider === 'llm').flatMap(c => !c.ok ? c.projectIds : c.invalidProjectIds ?? []));
  const details = samples.map(sample => {
    const matches = results.filter(r => r.projectId === sample.project.id);
    const result = matches[0];
    const ok = matches.length === 1 && result && validLabels(result) && result.experiment?.source !== 'failed'
      && !callFailures.has(sample.project.id) && result.reasoning !== 'LLM classification failed, defaulting to application';
    const gold = new Set(sample.expected.domains);
    const predicted = new Set(ok ? result.domains : []);
    for (const d of predicted) gold.has(d) ? tp++ : fp++;
    for (const d of gold) if (!predicted.has(d)) fn++;
    const layerMatch = !!ok && result.layer === sample.expected.layer;
    const domainMatch = !!ok && predicted.size === gold.size && [...gold].every(d => predicted.has(d));
    if (ok) valid++;
    if (layerMatch) layerCorrect++;
    if (domainMatch) domainExact++;
    if (layerMatch && domainMatch) joint++;
    return { id: sample.project.id, slice: sample.slice, ok: !!ok, layerMatch, domainMatch, expected: sample.expected, result: result ?? null };
  });
  const n = samples.length;
  const latencies = calls.map(c => c.elapsedMs).sort((a, b) => a - b);
  let knownCost = 0, unknownCostCalls = 0;
  const providers = (['llm', 'jev'] as const).map(provider => {
    const selected = calls.filter(c => c.provider === provider);
    for (const call of selected) {
      const input = provider === 'jev' ? prices.jevInputPerMillion : prices.llmInputPerMillion;
      const output = provider === 'jev' ? 0 : prices.llmOutputPerMillion;
      // Failed requests without usage may have been billed. Unknown is never zero.
      if (call.inputTokens === undefined || input === undefined || output === undefined || (output !== 0 && call.outputTokens === undefined)) unknownCostCalls++;
      else knownCost += (call.inputTokens * input + (call.outputTokens ?? 0) * output) / 1_000_000;
    }
    return { provider, calls: selected.length, failures: selected.filter(c => !c.ok || (c.invalidProjectIds?.length ?? 0) > 0).length,
      failureRate: selected.length ? selected.filter(c => !c.ok || (c.invalidProjectIds?.length ?? 0) > 0).length / selected.length : 0,
      inputTokens: selected.reduce((s, c) => s + (c.inputTokens ?? 0), 0), outputTokens: selected.reduce((s, c) => s + (c.outputTokens ?? 0), 0) };
  });
  const fallbackReasons: Record<string, number> = {};
  for (const result of results) if (result.experiment?.fallbackReason) fallbackReasons[result.experiment.fallbackReason] = (fallbackReasons[result.experiment.fallbackReason] ?? 0) + 1;
  const fallbackCount = Object.values(fallbackReasons).reduce((a, b) => a + b, 0);
  return {
    samples: n, valid, layerAccuracy: n ? layerCorrect / n : 0, domainsExactAccuracy: n ? domainExact / n : 0,
    jointAccuracy: n ? joint / n : 0, domainsMicroF1: 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : 0,
    failureRate: n ? (n - valid) / n : 0, fallbackRate: n ? fallbackCount / n : 0, fallbackReasons,
    wallMs, attemptedProjectsPerSecond: wallMs > 0 ? n * 1000 / wallMs : 0,
    successfulProjectsPerSecond: wallMs > 0 ? valid * 1000 / wallMs : 0,
    requestLatencyP50Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.5) - 1] : null,
    requestLatencyP95Ms: latencies.length ? latencies[Math.ceil(latencies.length * 0.95) - 1] : null,
    estimatedCostUsd: unknownCostCalls || !calls.length ? null : knownCost,
    knownEstimatedCostUsd: knownCost, unknownCostCalls, providers, details,
  };
}
