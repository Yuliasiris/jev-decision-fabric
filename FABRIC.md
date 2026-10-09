# Jev Decision Fabric — finite execution contract

This source derives from the N02 production-qualified assembled runtime.
The existing OAuth and `decision_evaluate(question_set, state)` result contract
are retained. Client plugin registration and source distribution are separate
delivery checks; server qualification does not prove either. Use the current
source correspondence in PROVENANCE.json and the usage Skill under skills/.
No provider or data-send permission is obtained from model text.

## Public entrypoints

- `decision_evaluate`: the original one-evaluation contract and native JSON.
  When `JEV_FABRIC_ENABLED=true`, it records a primary-only run. It does not
  start or wait for a shadow. Its additive `x-jev-shadow-status` is
  `not_requested`, not `unavailable`. When the flag is off, the legacy path is
  unchanged.
- `decision_run_v1`: advertised only when both `JEV_FABRIC_ENABLED=true` and
  `JEV_FABRIC_PLAN_ENABLED=true`. The caller supplies a finite plan using the
  four existing question sets. Only Jev is connected to this public entrypoint.
  The returned `RunResult` is a new versioned contract, not a replacement for
  the old Jev JSON. Use native values as observations, not automatic approvals.

Both entrypoints require existing OAuth authorization and live enablement.
`decision_run_v1` rechecks the grant and consumes existing inference quota before
each provider evaluation. A plan cannot smuggle endpoints, credentials, provider
IDs, scope/readers, arbitrary questions, or trace-reader privileges into state.
There is no trace retrieval tool, automatic tool dispatch, autonomous Apply,
external source fetch, or persistent background work in this candidate.

## Public finite plan

```json
{
  "version": 1,
  "topology": "compose",
  "max_calls": 2,
  "timeout_ms": 18000,
  "steps": [
    {"id": "first", "question_set": "synthetic-smoke-v0", "state": {"fixture": true}, "completion": "return_values"},
    {"id": "second", "question_set": "synthetic-smoke-v0", "state": {"fixture": true}, "reads": ["first"], "completion": "return_values"}
  ]
}
```

This is a synthetic shape example, not a useful reason to pay for two smoke
calls. Choose one evaluation when sufficient. Each step calls the same provider;
repetition is not independent evidence. `after` only imposes order. `reads`
forwards the named normalized result and its uncertainty; it does not fetch any
other stored record. Cross-check requires identical question definitions, state
and revision, with no inter-step reads.

The public bound is eight steps, eight started invocations and at most 18 seconds
for the run, excluding bounded final trace writes. Per-question completion is
selected using these named policies:

- `return_values` (default): a valid native answer is returned, including a
  Noul value of 0.5 or a Choice of `unknown`. `answered` means data was returned,
  not that the proposition is true or the work is accepted.
- `hold_on_unknown`: a literal `unknown` Choice requests hold.
- `need_evidence_on_unknown`: a literal `unknown` Choice requests new evidence;
  later primary steps are skipped. The plugin does not fetch that evidence.

These policies do not detect every kind of missing information and do not use a
universal numerical confidence threshold. A caller may acquire relevant source
material and make a new explicit bounded request. The input revision in this
entrypoint binds only the submitted snapshot; it is not proof that external
GitHub/Drive state is fresh.

## Mixed per-question completion

A step may contain several questions whose explicit completion rules request different
follow-ups. The runner preserves those dispositions in `assessment.by_question` and
returns every distinct follow-up in `next_actions`. It does not impose a universal
`hold > reframe > need_evidence > continue` ordering. `next_action` is populated
only when exactly one distinct follow-up exists; otherwise it is null and callers must
inspect `next_actions` / `by_question`. Any non-`continue` blocking follow-up stops
a primary cascade, but the reasons remain separate.

## Internal five execution forms

The trusted-host runner supports `single`, `cascade`, `cross-check`, `compose`
and `escalate`. It preserves all outcomes, stops at budget/deadline/cancellation,
and never retries paid inference automatically. In `compose`, data-reading
restrictions are intersected transitively: summarizing data does not declassify
it. A shadow can neither replace the primary result nor become its input.

