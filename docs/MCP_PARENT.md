# An ordinary parent over the optional work MCP service

`examples/work-parent.mts` is a reusable local client for the already-shipped
reference stdio host. It sends an ordinary request and saves a stable request_id.
The caller does not write a graph, task JSON, grant or planner.
The existing host constructs its registered work and keeps the canonical SDK
snapshot. This example publishes the same initialize, initialized, tools/list,
tool call and separate-process readback path used by the clean-install client.

After the normal build, run:

~~~sh
node dist/examples/work-parent.mjs --help
node dist/examples/work-parent.mjs --state ./private/host --receipt ./private/parent.json --request "Calculate the total and mean" --pause-after-read --format text
node dist/examples/work-parent.mjs --receipt ./private/parent.json --operation inspect --format text
node dist/examples/work-parent.mjs --receipt ./private/parent.json --operation continue --format text
node dist/examples/work-parent.mjs --receipt ./private/parent.json --operation status --format text
~~~

The start returns saved unfinished work, its original request/run identity,
pending work and a concrete command using the same receipt. Inspect displays
that saved record without contacting the host. Continue returns the actual
reference calculation: total 720, mean 240, count 3. You do not reconstruct the
original state directory, request ID or request text for inspect/continue/status.
The result's original run_id, provenance, unresolved work and nullable usage remain
available beside the readable answer. The launching parent must read that
line; writing stdout alone is not confirmation of another application's receipt.
The focused regression launches real parent/server processes and consumes
their output, checks the saved original admission/budget and unchanged read
attempt, then reads the result from a third process.

`--format text` foregrounds the answer and labels whether it came from a fresh
verified host operation or cached saved evidence. It separately shows earlier
unknown operations, unconfirmed host closes and the next safe command. A fresh
status may return an answer while an earlier continue remains unknown; both
facts stay visible and another continue is not suggested. If a current readback
fails, the old answer is labeled cached and the failure remains visible.

The default format remains one `ordinary-parent-message` JSON line with the
existing fields. Use `--format json` explicitly if preferred. `--operation inspect`
returns a saved-client-receipt projection: result_is_cached is true when a saved
Result exists, current_operation is null, and no new host readback is claimed.
Inspect does not create directories, obtain a lock, append history, connect,
resend an operation or alter the file. `--help` and invalid format checks run
before accessing a receipt. Human errors use stderr with a safe inspect command
when a receipt is known, rather than an internal stack trace.

`--request-id` is optional. On the first start the client generates its ID inside
the existing receipt lock and durably saves/readbacks it before connecting.
An identical start with the ID omitted reuses the saved ID and state directory;
it reads the local receipt without sending again. A different request, explicit
ID or state directory conflicts with that receipt. A lost response never causes
ID regeneration. Supplying your own stable ID remains supported.

For the other supported reference request, use a separate receipt and state
with "Compare the two policy texts". These two request shapes use scripted
planner/final code and actual packaged-file reads/calculation. They do not call
Jev or a native model. The parent text is a projection of an original C0 Result,
not a fresh native final or a second authenticated host. This does not close
J1 or the whole OSS Goal.

The client first lists the actual tools and checks the requested work operation's
argument fields. A connection advertising only decision_evaluate or
decision_run_v1 remains the existing fixed-question Plugin; the client stops
before a work call. It never places SDK work inside an old question's state.
See [interfaces](INTERFACES.md) for this distinction and [host connections](HOST_CONNECTIONS.md)
for the real authorization callbacks.

The private parent receipt is a **client request/response journal**, separate
from the host's canonical state directory. It records exact request/id/state,
one attempted operation, bounded verbatim JSON-RPC replies and readback digest.
It has no provider key, authenticated principal, active lease, admission clock,
controller checkpoint or effect-settlement authority. Its file lock prevents
concurrent client journal edits; the host's original writer lock and SDK checks
still govern effects. Do not use this file to extend the original deadline,
reset a budget or replace a host writer. Treat both directories as private.

Before a work call the exact operation is saved and read back. The example
performs one tools/call per explicit operation. A repeated identical start
reads the saved client receipt without reconnecting; a conflicting request/id
or state is rejected. The HostWorkService's separate idempotent start-readback
contract does not make this client automatically resend a lost call.
That local receipt projection reports delivery=saved_client_receipt,
current_operation=null and result_is_cached=true when it has an old Result.
It is not a new verified host response; the original operation history stays
in the private journal.

If a start reply is lost, run_id stays null. The client preserves the original
request_id and points to actual host readback/reconciliation; it does not
fabricate a run_id, regenerate an id, or call status without a known run.
If a continue reply is lost, another continue is rejected. An explicit status
may read the original known run through the currently authorized host even
when an earlier transport close is unconfirmed. It neither infers that the
old host exited nor settles the uncertain prior operation. A verified current
Result stays available beside the historical unknown status; old operation
dispositions and close records are retained. A lost start with no known run
still cannot call status. Tool errors,
wrong identities, text/structured mismatch and oversized replies are not
converted into successful results. Preflight failure reports no work call
and requests inspection of the original connection; it does not suggest an
unusable status call. This small example does not implement an authenticated
host settlement/readback API or automatic recovery of unknown operations.

Each parent message includes the current operation's disposition, error and
host-close confirmation. If a new status or preflight fails after an earlier
result, the old Result remains available with result_is_cached=true and the
message reports readback_unconfirmed. It does not display the old answer as a
new successful response or suggest continuation from a failed current readback.
A later explicit verified status may confirm the current Result; it does not
clear an older uncertain mutating operation.

Normal EOF closes the reference host and releases its own writer lock. Mutating
continuation after an unconfirmed close, crashed writer or unknown effect
requires actual host fencing/reconciliation. Read-only status still uses the
host's existing caller and writer checks; it cannot break a surviving lock or
grant permission to continue. Never remove a lock to force a restart. The transport
uses a bounded reply wait; timeout does not revive the original three-minute
admission. The journal is bounded to 32 explicit operations and 20 MiB; replies
are at most 512 KiB. Oversized bodies are not written into the journal.
File save/readback and graceful restart are qualified; power-loss and coherent
storage rollback are outside this example's evidence.

`runParentOperation` also accepts a trusted caller-bound ParentTransport port.
Bind the real supported client transport/authentication in code, outside tool
arguments. The returned qualification is client-only: this function cannot
attest a remote host's planner, provider, native origin or I/O from its Result.
No account, login, grant or real connection is supplied by the example.

`inspectParentReceipt(path)` reads the exact same client journal, returning its
detached immutable journal and cached ParentMessage. The pure
`renderParentText(message, {receiptPath, command, journal})` helper in
`examples/work-parent-view.mts` provides the same human view. Neither function
changes host state or authorizes an effect. Command arguments are shell-quoted;
the example's displayed commands use POSIX shell syntax. Original budgets and
deadline remain with the host, and unavailable remaining limits are not invented.

Run only the focused new client regression with:

~~~sh
node --experimental-strip-types --test adaptive/test/mcp-parent-view.test.mts
~~~

The view/ID regressions use TEST_ONLY bound transports, saved temporary receipts
and real client code for errors, cached/fresh distinctions and recovery guidance.
They do not supply native/paid provider evidence. The existing
`mcp-parent.test.mts` separately retains actual local response-loss, request-ID
conflict and early-exit regressions; its fault witnesses are also test-only.
