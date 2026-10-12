# Host-owned connections and authority

Your host owns existing accounts, capability registration, readable sources,
provider allocation, invocation lifecycle and durable storage. The SDK accepts
callbacks to those connections; it does not discover credentials, create an
account, issue an allocation or add a remote provider from JSON.

The ordinary caller supplies a request. Trusted host code constructs the
original frame, capability catalog and NativeAdmission, then binds the ports
below. Secrets stay in the host's existing secret manager/environment and
are not written into public source, snapshots sent to a model, or tool args.

## Required bindings

| Binding | The host supplies and verifies |
|---|---|
| `host.signal` | Current cancellation of the original admitted parent |
| `authorizeEntry()` | Actual current parent, writer and entry permission before effects |
| `checks.acceptNativeAdmission(admission, request)` | Original clock/deadline/profile binding and approved native ceiling |
| `checks.validateInput(capability, input)` | That registered operation's real input contract |
| `checks.authorize(task, sources, reads)` | Actual source/read/derived-data send permissions for this task |
| `checks.isCurrent(frame)` | Current revision, attempt and input binding |
| `planner.initial / next` | Existing capable planner returning a proposal and original receipt |
| `authorizePlanner(context)` | Current exact caller input/source/recipient/purpose and existing physical allowance before/after the save barrier |
| `verifyPlannerOrigin(outcome, reservation)` | Actual producer/receipt for that reserved call |
| `worker(frame, context)` | Actual registered worker/tool and original Observation |
| `archiveObservation(record)` | Preserve exact original worker Observation/frame before adoption |
| `verifyObservationOrigin(observation, frame)` | Independent original worker/attempt proof |
| `authorizeReconcile(input, snapshot)` | Current permission to read/consume actual saved effect evidence without minting a new invocation |
| `decision(input, context)` | Existing authorized decision connection, current candidate set and DecisionBoundary |
| `final(frame, context)` | Fresh final producer over accepted explicit reads, original bytes and receipt |
| `verifyFinalOrigin(reply, frame)` | Independent original producer/run/attempt proof; live means a new call |
| `archiveFinal(record)` | Durable verbatim raw bytes and exact frame before final adoption |
| `save(snapshot, reason) / readback(snapshot)` | Durable acknowledgement and exact saved wrapper verification |
| `acceptSnapshot(snapshot)` | Latest saved wrapper, exclusive writer, parent limits and replay fence |
| `restoreChecks.acceptCheckpoint` | Durable checkpoint origin, readable data and same controller |
| `restoreChecks.verifySettlement` | Existing host evidence of a pending effect's outcome |
| `evidenceText(observation)` | Actual textual projection available to the final quotation checker |

A boolean in a request or model answer is not the implementation of any
permission check. Apply your existing auth/source/worker policies in these
callbacks. The execution ports also retain their current provider-specific
quota, allocation, price and cancellation checks at the actual invocation.

Do not treat a hash/locator as read source text. A SourceView contains actual
text, revision, origin, range and omission. A task receives its authorized
source views and only the previous observations named by reads. It does not
receive every planner/worker observation by default.

## Provider and model independence

planner, decision, worker and final are separate ports. A host may bind
different existing providers and tools, or one existing caller for several
roles, without changing the generic controller. Report the actual provider
and physical invocation identity in the origin receipt. Using the same Jev
several times is not independent-provider evidence.

When you bind a real Jev DecisionPort, construct its allowed request from the
current controller boundary and reviewed candidate/state. Use the host's
legitimate current service connection and inference allocation. Preserve its
actual response mode, origin, nullable usage and native values. Do not
rewrite a transport error, 429 or timeout as an answered negative.
A callback that returns a fixture remains scripted/injected.

The published finite-question MCP tools retain their four meanings. They do
not accept the SDK's custom next-task request. To use a custom decision, bind
the actual host-side connection that supports it. New access, allocation or
purchase is outside the callback contract.

## Source storage and recovery

Use one controller and one exclusive current writer for each run. Save the
SDK wrapper and checkpoint before starting an admitted effect. An acknowledged
save must be recoverable by the host; an in-memory Map or log alone does not
qualify process-restart durability.

After interruption, fence the old writer before a replacement writer resumes.
Read the original attempt/effect state. A lost response can mean completed,
still running, unknown or not started. Match exact run/attempt/input identity
and preserve original usage even when content cannot be adopted. Unknown
outcomes are not automatic retry permission.

A plain JSON snapshot carries data and limits. `acceptSnapshot`,
`acceptCheckpoint`, current source grants and settlement witnesses confer the
restore authority. Restore retains the original absolute deadline and
budgets, including planner reservations. An expired run remains expired.

## SDK and OAuth routes

SDK ports run inside your own host using your existing connection callbacks.
This route does not require a ScienceLab account or the project's production
Owner session.

The existing Netlify finite-question server uses its existing OAuth format.
Its registered redirects are limited to ChatGPT; the SDK release does not
expand that list, scope or public HTTP routes. If you self-host that server,
you own its origin, secrets and enrollment configuration. The supplied
.env.example contains names and placeholders, not credentials or an
authenticated enrollment.

The optional MCP work adapter also does not issue a login. Its transport
obtains the actual principal and cancellation signal, then binds a
HostWorkService. SDK capability checks still run at effect boundaries.
Service configuration, model text or tool arguments cannot supply a trusted
principal or newly authorize effects.
