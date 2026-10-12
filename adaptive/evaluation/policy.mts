import {EVALUATION_VERSION, STRATEGIES, demand, digest, exact, profileScope, same, snapshot,
  validateManifest, validateReceipt, validateGrade} from './contract.mts';
import {active, bounded, validateAttestation} from './comparison.mts';
import type {ArmEvaluation, ArmReceipt, ConditionManifest, JSONValue, PairedComparison,
  ReceiptAttestation, Strategy, StrategyRunners} from './contract.mts';
import {verifiedCohortIdentity} from './cohort.mts';
import type {CohortIdentity, VerifiedCohort} from './cohort.mts';

export type PolicyProfile = Readonly<{version: typeof EVALUATION_VERSION;
  selection: Strategy; reason: string; scope: ReturnType<typeof profileScope>;
  evidence_quality: 'held_out_live' | 'diagnostic_only' | 'insufficient';
  evidence: readonly Readonly<{case_id: string; split: 'design' | 'held-out'; manifest_sha256: string;
    runs: readonly Readonly<{strategy: Strategy; run_id: string; receipt_sha256: string;
      attestation_sha256: string | null; grade_sha256: string | null}>[]}>[];
  provider_selection_required: boolean; authority: 'advisory_only'; automatic_apply: false; digest: string;
  cohort?: CohortIdentity}>;
const qualifiedProfiles = new WeakMap<VerifiedCohort, Set<string>>();
export type FreshPolicyAdmission = Readonly<{run_id: string; manifest: ConditionManifest}>;
export type CurrentUseReadback = Readonly<{status: 'verified' | 'unavailable' | 'denied';
  profile_digest: string; run_id: string; manifest_sha256: string; deadline_ms: number;
  current_fence: JSONValue; original: JSONValue}>;
export type PolicyAuthority = Readonly<{
  /** Resolve saved profile/comparison AND cohort preregistration/use-history originals.
   * A self-hash or old comparisons-only lookup is not that authentication.
   */
  verifyProfile: (profile: PolicyProfile) => Promise<boolean>;
  /** Current real admission/read permissions/budget/absolute D; never a JSON-issued grant. */
  authorizeAdmission: (admission: FreshPolicyAdmission) => Promise<boolean>;
  /** Existing runtime's create-only current-run claim, retained on failure/unknown; never refunded here. */
  reserveFreshUse: (admission: FreshPolicyAdmission, profile: PolicyProfile) => Promise<boolean>;
  attestReceipt: (receipt: ArmReceipt, manifest: ConditionManifest) => Promise<ReceiptAttestation>;
  /** Resolve BOTH original saved-profile and admission records under one actual current fence.
   * Sequential boolean reads cannot supply this witness. Missing binding leaves use unconfirmed.
   * This is readback of existing runtime authority, not a new grant/issuer/store/host endpoint.
   */
  readCurrentUse?: (profile: PolicyProfile, admission: FreshPolicyAdmission) => Promise<CurrentUseReadback | null>;
}>;

function validateComparison(c: PairedComparison) {
  exact(c, ['version','manifest','manifest_sha256','status','arms','authority','automatic_apply'], 'COMPARISON');
  validateManifest(c.manifest); demand(c.version === EVALUATION_VERSION && c.manifest_sha256 === digest(c.manifest) &&
    c.authority === 'advisory_only' && c.automatic_apply === false, 'COMPARISON');
  exact(c.arms, STRATEGIES, 'COMPARISON_ARMS');
  for (const s of STRATEGIES) {
    const a = c.arms[s];
    exact(a, ['strategy','status','error_kind','reason','receipt','received','receipt_sha256','attestation','grade'], 'COMPARISON_ARM');
    demand(a.strategy === s && ['measured','diagnostic_only','invalid','unavailable'].includes(a.status), 'COMPARISON_ARM');
    if (a.receipt) {validateReceipt(a.receipt, c.manifest, s); demand(a.receipt_sha256 === digest(a.receipt), 'COMPARISON_RECEIPT');}
    if (a.grade) validateGrade(a.grade);
    if (a.status === 'measured') {
      demand(a.receipt?.mode === 'live' && a.attestation?.status === 'verified' && a.grade !== null, 'MEASURED_PROOF');
      validateAttestation(a.attestation, a.receipt_sha256!);
    }
  }
  const statuses = STRATEGIES.map(s => c.arms[s].status);
  const expected = statuses.includes('invalid') ? 'invalid' : statuses.includes('unavailable') ? 'unavailable' :
    statuses.every(s => s === 'measured') ? 'measured' : 'diagnostic_only';
  demand(c.status === expected, 'COMPARISON_STATUS');
}
const gradeKeys = ['quality','evidence','unnecessary_work','unnecessary_holds','rework','re_explanation'] as const;
/** Conservative paired dominance: every dimension must be measured in the same units, with no regressions. */
function dominates(a: ArmEvaluation, b: ArmEvaluation): boolean {
  if (a.status !== 'measured' || b.status !== 'measured' || a.receipt?.outcome !== 'complete' ||
      b.receipt?.outcome !== 'complete' || !a.grade || !b.grade) return false;
  let gain = false;
  for (const k of gradeKeys) {
    const x = a.grade[k], y = b.grade[k]; if (x === null || y === null) return false;
    const higher = k === 'quality' || k === 'evidence';
    if (higher ? x < y : x > y) return false;
    if (x !== y) gain = true;
  }
  const x = a.receipt.measurements, y = b.receipt.measurements;
  if (x.cost === null || y.cost === null || x.latency_ms === null || y.latency_ms === null ||
      x.cost_unit === null || x.cost_unit !== y.cost_unit ||
      x.latency_scope === null || x.latency_scope !== y.latency_scope) return false;
  if (x.cost > y.cost || x.latency_ms > y.latency_ms) return false;
  if (x.cost < y.cost || x.latency_ms < y.latency_ms) gain = true;
  return gain;
}

