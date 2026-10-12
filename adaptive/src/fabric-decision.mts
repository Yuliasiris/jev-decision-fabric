/** Trusted-host preview question. Never routed through either fixed public tool. */
import {runPlan, digest} from '../../netlify/lib/decision-fabric.mts';
import type {Provider, TraceStore, RequestData} from '../../netlify/lib/decision-fabric.mts';
import type {DecisionPort, EvidenceMode, JSONValue} from '../contract/c0.mts';

export const TEMPLATE_VERSION = 'next-task-preview-v1';
/** Exact logical request shared by offline inspection and the unchanged bounded runner. */
export function prepareDecisionRequest(input: Parameters<DecisionPort>[0]): RequestData {
  if (input.candidates.some(c => c.id === 'hold')) throw new Error('reserved candidate ID');
  const state = {objective: input.request.objective, requested_output: input.request.requested_output,
    plan_version: input.plan_version, candidates: input.candidates, observations: input.observations};
  return {question_set: TEMPLATE_VERSION, questions: {next: {type: 'choice' as const,
    instructions: 'Select a useful supplied candidate, or hold for missing evidence. Selection grants no authority.',
    criteria: Object.fromEntries([...input.candidates.map(c => [c.id, c.purpose]), ['hold', 'Insufficient basis to continue']])}},
    state, modalities: ['text'] as const, revision: digest(state)};
}
export function fabricDecision(provider: Provider, mode: EvidenceMode, store?: TraceStore): DecisionPort {
  if (provider.capability.mode !== 'primary') throw new Error('preview decision requires a primary provider');
  const memory = new Map<string, unknown>();
  const trace = store ?? {create: async (key: string, value: unknown) => {
    if (memory.has(key)) return false;
    memory.set(key, structuredClone(value)); return true;
  }};
  return async input => {
    const request = prepareDecisionRequest(input);
    const run = await runPlan({topology: 'single', primary: 'select', policy_id: TEMPLATE_VERSION,
      max_calls: 1, timeout_ms: Math.max(1, Math.min(60000, Math.floor(input.timeout_ms))),
      steps: [{id: 'select', provider: provider.capability.id, request,
        scope: {readers: [provider.capability.id]}}]},
    {providers: [provider], principal: input.request.run_id, store: trace,
      evidence_mode: mode === 'live' ? 'live_transport' : mode === 'injected' ? 'injected_transport' :
        mode === 'recorded_replay' ? 'recorded_response' : 'unverified'});
    const selected = run.selected?.answers?.next?.value;
    return {candidate_id: run.status === 'answered' && typeof selected === 'string' && selected !== 'hold' ? selected : null,
      status: run.status !== 'answered' ? 'failed' : selected === 'hold' ? 'hold' : 'selected', mode,
      record: {template_version: TEMPLATE_VERSION, candidate_ids: input.candidates.map(c => c.id),
        state_digest: digest(request.state), trace_storage: store ? 'host_supplied' : 'in_memory',
        run: run as unknown as JSONValue}};
  };
}
