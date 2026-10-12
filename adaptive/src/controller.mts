import {createHash} from 'node:crypto';
import {CONTRACT_VERSION} from '../contract/c0.mts';
import type {Request, Task, Candidate, TaskRequest, Observation, Adoption, Event, EventKind,
  Result, RunStatus, ExecutionPort, DecisionPort, Selection, JSONValue, SourceView} from '../contract/c0.mts';
import {CHECKPOINT_VERSION, CONTROLLER_VERSION} from '../contract/checkpoint-v1.mts';
import type {Checkpoint, CheckpointState, CheckpointExecutionPort, DecisionEffect, PendingEffect,
  EffectSettlement, Recovery, DecisionBoundary} from '../contract/checkpoint-v1.mts';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const MODES = ['scripted', 'injected', 'recorded_replay', 'live', 'unverified'];
const STATUSES = ['completed', 'cancelled', 'unsupported', 'unauthorized', 'timeout',
  'rate_limited', 'invalid', 'error'];
export class ContractError extends Error { constructor() {super('invalid C0 contract');} }
function check(value: unknown): asserts value {if (!value) throw new ContractError();}
function obj(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function exact(value: Record<string, any>, fields: readonly string[]) {
  check(Object.keys(value).every(k => fields.includes(k)));
}
function id(value: unknown): value is string {return typeof value === 'string' && ID.test(value);}
function text(value: unknown): value is string {return typeof value === 'string' && value.length > 0 && value.length <= 16000;}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(id) && new Set(value).size === value.length;
}
function integer(v: unknown, min = 0, max = 1000000): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max;
}
export function canonical(value: unknown, depth = 0): string {
  check(depth <= 40);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {check(Number.isFinite(value)); return JSON.stringify(value);}
  if (Array.isArray(value)) return '[' + Array.from(value, x => canonical(x, depth + 1)).join(',') + ']';
  check(obj(value));
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k], depth + 1)).join(',') + '}';
}
export function digest(value: unknown): string {return createHash('sha256').update(canonical(value)).digest('hex');}
function clone<T>(value: T): T {
  check(Buffer.byteLength(canonical(value)) <= 512 * 1024);
  return structuredClone(value);
}
function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object') {Object.values(value).forEach(frozen); Object.freeze(value);}
  return value;
}
function validateObservation(observation: Observation) {
  check(obj(observation)); exact(observation, ['contract_version', 'id', 'run_id', 'task_id', 'attempt_id',
    'input_revision', 'input_digest', 'status', 'value', 'evidence', 'mode', 'usage']);
  check(observation.contract_version === CONTRACT_VERSION && id(observation.id) && id(observation.run_id) &&
    id(observation.task_id) && id(observation.attempt_id) && text(observation.input_revision) &&
    /^[a-f0-9]{64}$/.test(observation.input_digest) && STATUSES.includes(observation.status) &&
    MODES.includes(observation.mode) && ids(observation.evidence));
  validateUsage(observation.usage); clone(observation);
}
function validateUsage(usage: {tokens: number | null; cost: number | null}) {
  check(obj(usage)); exact(usage, ['tokens', 'cost']);
  check(Object.hasOwn(usage, 'tokens') && Object.hasOwn(usage, 'cost'));
  for (const v of Object.values(usage)) check(v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0));
}
function pairs<V>(values: readonly (readonly [string, V])[]): Map<string, V> {
  check(Array.isArray(values)); const out = new Map<string, V>();
  for (const pair of values) {check(Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && !out.has(pair[0])); out.set(pair[0], pair[1]);}
  return out;
}
type Entry = {task: Task; state: 'planned' | 'running' | 'done' | 'cancel_requested'; request?: TaskRequest};
export const NATIVE_PARENT_CEILING_MS = 180000;
export const DECISION_CAP_MS = 60000;
/** Host-local context, never a Request/CLI/model grant. The host authenticates its origin. */
export type NativeAdmission = Readonly<{run_id: string; profile_id: string; timeout_ms: number;
  admitted_at_ms: number; deadline_ms: number}>;
export type HostChecks = Readonly<{
  /** Trusted host code validates actual capability inputs. No schema/permission from model text. */
  validateInput: (capability: string, input: JSONValue) => boolean;
  /** Recheck host grants/data-send policy over the actual view and explicit reads before admission. */
  authorize: (task: Task, sources: readonly SourceView[], reads: Readonly<Record<string, Observation>>) => boolean;
  isCurrent?: (request: TaskRequest) => boolean;
  now?: () => number;
  /** Optional durable-admission barrier before a decision port can have an external effect. */
  beforeDecision?: (checkpoint: Checkpoint) => Promise<void>;
  /** Optional original admission; absent preserves the legacy 1..60000 constructor. */
  nativeAdmission?: NativeAdmission;
  /** Independent host permission/readback, including the approved ceiling and original binding. */
  acceptNativeAdmission?: (admission: NativeAdmission, request: Request) => boolean;
}>;
export type RestoreChecks = HostChecks & Readonly<{
  /** Host verifies durable origin, readable data, current writer lease and rollback/replay protection. */
  acceptCheckpoint: (checkpoint: Checkpoint) => boolean;
  /** A host read/reconciliation witness, never model self-approval. */
  verifySettlement: (effect: PendingEffect, settlement: EffectSettlement) => boolean;
}>;