/** Produce an advisory candidate profile. The existing consumer must authenticate/adopt it separately. */
export function createPolicyProfile(comparisons: readonly PairedComparison[], cohort?: VerifiedCohort): PolicyProfile {
  demand(Array.isArray(comparisons) && comparisons.length > 0 && comparisons.length <= 96, 'COMPARISONS_REQUIRED');
  const cs = comparisons.map(c => {validateComparison(c); return snapshot(c);});
  const cohortIdentity = cohort ? verifiedCohortIdentity(cohort, cs) : undefined;
  const scope = snapshot(profileScope(cs[0].manifest));
  demand(cs.every(c => same(profileScope(c.manifest), scope)), 'POLICY_SCOPE_MISMATCH');
  demand(new Set(cs.map(c => c.manifest.case_id)).size === cs.length, 'CASE_REUSED');
  const allRuns = cs.flatMap(c => STRATEGIES.flatMap(s => c.arms[s].receipt ? [c.arms[s].receipt!.run_id] : []));
  demand(new Set(allRuns).size === allRuns.length, 'RUN_REUSED');
  const designInputs = new Set(cs.filter(c => c.manifest.split === 'design').map(c => c.manifest.input_sha256));
  const held = cs.filter(c => c.manifest.split === 'held-out');
  const overlap = held.some(c => designInputs.has(c.manifest.input_sha256));
  let selection: Strategy = 'fixed', reason = 'NO_KNOWN_HELD_OUT_IMPROVEMENT';
  let evidence_quality: PolicyProfile['evidence_quality'] = 'insufficient';
  if (overlap) reason = 'DESIGN_HELD_OUT_OVERLAP';
  else if (held.length === 0) reason = 'NO_HELD_OUT_EVALUATION';
  else if (held.some(c => c.status !== 'measured')) {
    reason = 'NONLIVE_OR_UNVERIFIED_HELD_OUT';
    evidence_quality = held.every(c => c.status === 'diagnostic_only') ? 'diagnostic_only' : 'insufficient';
  } else if (!cohortIdentity) {
    reason = 'COHORT_ORIGIN_UNCONFIRMED';
  } else {
    evidence_quality = 'held_out_live';
    if (held.every(c => dominates(c.arms.single, c.arms.fixed) && dominates(c.arms.single, c.arms.adaptive))) {
      selection = 'single'; reason = 'KNOWN_HELD_OUT_SINGLE_IMPROVEMENT';
    } else if (held.every(c => dominates(c.arms.adaptive, c.arms.fixed) && dominates(c.arms.adaptive, c.arms.single))) {
      selection = 'adaptive'; reason = 'KNOWN_HELD_OUT_ADAPTIVE_IMPROVEMENT';
    }
  }
  const body = {version: EVALUATION_VERSION, selection, reason, scope, evidence_quality,
    evidence: cs.map(c => ({case_id: c.manifest.case_id, split: c.manifest.split, manifest_sha256: c.manifest_sha256,
      runs: STRATEGIES.flatMap(strategy => {
        const a = c.arms[strategy]; return a.receipt ? [{strategy, run_id: a.receipt.run_id,
          receipt_sha256: a.receipt_sha256!, attestation_sha256: a.attestation ? digest(a.attestation) : null,
          grade_sha256: a.grade ? digest(a.grade) : null}] : [];
      })})), provider_selection_required: selection === 'adaptive', authority: 'advisory_only' as const, automatic_apply: false as const,
    ...(cohortIdentity ? {cohort: cohortIdentity} : {})};
  const profile = snapshot({...body, digest: digest(body)});
  if (cohort) {
    const profiles = qualifiedProfiles.get(cohort) ?? new Set<string>();
    profiles.add(profile.digest); qualifiedProfiles.set(cohort, profiles);
  }
  return profile;
}

