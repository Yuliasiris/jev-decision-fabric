/** Ordinary-caller adapter over the immutable C0 Controller, not another controller or grant issuer. */
import {createHash} from 'node:crypto';
import {Controller, digest, canonical} from '../src/controller.mts';
import type {HostChecks, RestoreChecks, NativeAdmission} from '../src/controller.mts';
import {CONTRACT_VERSION} from '../contract/c0.mts';
import type {Request, Capability, Task, Candidate, Observation, TaskRequest, DecisionPort,
  Selection, EvidenceMode, JSONValue, Result} from '../contract/c0.mts';
import type {Checkpoint, DecisionBoundary, EffectSettlement} from '../contract/checkpoint-v1.mts';
import {inspectFinal} from './final.mts';
export type * from '../contract/c0.mts';
export type * from '../contract/checkpoint-v1.mts';
export type {HostChecks, RestoreChecks, NativeAdmission} from '../src/controller.mts';
export const SDK_VERSION = 'jev-work-sdk/0.1.0-preview' as const;
export type Registration = Readonly<{capability: Capability; description: string; input_description: string}>;
export type PortReceipt = Readonly<{mode: EvidenceMode; origin: JSONValue;
  usage: Observation['usage']; latency_ms: number | null}>;
export type NextAction = Readonly<{kind: 'dispatch'} | {kind: 'choose'; candidates: readonly Candidate[]} |
  {kind: 'pause'; reason: string}>;
export type InitialProposal = PortReceipt & Readonly<{tasks: readonly Task[]}>;
export type NextProposal = PortReceipt & Readonly<{action: NextAction}>;
export type PlannerPending = Readonly<{id: string; stage: 'initial' | 'next'; input_digest: string}>;
export type PortContext = Readonly<{signal: AbortSignal; deadline_ms: number}>;
export type PlannerContext = PortContext & Readonly<{request: Request; catalog: readonly Registration[];
  checkpoint: Checkpoint; observations: readonly Observation[]; invocation: PlannerPending}>;
export type PlannerPort = Readonly<{initial: (context: PlannerContext) => Promise<InitialProposal>;
  next: (context: PlannerContext) => Promise<NextProposal>}>;
export type FinalReply = PortReceipt & Readonly<{raw: Uint8Array; new_native_call: boolean}>;
export type PlannerRecord = PortReceipt & Readonly<{id: string; input_digest: string; outcome_digest: string}>;
export type WorkSnapshot = Readonly<{sdk_version: typeof SDK_VERSION; digest: string;
  checkpoint: Checkpoint; admission: NativeAdmission; catalog_digest: string; final_capability: string;
  planner_calls_started: number; planner_max_calls: number; planner_receipts: readonly PlannerRecord[];
  pending_planner: PlannerPending | null; initialized: boolean; last_planned_observations: string;
  paused_reason: string | null; uncertain: boolean; queued_action: NextAction | null; final_receipt: JSONValue}>;