/** One in-memory run owner. External workers run at the host; no background scheduler. */
export class Controller implements CheckpointExecutionPort {
  private readonly request: Request;
  private readonly checks: HostChecks;
  private readonly now: () => number;
  private readonly nativeAdmissionActive: boolean;
  private lastClock: number;
  private clockFault = false;
  private deadline: number;
  private entries = new Map<string, Entry>();
  private accepted = new Map<string, Observation>();
  private seen = new Map<string, string>();
  private attemptResults = new Map<string, string>();
  private applied = new Map<string, string>();
  private plans: {version: number; tasks: readonly Task[]}[] = [];
  private events: Event[] = [];
  private observations: {observation: Observation; adoption: Adoption}[] = [];
  private version = 1;
  private status: RunStatus = 'needs_host';
  private reason: string[] = [];
  private answer: string | null = null;
  private provenance: string[] = [];
  private operations = 0;
  private decisions = 0;
  private byKind = {worker: 0, tool: 0, caller: 0, decision: 0};
  private usages: {tokens: number | null; cost: number | null}[] = [];
  private selecting = false;
  private pendingDecision: DecisionEffect | null = null;
  private decisionBoundary: DecisionBoundary | null = null;
  private settlements = new Map<string, EffectSettlement>();
  private restoreHistory: string[] = [];
  private restoredFrom: string | null = null;
  // Only effects imported at this restore boundary require recovery readback.
  // Normal effects admitted by this current owner become uncertain at the next restore.
  private recoveryEffectIds = new Set<string>();
  private restoreChecks: RestoreChecks | null = null;

  constructor(request: Request, tasks: readonly Task[], checks: HostChecks) {
    check(obj(request)); exact(request, ['contract_version', 'run_id', 'objective', 'input_revision',
      'requested_output', 'sources', 'capabilities', 'budget']);
    check(request.contract_version === CONTRACT_VERSION && id(request.run_id) && text(request.objective) &&
      text(request.input_revision) && text(request.requested_output));
    check(Array.isArray(request.capabilities) && request.capabilities.length <= 64);
    const capabilityIDs = new Set<string>();
    for (const c of request.capabilities) {
      check(obj(c)); exact(c, ['id', 'kind', 'authorized', 'parallel', 'cancellable']);
      check(id(c.id) && !capabilityIDs.has(c.id) && ['worker', 'tool', 'caller'].includes(c.kind) &&
        [c.authorized, c.parallel, c.cancellable].every(v => typeof v === 'boolean'));
      capabilityIDs.add(c.id);
    }
    check(Array.isArray(request.sources) && request.sources.length <= 64);
    const sources = new Set<string>();
    for (const s of request.sources) {
      check(obj(s)); exact(s, ['id', 'revision', 'text', 'origin', 'range', 'omitted']);
      check(id(s.id) && !sources.has(s.id) && text(s.revision) && typeof s.text === 'string' &&
        text(s.origin) && text(s.range) && typeof s.omitted === 'boolean'); sources.add(s.id);
    }
    const b = request.budget; check(obj(b));
    exact(b, ['max_operations', 'max_decisions', 'max_plan_versions', 'max_parallel', 'timeout_ms']);
    check(integer(b.max_operations) && integer(b.max_decisions) && integer(b.max_plan_versions, 1, 64) &&
      integer(b.max_parallel, 1, 16) && integer(b.timeout_ms, 1,
        checks.nativeAdmission === undefined ? 60000 : NATIVE_PARENT_CEILING_MS));
    this.request = frozen(clone(request)); this.checks = checks; this.now = checks.now ?? Date.now;
    this.nativeAdmissionActive = checks.nativeAdmission !== undefined;
    const now = this.now(); check(integer(now, 0, Number.MAX_SAFE_INTEGER)); this.lastClock = now;
    if (checks.nativeAdmission !== undefined) {
      const a = frozen(clone(checks.nativeAdmission)); check(obj(a));
      exact(a, ['run_id', 'profile_id', 'timeout_ms', 'admitted_at_ms', 'deadline_ms']);
      check(a.run_id === request.run_id && id(a.profile_id) && a.timeout_ms === b.timeout_ms &&
        integer(a.admitted_at_ms, 0, Number.MAX_SAFE_INTEGER) &&
        integer(a.deadline_ms, 0, Number.MAX_SAFE_INTEGER) &&
        Number.isSafeInteger(a.admitted_at_ms + a.timeout_ms) &&
        a.deadline_ms === a.admitted_at_ms + a.timeout_ms && now >= a.admitted_at_ms &&
        checks.acceptNativeAdmission?.(a, this.request) === true);
      // Copy the authenticated original deadline; construction never starts another window.
      this.deadline = a.deadline_ms;
    } else {
      this.deadline = now + b.timeout_ms; check(Number.isSafeInteger(this.deadline));
    }
    this.validateTasks(tasks);
    this.entries = new Map(tasks.map(t => [t.id, {task: frozen(clone(t)), state: 'planned'}]));
    this.savePlan(); this.emit('run_started', null, {deadline_ms: this.deadline});
    if (checks.nativeAdmission !== undefined && now >= this.deadline) this.stop('hold', 'deadline_exhausted');
  }

