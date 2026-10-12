import {createHash} from 'node:crypto';

export const EVALUATION_VERSION = 'jev-paired-evaluation/0.1.0-preview' as const;
export const STRATEGIES = ['single', 'fixed', 'adaptive'] as const;
export type Strategy = typeof STRATEGIES[number];
export type JSONValue = null | boolean | number | string | JSONValue[] | {[key: string]: JSONValue};
export type ErrorKind = 'candidate_generation' | 'selection' | 'technical' | 'final';
export type Budget = Readonly<{max_operations: number; max_decisions: number;
  max_plan_versions: number; max_parallel: number; timeout_ms: number}>;
export type Tool = Readonly<{id: string; capability: string; model: string | null}>;
export type ModelBinding = Readonly<{caller: string; selector: string | null}>;
export type ConditionManifest = Readonly<{version: typeof EVALUATION_VERSION;
  case_id: string; task_class: string; split: 'design' | 'held-out'; input_sha256: string;
  sources: readonly Readonly<{id: string; sha256: string}>[];
  capabilities: readonly string[]; tools: readonly Tool[];
  models: Readonly<Record<Strategy, ModelBinding>>;
  implementation_sha256: Readonly<Record<Strategy, string>>;
  budget: Budget; deadline_ms: number; scoring_sha256: string}>;
export type ArmReceipt = Readonly<{version: typeof EVALUATION_VERSION; strategy: Strategy;
  case_id: string; run_id: string; manifest_sha256: string; input_sha256: string;
  sources: ConditionManifest['sources']; capabilities: readonly string[];
  models: ModelBinding; implementation_sha256: string; budget: Budget; deadline_ms: number;
  mode: 'live' | 'scripted' | 'injected' | 'recorded_replay' | 'unverified';
  outcome: 'complete' | 'hold' | 'failed' | 'unknown'; error_kind: ErrorKind | null;
  actual_tools: readonly Readonly<{call_id: string; tool_id: string; model: string | null;
    input_sha256: string; original: JSONValue}>[];
  accepted_reads: readonly Readonly<{source_id: string; sha256: string; observation_id: string}>[];
  final: Readonly<{raw_sha256: string; original: JSONValue; provenance: readonly string[]}> | null;
  usage: JSONValue; measurements: Readonly<{latency_ms: number | null; latency_scope: string | null; cost: number | null;
    cost_unit: string | null; original: JSONValue}>; retry_count: 0; original: JSONValue}>;
export type Grade = Readonly<{quality: number | null; evidence: number | null;
  unnecessary_work: number | null; unnecessary_holds: number | null;
  rework: number | null; re_explanation: number | null; original: JSONValue}>;
export type ReceiptAttestation = Readonly<{status: 'verified' | 'unavailable' | 'denied';
  receipt_sha256: string; original: JSONValue}>;
export type RunContext = Readonly<{signal: AbortSignal; deadline_ms: number; run_id?: string}>;
/** Ports own existing runtime execution/authority. This contract creates neither grants nor runs. */
export type StrategyRunner = (manifest: ConditionManifest, context: RunContext) => Promise<ArmReceipt>;
export type StrategyRunners = Readonly<Record<Strategy, StrategyRunner>>;
export type EvaluationHooks = Readonly<{signal: AbortSignal; now?: () => number;
  /** Must resolve the official current/fresh execution record, not trust receipt fields. */
  attestReceipt: (receipt: ArmReceipt, manifest: ConditionManifest) => Promise<ReceiptAttestation>;
  /** Independent evaluator: use actual final/read records; keep criteria/key outside provider input. */
  scoreFinal: (receipt: ArmReceipt, manifest: ConditionManifest) => Promise<Grade>}>;
export type ArmEvaluation = Readonly<{strategy: Strategy;
  status: 'measured' | 'diagnostic_only' | 'invalid' | 'unavailable';
  error_kind: ErrorKind | null; reason: string | null; receipt: ArmReceipt | null;
  received: JSONValue | null; receipt_sha256: string | null; attestation: ReceiptAttestation | null; grade: Grade | null}>;
export type PairedComparison = Readonly<{version: typeof EVALUATION_VERSION;
  manifest: ConditionManifest; manifest_sha256: string;
  status: 'measured' | 'diagnostic_only' | 'invalid' | 'unavailable';
  arms: Readonly<Record<Strategy, ArmEvaluation>>;
  authority: 'advisory_only'; automatic_apply: false}>;

