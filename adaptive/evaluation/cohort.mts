import {STRATEGIES, demand, digest, exact, isSHA, isText, profileScope, same, snapshot,
  validateManifest} from './contract.mts';
import {bounded} from './comparison.mts';
import type {JSONValue, PairedComparison} from './contract.mts';

export const COHORT_VERSION = 'jev-evaluation-cohort/0.1.0-preview' as const;
export type CohortCase = Readonly<{case_id: string; split: 'design' | 'held-out';
  input_sha256: string; sources_sha256: string}>;
export type CohortSeal = Readonly<{version: typeof COHORT_VERSION; cohort_id: string;
  scope_sha256: string; cases: readonly CohortCase[]; digest: string}>;
type CohortUse = Readonly<{kind: 'design' | 'evaluation'; run_id: string; original: JSONValue}>;
type CohortAdmission = Readonly<{run_id: string; admitted_at_ms: number; deadline_ms: number;
  budget_sha256: string; original: JSONValue}>;
type CohortCaseReadback = Readonly<{case_id: string; split: 'design' | 'held-out'; input_sha256: string;
  sources_sha256: string; usage_original: JSONValue; uses: readonly CohortUse[];
  admissions: readonly CohortAdmission[]}>;
export type CohortReadback = Readonly<{seal_digest: string; comparison_digest: string;
  registered_at_ms: number; current_fence: JSONValue; original: JSONValue;
  cases: readonly CohortCaseReadback[]}>;
export type CohortAuthority = Readonly<{signal: AbortSignal;
  /** ONE existing host readback of the actual saved preregistration, complete use history and
   * original admissions under one current fence. No new registry/service is created here.
   * A self-hash/JSON assertion is not this independently resolved record. Unknown returns null.
   */
  readCohort?: (seal: CohortSeal, comparisons: readonly PairedComparison[]) => Promise<CohortReadback | null>}>;
/** This descriptor is useful for logging only; its WeakMap identity is required for qualification. */
export type VerifiedCohort = Readonly<{version: typeof COHORT_VERSION; seal_digest: string;
  comparison_digest: string; origin_sha256: string}>;
export type CohortIdentity = Readonly<{seal_digest: string; comparison_digest: string; origin_sha256: string}>;
const verified = new WeakMap<VerifiedCohort, Readonly<{identity: CohortIdentity; original: CohortReadback}>>();

export function sealEvaluationCohort(input: {cohort_id: string; scope_sha256: string; cases: readonly CohortCase[]}): CohortSeal {
  exact(input, ['cohort_id','scope_sha256','cases'], 'COHORT_INPUT');
  const body = snapshot({version: COHORT_VERSION, ...input}); validateCases(body);
  return snapshot({...body, digest: digest(body)}); // Candidate only; does not prove preregistration/unusedness.
}
function validateCases(s: Omit<CohortSeal, 'digest'>) {
  demand(s.version === COHORT_VERSION && isText(s.cohort_id) && isSHA(s.scope_sha256) &&
    Array.isArray(s.cases) && s.cases.length > 0 && s.cases.length <= 96, 'COHORT_CASES');
  const ids = new Set<string>(), inputs = new Set<string>();
  for (const c of s.cases) {
    exact(c, ['case_id','split','input_sha256','sources_sha256'], 'COHORT_CASE');
    demand(isText(c.case_id) && ['design','held-out'].includes(String(c.split)) && isSHA(c.input_sha256) &&
      isSHA(c.sources_sha256) && !ids.has(c.case_id) && !inputs.has(c.input_sha256), 'COHORT_DUPLICATE_OR_CASE');
    ids.add(c.case_id); inputs.add(c.input_sha256);
  }
  demand(s.cases.some(c => c.split === 'held-out'), 'COHORT_HELD_OUT_REQUIRED');
}
function validateSeal(s: CohortSeal) {
  exact(s, ['version','cohort_id','scope_sha256','cases','digest'], 'COHORT_SEAL');
  const {digest: sha, ...body} = s; validateCases(body); demand(sha === digest(body), 'COHORT_SEAL_DIGEST');
}
/** Binds all inference-bearing facts without copying large duplicate raw receipts into a batch hash. */
export function cohortComparisonDigest(comparisons: readonly PairedComparison[]): string {
  return digest(comparisons.map(c => ({manifest_sha256: digest(c.manifest), status: c.status,
    authority: c.authority, automatic_apply: c.automatic_apply,
    arms: Object.fromEntries(STRATEGIES.map(s => {
      const a = c.arms[s]; return [s, {strategy: a.strategy, status: a.status, error_kind: a.error_kind,
        reason: a.reason, receipt: a.receipt ? digest(a.receipt) : null,
        attestation: a.attestation ? digest(a.attestation) : null, grade: a.grade ? digest(a.grade) : null}];
    }))})));
}
function coverage(s: CohortSeal, cs: readonly PairedComparison[]) {
  demand(Array.isArray(cs) && cs.length > 0 && cs.length <= 96, 'COHORT_COMPARISONS');
  const present = new Set<string>();
  for (const c of cs) {
    validateManifest(c.manifest);
    demand(c.manifest_sha256 === digest(c.manifest) && digest(profileScope(c.manifest)) === s.scope_sha256,
      'COHORT_CONDITIONS');
    const entry = s.cases.find(x => x.case_id === c.manifest.case_id);
    demand(entry && !present.has(entry.case_id), 'COHORT_UNKNOWN_OR_DUPLICATE_CASE');
    demand(entry.split === c.manifest.split && entry.input_sha256 === c.manifest.input_sha256 &&
      entry.sources_sha256 === digest(c.manifest.sources), 'COHORT_CASE_RELABEL_OR_INPUT');
    present.add(entry.case_id);
  }
  demand(s.cases.filter(c => c.split === 'held-out').every(c => present.has(c.case_id)),
    'COHORT_HELD_OUT_RETURN_MISSING');
}
const time = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

