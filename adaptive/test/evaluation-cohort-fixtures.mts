import {EVALUATION_VERSION, STRATEGIES, digest, runPairedComparison, sealEvaluationCohort, verifyEvaluationCohort, profileScope, cohortComparisonDigest} from '../evaluation/index.mts';
import type {ArmReceipt, ConditionManifest, Grade, PairedComparison, Strategy, StrategyRunners, CohortSeal, CohortReadback} from '../evaluation/index.mts';
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
export function sealFor(cs: readonly PairedComparison[], cohort_id = 'TEST_ONLY_COHORT'): CohortSeal {
 return sealEvaluationCohort({cohort_id,scope_sha256:digest(profileScope(cs[0].manifest)),cases:cs.map(c=>({case_id:c.manifest.case_id,
  split:c.manifest.split,input_sha256:c.manifest.input_sha256,sources_sha256:digest(c.manifest.sources)}))});
}
export function proofFor(s: CohortSeal, cs: readonly PairedComparison[]): CohortReadback {
 const admissions=cs.flatMap(c=>STRATEGIES.flatMap(k=>c.arms[k].receipt?[{run_id:c.arms[k].receipt!.run_id,
  admitted_at_ms:c.manifest.deadline_ms-c.manifest.budget.timeout_ms,deadline_ms:c.manifest.deadline_ms,
  budget_sha256:digest(c.manifest.budget),original:{kind:'TEST_ONLY_ORIGINAL_ADMISSION'}}]:[]));
 return {seal_digest:s.digest,comparison_digest:cohortComparisonDigest(cs),registered_at_ms:Math.min(...admissions.map(a=>a.admitted_at_ms))-1,
  current_fence:{kind:'TEST_ONLY_ATOMIC_EVALUATOR_FENCE'},original:{kind:'TEST_ONLY_SAVED_REGISTRATION'},cases:s.cases.map(c=>{
   const result=cs.find(x=>x.manifest.case_id===c.case_id),runs=result?STRATEGIES.flatMap(k=>result.arms[k].receipt?[result.arms[k].receipt!.run_id]:[]):[];
   return {...c,usage_original:{kind:'TEST_ONLY_COMPLETE_USAGE_HISTORY'},uses:[],admissions:admissions.filter(a=>runs.includes(a.run_id))};})};
}
export async function qualify(cs: readonly PairedComparison[]) {
 const seal=sealFor(cs);return (await verifyEvaluationCohort(seal,cs,{signal:new AbortController().signal,
  readCohort:async()=>proofFor(seal,cs)}))!;
}
