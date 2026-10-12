# Compare single, fixed and adaptive execution

Import comparison ports separately to keep their manifest types independent
of C0 names:

~~~ts
import {
  runPairedComparison,
  createPolicyProfile,
  consumePolicyProfile,
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

## Consume the result in a later fresh run

~~~ts
const profile = createPolicyProfile([comparison]);

const use = await consumePolicyProfile(
  profile,
  {run_id: freshRunId, manifest: freshConditionManifest},
  existingRunnerPorts,
  {verifyProfile, authorizeAdmission, reserveFreshUse, attestReceipt, readCurrentUse},
  {signal: originalFreshRunSignal},
);
~~~

The profile is advisory evidence. verifyProfile resolves the actual saved
comparison records. authorizeAdmission checks the current real source/grants/
budget/deadline. reserveFreshUse performs a create-only claim for the fresh
run and retains it if the outcome is uncertain. A serialized profile is not
authentication or an execution grant.

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
This is a scoped rule, not a universal claim that one method is best.

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