  private validateTasks(tasks: readonly Task[]) {
    check(Array.isArray(tasks) && tasks.length <= 64);
    const map = new Map<string, Task>();
    for (const t of tasks) {
      check(obj(t)); exact(t, ['id', 'purpose', 'capability', 'input_revision', 'input', 'sources', 'reads', 'after', 'output']);
      check(id(t.id) && t.id.length <= 126 && !map.has(t.id) && text(t.purpose) && text(t.input_revision) && text(t.output) &&
        ids(t.sources) && ids(t.reads) && ids(t.after));
      const c = this.request.capabilities.find(c => c.id === t.capability);
      check(c && c.authorized && this.checks.validateInput(c.id, t.input));
      check(t.sources.every(s => this.request.sources.some(v => v.id === s)));
      canonical(t.input); map.set(t.id, t as Task);
    }
    const visiting = new Set<string>(), done = new Set<string>();
    const visit = (key: string) => {
      check(!visiting.has(key)); if (done.has(key)) return;
      const t = map.get(key); check(t); visiting.add(key);
      for (const dep of new Set([...t.after, ...t.reads])) {check(dep !== key && map.has(dep)); visit(dep);}
      visiting.delete(key); done.add(key);
    };
    for (const key of map.keys()) visit(key);
  }
  private emit(kind: EventKind, task: string | null, data: JSONValue) {
    this.events.push(frozen({contract_version: CONTRACT_VERSION, run_id: this.request.run_id,
      seq: this.events.length + 1, plan_version: this.version, kind, task_id: task, data: clone(data)}));
  }
  private savePlan() {this.plans.push(frozen({version: this.version, tasks: [...this.entries.values()].map(x => x.task)}));}
  private stop(status: 'hold' | 'failed', reason: string) {
    if (this.status !== 'needs_host') return;
    this.status = status; this.reason.push(reason); this.emit('run_finished', null, {status, reason});
  }
  private clock(): number | null {
    if (this.clockFault) return null;
    const now = this.now();
    if (this.nativeAdmissionActive &&
        (!integer(now, 0, Number.MAX_SAFE_INTEGER) || now < this.lastClock)) {
      this.clockFault = true; this.stop('hold', 'clock_invalid'); return null;
    }
    this.lastClock = now; return now;
  }
  private remaining(deadline = this.deadline) {
    const now = this.clock(); return now === null ? 0 : Math.max(0, deadline - now);
  }
  private reserve(kind: keyof typeof this.byKind): boolean {
    if (!this.remaining()) {this.stop('hold', 'deadline_exhausted'); return false;}
    if (this.operations >= this.request.budget.max_operations) {this.stop('hold', 'budget_exhausted'); return false;}
    if (kind === 'decision' && this.decisions >= this.request.budget.max_decisions) {
      this.stop('hold', 'decision_budget_exhausted'); return false;
    }
    this.operations++; this.byKind[kind]++;
    if (kind === 'decision') this.decisions++;
    return true;
  }

  dispatch(): readonly TaskRequest[] {
    if (this.status !== 'needs_host' || this.selecting || this.pendingEffects().length) return [];
    if (!this.remaining()) {this.stop('hold', 'deadline_exhausted'); return [];}
    const requests: TaskRequest[] = [];
    for (const e of this.entries.values()) {
      if (e.state !== 'planned') continue;
      if ([...e.task.after, ...e.task.reads].some(dep => this.accepted.get(dep)?.status !== 'completed')) continue;
      const running = [...this.entries.values()].filter(x => x.state === 'running');
      if (running.length >= this.request.budget.max_parallel) break;
      const c = this.request.capabilities.find(c => c.id === e.task.capability)!;
      if (running.length && (!c.parallel || running.some(x =>
        !this.request.capabilities.find(c => c.id === x.task.capability)!.parallel))) continue;
      const reads = Object.fromEntries(e.task.reads.map(dep => [dep, this.accepted.get(dep)!]));
      const sources = this.request.sources.filter(s => e.task.sources.includes(s.id));
      if (!this.checks.authorize(e.task, sources, reads)) {this.stop('hold', 'unauthorized'); break;}
      const bound = {input: e.task.input, input_revision: e.task.input_revision, sources, reads};
      const req: TaskRequest = frozen({contract_version: CONTRACT_VERSION, run_id: this.request.run_id,
        task_id: e.task.id, attempt_id: e.task.id + ':1', plan_version: this.version,
        input_revision: e.task.input_revision, input_digest: digest(bound), purpose: e.task.purpose,
        capability: c.id, input: e.task.input, sources, reads, output: e.task.output, deadline_ms: this.deadline});
      if (this.checks.isCurrent && !this.checks.isCurrent(req)) {this.stop('hold', 'input_stale'); break;}
      if (!this.reserve(c.kind)) break;
      e.state = 'running'; e.request = req; requests.push(req);
      this.emit('task_requested', e.task.id, req as unknown as JSONValue);
    }
    return frozen(requests);
  }

