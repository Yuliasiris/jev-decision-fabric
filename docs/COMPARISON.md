# Compare single, fixed and adaptive execution

Import comparison ports separately to keep their manifest types independent
of C0 names:

~~~ts
import {
  runPairedComparison,
  createPolicyProfile,
  consumePolicyProfile,
  sealEvaluationCohort,
  verifyEvaluationCohort,
  cohortEvidence,
} from 'jev-decision-fabric/evaluation';
~~~

The host supplies real runner ports for single/fixed/adaptive and their
existing current admission/authority. This module does not create a
controller, grant an allocation, discover a model, or launch a live CLI from
JSON.

## Paired observations

~~~ts
const comparison = await runPairedComparison(
  conditionManifest,
  {single: singleRunner, fixed: fixedRunner, adaptive: adaptiveRunner},
  {signal: originalSignal, attestReceipt, scoreFinal},
);
~~~

Read ConditionManifest, ArmReceipt, Grade and EvaluationHooks in
adaptive/evaluation/contract.mts. The manifest binds input, available sources,
capabilities/tools, each strategy implementation, the same caller model,
original budget/deadline and scoring definition. Single/fixed have no selector
model; adaptive records its actual selector. Runners preserve actual
tools/physical call IDs, accepted reads, original final, usage and measurements.

attestReceipt resolves the official current execution record independently
of the returned JSON. scoreFinal is an independent evaluator over actual
final/read records; its criteria and answer key are not sent to the tested
provider. Classify candidate-generation, selection, technical and final
errors separately.

Scripted/injected/recorded/unverified replies remain diagnostic. A live arm
requires verified original receipt and scoring to be measured. Cost/latency
are nullable and retain units/scope/original receipts; an absent value is not
zero. Keep design inputs separate from held-out inputs.

## Fix the evaluation cohort before execution

Before any evaluation admission, save an explicit roster through the existing
authorized host storage. Its case IDs, design/held-out splits, exact input and
available-source hashes, and policy scope must already be fixed. This library
creates no registry, database, service or execution grant:

~~~ts
const seal = sealEvaluationCohort({cohort_id, scope_sha256, cases});
// Existing host saves seal plus the original preregistration record BEFORE runs.
// Return every sealed held-out case, including errors and unknown outcomes.
const cohort = await verifyEvaluationCohort(seal, comparisons, {
  signal: originalSignal,
  readCohort: existingOriginalCohortReader,
});
const profile = createPolicyProfile(comparisons, cohort);
const archivalCohort = cohort ? cohortEvidence(cohort) : null;
~~~

The existing reader must independently resolve the actual saved registration,
complete case-use history and original admissions under one coherent current
fence. Its readback binds the entire comparison set, including receipts,
attestations and independent grades. Registration must predate each original
admission with the original budget and absolute deadline. The original positive
duration may be shorter than the frozen timeout because the parent deadline
already limits it; the guard never extends that deadline. A held-out case may
have no design exposure or earlier evaluation run outside these saved results.
Reading these same results again is allowed and creates no run or use claim.
Dropping a held-out case, changing its split/input/source, adding a different
comparison, or substituting an evaluation receipt or grade breaks qualification.

The seal's self-digest and caller-supplied JSON do not prove preregistration or
unusedness. Missing/unavailable original readback produces no token. Calling
`createPolicyProfile(comparisons)` remains supported, but even verified-looking
live arms yield fixed/insufficient without verified cohort origin. Scripted or
injected arms remain diagnostic even with a verified cohort fixture.

The verified token is an exact in-process WeakMap identity. JSON, clones and
self-constructed descriptors cannot reuse it. Save archivalCohort and actual
original evidence privately alongside comparisons and profile; serialization
does not preserve token authority. To restore a saved new profile, re-read the
actual originals to obtain a new token, then call the pure
`createPolicyProfile(savedComparisons, token)` to reconstruct/register that
exact profile. This performs no model call, evaluation run or fresh-use claim.
Originals must retain the same identity; a changed registration cannot silently
authenticate an older profile.