function validateProfile(profile: PolicyProfile) {
  exact(profile, ['version','selection','reason','scope','evidence_quality','evidence','provider_selection_required','authority','automatic_apply','digest',
    ...(Object.hasOwn(profile, 'cohort') ? ['cohort'] : [])], 'PROFILE');
  const {digest: sha, ...body} = profile;
  demand(sha === digest(body) && profile.version === EVALUATION_VERSION && STRATEGIES.includes(profile.selection) &&
    profile.authority === 'advisory_only' && profile.automatic_apply === false &&
    profile.provider_selection_required === (profile.selection === 'adaptive') &&
    (profile.selection === 'fixed' || profile.evidence_quality === 'held_out_live'), 'PROFILE');
  demand(Array.isArray(profile.evidence), 'PROFILE_EVIDENCE');
  if (profile.cohort) {
    exact(profile.cohort, ['seal_digest','comparison_digest','origin_sha256'], 'PROFILE_COHORT');
    demand(Object.values(profile.cohort).every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)), 'PROFILE_COHORT');
  }
}

function validateCurrentUse(w: unknown, p: PolicyProfile, a: FreshPolicyAdmission): asserts w is CurrentUseReadback {
  exact(w, ['status','profile_digest','run_id','manifest_sha256','deadline_ms','current_fence','original'], 'CURRENT_USE');
  demand(['verified','unavailable','denied'].includes(String(w.status)) && w.profile_digest === p.digest &&
    w.run_id === a.run_id && w.manifest_sha256 === digest(a.manifest) && w.deadline_ms === a.manifest.deadline_ms,
    'CURRENT_USE_BINDING');
  demand(w.status !== 'verified' || w.current_fence !== null && w.original !== null, 'CURRENT_USE_ORIGIN');
}

/** Actual next-fresh-run consumer: selects ONE existing port after trusted profile/current-run readback.
 * No Controller construction, financial allocation, parent budget/D reset, new key or automatic Apply.
 */