  observe(observation: Observation): Adoption {
    // Malformed records are rejected before they can contaminate saveable C0 records.
    validateObservation(observation);
    const o = frozen(clone(observation)), hash = digest(o);
    const e = this.entries.get(o.task_id), req = e?.request;
    const previous = this.seen.get(o.id);
    const key = o.task_id + '/' + o.attempt_id;
    const priorAttempt = this.attemptResults.get(key);
    // Ignore the transport's observation ID when checking attempt-result identity.
    const {id: _id, ...payload} = o; const payloadHash = digest(payload);
    let adoption: Adoption;
    if (previous) adoption = previous === hash ? 'duplicate' : 'conflict';
    else if (!req || o.run_id !== req.run_id || o.attempt_id !== req.attempt_id) adoption = 'invalid';
    else if (o.input_revision !== req.input_revision || o.input_digest !== req.input_digest ||
      (this.checks.isCurrent && !this.checks.isCurrent(req))) adoption = 'stale';
    else if (priorAttempt) adoption = priorAttempt === payloadHash ? 'duplicate' : 'conflict';
    else if (this.settlements.has('task:' + key)) adoption = 'late';
    else if (e!.state === 'cancel_requested' || this.status === 'cancelled' || this.status === 'complete' ||
      this.status === 'failed' || !this.remaining()) adoption = 'late';
    else adoption = 'accepted';
    this.seen.set(o.id, previous ?? hash);
    this.observations.push(frozen({observation: o, adoption}));
    this.emit('observation_received', o.task_id, {observation_id: o.id, adoption, status: o.status, mode: o.mode});
    if (!this.remaining()) this.stop('hold', 'deadline_exhausted');
    if (req && o.status === 'cancelled' && e!.state === 'cancel_requested' && adoption === 'late') {
      this.emit('cancel_confirmed', o.task_id, {attempt_id: o.attempt_id});
    }
    // First matching physical completion counts usage once, even if stale/late; never count a foreign attempt.
    if (req && o.run_id === req.run_id && o.attempt_id === req.attempt_id && !priorAttempt &&
      o.input_digest === req.input_digest && o.input_revision === req.input_revision) {
      this.attemptResults.set(key, payloadHash);
      if (!this.settlements.has('task:' + key)) this.usages.push(o.usage);
    }
    if (adoption === 'accepted') {
      e!.state = 'done'; this.accepted.set(o.task_id, o);
      if (o.status !== 'completed') this.stop(['unsupported', 'unauthorized', 'cancelled'].includes(o.status) ? 'hold' : 'failed', o.status);
    } else if (adoption === 'stale' && req && o.attempt_id === req.attempt_id) {
      this.stop('hold', 'input_stale');
    }
    return adoption;
  }

  private patched(candidate: Candidate): Map<string, Entry> {
    check(obj(candidate)); exact(candidate, ['id', 'purpose', 'reason', 'evidence', 'patch']);
    check(id(candidate.id) && text(candidate.purpose) && text(candidate.reason) && ids(candidate.evidence));
    check(candidate.evidence.every(ref => [...this.accepted.values()].some(o => o.id === ref) || this.request.sources.some(s => s.id === ref)));
    check(obj(candidate.patch)); exact(candidate.patch, ['upsert', 'remove']);
    check(Array.isArray(candidate.patch.upsert) && ids(candidate.patch.remove));
    const changed = candidate.patch.upsert.map(t => t.id);
    check(new Set(changed).size === changed.length && !changed.some(id => candidate.patch.remove.includes(id)));
    const next = new Map(this.entries);
    for (const key of candidate.patch.remove) {const e = next.get(key); check(e && e.state === 'planned'); next.delete(key);}
    for (const t of candidate.patch.upsert) {
      const e = next.get(t.id); check(!e || e.state === 'planned');
      next.set(t.id, {task: frozen(clone(t)), state: 'planned'});
    }
    this.validateTasks([...next.values()].map(e => e.task));
    return next;
  }

  revise(candidate: Candidate, expected_version: number): boolean {
    const key = digest(candidate); const previous = this.applied.get(candidate.id);
    if (previous) {check(previous === key); return false;}
    check(this.status === 'needs_host' && !this.selecting && !this.pendingEffects().length && expected_version === this.version);
    const next = this.patched(candidate);
    if (this.version >= this.request.budget.max_plan_versions) {this.stop('hold', 'plan_budget_exhausted'); return false;}
    if (!this.remaining()) {this.stop('hold', 'deadline_exhausted'); return false;}
    this.entries = next; this.version++; this.applied.set(candidate.id, key); this.savePlan();
    this.emit('plan_changed', null, {candidate_id: candidate.id, reason: candidate.reason,
      evidence: [...candidate.evidence], added_or_changed: candidate.patch.upsert.map(t => t.id),
      removed: [...candidate.patch.remove]});
    return true;
  }

  getDecisionBoundary(): DecisionBoundary | null {
    return this.decisionBoundary === null ? null : Object.freeze({...this.decisionBoundary});
  }