## Consume the result in a later fresh run

~~~ts
const use = await consumePolicyProfile(
  profile,
  {run_id: freshRunId, manifest: freshConditionManifest},
  existingRunnerPorts,
  {verifyProfile, authorizeAdmission, reserveFreshUse, attestReceipt, readCurrentUse},
  {signal: originalFreshRunSignal, cohort},
);
~~~

The profile is advisory evidence. verifyProfile resolves the actual saved
comparison **and original cohort registration/use-history** records. A legacy
comparisons-only lookup cannot authenticate cohort qualification.
authorizeAdmission checks the current real source/grants/
budget/deadline. reserveFreshUse performs a create-only claim for the fresh
run and retains it if the outcome is uncertain. A serialized profile is not
authentication or an execution grant.

New profiles persist the exact cohort/comparison/origin identity and require
their reverified token before dispatch. An old serialized adaptive/single
profile without this cohort binding is rejected before any port runs. Old
fixed profiles remain API-compatible; an old claimed held-out qualification
is explicitly reported as `legacy_fixed_unsealed`, not reusable comparative
evidence. The next-run execution qualification is reported separately.

The optional readCurrentUse callback jointly reads the actual saved profile and
current original admission under one current fence. It returns their original
bindings and witness; self-asserted fields are not that proof. A live use stays
unconfirmed_use when the callback is absent or its joint readback is unavailable,
even if separate older profile/admission checks succeeded. Scripted and other
non-live use remains diagnostic_only.

The fresh run must differ from evaluation runs and match the policy scope:
task class, capabilities/tools/model bindings/implementation, budget and
scoring definition. The consumer chooses exactly one bound runner; failure or
unknown does not trigger another strategy or automatic retry.

The initial policy is conservative: fixed with no selector when held-out
gain is not known. Adaptive or single is selected only when all held-out
live comparisons show measured dominance across quality, evidence,
unnecessary work/holds, rework/re-explanation, cost and latency in equal
units/scope, with no regression. Unknown metrics prevent that recommendation.
This is a scoped rule over the complete registered finite cohort, not a
universal claim that one method is best. Exact input hashes do not establish
semantic novelty, absence from model training, or resistance to near-duplicate
tuning. Those limits require independent evaluation design and original evidence.

Save comparison, profile and consumption records privately with their
original execution evidence. Public source supplies the reusable method;
publishing local unit tests or fabricated runner receipts does not establish
real method gains or finish the whole Goal.


### Run the offline comparison method

After installing the public package, run its compiled example and save a new record:

```sh
node node_modules/jev-decision-fabric/dist/examples/work-comparison.mjs comparison.json
```

From a built checkout, use `node dist/examples/work-comparison.mjs comparison.json`. Omit the filename to print JSON. The output path must be new.

The example reads the packaged **synthetic** numbers `[120,240,360]`, runs single-code-caller, fixed and scripted-adaptive routes through the same file/calculation/format tools, independently checks the final arithmetic and provenance, creates a profile, and consumes it on another fresh local run. The design request asks for the total; the separate held-out wiring request asks for the mean. Both use the same known fixture, so this split proves method wiring rather than unfamiliar-input competence.

The record includes actual local I/O and timing, source/model/implementation/budget/deadline bindings, original final bytes, separate nullable scoring metrics, and the profile's next-use receipt. Cost, rework and re-explanation remain null. All arms stay `diagnostic_only`; no LLM/Jev quality or superiority is evaluated. The profile therefore selects **fixed/no-Jev**. The example's joint current-fence proof is explicitly unavailable, and its create-only claim is in-process rather than a durable host journal.

These code runners demonstrate the prepared comparison API. They are not equally capable real LLM baselines. Replace them only with the existing authorized runtime ports and actual receipts for live evaluation; retain the same permitted conditions, independent scoring and qualification checks.
