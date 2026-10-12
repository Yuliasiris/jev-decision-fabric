/** Sole C0 source. Preview SDK boundary; neither a public MCP tool nor an auth grant. */
export const CONTRACT_VERSION = 'jev-c0/0.1.0-preview' as const;
export type JSONValue = null | boolean | number | string | JSONValue[] | {[key: string]: JSONValue};
export type EvidenceMode = 'scripted' | 'injected' | 'recorded_replay' | 'live' | 'unverified';
export type Capability = Readonly<{id: string; kind: 'worker' | 'tool' | 'caller';
  authorized: boolean; parallel: boolean; cancellable: boolean}>;
export type SourceView = Readonly<{id: string; revision: string; text: string;
  origin: string; range: string; omitted: boolean}>;
export type Budget = Readonly<{max_operations: number; max_decisions: number;
  max_plan_versions: number; max_parallel: number; timeout_ms: number}>;
export type Request = Readonly<{contract_version: typeof CONTRACT_VERSION; run_id: string;
  objective: string; input_revision: string; requested_output: string;
  sources: readonly SourceView[]; capabilities: readonly Capability[]; budget: Budget}>;
export type Task = Readonly<{id: string; purpose: string; capability: string;
  input_revision: string; input: JSONValue; sources: readonly string[];
  reads: readonly string[]; after: readonly string[]; output: string}>;
export type Patch = Readonly<{upsert: readonly Task[]; remove: readonly string[]}>;
export type Candidate = Readonly<{id: string; purpose: string; reason: string;
  evidence: readonly string[]; patch: Patch}>;
export type TaskRequest = Readonly<{contract_version: typeof CONTRACT_VERSION;
  run_id: string; task_id: string; attempt_id: string; plan_version: number;
  input_revision: string; input_digest: string; purpose: string; capability: string;
  input: JSONValue; sources: readonly SourceView[];
  reads: Readonly<Record<string, Observation>>; output: string; deadline_ms: number}>;
export type ObservationStatus = 'completed' | 'cancelled' | 'unsupported' | 'unauthorized' |
  'timeout' | 'rate_limited' | 'invalid' | 'error';
export type Observation = Readonly<{contract_version: typeof CONTRACT_VERSION; id: string;
  run_id: string; task_id: string; attempt_id: string; input_revision: string;
  input_digest: string; status: ObservationStatus; value: JSONValue;
  evidence: readonly string[]; mode: EvidenceMode;
  usage: Readonly<{tokens: number | null; cost: number | null}>}>;
export type Adoption = 'accepted' | 'duplicate' | 'conflict' | 'late' | 'stale' | 'invalid';
export type RunStatus = 'needs_host' | 'complete' | 'hold' | 'cancelled' | 'failed';
export type EventKind = 'run_started' | 'plan_changed' | 'task_requested' | 'observation_received' |
  'cancel_requested' | 'cancel_confirmed' | 'decision' | 'run_finished';
export type Event = Readonly<{contract_version: typeof CONTRACT_VERSION; run_id: string;
  seq: number; plan_version: number; kind: EventKind; task_id: string | null; data: JSONValue}>;
export type Selection = Readonly<{candidate_id: string | null; status: 'selected' | 'hold' | 'failed';
  mode: EvidenceMode; record: JSONValue}>;
export type Usage = Readonly<{operations_started: number; decisions_started: number;
  by_kind: Readonly<Record<'worker' | 'tool' | 'caller' | 'decision', number>>;
  tokens: number | null; cost: number | null}>;
export type Result = Readonly<{contract_version: typeof CONTRACT_VERSION; run_id: string;
  status: RunStatus; answer: string | null; unresolved: readonly string[];
  provenance: readonly string[]; pending: readonly string[]; usage: Usage;
  authority: 'advisory_only'; automatic_apply: false}>;
/** A host stub implements this whole port. It does not implement a second replanner. */
export interface ExecutionPort {
  dispatch(): readonly TaskRequest[];
  observe(observation: Observation): Adoption;
  revise(candidate: Candidate, expected_version: number): boolean;
  choose(candidates: readonly Candidate[], decide: DecisionPort): Promise<Selection>;
  cancel(reason: string): void;
  finish(answer: string, provenance: readonly string[], unresolved?: readonly string[]): Result;
  result(): Result;
  records(): {request: Request; plans: readonly {version: number; tasks: readonly Task[]}[];
    events: readonly Event[]; observations: readonly {observation: Observation; adoption: Adoption}[];
    result: Result};
}
export type DecisionPort = (input: Readonly<{request: Request; plan_version: number;
  candidates: readonly Candidate[]; observations: readonly Observation[];
  timeout_ms: number}>) => Promise<Selection>;
