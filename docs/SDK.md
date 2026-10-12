# SDK: request, execute, save and resume

Use Node.js 22.13 or later. Build the public source with
`npm run build:sdk`, then install its locally packed tarball into your app.
Runtime package exports resolve to JavaScript under dist; TypeScript type
exports resolve to generated .d.mts declarations in the same dist tree. Node does not run TypeScript directly
beneath node_modules. The build uses its
[standard type-strip API](https://nodejs.org/download/release/v22.13.0/docs/api/module.html#modulestriptypescripttypescode-options)
for runtime code. The existing locked TypeScript 5.9.3 compiler performs strict
checking and emits declarations; no dependency is added. Install the normal
locked development dependencies with npm ci --ignore-scripts before building.

## Public entries

| Import | Entry |
|---|---|
| `jev-decision-fabric` or `jev-decision-fabric/sdk` | `createWork`, `restoreWork`, `WorkRun`, `SDK_VERSION`, SDK/C0 types |
| `jev-decision-fabric/controller` | Original `Controller`, contract error and canonical/digest helpers |
| `jev-decision-fabric/contract` | C0 contract version and types |
| `jev-decision-fabric/checkpoint` | Checkpoint/controller version and types |
| `jev-decision-fabric/evaluation` | Comparison and policy profile ports |
| `jev-decision-fabric/mcp` | Optional host-bound work adapter |
| `jev-decision-fabric/typesafe` | One-selection TypeSafe wire/decision adapter |

The existing C0 and Controller are reused as one implementation. SDK code
does not require ScienceLab or a particular model. The host chooses the actual
planner, decision provider, registered workers/tools and fresh final producer.
Use [the TypeSafe guide](TYPESAFE.md) for an existing one-call connection and
[the comparison guide](COMPARISON.md) for scoped method profiles.

## Bind your current host

`createWork` receives the ordinary request and trusted code bindings:

~~~ts
import {createWork, restoreWork} from 'jev-decision-fabric';

const run = createWork({
  requestText,
  frame,
  catalog,
  admission,
  planner,
  host,
  maxPlannerCalls: 8,
});
const outcome = await run.run();
~~~

These variables are obtained from your host's existing authenticated
admission and connections. They are not a JSON configuration to accept from
a user or model. [Host connections](HOST_CONNECTIONS.md) explains each port.
The ordinary caller supplies requestText; the host resolves the other inputs.

`frame` includes run_id, input_revision, requested_output, source views and
the original budget. `catalog` provides each capability's kind, description,
input description, parallel/cancellation support and current authorization.
At least one authorized caller capability matches `host.finalCapability`.

The initial native proposal is revised into the original controller from its
empty first plan. Set `frame.budget.max_plan_versions >= 2`. Set `maxPlannerCalls` explicitly (1..64). Planner reservations consume the
same original max_operations total as admitted execution/decision requests;
the finite planner ceiling does not reset operation, decision or time limits.

`admission` is the original host-authenticated NativeAdmission: run_id,
profile_id, timeout_ms, admitted_at_ms and deadline_ms. The host checks its
current origin and authorization. Copying these fields is not a grant.
Keep the original parent signal and deadline across planner, decision,
worker, final and storage operations.

The planner's `initial(context)` returns proposed tasks. Its
`next(context)` receives accepted observations and returns dispatch, choose
with explicit candidates, or pause with a reason. The controller validates
the proposal; only unstarted work is revised. `after` imposes ordering.
`reads` explicitly carries a prior observation. Source/derived-data send
permissions are rechecked by the host.

## Read the result and its evidence

`run.run()` returns an outcome containing:

- `sdk_status`: COMPLETE, PAUSED, NEEDS_RECONCILIATION or STOPPED;
- the original C0 `result` and `records`;
- the saveable `snapshot`, planner receipts and final receipt;
- parent_operations_started plus separate execution and planner usage.

`run.outcome()` reads the current outcome without starting work.
`run.snapshot()` creates an immutable save image; it is not itself a durable
write. The SDK calls host.save and exact host.readback at reservation and
observation boundaries. A storage failure stops further effects.

Missing token/cost values remain null. Planner and child invocation costs
are recorded separately; a host must not count the same physical charge
twice. Native/service receipts and latency measurements belong to the actual
ports. Operation counts do not estimate money, correctness or model quality.

## Save and restore the same work

Store the complete WorkSnapshot in your own private durable archive. The
archive must associate it with the original run and a current exclusive
writer, and return an exact readback acknowledgement. Persist private source
views and raw replies according to their actual permissions; do not publish
them as package examples.

On process restart, recover that exact snapshot and original host admission,
resolve the same catalog and actual current connections, and restore:

~~~ts
const resumed = await restoreWork(savedSnapshot, {
  catalog,
  admission,
  planner,
  host,
  restoreChecks,
});
const restoredState = resumed.outcome();
~~~

Restore checks authenticate the latest durable snapshot, original controller
checkpoint, readable source state, current writer fence and effect
settlements. The admission, catalog and final capability remain bound to the
original snapshot. A new process does not receive a fresh budget or deadline.
Expired/cancelled/failed work is not reopened by changing its JSON fields.

Inspect NEEDS_RECONCILIATION before calling run again. The host reads the
original effect's actual state, then calls `reconcile` with one of:

- `{observation}` for the exact original worker attempt;
- `{settlement}` backed by host evidence for a pending controller effect;
- `{planner}` for the original reserved planner outcome;
- `{final}` with the original FinalReply raw bytes for its one pending final frame.

Worker reconciliation requires independent original receipt verification and
archives the original Observation. A final cannot be substituted as an ordinary
worker Observation. Original late usage may be retained without reopening
expired admission. Unknown/still_running effects remain unresolved. The SDK does not resend a
physical effect because a response was lost. It preserves the original
attempt, source revision, admitted plan and usage.

A deliberately paused run requires explicit caller continuation:

~~~ts
await resumed.continue();
const continued = await resumed.run();
~~~

`continue()` clears the pause and requests another planner consideration
under the same limits. It does not run the whole workflow itself. Resolve
pending effects first; paused, failed, cancelled and expired are distinct.

`await run.cancel(reason)` records cancellation under current host authority and
preserves admitted/pending effects. The host implements and observes real child
cancellation; a recorded request does not mean the physical effect disappeared.

## Fresh final

The host final producer returns original UTF-8 JSON bytes and an independent
origin/usage receipt. For live mode it must confirm a new native call. The
SDK archives those verbatim bytes before validating their origin, frame or
provenance; archived bytes alone do not make the run complete.

The final JSON has exactly:

~~~json
{
  "run_id": "the-original-run",
  "task_id": "the-admitted-final-task",
  "attempt_id": "the-original-attempt",
  "input_digest": "the-original-frame-digest",
  "answer": "The ordinary answer.",
  "provenance": [
    {"observation_id": "an-accepted-explicit-read", "claim": "Supported claim."}
  ],
  "unresolved": []
}
~~~

Use actual values from the admitted frame. Duplicate members, wrong frame,
unaccepted or unread references, missing provenance and fabricated quotations
are rejected. `evidenceText` projects actual textual evidence for quotation
checks; a structured numeric worker can supply no quotation text.
Reference/quotation validity does not prove paraphrase truth. Semantic
scoring remains a separate witness.

## Try the packaged reference host

The direct and stdio reference hosts have two supported request shapes:
calculate the total/mean of the packaged numbers, or compare the two packaged
policy texts. They use scripted planner/final code and actual local file reads/
calculation. They send nothing to a model.

~~~sh
node dist/examples/work-sdk.mjs --state ./private/demo --request "Calculate the total and mean" --request-id example-1
node dist/examples/work-sdk.mjs --state ./private/demo --request "Compare the two policy texts" --request-id example-2
~~~

For a graceful saved pause before the remaining work:

~~~sh
node dist/examples/work-sdk.mjs --state ./private/resume-demo --request "Calculate the total and mean" --request-id paused-1 --pause-after-read
# Use the returned result.run_id in the next process
node dist/examples/work-sdk.mjs --state ./private/resume-demo --resume RETURNED_RUN_ID
node dist/examples/work-sdk.mjs --state ./private/resume-demo --status RETURNED_RUN_ID
~~~

Use a private state directory owned by your OS user. The example takes an
exclusive writer lock and stores its actual source bindings/snapshot/result.
The normal exit releases the lock. A crashed or still-running writer requires
actual host fencing/reconciliation; do not blindly remove a lock or resend an
uncertain request. Restoration retains the original three-minute deadline.
This graceful pause/restart recipe is not crash/power-loss qualification.

New reference observation archives and request claims use SHA-256 of the
original UTF-8 ID as their filename key, so an allowed `:` in an ID does not
become a filesystem name. The original IDs, frames, admission, budget and
digests remain unchanged. Existing legacy archives and claims are read without
renaming or rewriting them; a legacy claim must bind the exact original
request ID through its saved admission metadata. Observation readback checks
the original ID, body digest, recorded digest and frame. If both filenames
exist, their records must agree or readback fails closed. This mechanical
matching adds no caller, writer or origin authority. Linux saved-layout and
SDK reconciliation fixtures are qualified; an actual Windows host has not
been tested.

The stdio sample uses the same bounded reference service:

~~~sh
node dist/examples/work-stdio.mjs --state ./private/stdio-demo
~~~

It reads one JSON-RPC message per line from stdin and returns responses on
stdout. Its local process principal is not network OAuth authentication. See
[interfaces](INTERFACES.md) for exact work tool arguments.

## Verify a clean package

`npm run verify:sdk-package` builds the source, obtains npm's dry-run
distribution file list with lifecycle hooks and registry contact disabled,
and copies those same files into a fresh temporary consumer beneath
node_modules. It imports SDK, controller, contract, checkpoint, comparison and
MCP/provider exports. It also compiles a normal strict NodeNext TypeScript
consumer without allowImportingTsExtensions and executes its JavaScript. It
does not install dependencies or invoke your host ports.

Run the source tests for contract behavior:

~~~sh
npm run test:sdk
~~~

Local scripted examples and injected tests qualify their named scope.
To qualify your own service, observe actual admission, planner origin,
decision/provider call, workers, accepted observations, fresh final, durable
save/readback and restart under one original run. Record actual mode and
measured/null usage. A generic adapter interface is not that live evidence.


## Independently ready inputs

The host planner can admit independently ready work while explicitly pausing a dependent missing input. Read the bounded [ready-input pattern](../adaptive/sdk/READY_INPUTS.md) and its actual local I/O regression. The kernel still holds if the caller registers an unauthorized task first; this pattern does not silently skip failed or unknown effects.

The reference host checks its process writer lease, exact saved wrapper/result and original admission. Concurrent mutations are rejected; terminal/expired continuation reads the original qualified result without admitting more effects. Its status projects deadline exhaustion for unfinished work without rewriting the archived evidence. Graceful pause/restart is qualified by its own receipt; forced termination, coherent storage rollback and remote unknown-effect recovery require the actual host's evidence.

## Ordinary parent client

See [MCP_PARENT.md](MCP_PARENT.md) for a packaged client that submits an ordinary
request, saves the original operation identity, and reads or explicitly resumes
the same reference host run through real stdio messages. The client record is
a receipt aid; the host retains its original SDK state, writer and deadline.
An uncertain mutating response remains unresolved and is not automatically
resent. This local example retains the reference host scripted planner/final
qualification.