  async choose(candidates: readonly Candidate[], decide: DecisionPort): Promise<Selection> {
    check(!this.selecting && !this.pendingEffects().length && this.status === 'needs_host' && Array.isArray(candidates) && candidates.length <= 16);
    this.decisionBoundary = null; // An illegal reentrant call must not erase the active admission.
    const cs = frozen(clone(candidates)); check(new Set(cs.map(c => c.id)).size === cs.length);
    cs.forEach(c => this.patched(c));
    const held = (status: 'hold' | 'failed'): Selection => ({candidate_id: null, status, mode: 'unverified', record: null});
    if (!cs.length) {this.stop('hold', 'candidate_missing'); return held('hold');}
    if (!this.reserve('decision')) return held('hold');
    this.selecting = true;
    const version = this.version, acceptedHash = digest([...this.accepted.values()]);
    this.pendingDecision = frozen({kind: 'decision', id: 'decision:' + this.decisions, plan_version: version,
      input_digest: digest({candidates: cs, acceptedHash}), candidates: cs.map(c => c.id)});
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let portSettled = false;
    let selection: Selection;
    let decisionDeadline = this.deadline;
    try {
      // One short cap includes the durable barrier and port; it is never restarted after an await.
      const admittedAt = this.clock();
      check(admittedAt !== null && integer(admittedAt, 0, Number.MAX_SAFE_INTEGER));
      // Avoid adding the cap near the safe-integer ceiling when the original D is earlier.
      decisionDeadline = this.deadline - admittedAt <= DECISION_CAP_MS ? this.deadline : admittedAt + DECISION_CAP_MS;
      this.decisionBoundary = Object.freeze({run_id: this.request.run_id, effect_id: this.pendingDecision.id,
        plan_version: version, input_digest: this.pendingDecision.input_digest,
        parent_deadline_ms: this.deadline, decision_deadline_ms: decisionDeadline, admitted_at_ms: admittedAt});
      const timeout = this.remaining(decisionDeadline);
      selection = await Promise.race([Promise.resolve().then(async () => {
        if (this.status !== 'needs_host' || !this.remaining(decisionDeadline)) return held('hold');
        if (this.checks.beforeDecision) await this.checks.beforeDecision(this.checkpoint());
        if (this.status !== 'needs_host' || !this.remaining(decisionDeadline)) return held('hold');
        return decide({request: this.request, plan_version: version, candidates: cs,
          observations: [...this.accepted.values()], timeout_ms: this.remaining(decisionDeadline)});
      }).finally(() => {portSettled = true;}),
        new Promise<Selection>(resolve => {timer = setTimeout(() => {expired = true; resolve(held('hold'));}, timeout);})]);
      check(obj(selection)); exact(selection, ['candidate_id', 'status', 'mode', 'record']);
      check(['selected', 'hold', 'failed'].includes(selection.status) && MODES.includes(selection.mode));
      clone(selection);
      if (selection.status === 'selected') check(id(selection.candidate_id) && cs.some(c => c.id === selection.candidate_id));
      else check(selection.candidate_id === null);
    } catch {selection = held('failed');}
    finally {if (timer) clearTimeout(timer); this.selecting = false; this.decisionBoundary = null;
      if (portSettled) this.pendingDecision = null;}
    this.emit('decision', null, {selection: selection as unknown as JSONValue,
      candidate_ids: cs.map(c => c.id), input_digest: digest({candidates: cs, acceptedHash}),
      template_version: 'next-task-preview-v1', ...(portSettled ? {} : {effect_pending: true, extension_version: CHECKPOINT_VERSION})});
    // The decision observation is retained, but cannot rewrite a cancelled or changed input snapshot.
    if (this.status !== 'needs_host') return held('hold');
    if (!this.remaining()) {this.stop('hold', 'deadline_exhausted'); return held('hold');}
    if (expired || !this.remaining(decisionDeadline)) {this.stop('hold', 'decision_timeout'); return held('hold');}
    if (version !== this.version || acceptedHash !== digest([...this.accepted.values()]) ||
      [...this.entries.values()].some(e => e.request && this.checks.isCurrent && !this.checks.isCurrent(e.request))) {
      this.stop('hold', 'decision_stale'); return held('hold');
    }
    if (selection.status !== 'selected') this.stop(selection.status, 'decision_' + selection.status);
    else this.revise(cs.find(c => c.id === selection.candidate_id)!, version);
    return frozen(clone(selection));
  }

