import { createJevClassifier, type JevClassifier, type JevDecision, type JevOptions } from './jev-classifier.js';
import { validLabels, type ObserveCall, type ProjectInput } from './signal-types.js';
import type { SignalClassification } from './signal-tagger.js';

export type FallbackReason = 'reasoning_required' | 'low_confidence' | 'jev_error';
export interface ClassificationExperiment {
  source: 'jev' | 'llm' | 'failed';
  fallbackReason?: FallbackReason;
  /** Jev confidence, never a claim of LLM confidence. */
  jev?: JevDecision;
}
export interface SignalTaggerOptions {
  provider?: 'llm' | 'jev';
  /** Defaults to true to preserve the existing explanation contract. */
  requireReasoning?: boolean | ((project: ProjectInput) => boolean);
  minConfidence?: number;
  concurrency?: number;
  jev?: JevOptions;
  jevClassifier?: JevClassifier;
  onCall?: ObserveCall;
}
export type LlmClassifier = (projects: ProjectInput[], onCall?: ObserveCall) => Promise<SignalClassification[]>;
export async function classifyWithJev(projects: ProjectInput[], options: SignalTaggerOptions, llm: LlmClassifier): Promise<SignalClassification[]> {
  const threshold = options.minConfidence ?? 0.8;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('minConfidence must be in [0, 1]');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('concurrency must be an integer in [1, 32]');
  if (new Set(projects.map(p => p.id)).size !== projects.length) throw new Error('Duplicate project IDs');
  if (!projects.length) return [];
  const classify = options.jevClassifier ?? createJevClassifier(options.jev);
  const output: SignalClassification[] = new Array(projects.length);
  const pending: Array<{ index: number; reason: FallbackReason; jev?: JevDecision }> = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, async () => {
    while (next < projects.length) {
      const index = next++;
      const project = projects[index];
      const needsReasoning = typeof options.requireReasoning === 'function' ? options.requireReasoning(project) : options.requireReasoning ?? true;
      if (needsReasoning) {
        pending.push({ index, reason: 'reasoning_required' });
        continue;
      }
      try {
        const decision = await classify(project, options.onCall);
        if (!validLabels(decision) || !Number.isFinite(decision.confidence) || decision.confidence < 0 || decision.confidence > 1) throw new Error('invalid_decision');
        if (decision.confidence < threshold) pending.push({ index, reason: 'low_confidence', jev: decision });
        else output[index] = { projectId: project.id, layer: decision.layer, domains: decision.domains, reasoning: '', experiment: { source: 'jev', jev: decision } };
      } catch {
        pending.push({ index, reason: 'jev_error' });
      }
    }
  }));
  // Preserve batching in the existing LLM; failures of one Jev request do not abort siblings.
  pending.sort((a, b) => a.index - b.index);
  if (pending.length) {
    let fallback: SignalClassification[] = [];
    const failedIds = new Set<string>();
    try {
      fallback = await llm(pending.map(p => projects[p.index]), metric => {
        if (!metric.ok) metric.projectIds.forEach(id => failedIds.add(id));
        metric.invalidProjectIds?.forEach(id => failedIds.add(id));
        try { options.onCall?.(metric); } catch { /* telemetry only */ }
      });
    } catch { /* emit explicit failed outcomes below */ }
    for (const item of pending) {
      const project = projects[item.index];
      const matches = fallback.filter(r => r.projectId === project.id);
      const result = matches[0];
      const valid = matches.length === 1 && result && validLabels(result) && !failedIds.has(project.id)
        && typeof result.reasoning === 'string' && result.reasoning.length > 0
        && result.reasoning !== 'LLM classification failed, defaulting to application';
      output[item.index] = {
        ...(valid ? result : { projectId: project.id, layer: 'application', domains: ['other'], reasoning: 'Classification failed; requires review' }),
        experiment: { source: valid ? 'llm' : 'failed', fallbackReason: item.reason, jev: item.jev },
      };
    }
  }
  return output;
}