export async function consumePolicyProfile(profile: PolicyProfile, admission: FreshPolicyAdmission,
  runners: StrategyRunners, authority: PolicyAuthority, context: {signal: AbortSignal; now?: () => number; cohort?: VerifiedCohort}) {
  validateProfile(profile); validateManifest(admission.manifest);
  // Legacy fixed/no-selector remains usable. Legacy improved JSON must not bypass cohort qualification.
  demand(profile.selection === 'fixed' || profile.cohort, 'PROFILE_COHORT_REQUIRED');
  if (profile.cohort) demand(context.cohort && qualifiedProfiles.get(context.cohort)?.has(profile.digest) &&
    same(profile.cohort, context.cohort && {seal_digest: context.cohort.seal_digest,
      comparison_digest: context.cohort.comparison_digest, origin_sha256: context.cohort.origin_sha256}), 'PROFILE_COHORT_REQUIRED_OR_BINDING');
  const p = snapshot(profile), a = snapshot(admission), m = a.manifest;
  const parentSignal = context.signal, clock = context.now ?? Date.now, now = clock.bind(context);
  demand(typeof a.run_id === 'string' && a.run_id.length > 0 && a.run_id.length <= 512 &&
    !p.evidence.some(e => e.runs.some(r => r.run_id === a.run_id)), 'FRESH_RUN_REQUIRED');
  demand(same(profileScope(m), p.scope), 'CURRENT_POLICY_SCOPE_MISMATCH');
  // Capture original callbacks/port once; asynchronous aliases cannot swap the binding mid-use.
  const originalVerify = authority.verifyProfile, originalAuthorize = authority.authorizeAdmission,
    originalReserve = authority.reserveFreshUse, originalAttest = authority.attestReceipt,
    originalCurrentUse = authority.readCurrentUse, originalRun = runners[p.selection];
  demand([originalVerify,originalAuthorize,originalReserve,originalAttest].every(f => typeof f === 'function'), 'POLICY_AUTHORITY_REQUIRED');
  demand(typeof originalRun === 'function', 'RUNNER_REQUIRED');
  demand(originalCurrentUse === undefined || typeof originalCurrentUse === 'function', 'CURRENT_USE_READER');
  const verifyProfile = originalVerify.bind(authority), authorizeAdmission = originalAuthorize.bind(authority),
    reserveFreshUse = originalReserve.bind(authority), attestReceipt = originalAttest.bind(authority), run = originalRun.bind(runners);
  const readCurrentUse = originalCurrentUse?.bind(authority);
  active(parentSignal, m.deadline_ms, now);
  const remaining = m.deadline_ms - now();
  demand(remaining > 0 && remaining <= m.budget.timeout_ms && remaining <= 2147483647, 'ORIGINAL_DEADLINE');
  const expiry = new AbortController(), timer = setTimeout(() => expiry.abort('original deadline'), remaining);
  const signal = AbortSignal.any([parentSignal, expiry.signal]);
  try {
    demand(await bounded(signal, () => verifyProfile(p)) === true, 'PROFILE_NOT_ADOPTED');
    demand(await bounded(signal, () => authorizeAdmission(a)) === true, 'CURRENT_ADMISSION_DENIED');
    active(signal, m.deadline_ms, now);
    demand(await bounded(signal, () => reserveFreshUse(a, p)) === true, 'FRESH_USE_ALREADY_CLAIMED');
    demand(await bounded(signal, () => verifyProfile(p)) === true, 'PROFILE_CHANGED_DURING_RESERVATION');
    demand(await bounded(signal, () => authorizeAdmission(a)) === true, 'CURRENT_ADMISSION_CHANGED');
    active(signal, m.deadline_ms, now);
    // Reserve once; an exception, timeout or unknown outcome never invokes another strategy/retries.
    const receipt = snapshot(await bounded(signal, () => run(m,
      Object.freeze({signal, deadline_ms: m.deadline_ms, run_id: a.run_id}))));
    validateReceipt(receipt, m, p.selection); demand(receipt.run_id === a.run_id, 'RETURNED_RUN_MISMATCH');
    active(signal, m.deadline_ms, now);
    demand(await bounded(signal, () => verifyProfile(p)) === true, 'PROFILE_CHANGED_AFTER_RUN');
    demand(await bounded(signal, () => authorizeAdmission(a)) === true, 'CURRENT_ADMISSION_CHANGED');
    active(signal, m.deadline_ms, now);
    let attestation: ReceiptAttestation | null = null;
    if (receipt.mode === 'live') {
      const proof = snapshot(await bounded(signal, () => attestReceipt(receipt, m)));
      validateAttestation(proof, digest(receipt)); attestation = proof;
    }
    active(signal, m.deadline_ms, now);
    demand(await bounded(signal, () => verifyProfile(p)) === true, 'PROFILE_CHANGED_AT_RETURN');
    demand(await bounded(signal, () => authorizeAdmission(a)) === true, 'CURRENT_ADMISSION_CHANGED');
    active(signal, m.deadline_ms, now);
    // Final qualification needs a single actual fence for BOTH records. Do not manufacture one
    // by alternating partial reads: either original record can drift while the other awaits.
    const currentUse = readCurrentUse ? snapshot(await bounded(signal, () => readCurrentUse(p, a))) : null;
    if (currentUse !== null) validateCurrentUse(currentUse, p, a);
    active(signal, m.deadline_ms, now);
    return snapshot({version: EVALUATION_VERSION, profile_digest: p.digest, strategy: p.selection,
      run_id: a.run_id, receipt, receipt_sha256: digest(receipt), attestation, current_use: currentUse,
      qualification: receipt.mode !== 'live' ? 'diagnostic_only' :
        attestation?.status === 'verified' && currentUse?.status === 'verified' ? 'measured_use' : 'unconfirmed_use',
      policy_evaluation_qualification: p.cohort ? p.evidence_quality :
        p.evidence_quality === 'held_out_live' ? 'legacy_fixed_unsealed' : p.evidence_quality,
      reservation: 'RETAINED_NO_RETRY', authority: 'advisory_only', automatic_apply: false});
  } finally {clearTimeout(timer);}
}