  cancel(reason: string) {
    check(text(reason)); if (this.status === 'cancelled' || this.status === 'complete') return;
    this.status = 'cancelled'; this.reason = [reason];
    for (const e of this.entries.values()) if (e.state === 'running') {
      e.state = 'cancel_requested';
      const c = this.request.capabilities.find(c => c.id === e.task.capability)!;
      this.emit('cancel_requested', e.task.id, {attempt_id: e.request!.attempt_id, supported: c.cancellable, reason});
    }
    this.emit('run_finished', null, {status: 'cancelled', reason});
  }
  finish(answer: string, provenance: readonly string[], unresolved: readonly string[] = []): Result {
    check(this.status === 'needs_host' && !this.selecting && !this.pendingEffects().length && text(answer) && ids(provenance));
    if (!this.remaining()) {this.stop('hold', 'deadline_exhausted'); return this.result();}
    check([...this.entries.values()].every(e => e.state === 'done') &&
      provenance.every(ref => [...this.accepted.values()].some(o => o.id === ref && o.status === 'completed')));
    check(Array.isArray(unresolved) && unresolved.every(text));
    this.answer = answer; this.provenance = [...provenance]; this.reason = [...unresolved]; this.status = 'complete';
    this.emit('run_finished', null, {status: 'complete', provenance: [...provenance], unresolved: [...unresolved]});
    return this.result();
  }
  result(): Result {
    const measured = (kind: 'tokens' | 'cost') => {
      // Missing responses or decision measurements are unknown, even in a zero-price fixture.
      if (this.operations !== this.usages.length || this.usages.some(u => u[kind] === null)) return null;
      return this.usages.reduce((sum, u) => sum + u[kind]!, 0);
    };
    const blocked = this.pendingEffects().length > 0;
    return frozen({contract_version: CONTRACT_VERSION, run_id: this.request.run_id,
      status: blocked && this.status === 'needs_host' ? 'hold' : this.status,
      answer: this.answer, unresolved: [...this.reason, ...(blocked ? ['reconciliation_required'] : [])], provenance: [...this.provenance],
      pending: [...this.entries.values()].filter(e => e.state !== 'done').map(e => e.task.id),
      usage: {operations_started: this.operations, decisions_started: this.decisions,
        by_kind: {...this.byKind}, tokens: measured('tokens'), cost: measured('cost')},
      authority: 'advisory_only', automatic_apply: false});
  }
  records() {return frozen(clone({request: this.request, plans: this.plans, events: this.events,
    observations: this.observations, result: this.result()}));}

  private unresolvedEffects(): PendingEffect[] {
    const effects: PendingEffect[] = [];
    for (const e of this.entries.values()) if (e.request && ['running', 'cancel_requested'].includes(e.state)) {
      const key = e.task.id + '/' + e.request.attempt_id;
      if (!this.attemptResults.has(key) && !this.settlements.has('task:' + key)) effects.push(frozen({
        kind: 'task', id: 'task:' + key, request: e.request, cancel_requested: e.state === 'cancel_requested'}));
    }
    if (this.pendingDecision && !this.settlements.has(this.pendingDecision.id)) effects.push(this.pendingDecision);
    return effects;
  }
  private pendingEffects(): PendingEffect[] {
    return this.unresolvedEffects().filter(effect => this.recoveryEffectIds.has(effect.id));
  }
  recovery(): Recovery {return frozen({checkpoint_version: CHECKPOINT_VERSION,
    restored_from: this.restoredFrom, pending: this.pendingEffects()});}
  checkpoint(): Checkpoint {
    const state: CheckpointState = {request: this.request, deadline_ms: this.deadline, plan_version: this.version,
      entries: [...this.entries.values()].map(e => ({task: e.task, state: e.state, request: e.request ?? null})),
      accepted: [...this.accepted], seen: [...this.seen], attempt_results: [...this.attemptResults], applied: [...this.applied],
      plans: this.plans, events: this.events, observations: this.observations, status: this.status,
      reason: this.reason, answer: this.answer, provenance: this.provenance, operations: this.operations,
      decisions: this.decisions, by_kind: this.byKind, usages: this.usages, pending_decision: this.pendingDecision,
      settlements: [...this.settlements], restore_history: this.restoreHistory};
    const captured = this.clock(); check(captured !== null);
    const payload = {checkpoint_version: CHECKPOINT_VERSION, contract_version: CONTRACT_VERSION,
      controller_version: CONTROLLER_VERSION, captured_at_ms: captured, state};
    return frozen(clone({...payload, digest: digest(payload)}));
  }

  settle(settlement: EffectSettlement): boolean {
    check(this.restoreChecks && obj(settlement));
    exact(settlement, ['effect_id', 'outcome', 'evidence_ref', 'usage']);
    check(text(settlement.effect_id) && text(settlement.evidence_ref) &&
      ['unknown', 'still_running', 'not_started', 'cancelled', 'completed_without_result'].includes(settlement.outcome));
    validateUsage(settlement.usage);
    const s = frozen(clone(settlement)), previous = this.settlements.get(s.effect_id);
    if (previous) {check(digest(previous) === digest(s)); return false;}
    const effect = this.pendingEffects().find(e => e.id === s.effect_id);
    check(effect && this.restoreChecks.verifySettlement(effect, s));
    if (s.outcome === 'unknown' || s.outcome === 'still_running') return false;
    this.settlements.set(s.effect_id, s); this.usages.push(s.usage);
    if (effect.kind === 'task') {
      const e = this.entries.get(effect.request.task_id)!; e.state = 'done';
      if (s.outcome === 'cancelled' && effect.cancel_requested) this.emit('cancel_confirmed', e.task.id,
        {attempt_id: effect.request.attempt_id, evidence_ref: s.evidence_ref, extension_version: CHECKPOINT_VERSION});
      this.stop('hold', 'effect_result_unavailable');
    } else {
      this.pendingDecision = null;
      this.emit('decision', null, {extension_version: CHECKPOINT_VERSION, effect_id: effect.id,
        host_settlement: s as unknown as JSONValue, selection: null, result_available: false});
      this.stop('hold', 'decision_result_unavailable');
    }
    return true;
  }