export class EvaluationError extends Error {
  readonly code: string;
  constructor(code: string) {super(code); this.code = code;}
}
export function demand(ok: unknown, code: string): asserts ok {if (!ok) throw new EvaluationError(code);}
function json(v: unknown, depth = 0): string {
  demand(depth <= 28, 'JSON_DEPTH');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') {demand(Number.isFinite(v), 'JSON_NUMBER'); return JSON.stringify(v);}
  demand(typeof v === 'object' && v !== null && Object.getOwnPropertySymbols(v).length === 0, 'JSON_VALUE');
  if (Array.isArray(v)) {
    demand(v.length <= 4096 && Object.keys(v).length === v.length, 'JSON_ARRAY');
    return '[' + v.map(x => json(x, depth + 1)).join(',') + ']';
  }
  demand(Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null, 'JSON_OBJECT');
  const entries = Object.getOwnPropertyDescriptors(v);
  return '{' + Object.keys(entries).sort().map(k => {
    demand(Object.hasOwn(entries[k], 'value') && entries[k].enumerable, 'JSON_ACCESSOR');
    return JSON.stringify(k) + ':' + json(entries[k].value, depth + 1);
  }).join(',') + '}';
}
export function canonical(v: unknown): string {
  const result = json(v); demand(Buffer.byteLength(result) <= 1024 * 1024, 'JSON_SIZE'); return result;
}
export const digest = (v: unknown): string => createHash('sha256').update(canonical(v)).digest('hex');
export const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
function freeze<T>(v: T): T {if (v && typeof v === 'object') {Object.values(v).forEach(freeze); Object.freeze(v);} return v;}
export function snapshot<T>(v: T): T {canonical(v); return freeze(structuredClone(v));}
export const isSHA = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
export function exact(v: unknown, keys: readonly string[], code: string): asserts v is Record<string, unknown> {
  demand(v !== null && typeof v === 'object' && !Array.isArray(v) &&
    same(Object.keys(v).sort(), [...keys].sort()), code);
}
const integer = (v: unknown, min = 0) => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
function uniqueStrings(v: unknown, code: string) {
  demand(Array.isArray(v) && v.length <= 128 && v.every(isText) && new Set(v).size === v.length, code);
}
export function validateBudget(b: unknown): asserts b is Budget {
  exact(b, ['max_operations','max_decisions','max_plan_versions','max_parallel','timeout_ms'], 'BUDGET');
  demand(integer(b.max_operations, 1) && integer(b.max_decisions) && integer(b.max_plan_versions, 1) &&
    integer(b.max_parallel, 1) && integer(b.timeout_ms, 1), 'BUDGET');
}
function validateModels(m: unknown) {
  exact(m, ['caller','selector'], 'MODELS'); demand(isText(m.caller) && (m.selector === null || isText(m.selector)), 'MODELS');
}
export function validateManifest(m: unknown): asserts m is ConditionManifest {
  canonical(m); exact(m, ['version','case_id','task_class','split','input_sha256','sources','capabilities','tools',
    'models','implementation_sha256','budget','deadline_ms','scoring_sha256'], 'MANIFEST');
  demand(m.version === EVALUATION_VERSION && isText(m.case_id) && isText(m.task_class) &&
    ['design','held-out'].includes(String(m.split)) && isSHA(m.input_sha256) && isSHA(m.scoring_sha256) && integer(m.deadline_ms, 1), 'MANIFEST');
  uniqueStrings(m.capabilities, 'CAPABILITIES'); validateBudget(m.budget);
  demand(Array.isArray(m.sources) && m.sources.length > 0 && m.sources.length <= 128, 'SOURCES');
  const sourceIds = new Set<string>();
  for (const s of m.sources) {exact(s, ['id','sha256'], 'SOURCE'); demand(isText(s.id) && isSHA(s.sha256) && !sourceIds.has(s.id), 'SOURCE'); sourceIds.add(s.id);}
  demand(Array.isArray(m.tools) && m.tools.length <= 128, 'TOOLS'); const toolIds = new Set<string>();
  for (const t of m.tools) {exact(t, ['id','capability','model'], 'TOOL');
    demand(isText(t.id) && isText(t.capability) && (m.capabilities as string[]).includes(t.capability) &&
      (t.model === null || isText(t.model)) && !toolIds.has(t.id), 'TOOL'); toolIds.add(t.id);}
  exact(m.models, STRATEGIES, 'MODELS'); exact(m.implementation_sha256, STRATEGIES, 'IMPLEMENTATION');
  for (const s of STRATEGIES) {validateModels(m.models[s]); demand(isSHA(m.implementation_sha256[s]), 'IMPLEMENTATION');}
  const models = m.models as Record<Strategy, ModelBinding>;
  demand(models.single.caller === models.fixed.caller && models.fixed.caller === models.adaptive.caller &&
    models.single.selector === null && models.fixed.selector === null, 'UNEQUAL_CALLER_MODELS');
}
export function validateReceipt(r: unknown, m: ConditionManifest, strategy: Strategy): asserts r is ArmReceipt {
  canonical(r); exact(r, ['version','strategy','case_id','run_id','manifest_sha256','input_sha256','sources','capabilities',
    'models','implementation_sha256','budget','deadline_ms','mode','outcome','error_kind','actual_tools','accepted_reads',
    'final','usage','measurements','retry_count','original'], 'RECEIPT');
  demand(r.version === EVALUATION_VERSION && r.strategy === strategy && r.case_id === m.case_id && isText(r.run_id) &&
    r.manifest_sha256 === digest(m) && r.input_sha256 === m.input_sha256 && same(r.sources, m.sources) &&
    same(r.capabilities, m.capabilities) && same(r.models, m.models[strategy]) &&
    r.implementation_sha256 === m.implementation_sha256[strategy] && same(r.budget, m.budget) &&
    r.deadline_ms === m.deadline_ms && r.retry_count === 0, 'RECEIPT_CONDITIONS');
  demand(['live','scripted','injected','recorded_replay','unverified'].includes(String(r.mode)) &&
    ['complete','hold','failed','unknown'].includes(String(r.outcome)) &&
    (r.error_kind === null || ['candidate_generation','selection','technical','final'].includes(String(r.error_kind))), 'RECEIPT_STATUS');
  demand(r.outcome !== 'complete' || r.error_kind === null, 'COMPLETE_ERROR');
  demand(Array.isArray(r.actual_tools) && r.actual_tools.length <= m.budget.max_operations, 'ACTUAL_TOOLS');
  const calls = new Set<string>();
  for (const a of r.actual_tools) {exact(a, ['call_id','tool_id','model','input_sha256','original'], 'ACTUAL_TOOL');
    const allowed = m.tools.find(t => t.id === a.tool_id);
    demand(isText(a.call_id) && !calls.has(a.call_id) && allowed && a.model === allowed.model &&
      isSHA(a.input_sha256) && a.original !== null, 'ACTUAL_TOOL'); calls.add(a.call_id);}
  demand(Array.isArray(r.accepted_reads), 'ACCEPTED_READS'); const observations = new Set<string>();
  for (const a of r.accepted_reads) {exact(a, ['source_id','sha256','observation_id'], 'ACCEPTED_READ');
    demand(m.sources.some(s => s.id === a.source_id && s.sha256 === a.sha256) &&
      isText(a.observation_id) && !observations.has(a.observation_id), 'ACCEPTED_READ'); observations.add(a.observation_id);}
  if (r.final !== null) {exact(r.final, ['raw_sha256','original','provenance'], 'FINAL');
    uniqueStrings(r.final.provenance, 'FINAL_PROVENANCE');
    demand(isSHA(r.final.raw_sha256) && r.final.original !== null &&
      (r.final.provenance as string[]).every(id => observations.has(id)), 'FINAL');}
  demand(r.outcome !== 'complete' || r.final !== null, 'COMPLETE_WITHOUT_FINAL');
  exact(r.measurements, ['latency_ms','latency_scope','cost','cost_unit','original'], 'MEASUREMENTS');
  for (const k of ['latency_ms','cost']) metric(r.measurements[k], k);
  demand(r.measurements.cost_unit === null || isText(r.measurements.cost_unit), 'COST_UNIT');
  demand(r.measurements.latency_scope === null || isText(r.measurements.latency_scope), 'LATENCY_SCOPE');
  demand(r.measurements.latency_ms === null || r.measurements.latency_scope !== null && r.measurements.original !== null, 'LATENCY_ORIGIN');
  demand(r.measurements.cost === null || r.measurements.cost_unit !== null && r.measurements.original !== null, 'COST_ORIGIN');
  demand(r.original !== null, 'ORIGINAL_RECEIPT');
}
export function metric(v: unknown, code: string, bounded = false) {
  demand(v === null || typeof v === 'number' && Number.isFinite(v) && v >= 0 && (!bounded || v <= 1), code);
}
export function validateGrade(g: unknown): asserts g is Grade {
  exact(g, ['quality','evidence','unnecessary_work','unnecessary_holds','rework','re_explanation','original'], 'GRADE');
  for (const k of ['quality','evidence','unnecessary_work','unnecessary_holds','rework','re_explanation']) metric(g[k], 'GRADE_METRIC', k === 'quality' || k === 'evidence');
  demand(g.original !== null, 'GRADE_ORIGIN'); canonical(g);
}
export function profileScope(m: ConditionManifest) {
  return {task_class: m.task_class, capabilities: m.capabilities, tools: m.tools, models: m.models,
    implementation_sha256: m.implementation_sha256, budget: m.budget, scoring_sha256: m.scoring_sha256};
}
