export type QuestionSpec =
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } };

export const OPS_LIVENESS_V0: Record<string, QuestionSpec> = {
  Q01: { type: "choice", instructions: "For the bounded scope represented by this state, what completion stage is established? Do not generalize a local completion to campaign completion. Use unknown when the terminal scope cannot be established.", criteria: {
    scope_closed: "Explicit terminal evidence closes this same bounded scope with no remaining authorized successor in that scope.",
    local_milestone_only: "A local deliverable or milestone is complete but a stated successor remains open.",
    work_open: "Work remains and no local completion milestone is established.",
    unknown: "Completion or requested terminal scope cannot be established from the supplied state.",
    conflicting: "Same-scope authoritative completion evidence conflicts."
  }},
  Q02: { type: "choice", instructions: "What substantive progress is actually established in this state? Distinguish artifact creation, receiver consumption, product execution, and evidence/status-only updates.", criteria: {
    author_output_received: "The intended receiver is reported to have obtained and consumed author output.",
    author_output_created: "Output exists but receiver receipt is not established.",
    product_execution_observed: "The relevant Product behavior was observed for this successor scope.",
    evidence_or_status_only: "Only reporting or evidence packaging is established, not the requested artifact or Product change.",
    none_recorded: "The state explicitly says there was no substantive change.",
    unknown: "Insufficient evidence to classify progress."
  }},
  Q03: { type: "choice", instructions: "Has the artifact/output been received by the intended receiver? A send attempt or pointer is not receiver readback.", criteria: {
    received_by_receipt: "Receiver-side receipt/readback is present.",
    pointer_only: "Only a name, link, path, or pointer is present.",
    send_only: "A send attempt exists without receiver readback.",
    not_received: "A current receiver observation explicitly says it was not received.",
    unknown: "No adequate delivery evidence.",
    conflicting: "Current receiver observations conflict."
  }},
  Q04: { type: "choice", instructions: "Is the next work item concrete enough to execute? Judge whether object, check, and exit condition are specified. Do not invent a next step.", criteria: {
    concrete: "Object, check, and exit condition are specified.",
    vague: "A next step exists but only at a general level.",
    explicitly_missing: "The current state explicitly says no next step exists.",
    not_needed: "This same scope is terminal.",
    unknown: "Evidence does not establish the quality of the next step."
  }},
  Q05: { type: "choice", instructions: "Is a task-scoped accountable party for the next work explicitly identified? Do not infer ownership from general role labels.", criteria: {
    identified: "A task-scoped accountable party is explicitly identified.",
    explicitly_unassigned: "Accountability is explicitly unassigned.",
    conflicting: "Multiple incompatible sole owners are asserted for the same scope.",
    not_needed: "The scope is terminal and accountability is closed.",
    unknown: "No adequate accountability evidence."
  }},
  Q06: { type: "choice", instructions: "What is the current repository-writer assignment state for the next write, if any? Historical writers are not current assignments.", criteria: {
    selected: "A current exact writer assignment is recorded; further guards may still apply.",
    pending_selection: "Selection awaits stated scope or authority checks.",
    missing_required: "An action is purportedly executing while its required writer is explicitly unassigned.",
    not_needed: "No repository write is needed in the current phase and none is pending.",
    conflicting: "Conflicting active writers or bindings exist.",
    unknown: "Binding evidence is insufficient."
  }},
  Q07: { type: "choice", instructions: "Is there observed successor-specific coverage that would start or wake the next bounded work? Policy alone is not an observed wake/start event.", criteria: {
    coverage_recorded: "A successor-specific start event or bounded scheduled wake is recorded.",
    manual_only: "The state explicitly says only a manual wake can resume this successor.",
    explicitly_absent: "A live readback explicitly establishes no successor wake/start coverage.",
    not_needed: "This scope has no remaining successor.",
    unknown: "The successor event/timer/readback was not observed."
  }},
  Q08: { type: "choice", instructions: "What wait reason is established for the successor, if any? Do not convert unobserved state into a blocker.", criteria: {
    execution_precondition: "Scope, authority, or writer-selection checks precede execution.",
    active_dependency: "A specifically identified dependency is actively running.",
    intentional_pause: "An authorized pause of this successor itself is stated.",
    owner_gate: "An exact Owner-only decision explicitly gates this successor.",
    not_waiting: "The successor is executing or complete, not waiting.",
    unknown: "No adequate wait rationale."
  }},
  Q09: { type: "choice", instructions: "How broadly can the recorded blocker or prerequisite be generalized? Do not elevate a local fault to a global stop without evidence.", criteria: {
    action_only: "The prerequisite/fault is tied to one action; no global stop is proven.",
    shared_dependency: "Multiple named nodes share a documented dependency.",
    global_proven: "Every remaining authorized node is verified to share the same gate.",
    no_blocker_reported: "The relevant task explicitly has no blocking prerequisite.",
    unknown: "No adequate scope evidence."
  }},
  Q10: { type: "choice", instructions: "Does the supplied state establish a new Owner-only decision gate? Do not treat ordinary delegated technical preconditions as Owner approval requirements.", criteria: {
    owner_only_boundary_proven: "An actual Owner-only boundary change is established.",
    boundary_check_first: "A possible boundary issue needs inspection before deciding whether Owner action is required.",
    delegated_preconditions: "The step is within documented delegation subject to exact preconditions; this grants no lease.",
    not_needed: "No decision or execution is pending.",
    unknown: "Relevant authority or actual change is unobserved."
  }},
  Q11: { type: "choice", instructions: "How far does the currently supplied evidence support the asserted successor operation? Evidence for a predecessor or different scope is not exact-scope proof.", criteria: {
    exact_scope: "Evidence covers the asserted operation on this exact successor.",
    partial: "Evidence covers the author artifact or predecessor only in part; successor behavior remains unobserved.",
    other_scope_only: "Only unrelated or obsolete-scope evidence is present.",
    none_observed: "No pertinent evidence is observed.",
    conflicting: "Same-operation evidence conflicts.",
    unknown: "Evidence scope cannot be assessed."
  }},
  Q12: { type: "choice", instructions: "Do summary and detailed records describe the same scope and time consistently? Scope mismatch is not automatically a true contradiction.", criteria: {
    consistent_same_scope: "Summary and details explicitly agree for the same scope/time.",
    scope_mismatch: "They plausibly describe different scopes; using the summary as task completion would mislead.",
    true_conflict: "They make incompatible claims about the same field, scope, and time.",
    unknown: "Scope or time semantics are insufficient for classification."
  }},
  Q13: { type: "choice", instructions: "Should collection or notification be repeated? Avoid retrying when receiver receipt already exists; distinguish unknown outcome from explicit retry conditions.", criteria: {
    do_not_repeat_received: "Receiver receipt already exists; avoid redundant delivery or recapture.",
    readback_before_retry: "Outcome is unknown and receiver readback is needed before any retry.",
    retry_condition_met: "Explicit failure and an authorized bounded retry condition are both established.",
    not_applicable: "No delivery is involved.",
    unknown: "Evidence is insufficient."
  }},
  Q14: { type: "choice", instructions: "What can be said about proceeding to another safe work item? Policy permission alone is not evidence that an actual ready node exists.", criteria: {
    ready_node_observed: "A named authorized nonconflicting ready node is observed.",
    policy_only_no_node_observed: "Policy permits continuation, but no actual ready node was read in this state.",
    none_ready_confirmed: "A complete current queue readback explicitly confirms no ready nodes.",
    unknown: "Policy or queue observation is insufficient."
  }},
  Q15: { type: "choice", instructions: "Is the reentry condition executable as written? It should identify the bounded object and the checks required to reopen it.", criteria: {
    actionable: "The condition identifies the bounded object and checks needed to reopen the action.",
    missing_condition: "A blocked action explicitly lacks a reentry condition.",
    vague: "A condition exists but cannot be tested as written.",
    not_needed: "No blocked or pending action remains.",
    unknown: "Condition evidence is insufficient."
  }},
  Q16: { type: "choice", instructions: "Does the state actually prove a time-overdue/stalled successor? Require an explicit deadline plus sufficiently complete current observation; absence of evidence is not proof of a stall.", criteria: {
    overdue_observed: "An explicit successor deadline is exceeded and no later successor progress is observed in a complete event readback.",
    within_window: "A scoped deadline exists and the complete current observation remains within it.",
    not_waiting: "This successor is observed executing or terminal.",
    unproven: "A deadline, live observation, or complete event readback is missing.",
    conflicting: "Temporal evidence is inconsistent."
  }}
};

export const QUESTION_SETS: Record<string, Record<string, QuestionSpec>> = {
  "ops-liveness-v0": OPS_LIVENESS_V0,
  "synthetic-smoke-v0": {
    should_continue: {
      type: "noul",
      instructions: "Does the supplied state explicitly indicate that another bounded unit of work is ready to continue now?",
      criteria: {
        true: "A bounded ready successor is explicit.",
        false: "No bounded ready successor is explicit."
      }
    }
  }
};

