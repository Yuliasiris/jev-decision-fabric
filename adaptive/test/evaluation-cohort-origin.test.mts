import test from 'node:test';
import assert from 'node:assert/strict';
import {EVALUATION_VERSION, STRATEGIES, EvaluationError, digest, runPairedComparison,
  createPolicyProfile} from '../evaluation/index.mts';
import type {ArmReceipt, ConditionManifest, Grade, PairedComparison, PolicyProfile,
  Strategy, StrategyRunners} from '../evaluation/index.mts';

const sha = (text: string) => digest(text); // Hash of explicit TEST_ONLY fixture bytes; never a real source identity.
export function fixtureManifest(id: string, split: 'design' | 'held-out' = 'held-out'): ConditionManifest {
  return {version:EVALUATION_VERSION,case_id:id,task_class:'cohort-guard-fixture',split,input_sha256:sha('fixture input '+id),
    sources:[{id:'source',sha256:sha('fixture source')}],capabilities:['read'],tools:[{id:'read',capability:'read',model:null}],
    models:{single:{caller:'TEST_ONLY_CALLER',selector:null},fixed:{caller:'TEST_ONLY_CALLER',selector:null},
      adaptive:{caller:'TEST_ONLY_CALLER',selector:'TEST_ONLY_SELECTOR'}},
    implementation_sha256:{single:sha('fixture single code'),fixed:sha('fixture fixed code'),adaptive:sha('fixture adaptive code')},
    budget:{max_operations:8,max_decisions:2,max_plan_versions:4,max_parallel:2,timeout_ms:10000},
    deadline_ms:Date.now()+5000,scoring_sha256:sha('fixture independent criteria')};
}
export function fixtureReceipt(m: ConditionManifest, s: Strategy): ArmReceipt {
  return {version:EVALUATION_VERSION,strategy:s,case_id:m.case_id,run_id:m.case_id+'-'+s,manifest_sha256:digest(m),
    input_sha256:m.input_sha256,sources:m.sources,capabilities:m.capabilities,models:m.models[s],
    implementation_sha256:m.implementation_sha256[s],budget:m.budget,deadline_ms:m.deadline_ms,
    mode:'live',outcome:'complete',error_kind:null,actual_tools:[],accepted_reads:[],
    final:{raw_sha256:sha('TEST_ONLY final'),original:{kind:'TEST_ONLY_FINAL'},provenance:[]},usage:null,
    measurements:{latency_ms:10,latency_scope:'TEST_ONLY_FULL_SCOPE',cost:1,cost_unit:'TEST_ONLY_UNIT',original:{kind:'TEST_ONLY_METER'}},
    retry_count:0,original:{kind:'TEST_ONLY_EXECUTION'}};
}
export async function fixtureComparison(id: string, split: 'design' | 'held-out' = 'held-out', favorable = true): Promise<PairedComparison> {
  const m=fixtureManifest(id,split),ports=Object.fromEntries(STRATEGIES.map(s=>[s,async()=>fixtureReceipt(m,s)])) as unknown as StrategyRunners;
  return runPairedComparison(m,ports,{signal:new AbortController().signal,
    attestReceipt:async r=>({status:'verified',receipt_sha256:digest(r),original:{kind:'TEST_ONLY_OFFICIAL_RECORD'}}),
    scoreFinal:async r=>({quality:r.strategy==='adaptive'?(favorable?0.95:0.2):0.7,evidence:1,
      unnecessary_work:0,unnecessary_holds:0,rework:0,re_explanation:0,original:{kind:'TEST_ONLY_SCORE'}} satisfies Grade)});
}
function cannotPromote(cs: readonly PairedComparison[], untrustedCohort?: unknown) {
  const call=createPolicyProfile as unknown as (c:readonly PairedComparison[],token?:unknown)=>PolicyProfile;
  let profile:PolicyProfile;
  try {profile=call(cs,untrustedCohort);} catch(e) {
    if(e instanceof EvaluationError && e.code.startsWith('COHORT_'))return;
    throw e;
  }
  assert.equal(profile.selection,'fixed');assert.equal(profile.evidence_quality,'insufficient');
}

test('verified-looking live arms without original preregistration cannot claim held-out gain',async()=>{
  cannotPromote([await fixtureComparison('new-origin-case')]);
});
test('a favorable subset cannot use a self-declared cohort with an omitted unfavorable held-out case',async()=>{
  const favorable=await fixtureComparison('new-favorable'),unfavorable=await fixtureComparison('new-unfavorable','held-out',false);
  cannotPromote([favorable],{status:'verified',cohort:{cases:[favorable.manifest,unfavorable.manifest]},original:null});
});
test('design case relabelled held-out cannot acquire origin qualification from JSON',async()=>{
  const source=await fixtureComparison('new-design-case','held-out');
  cannotPromote([source],{status:'verified',cohort:{case_id:source.manifest.case_id,original_split:'design'},original:null});
});
test('spent evaluation input cannot acquire a new unused qualification from self-digested JSON',async()=>{
  const source=await fixtureComparison('new-spent-case');
  cannotPromote([source],{status:'verified',cohort_digest:sha('self-digest'),prior_usage:[source.manifest.input_sha256],original:null});
});
