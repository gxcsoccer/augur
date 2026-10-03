import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type FixtureData from './fixtures/signal-samples.json';
const dataset: typeof FixtureData = createRequire(import.meta.url)('./fixtures/signal-samples.json');
import { classifyProjectsWithLlm } from '../analyzer/signal-tagger.js';
import { classifyWithJev } from '../analyzer/signal-tagger-experiment.js';
import { JEV_MODEL } from '../analyzer/jev-classifier.js';
import { LLM_MODEL } from '../llm/client.js';
import { offlineJev, offlineLlm } from './signal-offline.js';
import { summarize } from './signal-metrics.js';
import type { CallMetric } from '../analyzer/signal-types.js';
import type { SignalClassification } from '../analyzer/signal-tagger.js';

async function main() {
  const { values } = parseArgs({ options: {
    live: { type: 'boolean', default: false }, reasoning: { type: 'boolean', default: false },
    repeats: { type: 'string', default: '2' }, concurrency: { type: 'string', default: '4' },
    threshold: { type: 'string', default: '0.8' }, model: { type: 'string', default: JEV_MODEL },
    output: { type: 'string', default: 'reports/jev-ab.offline.json' },
    'jev-input-price': { type: 'string', default: '0.042' },
    'llm-input-price': { type: 'string' }, 'llm-output-price': { type: 'string' },
  } });
  function number(raw: string | undefined, name: string): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n < 0) throw new Error(`Invalid ${name}`);
    return n;
  }
  const repeats = number(values.repeats, 'repeats')!;
  const concurrency = number(values.concurrency, 'concurrency')!;
  const threshold = number(values.threshold, 'threshold')!;
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 100) throw new Error('repeats must be in [1, 100]');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('concurrency must be in [1, 32]');
  if (threshold > 1) throw new Error('threshold must be in [0, 1]');
  const prices = { jevInputPerMillion: number(values['jev-input-price'], 'jev-input-price')!,
    llmInputPerMillion: number(values['llm-input-price'], 'llm-input-price'),
    llmOutputPerMillion: number(values['llm-output-price'], 'llm-output-price') };
  if (values.live && (!process.env.GLM_API_KEY || (!values.reasoning && !process.env.TYPESAFE_API_KEY))) {
    throw new Error('Live benchmark requires GLM_API_KEY and (unless --reasoning) TYPESAFE_API_KEY. Omit --live for offline replay.');
  }
  const projects = dataset.samples.map(s => s.project);
  const llm = values.live ? classifyProjectsWithLlm : offlineLlm;
  const runs = [];
  for (let round = 0; round < repeats; round++) {
    // Alternate order; compare the same frozen evidence. No hidden warm-up calls.
    for (const arm of round % 2 ? ['B', 'A'] : ['A', 'B']) {
      const calls: CallMetric[] = [];
      const start = performance.now();
      let results: SignalClassification[] = [];
      let runError: string | undefined;
      try {
        results = arm === 'A' ? await llm(projects, c => calls.push(c)) : await classifyWithJev(projects, {
          provider: 'jev', requireReasoning: values.reasoning, minConfidence: threshold, concurrency,
          jev: { model: values.model }, jevClassifier: values.live ? undefined : offlineJev,
          onCall: c => calls.push(c),
        }, llm);
      } catch { runError = 'classifier_failed'; }
      runs.push({ round: round + 1, arm, runError, ...summarize(dataset.samples, results, calls, performance.now() - start, prices), calls });
    }
  }
  const report = {
    mode: values.live ? 'live' : 'offline-mock',
    notice: values.live ? 'Small synthetic dataset with provisional labels; costs are token-rate estimates, not billing invoices.' : 'Scripted fixtures only. Accuracy, tokens and cost are synthetic; wall time measures local harness overhead, NOT model throughput. No API calls.',
    createdAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    worktreeDirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0,
    datasetVersion: dataset.version, datasetSha256: createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),
    provenance: dataset.provenance, settings: { repeats, concurrency, threshold, requireReasoning: values.reasoning,
      jevModel: values.model, llmModel: LLM_MODEL, llmBatchSize: 10, prices },
    costNotice: 'Unknown usage or unspecified LLM rates produce null totals. knownEstimatedCostUsd is only a subtotal; fallback LLM usage is included. SDK-internal LLM retries are not separately instrumented.',
    runs,
  };
  const output = resolve(values.live && values.output === 'reports/jev-ab.offline.json' ? 'reports/jev-ab.live.json' : values.output!);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(report.notice);
  console.table(runs.map(r => ({ round: r.round, arm: r.arm, layer: r.layerAccuracy.toFixed(3),
    domainsExact: r.domainsExactAccuracy.toFixed(3), domainsF1: r.domainsMicroF1.toFixed(3),
    joint: r.jointAccuracy.toFixed(3), failure: r.failureRate.toFixed(3), fallback: r.fallbackRate.toFixed(3),
    projectsPerSecond: r.successfulProjectsPerSecond.toFixed(1), estimatedUsd: r.estimatedCostUsd ?? 'unknown',
    knownSubtotalUsd: r.knownEstimatedCostUsd.toFixed(6), unknownCostCalls: r.unknownCostCalls })));
  console.log(`Report: ${output}`);
  if (runs.some(r => r.runError)) process.exitCode = 1;
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Benchmark failed'); process.exitCode = 1; });
