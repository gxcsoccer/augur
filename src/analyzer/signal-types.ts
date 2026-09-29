export const LAYERS = ['infrastructure', 'tooling', 'application'] as const;
export const DOMAINS = ['agent', 'memory', 'desktop', 'voice', 'eval', 'local-ai', 'code-gen', 'search', 'data', 'security', 'devops', 'economy', 'other'] as const;
export type Layer = typeof LAYERS[number];
export type Domain = typeof DOMAINS[number];
export interface ProjectInput {
  id: string;
  description: string | null;
  language: string | null;
  topics: string | null;
  readme?: string;
}
export interface CallMetric {
  provider: 'llm' | 'jev';
  projectIds: string[];
  model: string;
  elapsedMs: number;
  ok: boolean;
  inputTokens?: number;
  outputTokens?: number;
  /** Safe category only: never log provider bodies, prompts or credentials. */
  error?: string;
  invalidProjectIds?: string[];
}
export type ObserveCall = (metric: CallMetric) => void;
export function observe(observer: ObserveCall | undefined, metric: CallMetric): void {
  // Telemetry must not alter classification or cause a second provider call.
  try { observer?.(metric); } catch { /* observational only */ }
}
export function validLabels(value: { layer: string; domains: string[] }): boolean {
  return LAYERS.includes(value.layer as Layer) && Array.isArray(value.domains)
    && value.domains.length > 0 && new Set(value.domains).size === value.domains.length
    && value.domains.every(d => DOMAINS.includes(d as Domain))
    && !(value.domains.includes('other') && value.domains.length > 1);
}
