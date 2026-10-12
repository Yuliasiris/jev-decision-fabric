/** Optional extension. The immutable C0 0.1.0 wire contract and six fixtures remain unchanged. */
import type {Request, Task, TaskRequest, Observation, Adoption, Event, RunStatus,
  ExecutionPort} from './c0.mts';
export const CHECKPOINT_VERSION = 'jev-c0-checkpoint/0.1.0-preview' as const;
export const CONTROLLER_VERSION = 'jev-adaptive/0.3.0-preview' as const;
export type TaskState = 'planned' | 'running' | 'done' | 'cancel_requested';
export type DecisionEffect = Readonly<{kind: 'decision'; id: string; plan_version: number;
  input_digest: string; candidates: readonly string[]}>;
export type PendingEffect = DecisionEffect | Readonly<{kind: 'task'; id: string;
  request: TaskRequest; cancel_requested: boolean}>;
export type EffectSettlement = Readonly<{effect_id: string;
  outcome: 'unknown' | 'still_running' | 'not_started' | 'cancelled' | 'completed_without_result';
  evidence_ref: string; usage: Readonly<{tokens: number | null; cost: number | null}>}>;
export type CheckpointState = Readonly<{
  request: Request; deadline_ms: number; plan_version: number;
  entries: readonly {task: Task; state: TaskState; request: TaskRequest | null}[];
  accepted: readonly (readonly [string, Observation])[];
  seen: readonly (readonly [string, string])[];
  attempt_results: readonly (readonly [string, string])[];
  applied: readonly (readonly [string, string])[];
  plans: readonly {version: number; tasks: readonly Task[]}[];
  events: readonly Event[];
  observations: readonly {observation: Observation; adoption: Adoption}[];
  status: RunStatus; reason: readonly string[]; answer: string | null; provenance: readonly string[];
  operations: number; decisions: number;
  by_kind: Readonly<Record<'worker' | 'tool' | 'caller' | 'decision', number>>;
  usages: readonly {tokens: number | null; cost: number | null}[];
  pending_decision: DecisionEffect | null;
  settlements: readonly (readonly [string, EffectSettlement])[];
  restore_history: readonly string[];
}>;
export type Checkpoint = Readonly<{checkpoint_version: typeof CHECKPOINT_VERSION;
  contract_version: Request['contract_version'];
  /** Same layout; old versions retain their original 1..60000 validation. */
  controller_version: typeof CONTROLLER_VERSION | 'jev-adaptive/0.2.0-preview' | 'jev-adaptive/0.2.1-preview';
  captured_at_ms: number; state: CheckpointState; digest: string}>;
export type Recovery = Readonly<{checkpoint_version: typeof CHECKPOINT_VERSION;
  restored_from: string | null; pending: readonly PendingEffect[]}>;
/** Transient read-only identity of the current choose admission, never a restored grant. */
export type DecisionBoundary = Readonly<{run_id: string; effect_id: string; plan_version: number;
  input_digest: string; parent_deadline_ms: number; decision_deadline_ms: number; admitted_at_ms: number}>;
export interface CheckpointExecutionPort extends ExecutionPort {
  checkpoint(): Checkpoint;
  recovery(): Recovery;
  /** Host evidence only. Unknown/still_running leaves admission blocked. No worker retry. */
  settle(settlement: EffectSettlement): boolean;
  /** Available synchronously after admission until choose settles. Null does not prove no effect. */
  getDecisionBoundary?(): DecisionBoundary | null;
}