export type ReconcileInput = {observation: Observation} | {settlement: EffectSettlement} | {planner: InitialProposal | NextProposal} | {final: FinalReply};
export type WorkHost = Readonly<{
  checks: Omit<HostChecks, 'beforeDecision' | 'nativeAdmission'> & Required<Pick<HostChecks, 'isCurrent' | 'acceptNativeAdmission'>>;
  finalCapability: string; signal: AbortSignal;
  /** Actual current parent/writer and grants. Never accept a model field as authority. */
  authorizeEntry: () => boolean | Promise<boolean>;
  /** Fulfillment must mean durable acknowledgement; readback verifies the exact saved wrapper. */
  save: (snapshot: WorkSnapshot, reason: string) => Promise<void>;
  readback: (snapshot: WorkSnapshot) => Promise<boolean>;
  /** Latest durable wrapper, exclusive writer, parent limits and replay protection for restore. */
  acceptSnapshot: (snapshot: WorkSnapshot) => boolean | Promise<boolean>;
  /** Read/consume existing records only; may retain actual late usage without reopening expired admission. */
  authorizeReconcile: (input: ReconcileInput, snapshot: WorkSnapshot) => boolean | Promise<boolean>;
  verifyObservationOrigin: (observation: Observation, frame: TaskRequest) => boolean | Promise<boolean>;
  /** Exact caller input/source/recipient/purpose and existing physical allowance, before and after save. */
  authorizePlanner: (context: PlannerContext) => boolean | Promise<boolean>;
  verifyPlannerOrigin: (outcome: InitialProposal | NextProposal, pending: PlannerPending) => boolean | Promise<boolean>;
  archiveObservation: (record: {frame: TaskRequest; observation: Observation; observation_sha256: string}) => Promise<void>;
  worker: (frame: TaskRequest, context: PortContext) => Promise<Observation>;
  decision: (input: Parameters<DecisionPort>[0], context: PortContext & {boundary: DecisionBoundary}) => Promise<Selection>;
  final: (frame: TaskRequest, context: PortContext & {observations: readonly Observation[]}) => Promise<FinalReply>;
  verifyFinalOrigin: (reply: FinalReply, frame: TaskRequest) => boolean | Promise<boolean>;
  /** Preserve verbatim bytes even when origin/frame/provenance validation fails. */
  archiveFinal: (record: {raw: Uint8Array; frame: TaskRequest; origin: JSONValue; raw_sha256: string}) => Promise<void>;
  /** Actual host projection of evidence text; structured numeric workers may return no quotation text. */
  evidenceText: (observation: Observation) => readonly string[];
}>;
export type CreateWorkOptions = Readonly<{requestText: string;
  frame: Omit<Request, 'contract_version' | 'objective' | 'capabilities'>;
  catalog: readonly Registration[]; admission: NativeAdmission; planner: PlannerPort; host: WorkHost;
  maxPlannerCalls: number}>;
export type RestoreWorkOptions = Readonly<{catalog: readonly Registration[]; admission: NativeAdmission;
  planner: PlannerPort; host: WorkHost; restoreChecks: RestoreChecks}>;
