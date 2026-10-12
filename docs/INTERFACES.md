# Interface capability contract

These are distinct interfaces over shared project code. The existing Plugin
and Netlify finite-question server keep their current behavior. A host can
bind the SDK work service through the optional MCP adapter without replacing
those routes or widening their OAuth grants.

## SDK

`createWork` admits an ordinary request with host-supplied frame/catalog,
original NativeAdmission, PlannerPort and WorkHost.
`run.run()` executes bounded authorized ports; `outcome()` reads records;
`snapshot()` returns the wrapper that the host durably saves.
`restoreWork`, explicit `reconcile` and caller `continue` retain the same
controller, deadline, budget and recorded effects.

SDK connection callbacks are required. A source package does not supply live
Jev, native planner/final, allocation evidence or a credential store.

## Optional host-bound MCP

Import from `jev-decision-fabric/mcp`:

~~~ts
import {
  workToolDefinitions,
  callWorkTool,
  createWorkMcpHandler,
} from 'jev-decision-fabric/mcp';
~~~

Bind a real HostWorkService and a caller supplied by your trusted transport.
Without a service, `workToolDefinitions()` returns no new tools.

| Tool | Exact arguments | Action |
|---|---|---|
| `work_start_v1` | `request`, `request_id` | Admit the ordinary request once for this principal/id |
| `work_continue_v1` | `run_id` | Continue its saved work under original limits |
| `work_status_v1` | `run_id` | Read current result and unresolved work |
| `work_cancel_v1` | `run_id`, `reason` | Request cancellation and preserve saved evidence |

`request_id` is a client idempotency key retained for readback after a lost
response. Before effects, start must durably bind principal + request_id +
exact request. An identical repeated request reads the original run; a
conflicting request does not start another run. Unknown effects are not
resent.

HostWorkService implements authorize/start/continue/status/cancel. The
transport supplies `{principal, signal}` outside tool args. The adapter
validates argument shape, checks authorization before and after service work,
and returns the C0 Result with advisory authority and automatic_apply false.
The SDK host rechecks actual grants at each effect too. This contract does
not provide an authenticated server or make JSON fields into grants.

A reference stdio host is a local process example. Its local caller binding
and scripted planner are separate from network authentication and real Jev
qualification. To register an actual MCP host in a client, use the client's
normal supported transport and your host's legitimate authentication.

## Existing fixed-question MCP and Plugin

`decision_evaluate(question_set,state)` and `decision_run_v1(plan)` use the
existing fixed sets:

- ops-liveness-v0;
- roi-delta-v0;
- music-routing-v0;
- synthetic-smoke-v0.

The latter is a finite plan of at most eight steps, using the same connected
Jev provider. It is advertised only when enabled in that service. The old
tools do not dispatch SDK workers, restore a WorkSnapshot, fetch private URLs
or accept custom SDK/J1 questions.

The current installed Plugin's fixed two-tool exposure does not prove delivery
of the optional work adapter, version 1.0.1 manifest, new description or Skill.
Check the actual tool list of the connection in use. Generic host work is
available only through a separately bound host service that advertises those
operations; it is not silently inserted into the old tool state.

## Comparison

`jev-decision-fabric/evaluation` supplies paired comparison and scoped policy
profile ports. A trusted host binds the actual single/fixed/adaptive runners,
original receipt attestation and final scoring. Serialized manifests/results/
profiles contain evidence and policies, not invocation permissions or
connections. Read the implementation's exported contract before providing
a runner; do not call an injected reply measured quality evidence.
