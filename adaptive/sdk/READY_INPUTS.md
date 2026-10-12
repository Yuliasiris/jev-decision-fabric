# Keep independent work moving when an input is missing

The host's ordinary PlannerPort should admit the units that are currently executable. Keep a requested unit with missing input in the actual caller record (`requested_units`, `pending_inputs` and its reentry condition); do not register it as completed or pretend its input was read. C0 `Result.pending` contains admitted tasks, so clients also display the caller's pending-input record and `paused_reason`.

For example, A is readable while B has not been supplied. The caller initially proposes A and an unstarted reporter. After A's real observation is durably saved, `next` returns `action: {kind: 'pause', reason: 'B is missing; A is saved. Supply B and continue within the original limits.'}`. Preserve the run's snapshot. Restore it under the current writer/readback checks, then explicitly call `continue()` and `run()` after B is available.

The fresh proposal can add B and update the unstarted reporter's `reads` through the existing candidate/decision port. Bind B's actual revision and SHA in the existing registered reader's validated Task input. Do not rewrite the original Request SourceViews, reset D/budget, expand capabilities or issue permissions. The worker's completed Observation retains B's actually read text, revision, origin, range and hash. An initial omitted view, locator or hash alone is never a read.

The host verifies the registered input ID and source references, current data/send rights, exact input freshness, actual I/O and original archive. A planner cannot relabel A's bytes as B or turn a missing/denied unit into an authorized one. If permission/readiness fails after admission, the existing global hold remains in force. Deferred work that needs a new capability or permission requires another properly authorized admission.

The raw final cites actual accepted reads and preserves remaining uncertainty. If B is still unavailable, keep the run paused rather than finishing and then trying to reopen it. Original parent limits include the additional caller/decision reservations.

The focused missing-input example uses actual temporary-file reads and disk-backed snapshots/archives, with a scripted caller/final and injected decision. It demonstrates this local registered-reader pattern, not a real native planner, live Jev, production crash fencing or whole-Goal completion.