function require(ok: unknown, reason: string): asserts ok {if (!ok) throw Error('sdk:' + reason);}
const fresh = <T,>(value: T): T => structuredClone(value);
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {Object.values(value).forEach(immutable); Object.freeze(value);} return value;
}
function portReceipt(v: PortReceipt) {
  require(['scripted','injected','recorded_replay','live','unverified'].includes(v.mode) && v.origin !== null, 'origin_receipt');
  require(v.usage && Object.keys(v.usage).length === 2 && ['tokens','cost'].every(k => Object.hasOwn(v.usage,k)), 'usage');
  for (const n of [...Object.values(v.usage),v.latency_ms]) require(n === null || typeof n === 'number' && Number.isFinite(n) && n >= 0, 'measurement');
  canonical(v.origin);
}
function validateHost(host: WorkHost, catalog: readonly Registration[]) {
  for (const name of ['authorizeEntry','save','readback','acceptSnapshot','authorizeReconcile','verifyObservationOrigin','authorizePlanner','verifyPlannerOrigin','archiveObservation','worker','decision',
    'final','verifyFinalOrigin','archiveFinal','evidenceText']) require(typeof (host as any)[name] === 'function', 'host_' + name);
  for (const name of ['authorize','validateInput','isCurrent','acceptNativeAdmission']) require(typeof (host.checks as any)[name] === 'function', 'checks_' + name);
  require(catalog.length > 0 && catalog.every(c => c.description?.trim() && c.input_description?.trim()), 'catalog');
  require(host.signal instanceof AbortSignal, 'parent_signal');
  const final = catalog.find(c => c.capability.id === host.finalCapability)?.capability;
  require(final?.kind === 'caller' && final.authorized, 'final_capability');
}
async function bounded<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw Error('sdk:parent_ended');
  let abort!: () => void;
  const ended = new Promise<never>((_, reject) => {abort = () => reject(Error('sdk:parent_ended'));
    signal.addEventListener('abort', abort, {once: true});});
  try {return await Promise.race([Promise.resolve().then(() => {if (signal.aborted) throw Error('sdk:parent_ended'); return action();}), ended]);}
  finally {signal.removeEventListener('abort', abort);}
}
export class WorkRun {
  private controller!: Controller;
  private host: WorkHost;
  private planner: PlannerPort;
  private catalog: readonly Registration[];
  private admission: NativeAdmission;
  private started = 0;
  private limit: number;
  private receipts: PlannerRecord[] = [];
  private pending: PlannerPending | null = null;
  private initialized = false;
  private lastPlanned = '';
  private paused: string | null = null;
  private uncertain = false;
  private finalReceipt: JSONValue = null;
  private queued: NextAction | null = null;
  private busy = false;
  private storageFailed = false;
  constructor(options: CreateWorkOptions) {
    validateHost(options.host, options.catalog);
    require(typeof options.requestText === 'string' && options.requestText.trim().length > 0, 'request_text');
    require(options.frame.budget.max_plan_versions >= 2, 'initial_plan_version_budget');
    this.host = options.host; this.planner = options.planner; this.catalog = immutable(fresh(options.catalog));
    this.admission = immutable(fresh(options.admission));
    this.limit = options.maxPlannerCalls; // A finite count is not a provider/allocation grant.
    require(Number.isSafeInteger(this.limit) && this.limit >= 1 && this.limit <= 64, 'planner_budget');
    const request: Request = {...fresh(options.frame), contract_version: CONTRACT_VERSION,
      objective: options.requestText, capabilities: this.catalog.map(c => c.capability)};
    this.controller = new Controller(request, [], this.checks());
    this.lastPlanned = this.acceptedDigest();
  }
  private checks(): HostChecks {
    return {...this.host.checks, nativeAdmission: this.admission,
      authorize: (task, sources, reads) => this.host.checks.authorize(task, sources, reads) && this.parentRemaining() > 0,
      beforeDecision: async () => {await this.persist('decision_reserved'); await this.authorize();}};
  }
  static async restore(snapshot: WorkSnapshot, options: RestoreWorkOptions) {
    snapshot = immutable(fresh(snapshot));
    options = {...options, catalog: immutable(fresh(options.catalog)), admission: immutable(fresh(options.admission)),
      restoreChecks: {...options.restoreChecks}};
    validateHost(options.host, options.catalog);
    const body = fresh(snapshot) as any; delete body.digest;
    require(snapshot.sdk_version === SDK_VERSION && digest(body) === snapshot.digest &&
      snapshot.catalog_digest === digest(options.catalog) && digest(snapshot.admission) === digest(options.admission) &&
      snapshot.final_capability === options.host.finalCapability, 'snapshot_binding');
    require(Number.isSafeInteger(snapshot.planner_max_calls) && snapshot.planner_max_calls >= 1 && snapshot.planner_max_calls <= 64 &&
      Number.isSafeInteger(snapshot.planner_calls_started) && snapshot.planner_calls_started >= 0 &&
      snapshot.planner_calls_started <= snapshot.planner_max_calls &&
      snapshot.planner_calls_started + snapshot.checkpoint.state.operations <= snapshot.checkpoint.state.request.budget.max_operations, 'planner_budget');
    require(await options.host.acceptSnapshot(snapshot) === true && await options.host.authorizeEntry() === true, 'restore_authority');
    // Avoid another constructor/admission: restore the original controller exactly once.
    const run = Object.create(WorkRun.prototype) as WorkRun;
    run.host = options.host; run.planner = options.planner; run.catalog = immutable(fresh(options.catalog));
    run.admission = immutable(fresh(options.admission)); run.limit = snapshot.planner_max_calls;
    run.started = snapshot.planner_calls_started; run.receipts = fresh([...snapshot.planner_receipts]);
    run.pending = fresh(snapshot.pending_planner); run.initialized = snapshot.initialized;
    run.lastPlanned = snapshot.last_planned_observations; run.paused = snapshot.paused_reason;
    run.uncertain = snapshot.uncertain; run.queued = fresh(snapshot.queued_action); run.finalReceipt = fresh(snapshot.final_receipt);
    run.busy = false; run.storageFailed = false;
    run.controller = Controller.restore(snapshot.checkpoint, {...options.restoreChecks,
      ...run.checks(), acceptCheckpoint: options.restoreChecks.acceptCheckpoint,
      verifySettlement: options.restoreChecks.verifySettlement});
    await run.persist('restored');
    return run;
  }
  private parentRemaining() {
    if (!this.controller) return Number.MAX_SAFE_INTEGER;
    return this.controller.records().request.budget.max_operations - this.started - this.controller.result().usage.operations_started;
  }
  private unresolvedEffects() {
    const state = this.controller.checkpoint().state, attempts = new Map(state.attempt_results), settlements = new Map(state.settlements);
    const tasks = state.entries.filter(e => e.request && ['running','cancel_requested'].includes(e.state) &&
      !attempts.has(e.task.id + '/' + e.request.attempt_id) && !settlements.has('task:' + e.task.id + '/' + e.request.attempt_id));
    return tasks.length + (state.pending_decision && !settlements.has(state.pending_decision.id) ? 1 : 0);
  }
  private accepted() {return this.controller.records().observations.filter(x => x.adoption === 'accepted').map(x => x.observation);}
  private acceptedDigest() {return digest(this.accepted());}
  snapshot(): WorkSnapshot {
    const body = {sdk_version: SDK_VERSION, checkpoint: this.controller.checkpoint(), admission: this.admission,
      catalog_digest: digest(this.catalog), final_capability: this.host.finalCapability,
      planner_calls_started: this.started, planner_max_calls: this.limit, planner_receipts: fresh(this.receipts),
      pending_planner: this.pending, initialized: this.initialized, last_planned_observations: this.lastPlanned,
      paused_reason: this.paused, uncertain: this.uncertain, queued_action: this.queued, final_receipt: this.finalReceipt};
    return immutable(fresh({...body, digest: digest(body)}));
  }
  private async persist(reason: string) {
    require(!this.storageFailed, 'storage_failed');
    const snapshot = this.snapshot();
    try {await this.host.save(snapshot, reason); require(await this.host.readback(snapshot) === true, 'save_readback');}
    catch (error) {this.storageFailed = true; throw error;}
  }
  private context(signal?: AbortSignal): PortContext {
    const remaining = this.admission.deadline_ms - (this.host.checks.now?.() ?? Date.now());
    const timeout = AbortSignal.timeout(Math.max(0, Math.min(180000, remaining)));
    return {signal: AbortSignal.any([this.host.signal, timeout, ...(signal ? [signal] : [])]), deadline_ms: this.admission.deadline_ms};
  }
  private async authorize() {
    require(!this.storageFailed && !this.host.signal.aborted &&
      (this.host.checks.now?.() ?? Date.now()) < this.admission.deadline_ms, 'parent_ended');
    require(await this.host.authorizeEntry() === true, 'entry_authority');
    require(!this.host.signal.aborted && (this.host.checks.now?.() ?? Date.now()) < this.admission.deadline_ms, 'parent_ended');
  }
  private async current(frame: TaskRequest, signal?: AbortSignal) {
    require(!signal?.aborted, 'parent_ended'); await this.authorize();
    require(!signal?.aborted, 'parent_ended');
    const state = this.controller.checkpoint().state, task = state.entries.find(e => e.task.id === frame.task_id)!.task;
    require(this.host.checks.isCurrent(frame) && this.host.checks.authorize(task, frame.sources, frame.reads), 'current_authority');
  }
  private async serial<T>(action: () => Promise<T>) {
    require(!this.busy, 'busy'); this.busy = true;
    try {return await action();} finally {this.busy = false;}
  }
  private async applyPlanner(outcome: InitialProposal | NextProposal) {
    outcome = immutable(fresh(outcome));
    const pending = immutable(fresh(this.pending!)); portReceipt(outcome);
    require(await this.host.verifyPlannerOrigin(outcome, pending) === true, 'planner_origin');
    await this.authorize();
    require((this.host.checks.now?.() ?? Date.now()) < this.admission.deadline_ms && this.controller.result().status === 'needs_host', 'planner_parent');
    if (pending.stage === 'initial') {
      const initial = outcome as InitialProposal;
      require(Array.isArray(initial.tasks) && initial.tasks.length > 0 &&
        initial.tasks.filter(t => t.capability === this.host.finalCapability).length === 1, 'initial_tasks');
      const applied = this.controller.revise({id: pending.id, purpose: 'Plan the ordinary request', reason: 'Host caller proposal',
        evidence: [], patch: {upsert: initial.tasks, remove: []}}, this.controller.checkpoint().state.plan_version);
      require(applied === true, 'initial_plan_not_applied'); this.initialized = true;
    } else {
      const next = (outcome as NextProposal).action;
      require(next && ['dispatch','choose','pause'].includes(next.kind), 'next_action');
      this.queued = fresh(next);
    }
    this.receipts.push({id: pending.id, input_digest: pending.input_digest, outcome_digest: digest(outcome),
      mode: outcome.mode, origin: fresh(outcome.origin), usage: fresh(outcome.usage), latency_ms: outcome.latency_ms});
    this.pending = null; this.lastPlanned = this.acceptedDigest();
    await this.persist('planner_observed');
  }
  private async executeQueued(context: PortContext) {
    const action = this.queued!;
    if (action.kind === 'choose' && this.parentRemaining() <= 0) {
      this.paused = 'parent_operation_budget_exhausted'; await this.persist('parent_limit'); return;
    }
    if (action.kind === 'choose') {
      await this.controller.choose(action.candidates, async input => {
        const boundary = this.controller.getDecisionBoundary(); require(boundary, 'decision_boundary');
        const remaining = boundary!.decision_deadline_ms - (this.host.checks.now?.() ?? Date.now());
        require(remaining > 0, 'decision_deadline');
        const signal = AbortSignal.any([context.signal, AbortSignal.timeout(Math.min(60000, remaining))]);
        await this.authorize(); require(!signal.aborted, 'parent_ended');
        return this.host.decision(input, {...context, signal, boundary: boundary!});
      });
    } else if (action.kind === 'pause') {
      require(typeof action.reason === 'string' && action.reason.trim(), 'pause_reason'); this.paused = action.reason;
    }
    this.queued = null; await this.persist('next_action_consumed');
  }
  private async plan(stage: 'initial' | 'next', context: PortContext) {
    if (this.parentRemaining() <= 0) {this.paused = 'parent_operation_budget_exhausted'; await this.persist('parent_limit'); return;}
    if (this.started >= this.limit) {this.paused = 'planner_budget_exhausted'; await this.persist('planner_limit'); return;}
    const base = {request: this.controller.records().request, catalog: this.catalog,
      checkpoint: this.controller.checkpoint(), observations: this.accepted()};
    const pending: PlannerPending = immutable({id: 'planner:' + (this.started + 1), stage, input_digest: digest(base)});
    const input = Object.freeze({...context, ...immutable(fresh(base)), invocation: pending});
    require(await this.host.authorizePlanner(input) === true, 'planner_authority');
    await this.authorize();
    this.pending = pending; this.started++;
    await this.persist('planner_reserved'); // Failure stops before the actual caller/LLM effect.
    await this.authorize();
    try {
      require(await this.host.authorizePlanner(input) === true, 'planner_authority');
      await this.authorize();
      const outcome = await bounded<InitialProposal | NextProposal>(context.signal, () => this.planner[stage](input));
      await this.applyPlanner(outcome);
    } catch (error) {
      if (this.storageFailed) throw error;
      this.uncertain = true; await this.persist('planner_unconfirmed');
    }
  }
  private async executeFinal(frame: TaskRequest, context: PortContext) {
    require(this.controller.checkpoint().state.entries.every(e => e.task.id === frame.task_id || e.state === 'done'), 'final_order');
    const returned = await bounded(context.signal, () => this.host.final(frame, {...context, observations: this.accepted()}));
    await this.consumeFinal(returned, frame, context);
  }
  private async consumeFinal(returned: FinalReply, frame: TaskRequest, context: PortContext) {
    require(this.controller.checkpoint().state.entries.every(e => e.task.id === frame.task_id || e.state === 'done'), 'final_order');
    const reply = immutable(fresh({mode: returned.mode, origin: returned.origin, usage: returned.usage,
      latency_ms: returned.latency_ms, new_native_call: returned.new_native_call}));
    require(returned.raw instanceof Uint8Array, 'raw_final_bytes');
    const raw = Uint8Array.from(returned.raw), raw_sha256 = createHash('sha256').update(raw).digest('hex');
    await this.host.archiveFinal({raw: Uint8Array.from(raw), frame, origin: fresh(reply.origin), raw_sha256});
    portReceipt(reply);
    require(reply.mode !== 'recorded_replay' && (reply.mode !== 'live' || reply.new_native_call === true) &&
      await this.host.verifyFinalOrigin({...reply, raw: Uint8Array.from(raw)}, frame) === true, 'final_origin');
    const ended = context.signal.aborted || this.host.signal.aborted ||
      (this.host.checks.now?.() ?? Date.now()) >= this.admission.deadline_ms;
    if (!ended) await this.current(frame, context.signal);
    else require(await this.host.authorizeReconcile({final: {...reply, raw: Uint8Array.from(raw)}}, this.snapshot()) === true, 'late_final_read_authority');
    const inspected = inspectFinal(raw, frame, this.accepted(), this.host.evidenceText);
    const projection = inspected.projection;
    const observation: Observation = {contract_version: CONTRACT_VERSION, id: 'final:' + frame.task_id,
      run_id: frame.run_id, task_id: frame.task_id, attempt_id: frame.attempt_id,
      input_revision: frame.input_revision, input_digest: frame.input_digest, status: 'completed',
      value: {answer: projection.answer, unresolved: projection.unresolved}, evidence: projection.provenance,
      mode: reply.mode, usage: reply.usage};
    if (ended) {
      if (context.signal.aborted || this.host.signal.aborted) this.controller.cancel('Original SDK parent cancelled before native readback');
      const adoption = this.controller.observe(observation);
      require(adoption !== 'accepted', 'late_final_not_accepted');
      this.finalReceipt = {...inspected.receipt, mode: reply.mode, origin: fresh(reply.origin),
        new_native_call: reply.new_native_call, usage: fresh(reply.usage), latency_ms: reply.latency_ms,
        adoption, disposition: 'SAVED_UNADOPTED_ORIGINAL_PARENT_ENDED'};
      await this.persist('final_late'); return; // Retain actual native usage, never finish or reopen admission.
    }
    const previous = this.accepted().find(o => o.task_id === frame.task_id);
    if (previous) require(digest(previous) === digest(observation), 'changed_final_observation');
    else {const adoption = this.controller.observe(observation); require(adoption === 'accepted', 'final_adoption');}
    // Persist accepted output before finish; no string-only completion or substitute raw frame.
    this.finalReceipt = {...inspected.receipt, mode: reply.mode, origin: fresh(reply.origin),
      new_native_call: reply.new_native_call, usage: fresh(reply.usage), latency_ms: reply.latency_ms};
    await this.persist('final_observed');
    await this.current(frame, context.signal); // The durable barrier may revoke writer/data rights without expiring D.
    this.controller.finish(projection.answer, projection.provenance, projection.unresolved);
  }
  async run(options: {signal?: AbortSignal} = {}) {
    return this.serial(async () => {
      if (this.controller.result().status !== 'needs_host' && !this.controller.recovery().pending.length) return this.outcome();
      await this.authorize(); const context = this.context(options.signal);
      if (this.pending || this.uncertain || this.controller.recovery().pending.length || this.paused) return this.outcome();
      if (!this.initialized) await this.plan('initial', context);
      const bound = this.controller.records().request.budget.max_operations + this.limit + 1;
      for (let i = 0; i < bound && !context.signal.aborted; i++) {
        if (this.pending || this.uncertain || this.paused || this.controller.result().status !== 'needs_host') break;
        if (this.queued) {await this.executeQueued(context); continue;}
        if (this.lastPlanned !== this.acceptedDigest()) {await this.plan('next', context); continue;}
        const frames = this.controller.dispatch();
        await this.persist('tasks_reserved'); // Save all admitted frames before starting any worker/final effect.
        if (!frames.length) break;
        const results = await Promise.allSettled(frames.map(async frame => {
          await this.current(frame, context.signal);
          if (frame.capability === this.host.finalCapability) await this.executeFinal(frame, context);
          else {
            const observation = await bounded(context.signal, () => this.host.worker(frame, context));
            const original = immutable(fresh(observation));
            await this.host.archiveObservation({frame, observation: original, observation_sha256: digest(original)});
            require(await this.host.verifyObservationOrigin(original, frame) === true, 'observation_origin');
            await this.current(frame, context.signal); // Permission/freshness may change during actual I/O or archival.
            const adoption = this.controller.observe(original);
            if (adoption !== 'accepted') this.uncertain = true;
          }
        }));
        if (results.some(r => r.status === 'rejected')) this.uncertain = true;
        await this.persist('effects_observed');
      }
      if (context.signal.aborted && this.controller.result().status === 'needs_host') {
        this.controller.cancel('Original SDK parent ended'); await this.persist('parent_ended');
      }
      return this.outcome();
    });
  }
  /** Existing host supplies actual observation/readback. No pending physical effect is resent. */
  async reconcile(input: ReconcileInput) {
    // Pin JSON data before any authorization await. Keep private raw bytes away from mutable callbacks.
    if ('final' in input) require(input.final.raw instanceof Uint8Array, 'raw_final_bytes');
    const rawFinal = 'final' in input ? Uint8Array.from(input.final.raw) : null;
    const fixed = 'final' in input ? immutable(fresh({final: {mode: input.final.mode, origin: input.final.origin,
      usage: input.final.usage, latency_ms: input.final.latency_ms, new_native_call: input.final.new_native_call}})) : immutable(fresh(input));
    const authorizerInput = () => 'final' in fixed ? {...fixed, final: {...fixed.final, raw: Uint8Array.from(rawFinal!)}} as ReconcileInput : fixed as ReconcileInput;
    return this.serial(async () => {
      require(!this.storageFailed && await this.host.authorizeReconcile(authorizerInput(), this.snapshot()) === true, 'reconcile_authority');
      if ('planner' in fixed) {require(this.pending, 'no_pending_planner'); await this.applyPlanner(fixed.planner);}
      else if ('final' in fixed) {
        const reports = this.controller.checkpoint().state.entries.filter(e => e.task.capability === this.host.finalCapability && e.request);
        require(reports.length === 1, 'pending_final_frame');
        await this.consumeFinal({...fixed.final, raw: Uint8Array.from(rawFinal!)}, reports[0].request!, this.context());
      } else if ('observation' in fixed) {
        const original = fixed.observation;
        const frame = this.controller.checkpoint().state.entries.find(e => e.task.id === original.task_id)?.request;
        require(frame && frame.capability !== this.host.finalCapability, 'raw_final_required');
        require(await this.host.verifyObservationOrigin(original, frame) === true, 'observation_origin');
        await this.host.archiveObservation({frame: frame!, observation: original, observation_sha256: digest(original)});
        require(await this.host.authorizeReconcile(authorizerInput(), this.snapshot()) === true, 'reconcile_authority');
        if (this.host.signal.aborted) this.controller.cancel('Original SDK parent cancelled before readback');
        else if ((this.host.checks.now?.() ?? Date.now()) < this.admission.deadline_ms) await this.current(frame!);
        this.controller.observe(original); // Core retains actual late/stale/duplicate status and counts matching usage once.
      }
      else this.controller.settle((fixed as {settlement: EffectSettlement}).settlement);
      this.uncertain = !!this.pending || this.unresolvedEffects() > 0;
      await this.persist('reconciled'); return this.outcome();
    });
  }
  /** Cancellation retains admitted/pending effects; it never implies their physical absence. */
  async cancel(reason: string) {
    return this.serial(async () => {
      require(await this.host.authorizeEntry() === true && !this.storageFailed, 'cancel_authority');
      this.controller.cancel(reason); await this.persist('cancelled'); return this.outcome();
    });
  }
  /** An explicit caller reentry can reconsider a paused plan; it cannot reopen failed/cancelled/expired work. */
  async continue() {
    return this.serial(async () => {await this.authorize();
      require(this.controller.result().status === 'needs_host' && !this.pending && !this.uncertain, 'cannot_continue');
      this.paused = null; this.lastPlanned = ''; await this.persist('caller_continue'); return this.outcome();});
  }
  outcome() {
    const result = this.controller.result(), unknown = !!this.pending || this.uncertain || this.unresolvedEffects() > 0;
    return {sdk_version: SDK_VERSION, sdk_status: unknown ? 'NEEDS_RECONCILIATION' : result.status === 'complete' ? 'COMPLETE' :
      this.paused || result.status === 'needs_host' ? 'PAUSED' : 'STOPPED', result,
      records: this.controller.records(), snapshot: this.snapshot(), planner_receipts: fresh(this.receipts), final_receipt: fresh(this.finalReceipt),
      usage: {parent_operations_started: result.usage.operations_started + this.started, execution: result.usage, planner: {calls_started: this.started,
        tokens: this.started === this.receipts.length && this.receipts.every(r => r.usage.tokens !== null) ? this.receipts.reduce((s,r)=>s+r.usage.tokens!,0) : null,
        cost: this.started === this.receipts.length && this.receipts.every(r => r.usage.cost !== null) ? this.receipts.reduce((s,r)=>s+r.usage.cost!,0) : null}}};
  }
}
export function createWork(options: CreateWorkOptions) {return new WorkRun(options);}
export async function restoreWork(snapshot: WorkSnapshot, options: RestoreWorkOptions) {return WorkRun.restore(snapshot, options);}
