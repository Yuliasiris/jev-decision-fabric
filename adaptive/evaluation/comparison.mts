import {EVALUATION_VERSION, STRATEGIES, demand, digest, exact, snapshot,
  validateManifest, validateReceipt, validateGrade, EvaluationError} from './contract.mts';
import type {ArmEvaluation, ArmReceipt, ConditionManifest, EvaluationHooks, JSONValue,
  PairedComparison, ReceiptAttestation, Strategy, StrategyRunners} from './contract.mts';

export function active(signal: AbortSignal, deadline: number, now: () => number) {
  demand(!signal.aborted && now() < deadline, 'ORIGINAL_PARENT_ENDED');
}
export async function bounded<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  demand(!signal.aborted, 'ORIGINAL_PARENT_ENDED');
  let listener!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    listener = () => reject(new EvaluationError('ORIGINAL_PARENT_ENDED'));
    signal.addEventListener('abort', listener, {once: true});
  });
  try {return await Promise.race([Promise.resolve().then(() => {
    demand(!signal.aborted, 'ORIGINAL_PARENT_ENDED'); return operation();
  }), cancelled]);}
  finally {signal.removeEventListener('abort', listener);}
}
export function validateAttestation(a: unknown, sha: string): asserts a is ReceiptAttestation {
  exact(a, ['status','receipt_sha256','original'], 'ATTESTATION');
  demand(['verified','unavailable','denied'].includes(String(a.status)) && a.receipt_sha256 === sha &&
    (a.status !== 'verified' || a.original !== null), 'ATTESTATION');
}

/** One invocation per arm. Original runtime ports own execution, limits, authority and private journals. */
export async function runPairedComparison(manifest: ConditionManifest, runners: StrategyRunners,
  hooks: EvaluationHooks): Promise<PairedComparison> {
  validateManifest(manifest); const m = snapshot(manifest);
  // Capture original callable bindings before the first await. Their runtime records remain current.
  const parentSignal = hooks.signal, clock = hooks.now ?? Date.now;
  const originalAttest = hooks.attestReceipt, originalScore = hooks.scoreFinal;
  demand(typeof originalAttest === 'function' && typeof originalScore === 'function', 'TRUSTED_HOOKS_REQUIRED');
  const attestReceipt = originalAttest.bind(hooks), scoreFinal = originalScore.bind(hooks), now = clock.bind(hooks);
  const ports = {} as Record<Strategy, StrategyRunners[Strategy]>;
  for (const strategy of STRATEGIES) {
    const port = runners[strategy]; demand(typeof port === 'function', 'RUNNER_REQUIRED');
    ports[strategy] = port.bind(runners);
  }
  Object.freeze(ports);
  active(parentSignal, m.deadline_ms, now);
  // Bound each original admission; do not create a new timeout window or reset a run's budget.
  const remaining = m.deadline_ms - now();
  demand(remaining > 0 && remaining <= m.budget.timeout_ms && remaining <= 2147483647, 'ORIGINAL_DEADLINE');
  const expiry = new AbortController(), timer = setTimeout(() => expiry.abort('original deadline'), remaining);
  const signal = AbortSignal.any([parentSignal, expiry.signal]);
  const context = Object.freeze({signal, deadline_ms: m.deadline_ms});
  try {
    const evaluations = await Promise.all(STRATEGIES.map(async (strategy): Promise<ArmEvaluation> => {
      let received: JSONValue | null = null, receipt: ArmReceipt | null = null;
      let sha: string | null = null, attestation: ReceiptAttestation | null = null;
      try {
        active(signal, m.deadline_ms, now);
        const raw = await bounded(signal, () => ports[strategy](m, context));
        // Capture before the first independent await; runner aliases cannot rewrite evaluated facts.
        const saved = snapshot(raw); received = saved as unknown as JSONValue;
        validateReceipt(saved, m, strategy); receipt = saved; sha = digest(saved);
        active(signal, m.deadline_ms, now);
        if (saved.mode === 'live') {
          const proof = snapshot(await bounded(signal, () => attestReceipt(saved, m)));
          validateAttestation(proof, sha); attestation = proof;
          active(signal, m.deadline_ms, now);
          if (proof.status !== 'verified') return snapshot({strategy,
            status: proof.status === 'denied' ? 'invalid' : 'unavailable',
            error_kind: 'technical', reason: 'OFFICIAL_RECEIPT_' + proof.status.toUpperCase(),
            receipt, received, receipt_sha256: sha, attestation, grade: null});
        }
        const grade = snapshot(await bounded(signal, () => scoreFinal(saved, m)));
        validateGrade(grade); active(signal, m.deadline_ms, now);
        return snapshot({strategy, status: saved.mode === 'live' ? 'measured' : 'diagnostic_only',
          error_kind: saved.error_kind, reason: null, receipt, received, receipt_sha256: sha, attestation, grade});
      } catch (e) {
        const validation = e instanceof EvaluationError && e.code !== 'ORIGINAL_PARENT_ENDED';
        return snapshot({strategy, status: validation ? 'invalid' : 'unavailable', error_kind: 'technical',
          reason: e instanceof EvaluationError ? e.code : 'RUN_OR_EVALUATOR_UNAVAILABLE',
          receipt, received, receipt_sha256: sha, attestation, grade: null});
      }
    }));
    let arms = Object.fromEntries(evaluations.map(e => [e.strategy, e])) as Record<Strategy, ArmEvaluation>;
    const runIds = evaluations.flatMap(e => e.receipt ? [e.receipt.run_id] : []);
    if (new Set(runIds).size !== runIds.length) arms = Object.fromEntries(evaluations.map(e => [e.strategy,
      snapshot({...e, status: 'invalid', error_kind: 'technical', reason: 'RUN_REUSED_BETWEEN_ARMS', grade: null})])) as Record<Strategy, ArmEvaluation>;
    const statuses = STRATEGIES.map(s => arms[s].status);
    const status = statuses.includes('invalid') ? 'invalid' : statuses.includes('unavailable') ? 'unavailable' :
      statuses.every(s => s === 'measured') ? 'measured' : 'diagnostic_only';
    return snapshot({version: EVALUATION_VERSION, manifest: m, manifest_sha256: digest(m),
      status, arms, authority: 'advisory_only', automatic_apply: false});
  } finally {clearTimeout(timer);}
}
