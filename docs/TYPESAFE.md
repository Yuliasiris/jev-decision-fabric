# Bind an existing TypeSafe Jev connection

Import the published adapter from `jev-decision-fabric/typesafe`.
It reuses the existing reviewed serializer, normalizer and finite runner for
one host-side `next-task-preview-v1` Choice selection.

~~~ts
import {createTypeSafeDecision} from 'jev-decision-fabric/typesafe';

const decide = createTypeSafeDecision(
  hostOptions,
  {signal: originalParentSignal, deadline_ms: originalDeadline},
  'live',
  privateTraceStore,
);
~~~

Construction does not read a credential or call the provider. The trusted
host binds this DecisionPort to the SDK's host.decision for the original
admitted selection. It supplies the current input/candidate set and retains
the original controller boundary, cancellation and deadline.

## HostOptions

| Field | Actual host responsibility |
|---|---|
| `model` | Current approved Jev model for this connection |
| `authorize(wire)` | Current source/data-send, purpose, recipient and original allocation authority over the exact reviewed wire |
| `getCredential()` | Read the existing host-local credential at invocation; no new key is created or discovered |
| `record(event)` | Durably acknowledge private prepared-wire, transport and raw response records before/after the effect |
| `send` | Optional existing transport; the default is native fetch |

The adapter is fixed to the TypeSafe SystemOne HTTPS endpoint. WireReview
exposes nonsecret method, recipient, model, questions, actual UTF-8 body and
body identity for the trusted check. It excludes credential values.
It rechecks authority over actual bytes after journal waiting and immediately
before send. The private journal may contain actual selected source/state and
raw replies; keep it under the host's current data/storage permissions.

Use the original trusted allocation/readback for this exact selection.
A key, model name, local configuration or WireReview self-hash is not that
authorization. Unavailable or unknown quota/monetary coverage remains
unavailable/unknown according to the actual host policy; the adapter issues
no allowance.

## One physical attempt

One adapter instance reserves at most one physical POST and performs zero
automatic retries. The transport is bounded by 15 seconds or the earlier
parent/runner boundary. Reusing the instance cannot begin a second paid call.
A lost response, timeout, 429 or unknown outcome does not release a fresh
allowance or authorize a resend.

If a later fresh decision is needed, the host must establish its real new
selection grant inside the same remaining original run budget/deadline,
then bind another one-use port for that new admitted decision. Do not
recreate the adapter inside a retry loop for the same effect.

Use `mode: 'live'` only for an actual native provider path. Host-injected
transport retains its own injected qualification and original receipt.
The caller/worker/final remain separately authorized ports: one Jev selection
does not cover a separate paid native planner/final operation.

This SDK port carries a custom host-side question. It does not tunnel that
request through the installed fixed-question MCP tools, change their four
sets, widen OAuth or replace the production Netlify root.

The published connection point does not prove that this project's current
runtime parent, original allocation reader or fresh native producer is bound.
Those real handles still require their own same-run execution/readback.