  static restore(checkpoint: Checkpoint, checks: RestoreChecks): Controller {
    check(obj(checkpoint)); exact(checkpoint, ['checkpoint_version', 'contract_version', 'controller_version',
      'captured_at_ms', 'state', 'digest']);
    check(checkpoint.checkpoint_version === CHECKPOINT_VERSION && checkpoint.contract_version === CONTRACT_VERSION &&
      [CONTROLLER_VERSION, 'jev-adaptive/0.2.0-preview', 'jev-adaptive/0.2.1-preview'].includes(checkpoint.controller_version) &&
      integer(checkpoint.captured_at_ms, 0, Number.MAX_SAFE_INTEGER));
    const cp = frozen(clone(checkpoint)), {digest: expected, ...payload} = cp;
    check(typeof expected === 'string' && expected === digest(payload) && checks.acceptCheckpoint(cp));
    const s = cp.state; check(obj(s));
    exact(s, ['request', 'deadline_ms', 'plan_version', 'entries', 'accepted', 'seen', 'attempt_results', 'applied',
      'plans', 'events', 'observations', 'status', 'reason', 'answer', 'provenance', 'operations', 'decisions',
      'by_kind', 'usages', 'pending_decision', 'settlements', 'restore_history']);
    check(integer(s.deadline_ms, 0, Number.MAX_SAFE_INTEGER) && integer(s.plan_version, 1, 64) && Array.isArray(s.entries));
    // Old-version payloads never inherit the new native ceiling, even after a valid rehash.
    if (cp.controller_version !== CONTROLLER_VERSION) check(integer(s.request?.budget?.timeout_ms, 1, 60000));
    if (checks.nativeAdmission !== undefined) check(checks.nativeAdmission.deadline_ms === s.deadline_ms);
    const c = new Controller(s.request, s.entries.map(e => e.task), checks);
    check(cp.captured_at_ms >= s.deadline_ms - s.request.budget.timeout_ms && c.now() >= cp.captured_at_ms);
    check(s.plan_version <= s.request.budget.max_plan_versions && Array.isArray(s.plans) && s.plans.length === s.plan_version);
    for (let i = 0; i < s.plans.length; i++) {check(s.plans[i].version === i + 1); c.validateTasks(s.plans[i].tasks);}
    check(digest(s.plans.at(-1)!.tasks) === digest(s.entries.map(e => e.task)));
    check(['needs_host', 'complete', 'hold', 'cancelled', 'failed'].includes(s.status) &&
      Array.isArray(s.reason) && s.reason.every(text) && (s.answer === null || text(s.answer)) && ids(s.provenance));
    const accepted = pairs(s.accepted), seen = pairs(s.seen), attempts = pairs(s.attempt_results), applied = pairs(s.applied);
    const settlements = pairs(s.settlements);
    for (const [key, hash] of [...seen, ...applied]) check(id(key) && /^[a-f0-9]{64}$/.test(hash));
    for (const [key, hash] of attempts) check(text(key) && /^[a-f0-9]{64}$/.test(hash));
    check(Array.isArray(s.observations));
    const observedIDs = new Map<string, string>();
    for (const row of s.observations) {
      check(obj(row)); exact(row, ['observation', 'adoption']); validateObservation(row.observation);
      check(['accepted', 'duplicate', 'conflict', 'late', 'stale', 'invalid'].includes(row.adoption));
      if (!observedIDs.has(row.observation.id)) observedIDs.set(row.observation.id, digest(row.observation));
    }
    check(digest([...observedIDs]) === digest([...seen]));
    for (const [key, o] of accepted) {
      validateObservation(o); check(key === o.task_id && s.observations.some(row => row.adoption === 'accepted' && digest(row.observation) === digest(o)));
    }
    const entries = new Map<string, Entry>();
    for (const e of s.entries) {
      check(obj(e)); exact(e, ['task', 'state', 'request']);
      check(['planned', 'running', 'done', 'cancel_requested'].includes(e.state) && !entries.has(e.task.id));
      if (e.state === 'planned') check(e.request === null && !accepted.has(e.task.id));
      else {
        const r = e.request; check(r && integer(r.plan_version, 1, s.plan_version));
        const taskAtStart = s.plans[r.plan_version - 1].tasks.find((t: Task) => t.id === e.task.id);
        check(taskAtStart && digest(taskAtStart) === digest(e.task));
        const reads = Object.fromEntries(e.task.reads.map((key: string) => {const o = accepted.get(key); check(o && o.status === 'completed'); return [key, o];}));
        const sources = s.request.sources.filter(v => e.task.sources.includes(v.id));
        const bound = {input: e.task.input, input_revision: e.task.input_revision, sources, reads};
        const frame: TaskRequest = {contract_version: CONTRACT_VERSION, run_id: s.request.run_id, task_id: e.task.id,
          attempt_id: e.task.id + ':1', plan_version: r.plan_version, input_revision: e.task.input_revision,
          input_digest: digest(bound), purpose: e.task.purpose, capability: e.task.capability,
          input: e.task.input, sources, reads, output: e.task.output, deadline_ms: s.deadline_ms};
        check(digest(r) === digest(frame));
        if (e.state === 'done') check(accepted.has(e.task.id) || settlements.has('task:' + e.task.id + '/' + r.attempt_id));
      }
      entries.set(e.task.id, {task: e.task, state: e.state, ...(e.request ? {request: e.request} : {})});
    }
    for (const [key, o] of accepted) {
      const e = entries.get(key); check(e?.request && e.state === 'done' && o.run_id === e.request.run_id &&
        o.attempt_id === e.request.attempt_id && o.input_digest === e.request.input_digest && o.input_revision === e.request.input_revision);
    }
    for (const [key, hash] of attempts) check(s.observations.some(({observation: o}) => {
      const r = entries.get(o.task_id)?.request; const {id: _id, ...body} = o;
      return r && key === o.task_id + '/' + o.attempt_id && o.run_id === r.run_id &&
        o.attempt_id === r.attempt_id && o.input_digest === r.input_digest && o.input_revision === r.input_revision && digest(body) === hash;
    }));
    check(Array.isArray(s.events) && s.events.length > 0);
    const started = new Map<string, TaskRequest>(), kinds = {worker: 0, tool: 0, caller: 0, decision: 0};
    let completedDecisions = 0;
    for (let i = 0; i < s.events.length; i++) {
      const event = s.events[i]; check(obj(event)); exact(event, ['contract_version', 'run_id', 'seq', 'plan_version', 'kind', 'task_id', 'data']);
      check(event.contract_version === CONTRACT_VERSION && event.run_id === s.request.run_id && event.seq === i + 1 &&
        integer(event.plan_version, 1, s.plan_version) && ['run_started', 'plan_changed', 'task_requested', 'observation_received',
          'cancel_requested', 'cancel_confirmed', 'decision', 'run_finished'].includes(event.kind));
      if (event.kind === 'task_requested') {
        const r = entries.get(event.task_id!)?.request; check(r && !started.has(r.task_id) && digest(r) === digest(event.data));
        started.set(r.task_id, r); kinds[s.request.capabilities.find(v => v.id === r.capability)!.kind]++;
      }
      if (event.kind === 'decision' && (!obj(event.data) || event.data.effect_pending !== true)) completedDecisions++;
    }
    const first = s.events[0]; check(first.kind === 'run_started' && obj(first.data) && first.data.deadline_ms === s.deadline_ms);
    check(started.size === s.entries.filter(e => e.request).length);
    if (s.pending_decision !== null) {
      const d = s.pending_decision; check(obj(d)); exact(d, ['kind', 'id', 'plan_version', 'input_digest', 'candidates']);
      check(d.kind === 'decision' && d.id === 'decision:' + s.decisions && d.plan_version === s.plan_version &&
        /^[a-f0-9]{64}$/.test(d.input_digest) && ids(d.candidates));
    }
    const decisions = completedDecisions + (s.pending_decision ? 1 : 0);
    kinds.decision = decisions;
    check(integer(s.operations) && integer(s.decisions) && s.decisions === decisions &&
      s.operations === started.size + decisions && s.operations <= s.request.budget.max_operations &&
      decisions <= s.request.budget.max_decisions && digest(s.by_kind) === digest(kinds));
    check(applied.size === s.plan_version - 1 && Array.isArray(s.usages) && s.usages.length <= s.operations);
    s.usages.forEach(validateUsage);
    for (const [key, value] of settlements) {
      check(obj(value)); exact(value, ['effect_id', 'outcome', 'evidence_ref', 'usage']);
      check(key === value.effect_id && text(value.evidence_ref) && ['not_started', 'cancelled', 'completed_without_result'].includes(value.outcome));
      validateUsage(value.usage);
      check(key.startsWith('decision:') || s.entries.some(e => e.request && key === 'task:' + e.task.id + '/' + e.request.attempt_id));
    }
    check(Array.isArray(s.restore_history) && s.restore_history.every(hash => /^[a-f0-9]{64}$/.test(hash)));
    c.deadline = s.deadline_ms; c.version = s.plan_version; c.entries = entries; c.accepted = accepted;
    c.seen = seen; c.attemptResults = attempts; c.applied = applied; c.plans = [...s.plans]; c.events = [...s.events];
    c.observations = [...s.observations]; c.status = s.status; c.reason = [...s.reason]; c.answer = s.answer;
    c.provenance = [...s.provenance]; c.operations = s.operations; c.decisions = s.decisions;
    c.byKind = {...s.by_kind}; c.usages = [...s.usages]; c.pendingDecision = s.pending_decision; c.settlements = settlements;
    c.restoreHistory = [...s.restore_history, cp.digest]; c.restoredFrom = cp.digest; c.restoreChecks = checks;
    c.recoveryEffectIds = new Set(c.unresolvedEffects().map(effect => effect.id));
    if (s.status === 'complete') check(s.answer !== null && s.entries.every(e => e.state === 'done') &&
      s.provenance.every(ref => [...accepted.values()].some(o => o.id === ref && o.status === 'completed')));
    if (!c.remaining()) c.stop('hold', 'deadline_exhausted');
    if ([...entries.values()].some(e => e.request && checks.isCurrent && !checks.isCurrent(e.request))) {
      if (c.status === 'complete') c.status = 'needs_host'; c.stop('hold', 'input_stale');
    }
    return c;
  }
}
