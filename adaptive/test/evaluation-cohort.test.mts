import test from 'node:test';
import assert from 'node:assert/strict';
import {createPolicyProfile, verifyEvaluationCohort, cohortEvidence, digest,
  consumePolicyProfile} from '../evaluation/index.mts';
import type {CohortReadback, StrategyRunners} from '../evaluation/index.mts';
import {fixtureComparison, fixtureManifest, fixtureReceipt, sealFor, proofFor, qualify} from './evaluation-cohort-fixtures.mts';

test('complete preregistered original cohort produces a bound opaque token; saved reads do not create another run',async()=>{
  const cs=[await fixtureComparison('fresh-design','design'),await fixtureComparison('fresh-held')],seal=sealFor(cs);
  let reads=0;const token=await verifyEvaluationCohort(seal,cs,{signal:new AbortController().signal,
    readCohort:async()=>{reads++;return proofFor(seal,cs);}});
  assert.ok(token);const p=createPolicyProfile(cs,token);
  assert.equal(p.selection,'adaptive');assert.equal(p.evidence_quality,'held_out_live');assert.ok(p.cohort);
  assert.deepEqual(cohortEvidence(token).identity,p.cohort);
  assert.equal(createPolicyProfile(cs,token).digest,p.digest);assert.equal(reads,1);
});
test('all held-out cases must return, including the unfavorable case; callbacks cannot qualify a favorable subset',async()=>{
  const cs=[await fixtureComparison('good-case'),await fixtureComparison('bad-case','held-out',false)],seal=sealFor(cs);let reads=0;
  await assert.rejects(verifyEvaluationCohort(seal,[cs[0]],{signal:new AbortController().signal,
    readCohort:async()=>{reads++;return proofFor(seal,cs);}}),/COHORT_HELD_OUT_RETURN_MISSING/);
  assert.equal(reads,0);const token=await qualify(cs);assert.equal(createPolicyProfile(cs,token).selection,'fixed');
});
test('relabelled design case or changed source/split/input is rejected against the sealed roster',async()=>{
  const design=await fixtureComparison('original-design','design'),held=await fixtureComparison('original-held'),cs=[design,held],seal=sealFor(cs);
  for(const m of [{...design.manifest,split:'held-out' as const},
    {...design.manifest,input_sha256:digest('TEST_ONLY_DIFFERENT_INPUT')},
    {...design.manifest,sources:[{id:'source',sha256:digest('TEST_ONLY_DIFFERENT_SOURCE')}]}]){
    const changed={...design,manifest:m,manifest_sha256:digest(m)};
    await assert.rejects(verifyEvaluationCohort(seal,[changed,held],{signal:new AbortController().signal,
      readCohort:async()=>proofFor(seal,cs)}),/COHORT_CASE_RELABEL_OR_INPUT/);
  }
});
test('the actual saved registry split overrides a new self-rehashed seal',async()=>{
  const cs=[await fixtureComparison('registry-design')],s=sealFor(cs),proof=proofFor(s,cs);
  const altered={...proof,cases:proof.cases.map(c=>({...c,split:'design' as const}))};
  await assert.rejects(verifyEvaluationCohort(s,cs,{signal:new AbortController().signal,readCohort:async()=>altered}),/COHORT_REGISTRY_BINDING/);
});
test('design exposure and an older evaluation run make held-out input spent; current result readback stays allowed',async()=>{
  const cs=[await fixtureComparison('usage-case')],s=sealFor(cs);
  for(const kind of ['design','evaluation'] as const){
    const p=proofFor(s,cs),altered={...p,cases:p.cases.map(c=>({...c,uses:[{kind,run_id:'old-exposure',original:{kind:'TEST_ONLY_PRIOR_EXPOSURE'}}]}))};
    await assert.rejects(verifyEvaluationCohort(s,cs,{signal:new AbortController().signal,readCohort:async()=>altered}),/COHORT_DESIGN_RELABEL|COHORT_SPENT_INPUT_REUSED/);
  }
  const p=proofFor(s,cs),r=cs[0].arms.adaptive.receipt!;
  const current={...p,cases:p.cases.map(c=>({...c,uses:[{kind:'evaluation' as const,run_id:r.run_id,original:{kind:'TEST_ONLY_THIS_RESULT'}}]}))};
  const token=await verifyEvaluationCohort(s,cs,{signal:new AbortController().signal,readCohort:async()=>current});assert.ok(token);
});
test('registration after original admission and unknown saved origin/current fence cannot qualify',async()=>{
  const cs=[await fixtureComparison('clock-case')],s=sealFor(cs);
  for(const bad of ['late','origin','fence'] as const){
    const p=proofFor(s,cs),altered=bad==='late'?{...p,registered_at_ms:p.cases[0].admissions[0].admitted_at_ms}:
      bad==='origin'?{...p,original:null}:{...p,current_fence:null};
    await assert.rejects(verifyEvaluationCohort(s,cs,{signal:new AbortController().signal,readCohort:async()=>altered}),/COHORT_NOT_PREREGISTERED_OR_ADMISSION|COHORT_ORIGIN/);
  }
  const noReader=await verifyEvaluationCohort(s,cs,{signal:new AbortController().signal});assert.equal(noReader,undefined);
  const noOrigin=await verifyEvaluationCohort(s,cs,{signal:new AbortController().signal,readCohort:async()=>null});
  assert.equal(createPolicyProfile(cs,noOrigin).evidence_quality,'insufficient');
});
test('original admissions must cover exactly all returned runs with original budget and deadline',async()=>{
  const cs=[await fixtureComparison('admission-case')],s=sealFor(cs);
  for(const bad of ['missing','extra','budget','deadline'] as const){
    const p=proofFor(s,cs),record=p.cases[0];
    const admissions=bad==='missing'?record.admissions.slice(1):bad==='extra'?
      [...record.admissions,{...record.admissions[0],run_id:'unreturned-original-run'}]:
      record.admissions.map((a,i)=>i? a:bad==='budget'?{...a,budget_sha256:digest('TEST_ONLY_CHANGED_BUDGET')}:
        {...a,deadline_ms:a.deadline_ms+1});
    await assert.rejects(verifyEvaluationCohort(s,cs,{signal:new AbortController().signal,
      readCohort:async()=>({...p,cases:[{...record,admissions}]})}),/COHORT_ADMISSION_COVERAGE|COHORT_NOT_PREREGISTERED_OR_ADMISSION/);
  }
});
test('shorter original parent deadline is valid; zero or over-budget original durations stay invalid',async()=>{
  const cs=[await fixtureComparison('short-parent-deadline-case')],s=sealFor(cs),p=proofFor(s,cs),D=cs[0].manifest.deadline_ms;
  const short={...p,cases:p.cases.map(c=>({...c,admissions:c.admissions.map(a=>({...a,admitted_at_ms:D-5000}))}))};
  const token=await verifyEvaluationCohort(s,cs,{signal:new AbortController().signal,readCohort:async()=>short});
  assert.ok(token);assert.equal(createPolicyProfile(cs,token).selection,'adaptive');
  for(const duration of [0,cs[0].manifest.budget.timeout_ms+1]){
    const invalid={...p,registered_at_ms:D-duration-1,cases:p.cases.map(c=>({...c,
      admissions:c.admissions.map(a=>({...a,admitted_at_ms:D-duration}))}))};
    await assert.rejects(verifyEvaluationCohort(s,cs,{signal:new AbortController().signal,readCohort:async()=>invalid}),/COHORT_NOT_PREREGISTERED_OR_ADMISSION/);
  }
});
test('original cohort callback and comparison snapshot cannot be replaced while its readback awaits',async()=>{
  const cs=[await fixtureComparison('reader-alias-case')],s=sealFor(cs),proof=proofFor(s,cs);let originalCalls=0,replacedCalls=0;
  const authority={signal:new AbortController().signal,readCohort:async():Promise<CohortReadback|null>=>{originalCalls++;
    authority.readCohort=async()=>{replacedCalls++;return null;};
    await Promise.resolve();return proof;}};
  const token=await verifyEvaluationCohort(s,cs,authority);assert.ok(token);
  (proof as unknown as {original:unknown}).original={kind:'TEST_ONLY_ALIAS_CHANGED_AFTER_READ'};
  assert.equal(originalCalls,1);assert.equal(replacedCalls,0);
  assert.notDeepEqual(cohortEvidence(token).original.original,proof.original);
  assert.equal(createPolicyProfile(cs,token).selection,'adaptive');
});
test('JSON/cloned token and a changed comparison grade/attestation set cannot reuse qualification',async()=>{
  const cs=[await fixtureComparison('token-case')],token=await qualify(cs);
  assert.throws(()=>createPolicyProfile(cs,structuredClone(token)),/COHORT_TOKEN_UNVERIFIED_OR_BINDING/);
  for(const field of ['grade','receipt','attestation'] as const){
    const changed=structuredClone(cs),arm=changed[0].arms.adaptive;
    const updated=field==='grade'?{...arm,grade:{...arm.grade!,quality:0.1}}:
      field==='receipt'?{...arm,receipt:{...arm.receipt!,measurements:{...arm.receipt!.measurements,cost:0.1}}}:
        {...arm,attestation:{...arm.attestation!,original:{kind:'TEST_ONLY_CHANGED_OFFICIAL_RECORD'}}};
    if(field==='receipt')updated.receipt_sha256=digest(updated.receipt);
    if(field==='receipt')updated.attestation={...updated.attestation!,receipt_sha256:updated.receipt_sha256!};
    changed[0]={...changed[0],arms:{...changed[0].arms,adaptive:updated}};
    assert.throws(()=>createPolicyProfile(changed,token),/COHORT_TOKEN_UNVERIFIED_OR_BINDING/);
  }
  assert.throws(()=>createPolicyProfile([...cs,...cs],token),/COHORT_TOKEN_UNVERIFIED_OR_BINDING/);
});
test('old serialized improved profile is refused before any port; old fixed profile remains advisory-compatible',async()=>{
  const cs=[await fixtureComparison('legacy-case')],token=await qualify(cs),current=createPolicyProfile(cs,token);
  const {cohort:_cohort,digest:_sha,...oldBody}=current;
  const oldGain={...oldBody,digest:digest(oldBody)},m=fixtureManifest('future-job');let calls=0;
  const ports=Object.fromEntries(['single','fixed','adaptive'].map(s=>[s,async()=>{calls++;throw Error('port must not run');}])) as unknown as StrategyRunners;
  const authority={verifyProfile:async()=>true,authorizeAdmission:async()=>true,reserveFreshUse:async()=>true,
    attestReceipt:async()=>{throw Error('not called');}};
  await assert.rejects(consumePolicyProfile(oldGain,{run_id:'future',manifest:m},ports,authority,{signal:new AbortController().signal}),/PROFILE_COHORT_REQUIRED/);
  assert.equal(calls,0);
  const fixedBody={...oldBody,selection:'fixed' as const,provider_selection_required:false},oldFixed={...fixedBody,digest:digest(fixedBody)};
  const fixedPorts={...ports,fixed:async()=>{calls++;return fixtureReceipt(m,'fixed');}};
  const a={...authority,attestReceipt:async(r:ReturnType<typeof fixtureReceipt>)=>({status:'verified' as const,receipt_sha256:digest(r),original:{kind:'TEST_ONLY_RECORD'}})};
  const fixedM=fixtureManifest('legacy-case'); // Same scope; current admission must have the expected fresh ID.
  const correctedPorts={...fixedPorts,fixed:async(_input:unknown,ctx:{run_id?:string})=>{calls++;return {...fixtureReceipt(fixedM,'fixed'),run_id:ctx.run_id!};}};
  const output=await consumePolicyProfile(oldFixed,{run_id:'future-fixed',manifest:fixedM},correctedPorts,a,{signal:new AbortController().signal});
  assert.equal(output.policy_evaluation_qualification,'legacy_fixed_unsealed');assert.equal(output.qualification,'unconfirmed_use');
});
test('saved new profile needs reverified cohort and pure reconstruction; detached JSON alone cannot dispatch',async()=>{
  const cs=[await fixtureComparison('restore-profile-case')],token=await qualify(cs),p=createPolicyProfile(cs,token),saved=structuredClone(p);
  const restored=await qualify(cs);createPolicyProfile(cs,restored);const m=fixtureManifest('new-operation');let calls=0;
  const ports={single:async()=>{throw Error('wrong port');},fixed:async()=>{throw Error('wrong port');},
    adaptive:async(_input:unknown,ctx:{run_id?:string})=>{calls++;return {...fixtureReceipt(m,'adaptive'),run_id:ctx.run_id!};}};
  const a={verifyProfile:async()=>true,authorizeAdmission:async()=>true,reserveFreshUse:async()=>true,
    attestReceipt:async(r:ReturnType<typeof fixtureReceipt>)=>({status:'verified' as const,receipt_sha256:digest(r),original:{kind:'TEST_ONLY_RECORD'}})};
  await assert.rejects(consumePolicyProfile(saved,{run_id:'new-operation',manifest:m},ports,a,{signal:new AbortController().signal}),/PROFILE_COHORT_REQUIRED_OR_BINDING/);
  const use=await consumePolicyProfile(saved,{run_id:'new-operation',manifest:m},ports,a,{signal:new AbortController().signal,cohort:restored});
  assert.equal(calls,1);assert.equal(use.qualification,'unconfirmed_use');assert.ok(use.profile_digest===p.digest);
});