Trusted code may supply explicit per-step `completion` rules for Choice, Noul or
Score. Choice rules specify accepted labels and optional native confidence or
selected-label margin. Numerical rules specify accepted intervals. Their unmet
condition explicitly chooses `continue`, `need_evidence`, `reframe`, or `hold`.
These are execution policies, not calibrated truth estimates. Missing native
confidence is not imputed. Existing plans without these rules retain their
legacy acceptance behavior.

The default direct `evaluateWithTrace` bridge remains synchronous for callers
that explicitly use it. `comparison_mode: 'primary-only'` skips shadow work;
`comparison_mode: 'synchronous'` performs and waits for the configured comparison.
Normal app calls select primary-only. No detached Promise or background-function
claim is substituted for a durable worker. The primary-only mode saves shadow
calls by not doing them; it does not secretly collect comparison data later.

## Native result compatibility

Capabilities retain provider identity, available modalities, question kinds,
confirmation evidence and `primary`/`shadow`/`off`. Current public Jev capabilities
are fixed Choice/Noul over text state. OpenAI Decisions remains an unavailable
shadow port. Clef is not wired in this candidate. Image/video/audio support in an
upstream model is not proof of an operational plugin input path.

`answered`, `unsupported`, `unavailable`, `unauthorized`, `invalid`, `timeout`,
`cancelled`, `stale`, `rate_limited`, `error`, `budget_exhausted` and `skipped` are
distinct. Choice's `unknown` remains an answer, not a transport error.

The common normalizer supports two separate Score meanings:

1. Legacy bounded scalar: question `min`/`max`/`rubric`, native score in that range.
2. Ordinal SystemOne form: question `criteria` is an ordered list. Native answer
   must preserve matching `legend`, all option `probabilities`, and its expected
   category index as `score`. Optional `confidence` remains provider-reported.

Ordinal probability mass and expected index are checked with a bound for
independent four-decimal rounding. Values are not silently renormalized or
recomputed for output. Wrong labels, scale/order, missing bins and inconsistent
expectations are rejected. A native answer `type`, when present, must match the
question kind. Ordinal means and confidence are not event probabilities. This
format support is not a Clef live-response or calibration qualification.

## Trace

Create-only records use the existing Store under
`fabric/<principal-hash>/<run-id>/<sequence>`. They hold policy/plan hashes,
question/state hashes, result provenance, finite answers, usage, statuses,
completion assessments and selected next action. Raw state, credentials, raw
revision strings and arbitrary exception text are not stored. Even this metadata
is private. Trace is neither a full input archive nor a resumable checkpoint.

Journal failures are surfaced as incomplete and do not repeat successful paid
inference. After a persisted run, the application privately reads back only the
final trace record and returns `x-jev-trace-readback: verified|unverified`; trace
contents remain private and no public trace retrieval tool is added. A failed
readback does not replay paid inference. A timed-out store operation may finish
later without an acknowledged write; it is not retroactively claimed as persisted.
Test transport, recorded replay and live transport remain different evidence modes.

## Qualification and rollback

The source was assembled from the recovery base, the complete Fabric changes,
the existing recovery patch and the one-line trace-test output repair.
PROVENANCE.json records the immutable inputs, runtime fingerprints and the
public configuration transformations. The bundled lock is newly generated;
it is not claimed byte-identical to the deployed lock.

N02's 215 passing software tests and production calls are retained evidence.
Release checks cover the source packaging, offline example and configuration
delta; they are not additional model-quality cases or a new deployment.

`JEV_FABRIC_PLAN_ENABLED=false` removes the finite-plan tool; also disabling
`JEV_FABRIC_ENABLED` restores the legacy evaluator. Environment changes on a
deployed site require that site's normal deployment process. Preserve grants,
storage and question definitions. Do not roll back by resetting those assets.

The existing gateway maintainer remains responsible for the deployed service.
Test counts are not empirical model cases or user acceptance.
