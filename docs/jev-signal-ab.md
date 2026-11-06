# Jev signal tagging: opt-in A/B experiment

Status: implementation and offline contract tests complete; **no live model measurements yet**. Existing CLI/report callers still use the original GLM batch classifier. No API key is needed for build, tests or offline replay.

## Verified API/SDK (2026-09-29)

Checked first-party sources, not Jev-branded third-party gateways:

- [HTTP API](https://docs.typesafe.ai/api): `POST https://api.typesafe.ai/v1/systemone`, Bearer authentication, `state`, `model`, and a keyed `questions` map; answers use the same keys.
- [Official JavaScript SDK](https://docs.typesafe.ai/sdk/javascript): `@typesafe-ai/sdk`, Node >=20, `TypeSafeClient.systemOne()`, `choice()` helpers and `TYPESAFE_API_KEY`.
- [Models and pricing](https://docs.typesafe.ai/models): `jev-1.13.0`, currently also `jev-latest`; $0.042 per million input tokens, output free. Aliases can move; this experiment pins the version and records the returned model.
- [Confidence](https://docs.typesafe.ai/confidence): Choice confidence is a distribution-derived statistic, not the selected option's probability or guaranteed empirical accuracy. Noul gives P(yes), without a separate confidence field.
- [Known limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13): literal interpretation and complex judgments need careful evaluation. Include Chinese examples because English is the primary training language.

Implementation deliberately uses a small injectable `fetch` adapter for the verified REST contract: no new production dependency, no guessed SDK version, no eager credential check. The SDK is a compatible future transport option. This is a documentation-verified contract, **not an authenticated API smoke test**.

[Lenny's September 28 episode](https://www.lennysnewsletter.com/p/jev-for-beginners-how-to-use-it-and) motivates the experiment. Its PR/classification workflows, and the user's quoted $4 result, are not an Augur price forecast. Charge from actual returned usage, never from dividing those case-study costs by operation count.

## Use from code

```ts
import { classifyProjects } from './analyzer/signal-tagger.js';

// Existing behavior, including reasoning and batches of 10: unchanged.
const original = await classifyProjects(projects);

// Opt in to Jev for decisions only.
const experimental = await classifyProjects(projects, {
  provider: 'jev',
  requireReasoning: false,
  minConfidence: 0.8,
  concurrency: 4,
  onCall: metric => console.log(metric),
});

// Optional per-project reasoning requirement.
const mixed = await classifyProjects(projects, {
  provider: 'jev',
  requireReasoning: project => selectedForReport.has(project.id),
});
```

`requireReasoning` defaults to `true`: setting only `provider: 'jev'` still uses the LLM for all projects. Explicitly disable reasoning for consumers that can accept `reasoning: ''`. Requiring prose routes straight to the LLM, avoiding an unnecessary paid Jev call. The LLM's labels and explanation replace the whole result to keep them consistent.

Jev asks 13 independent Choice questions in one request per project: one 3-way layer question plus 12 yes/no domain questions. Multiple positive domains are retained; all-negative maps to `other`. Every question carries explicit criteria. Project metadata and the first 500 README characters match the existing evidence budget.

The gate takes the minimum confidence across layer and **all** domain decisions, including negatives; it is conservative, not a joint probability. The initial 0.8 threshold is an engineering default to calibrate, not a validated quality claim. It is likely to cause more fallback than a layer-only gate.

Timeout (10s), HTTP failure, missing credentials, malformed answers, unknown labels or missing/invalid confidence all route to the original LLM. One Jev attempt per project; 429/529 are not retried, avoiding extra latency and hidden cost in this minimal experiment. Requests have bounded concurrency. No keys or provider error bodies are logged by the adapter. The LLM retains its existing SDK retry and timeout behavior.

Fallback projects are sorted back into input order and sent through the existing batches of 10. Missing/duplicate/invalid LLM results or both-provider failure return an explicit `experiment.source: 'failed'` review marker. The compatibility `application/other` placeholder on failed rows is **not** scored as a successful prediction. Existing default-path output retains its original shape and error behavior; optional instrumentation records raw invalid labels before its legacy coercion.

Experimental rows add `experiment.source`, `fallbackReason` and, when available, the full Jev decision with per-question confidence and actual model version. A fallback retains the attempted Jev confidence under `experiment.jev`; it does not pretend the LLM has that confidence. Existing database schema is untouched.

## Fixed samples and offline run

```bash
npm ci
npm run build
npm run test:signal
npm run bench:signal
npm run bench:signal -- --reasoning --repeats 1 --output reports/jev-ab.reasoning.json
```

Node 20+ is recommended. The benchmark uses `node --import tsx` to avoid the tsx CLI's optional IPC server. It also runs after compilation via `node dist/benchmarks/signal-tagger.js`.

- `src/benchmarks/fixtures/signal-samples.json`: 24 fictional project descriptions, 8 per layer, all 13 domain labels, multi-label cases and one Chinese example. Expected labels are authored engineering annotations, **not user-approved production gold labels**. The file and dataset hash freeze evidence, avoiding changes to live GitHub descriptions.
- `offline-responses.json`: separate frozen, scripted predictions. Deliberately includes wrong predictions, three uncertain cases, two Jev failures, and a missing LLM result. No fake endpoint is contacted; an injected transport exercises the real Jev request/response adapter. Mocks never consume the expected labels at benchmark runtime.
- Offline numbers are **harness checks only**. Mock accuracy, token counts, and costs cannot support a Jev-vs-LLM quality or savings claim. Mock throughput measures local execution overhead.

Offline smoke result: A joint matches 21/24; B joint matches 22/24; B falls back on 5/24; both have one missing/failed final result. These differences were intentionally scripted. Cost totals remain `null` with unspecified LLM rates or unknown usage on failed requests; the Jev known-usage subtotal is not the total cost.

## Live paired benchmark (optional, later)

Use keys already present in the environment; never commit them. This task did not call either paid provider.

```bash
# Environment: TYPESAFE_API_KEY and GLM_API_KEY
npm run bench:signal -- --live --repeats 4 --output reports/jev-ab.live.json

# Optional actual contracted prices, USD per million tokens:
# append --llm-input-price <rate> --llm-output-price <rate>
# Jev input price defaults to 0.042; override with --jev-input-price if needed.

# If every consumer still needs prose, measure that actual requirement separately:
npm run bench:signal -- --live --reasoning --repeats 2 --output reports/jev-ab.reasoning-live.json
```

A = unchanged batch LLM classification, with reasoning. B = Jev plus LLM fallback, no prose on accepted Jev decisions. They share the same frozen input, alternate A/B then B/A, and have no hidden warm-up. `--reasoning` measures the prose-required case, which should eliminate Jev calls and any expected savings. This is an end-to-end workflow comparison; A has 10-item batches, B has one-project requests at configured concurrency. It does not isolate raw per-model inference speed.

Each JSON report records dataset hash, git HEAD plus dirty-worktree state, requested/returned models, thresholds, concurrency, per-call usage and elapsed time, expected/predicted labels, and:

| Metric | Definition |
|---|---|
| Layer / domains exact / joint accuracy | Correct rows divided by **all** input rows; missing/failed results are wrong |
| Domain micro-F1 | Set-based multi-label F1; missing results add false negatives |
| Final failure rate | Missing, duplicate, invalid or failed final rows / all rows |
| Provider failure rate | Failed request/parse or invalid-result calls / provider calls |
| Fallback rate and reasons | Low confidence, Jev error, reasoning required, including failed fallbacks |
| Throughput | Both attempted and successful projects / measured whole-arm wall time |
| Request p50/p95 | Client call latency, not pure inference; mixed Jev/LLM sizes, per-call details retained |
| Cost estimate | Returned tokens × specified rates, including Jev attempts and LLM fallback |

Missing usage or unspecified rates make the total `null`; known subtotals and unknown-call counts are retained. Failed calls may still cost money. Existing OpenAI SDK internal retries are not separately instrumented, so invoice reconciliation remains necessary. SDK retries are included in client wall time. Reports are generated locally and ignored by git by default.

Before changing the default: annotate a representative production holdout (including ambiguous, short and Chinese descriptions), calibrate thresholds on a separate split, and compare per-row errors, domain F1, coverage/fallback, cost completeness and end-to-end throughput. The 24-case synthetic sample is sufficient for this minimal plumbing experiment, not for a rollout decision.

## Validation in this change

- TypeScript build: passed.
- Targeted offline contract/routing/accounting tests: passed.
- Offline A/B runner and compiled JS entry point: passed, no credentials.
- Existing full suite: blocked in this execution environment by missing `better-sqlite3` native binding under Node 24. Rebuild failed during Node-header extraction (`fchown EINVAL`). The existing SQLite tests fail before exercising their assertions; this change does not modify SQLite. Build output also causes the existing unconfigured Vitest runner to discover compiled test duplicates.