export async function verifyEvaluationCohort(seal: CohortSeal, comparisons: readonly PairedComparison[],
  authority: CohortAuthority): Promise<VerifiedCohort | undefined> {
  validateSeal(seal); demand(Array.isArray(comparisons), 'COHORT_COMPARISONS');
  const s = snapshot(seal), cs = comparisons.map(snapshot);
  coverage(s, cs); const binding = cohortComparisonDigest(cs);
  const reader = authority.readCohort, signal = authority.signal;
  demand(reader === undefined || typeof reader === 'function', 'COHORT_READER');
  if (!reader) return undefined;
  const read = reader.bind(authority);
  const raw = await bounded(signal, () => read(s, cs));
  if (raw === null) return undefined;
  const proof = snapshot(raw); // Original reader aliases cannot rewrite qualification while returned.
  exact(proof, ['seal_digest','comparison_digest','registered_at_ms','current_fence','original','cases'], 'COHORT_READBACK');
  demand(proof.seal_digest === s.digest && proof.comparison_digest === binding && time(proof.registered_at_ms) &&
    proof.current_fence !== null && proof.original !== null && Array.isArray(proof.cases), 'COHORT_ORIGIN');
  demand(proof.cases.length === s.cases.length && new Set(proof.cases.map(c => c.case_id)).size === s.cases.length,
    'COHORT_REGISTRY_COVERAGE');
  for (const registered of s.cases) {
    const record = proof.cases.find(c => c.case_id === registered.case_id);
    demand(record !== undefined, 'COHORT_REGISTRY_CASE');
    exact(record, ['case_id','split','input_sha256','sources_sha256','usage_original','uses','admissions'], 'COHORT_REGISTRY_CASE');
    demand(record.split === registered.split && record.input_sha256 === registered.input_sha256 &&
      record.sources_sha256 === registered.sources_sha256 && record.usage_original !== null &&
      Array.isArray(record.uses) && Array.isArray(record.admissions), 'COHORT_REGISTRY_BINDING');
    const result = cs.find(c => c.manifest.case_id === record.case_id);
    const runs = result ? STRATEGIES.flatMap(k => result.arms[k].receipt ? [result.arms[k].receipt!.run_id] : []) : [];
    demand(new Set(runs).size === runs.length && new Set(record.admissions.map(a => a.run_id)).size === record.admissions.length &&
      same([...runs].sort(), record.admissions.map(a => a.run_id).sort()), 'COHORT_ADMISSION_COVERAGE');
    for (const u of record.uses) {
      exact(u, ['kind','run_id','original'], 'COHORT_USAGE');
      demand(['design','evaluation'].includes(String(u.kind)) && isText(u.run_id) && u.original !== null, 'COHORT_USAGE');
      if (registered.split === 'held-out') {
        demand(u.kind !== 'design', 'COHORT_DESIGN_RELABEL');
        demand(runs.includes(u.run_id), 'COHORT_SPENT_INPUT_REUSED');
      }
    }
    for (const a of record.admissions) {
      exact(a, ['run_id','admitted_at_ms','deadline_ms','budget_sha256','original'], 'COHORT_ADMISSION');
      demand(result && isText(a.run_id) && time(a.admitted_at_ms) && time(a.deadline_ms) && a.original !== null &&
        proof.registered_at_ms < a.admitted_at_ms && a.admitted_at_ms < a.deadline_ms &&
        a.deadline_ms === result.manifest.deadline_ms && a.budget_sha256 === digest(result.manifest.budget) &&
        a.deadline_ms - a.admitted_at_ms <= result.manifest.budget.timeout_ms, 'COHORT_NOT_PREREGISTERED_OR_ADMISSION');
    }
  }
  demand(!signal.aborted, 'COHORT_PARENT_ENDED');
  const identity = snapshot({seal_digest: s.digest, comparison_digest: binding, origin_sha256: digest(proof.original)});
  const token = snapshot({version: COHORT_VERSION, ...identity});
  verified.set(token, snapshot({identity, original: proof})); return token;
}

export function verifiedCohortIdentity(token: VerifiedCohort, comparisons: readonly PairedComparison[]): CohortIdentity {
  const value = verified.get(token);
  demand(value && value.identity.comparison_digest === cohortComparisonDigest(comparisons), 'COHORT_TOKEN_UNVERIFIED_OR_BINDING');
  return value.identity;
}
/** Archive this existing-origin readback alongside the profile, privately. It does not serialize token authority. */
export function cohortEvidence(token: VerifiedCohort): Readonly<{identity: CohortIdentity; original: CohortReadback}> {
  const value = verified.get(token); demand(value, 'COHORT_TOKEN_UNVERIFIED'); return snapshot(value);
}
