import test from 'node:test';
import assert from 'node:assert/strict';
import {EVALUATION_VERSION, STRATEGIES, digest, runPairedComparison, createPolicyProfile,
  consumePolicyProfile, validateManifest} from '../evaluation/index.mts';
import type {ArmReceipt, ConditionManifest, Grade, EvaluationHooks, PolicyAuthority,
  Strategy, StrategyRunners} from '../evaluation/index.mts';
import {qualify} from './evaluation-cohort-fixtures.mts';

const sha = (s: string) => digest(s);
const originalFetch = globalThis.fetch;
let forbiddenNetworkCalls = 0;
test.before(() => {globalThis.fetch = async () => {forbiddenNetworkCalls++; throw Error('offline comparison test');};});
test.after(() => {globalThis.fetch = originalFetch; assert.equal(forbiddenNetworkCalls, 0);});
function manifest(id = 'held-case', split: 'design' | 'held-out' = 'held-out'): ConditionManifest {
  return {version: EVALUATION_VERSION, case_id: id, task_class: 'bounded-evidence-answer', split,
    input_sha256: sha('input-' + id), sources: [{id: 'A', sha256: sha('source-A')}],
    capabilities: ['read','ordinary-final'], tools: [
      {id: 'read-file', capability: 'read', model: null},
      {id: 'ordinary', capability: 'ordinary-final', model: 'same-native-model'}],
    models: {single: {caller: 'same-native-model', selector: null},
      fixed: {caller: 'same-native-model', selector: null},
      adaptive: {caller: 'same-native-model', selector: 'real-selector-model'}},
    implementation_sha256: {single: sha('single-source'), fixed: sha('fixed-source'), adaptive: sha('adaptive-source')},
    budget: {max_operations: 8, max_decisions: 2, max_plan_versions: 4, max_parallel: 2, timeout_ms: 10000},
    deadline_ms: Date.now() + 5000, scoring_sha256: sha('independent-criteria-v1')};
}
function receipt(m: ConditionManifest, strategy: Strategy, mode: ArmReceipt['mode'] = 'live', run?: string): ArmReceipt {
  return {version: EVALUATION_VERSION, strategy, case_id: m.case_id, run_id: run ?? m.case_id + '-' + strategy,
    manifest_sha256: digest(m), input_sha256: m.input_sha256, sources: m.sources, capabilities: m.capabilities,
    models: m.models[strategy], implementation_sha256: m.implementation_sha256[strategy], budget: m.budget,
    deadline_ms: m.deadline_ms, mode, outcome: 'complete', error_kind: null,
    actual_tools: [{call_id: 'physical-read-1', tool_id: 'read-file', model: null,
      input_sha256: m.input_sha256, original: {kind: 'TEST_ONLY_IO_RECORD'}}],
    accepted_reads: [{source_id: 'A', sha256: m.sources[0].sha256, observation_id: 'accepted-A'}],
    final: {raw_sha256: sha('new-test-raw-' + strategy), original: {kind: 'TEST_ONLY_FINAL_RECORD'}, provenance: ['accepted-A']},
    usage: null, measurements: {latency_ms: 100, latency_scope: 'original-admission-through-final-receipt', cost: 10, cost_unit: 'original-test-unit', original: {kind: 'TEST_ONLY_METER'}},
    retry_count: 0, original: {kind: 'TEST_ONLY_EXECUTION_RECORD'}};
}
const grade = (quality = 0.8): Grade => ({quality, evidence: 0.9, unnecessary_work: 0,
  unnecessary_holds: 0, rework: 0, re_explanation: 0, original: {kind: 'TEST_ONLY_INDEPENDENT_SCORE'}});
function runners(make: (m: ConditionManifest, s: Strategy) => ArmReceipt = receipt): StrategyRunners {
  return Object.fromEntries(STRATEGIES.map(s => [s, async (m: ConditionManifest) => make(m, s)])) as unknown as StrategyRunners;
}
function hooks(score: (s: Strategy) => Grade = () => grade()): EvaluationHooks {
  return {signal: new AbortController().signal,
    attestReceipt: async r => ({status: 'verified', receipt_sha256: digest(r), original: {kind: 'TEST_ONLY_OFFICIAL_RECORD'}}),
    scoreFinal: async r => score(r.strategy)};
}
async function paired(m = manifest(), make = receipt, score: (s: Strategy) => Grade = () => grade()) {
  return runPairedComparison(m, runners(make), hooks(score));
}
function authority(): PolicyAuthority {
  const claims = new Set<string>();
  return {verifyProfile: async () => true, authorizeAdmission: async () => true,
    reserveFreshUse: async a => {if (claims.has(a.run_id)) return false; claims.add(a.run_id); return true;},
    attestReceipt: async r => ({status: 'verified', receipt_sha256: digest(r), original: {kind: 'TEST_ONLY_OFFICIAL_RECORD'}}),
    readCurrentUse: async(p,a)=>({status:'verified',profile_digest:p.digest,run_id:a.run_id,
      manifest_sha256:digest(a.manifest),deadline_ms:a.manifest.deadline_ms,
      current_fence:{kind:'TEST_ONLY_ATOMIC_CURRENT_FENCE'},original:{kind:'TEST_ONLY_JOINT_CURRENT_RECORD'}})};
}

test('perfect injected/replay/scripted scores remain diagnostic and cannot recommend adaptive', async () => {
  for (const mode of ['injected','recorded_replay','scripted','unverified'] as const) {
    let attest = 0;
    const h = {...hooks(s => grade(s === 'adaptive' ? 1 : 0.2)), attestReceipt: async () => {attest++; throw Error('must not attest a fixture');}};
    const result = await runPairedComparison(manifest(mode), runners((m,s) => receipt(m,s,mode)), h);
    assert.equal(result.status, 'diagnostic_only'); assert.equal(attest, 0);
    const p = createPolicyProfile([result],await qualify([result])); assert.equal(p.selection, 'fixed'); assert.equal(p.provider_selection_required, false);
  }
});

test('a live label without official receipt readback is not measured and is not scored', async () => {
  let scores = 0;
  const h: EvaluationHooks = {...hooks(), attestReceipt: async r => ({status: 'unavailable', receipt_sha256: digest(r), original: null}),
    scoreFinal: async () => {scores++; return grade(1);}};
  const result = await runPairedComparison(manifest(), runners(), h);
  assert.equal(result.status, 'unavailable'); assert.equal(scores, 0);
  assert.equal(createPolicyProfile([result]).selection, 'fixed');
});

test('input/source/model/budget/deadline/implementation and actual tool mismatches invalidate before scoring', async () => {
  const mutations: ((r: ArmReceipt) => ArmReceipt)[] = [
    r => ({...r,input_sha256:sha('other-input')}), r => ({...r,sources:[{id:'A',sha256:sha('other-source')}]}),
    r => ({...r,models:{...r.models,caller:'other-native-model'}}), r => ({...r,budget:{...r.budget,max_operations:9}}),
    r => ({...r,deadline_ms:r.deadline_ms+1}), r => ({...r,implementation_sha256:sha('other-code')}),
    r => ({...r,actual_tools:[{...r.actual_tools[0],tool_id:'unregistered-tool'}]}),
    r => ({...r,actual_tools:[{...r.actual_tools[0],model:'unauthorized-tool-model'}]}),
    r => ({...r,accepted_reads:[{source_id:'A',sha256:sha('other-read'),observation_id:'accepted-A'}]}),
    r => ({...r,final:{...r.final!,provenance:['unaccepted-observation']}}),
  ];
  for (let i=0;i<mutations.length;i++) {
    let invalidArmScores = 0; const h = {...hooks(),scoreFinal:async (r:ArmReceipt) => {if(r.strategy==='adaptive')invalidArmScores++;return grade();}};
    const result = await runPairedComparison(manifest('mismatch-'+i), runners((m,s) => s==='adaptive'?mutations[i](receipt(m,s)):receipt(m,s)), h);
    assert.equal(result.status,'invalid'); assert.equal(result.arms.adaptive.status,'invalid');
    assert.equal(invalidArmScores,0); assert.ok(result.arms.adaptive.received);
  }
});

test('attestation binds exact captured bytes; a different official-record digest fails', async () => {
  const h = {...hooks(),attestReceipt:async () => ({status:'verified' as const,receipt_sha256:sha('different-record'),original:{kind:'TEST'}})};
  const result = await runPairedComparison(manifest(),runners(),h);
  assert.equal(result.status,'invalid'); assert.equal(result.arms.single.reason,'ATTESTATION');
});

test('retained runner aliases cannot rewrite measurements or accepted provenance during attestation', async () => {
  const originals: ArmReceipt[] = [];
  const h = {...hooks(),attestReceipt:async (r:ArmReceipt) => {
    const original = originals.find(o=>o.strategy===r.strategy)!;
    Object.assign(original,{measurements:{...original.measurements,cost:0},accepted_reads:[]});
    return {status:'verified' as const,receipt_sha256:digest(r),original:{kind:'TEST'}};
  }};
  const result = await runPairedComparison(manifest(),runners((m,s)=>{const r=receipt(m,s);originals.push(r);return r;}),h);
  assert.equal(result.status,'measured'); assert.equal(result.arms.adaptive.receipt!.measurements.cost,10);
  assert.equal(result.arms.adaptive.receipt!.accepted_reads.length,1);
});

test('one underlying run cannot masquerade as three paired arms', async () => {
  const result = await paired(manifest(),(m,s)=>receipt(m,s,'live','same-old-run'));
  assert.equal(result.status,'invalid'); assert.equal(result.arms.fixed.reason,'RUN_REUSED_BETWEEN_ARMS');
});

test('candidate-generation, selection, technical and final errors remain distinct actual outcomes', async () => {
  for(const kind of ['candidate_generation','selection','technical','final'] as const) {
    const result=await paired(manifest(kind),(m,s)=>s==='adaptive'?{...receipt(m,s),outcome:'failed',error_kind:kind,final:null}:receipt(m,s));
    assert.equal(result.arms.adaptive.error_kind,kind); assert.equal(result.arms.adaptive.receipt!.outcome,'failed');
    assert.equal(createPolicyProfile([result]).selection,'fixed');
  }
});

test('unknown metrics and incomparable original cost units do not select an apparent winner', async () => {
  const unknown=await paired(manifest('unknown'),(m,s)=>({...receipt(m,s),measurements:{latency_ms:null,latency_scope:null,cost:null,cost_unit:null,original:null}}),s=>grade(s==='adaptive'?1:0.4));
  assert.equal(unknown.arms.adaptive.receipt!.measurements.cost,null);
  assert.equal(createPolicyProfile([unknown],await qualify([unknown])).selection,'fixed');
  const mixed=await paired(manifest('units'),(m,s)=>({...receipt(m,s),measurements:{...receipt(m,s).measurements,cost_unit:s==='adaptive'?'other-original-unit':'original-test-unit'}}),s=>grade(s==='adaptive'?1:0.4));
  assert.equal(createPolicyProfile([mixed],await qualify([mixed])).selection,'fixed');
  const scopes=await paired(manifest('scopes'),(m,s)=>({...receipt(m,s),measurements:{...receipt(m,s).measurements,latency_scope:s==='adaptive'?'native-time-only':'original-admission-through-final-receipt'}}),s=>grade(s==='adaptive'?1:0.4));
  assert.equal(createPolicyProfile([scopes],await qualify([scopes])).selection,'fixed');
});

test('unknown rework/re-explanation remains null rather than being replaced with a zero advantage', async () => {
  const result=await paired(manifest(),receipt,s=>({...grade(s==='adaptive'?1:0.3),rework:null,re_explanation:null}));
  const p=createPolicyProfile([result],await qualify([result]));assert.equal(p.selection,'fixed');assert.equal(result.arms.adaptive.grade!.rework,null);
});

test('design-only improvements and design/held-out input overlap cannot recommend adaptive', async () => {
  const design=await paired(manifest('design','design'),receipt,s=>grade(s==='adaptive'?1:0.2));
  assert.equal(createPolicyProfile([design]).reason,'NO_HELD_OUT_EVALUATION');
  const m={...manifest('held'),input_sha256:design.manifest.input_sha256};
  const held=await paired(m,receipt,s=>grade(s==='adaptive'?1:0.2));
  assert.equal(createPolicyProfile([design,held]).reason,'DESIGN_HELD_OUT_OVERLAP');
});

test('known held-out improvement can select adaptive, single/no-Jev or fixed with no predetermined winner', async () => {
  for(const winner of STRATEGIES) {
    const result=await paired(manifest(winner),receipt,s=>grade(s===winner?0.95:0.7));
    const p=createPolicyProfile([result],await qualify([result]));assert.equal(p.selection,winner);assert.equal(p.provider_selection_required,winner==='adaptive');
  }
  const tied=await paired(manifest('tie')),tie=createPolicyProfile([tied],await qualify([tied]));assert.equal(tie.selection,'fixed');
});

test('higher answer quality with worse time or unnecessary work does not claim dominance', async () => {
  const slow=await paired(manifest('slow'),(m,s)=>({...receipt(m,s),measurements:{...receipt(m,s).measurements,latency_ms:s==='adaptive'?200:100}}),s=>grade(s==='adaptive'?1:0.7));
  assert.equal(createPolicyProfile([slow],await qualify([slow])).selection,'fixed');
  const waste=await paired(manifest('waste'),receipt,s=>({...grade(s==='adaptive'?1:0.7),unnecessary_work:s==='adaptive'?1:0}));
  assert.equal(createPolicyProfile([waste],await qualify([waste])).selection,'fixed');
});

test('profile consumer executes exactly the chosen existing port on a new original admission', async () => {
  const measured=await paired(manifest('evaluation'),receipt,s=>grade(s==='single'?1:0.5));
  const cohort=await qualify([measured]),profile=createPolicyProfile([measured],cohort), m=manifest('new-job');let calls=0;
  const ports:StrategyRunners={single:async (input,ctx)=>{calls++;assert.equal(ctx.deadline_ms,m.deadline_ms);assert.deepEqual(input.budget,m.budget);return receipt(input,'single','live',ctx.run_id);},
    fixed:async()=>{throw Error('wrong port');},adaptive:async()=>{throw Error('wrong port');}};
  const output=await consumePolicyProfile(profile,{run_id:'new-current-parent',manifest:m},ports,authority(),{signal:new AbortController().signal,cohort});
  assert.equal(calls,1);assert.equal(output.strategy,'single');assert.equal(output.qualification,'measured_use');
  assert.equal(output.receipt.deadline_ms,m.deadline_ms);assert.equal(output.automatic_apply,false);
});

test('changed current models/budget or a comparison run reused as current run never invokes a port', async () => {
  const measured=await paired(manifest('evaluation')), p=createPolicyProfile([measured]);let calls=0;
  const ports=runners((m,s)=>{calls++;return receipt(m,s);});
  for(const m of [{...manifest('new'),budget:{...manifest().budget,max_operations:9}},
    {...manifest('new'),implementation_sha256:{...manifest().implementation_sha256,fixed:sha('changed-consumer')}}]) {
    await assert.rejects(consumePolicyProfile(p,{run_id:'new-run',manifest:m},ports,authority(),{signal:new AbortController().signal}),/CURRENT_POLICY_SCOPE_MISMATCH/);
  }
  await assert.rejects(consumePolicyProfile(p,{run_id:measured.arms.fixed.receipt!.run_id,manifest:manifest('new')},ports,authority(),{signal:new AbortController().signal}),/FRESH_RUN_REQUIRED/);
  assert.equal(calls,0);
});

test('a recomputed profile hash is not adoption; trusted profile/current admission readback is required', async () => {
  const p=createPolicyProfile([await paired()]);let calls=0;
  const ports=runners((m,s)=>{calls++;return receipt(m,s);});const admission={run_id:'new-run',manifest:manifest('new')};
  await assert.rejects(consumePolicyProfile(p,admission,ports,{...authority(),verifyProfile:async()=>false},{signal:new AbortController().signal}),/PROFILE_NOT_ADOPTED/);
  await assert.rejects(consumePolicyProfile(p,admission,ports,{...authority(),authorizeAdmission:async()=>false},{signal:new AbortController().signal}),/CURRENT_ADMISSION_DENIED/);
  assert.equal(calls,0);
});

test('failed port retains fresh-use claim and cannot retry or fall back to another strategy', async () => {
  const p=createPolicyProfile([await paired()]), a={run_id:'unknown-current-run',manifest:manifest('new')};
  let calls=0;const auth=authority();const ports=runners(()=>{calls++;throw Error('physical outcome unknown');});
  await assert.rejects(consumePolicyProfile(p,a,ports,auth,{signal:new AbortController().signal}),/physical outcome unknown/);
  await assert.rejects(consumePolicyProfile(p,a,ports,auth,{signal:new AbortController().signal}),/FRESH_USE_ALREADY_CLAIMED/);
  assert.equal(calls,1);
});

test('admission or adopted profile revoked during the durable use claim blocks dispatch', async () => {
  const p=createPolicyProfile([await paired()]), admission={run_id:'new-current',manifest:manifest('new')};let calls=0;
  const ports=runners((m,s)=>{calls++;return receipt(m,s,'live','new-current');});
  let current=true;
  const admissionLoss={...authority(),authorizeAdmission:async()=>current,
    reserveFreshUse:async()=>{current=false;return true;}};
  await assert.rejects(consumePolicyProfile(p,admission,ports,admissionLoss,{signal:new AbortController().signal}),/CURRENT_ADMISSION_CHANGED/);
  let adopted=true;
  const profileLoss={...authority(),verifyProfile:async()=>adopted,
    reserveFreshUse:async()=>{adopted=false;return true;}};
  await assert.rejects(consumePolicyProfile(p,admission,ports,profileLoss,{signal:new AbortController().signal}),/PROFILE_CHANGED_DURING_RESERVATION/);
  assert.equal(calls,0);
});

test('cancellation/authority loss after runner return cannot qualify policy use', async () => {
  const p=createPolicyProfile([await paired()]), m=manifest('new');let checks=0,calls=0;
  const auth={...authority(),authorizeAdmission:async()=>++checks<=2};
  await assert.rejects(consumePolicyProfile(p,{run_id:'new-run',manifest:m},runners((input,s)=>{calls++;return receipt(input,s,'live','new-run');}),auth,{signal:new AbortController().signal}),/CURRENT_ADMISSION_CHANGED/);
  assert.equal(calls,1);
});

for (const phase of ['runner','attestation'] as const) {
  test('profile loss during '+phase+' cannot qualify use; retained claim cannot retry', async () => {
    const p=createPolicyProfile([await paired(manifest('proof-'+phase))]);
    const admission={run_id:'current-'+phase,manifest:manifest('new-'+phase)};
    let adopted=true,calls=0;
    const base=authority(), auth={...base,verifyProfile:async()=>adopted,
      attestReceipt:async(r:ArmReceipt)=>{if(phase==='attestation')adopted=false;return base.attestReceipt(r,admission.manifest);}};
    const ports=runners((m,s)=>{calls++;if(phase==='runner')adopted=false;return receipt(m,s,'live',admission.run_id);});
    await assert.rejects(consumePolicyProfile(p,admission,ports,auth,{signal:new AbortController().signal}),
      phase==='runner'?/PROFILE_CHANGED_AFTER_RUN/:/PROFILE_CHANGED_AT_RETURN/);
    assert.equal(calls,1);adopted=true;
    await assert.rejects(consumePolicyProfile(p,admission,ports,auth,{signal:new AbortController().signal}),/FRESH_USE_ALREADY_CLAIMED/);
    assert.equal(calls,1);
  });
}

test('profile lost during the last separate admission read is not qualified without joint current-use proof', async () => {
  const p=createPolicyProfile([await paired(manifest('last-read-proof'))]);
  const a={run_id:'last-read-current',manifest:manifest('new-last-read')};
  let adopted=true,checks=0,calls=0;
  const auth={...authority(),verifyProfile:async()=>adopted,authorizeAdmission:async()=>{
    checks++;if(checks===4)adopted=false;return true;
  },readCurrentUse:async()=>({status:adopted?'verified' as const:'denied' as const,
    profile_digest:p.digest,run_id:a.run_id,manifest_sha256:digest(a.manifest),deadline_ms:a.manifest.deadline_ms,
    current_fence:adopted?{kind:'TEST_ONLY_SAME_CURRENT_FENCE'}:null,original:{kind:'TEST_ONLY_JOINT_READBACK'}})};
  const result=await consumePolicyProfile(p,a,runners((m,s)=>{calls++;return receipt(m,s,'live',a.run_id);}),auth,{signal:new AbortController().signal});
  assert.equal(checks,4);assert.equal(calls,1);assert.equal(result.qualification,'unconfirmed_use');
});

test('consumer captures original runner and authority callbacks before awaiting profile readback', async () => {
  const p=createPolicyProfile([await paired()]), admission={run_id:'current-captured',manifest:manifest('new')};
  let replacements=0,originalCalls=0,profileReads=0;
  const replacement=async()=>{replacements++;throw Error('replacement callback outside original binding');};
  const ports={...runners((m,s)=>{originalCalls++;return receipt(m,s,'live',admission.run_id);})};
  const auth={...authority(),verifyProfile:async()=>{
    profileReads++;
    if(profileReads===1){ports.fixed=replacement;auth.verifyProfile=replacement;
      auth.authorizeAdmission=replacement;auth.reserveFreshUse=replacement;auth.attestReceipt=replacement;auth.readCurrentUse=replacement;}
    return true;
  }};
  const result=await consumePolicyProfile(p,admission,ports,auth,{signal:new AbortController().signal});
  assert.equal(result.qualification,'measured_use');assert.equal(originalCalls,1);assert.equal(replacements,0);
});

test('consumer captures original callbacks before awaiting durable fresh-use reservation', async () => {
  const p=createPolicyProfile([await paired()]), admission={run_id:'claim-captured',manifest:manifest('new')};
  let replacements=0,originalCalls=0;
  const replacement=async()=>{replacements++;throw Error('changed binding after reservation');};
  const ports={...runners((m,s)=>{originalCalls++;return receipt(m,s,'live',admission.run_id);})};
  const auth={...authority(),reserveFreshUse:async()=>{
    ports.fixed=replacement;auth.verifyProfile=replacement;auth.authorizeAdmission=replacement;auth.attestReceipt=replacement;auth.readCurrentUse=replacement;
    return true;
  }};
  const result=await consumePolicyProfile(p,admission,ports,auth,{signal:new AbortController().signal});
  assert.equal(result.qualification,'measured_use');assert.equal(originalCalls,1);assert.equal(replacements,0);
});

test('paired comparison captures all original runner and evaluator references before any port awaits', async () => {
  const m=manifest('paired-captured');let replacements=0,originalCalls=0;
  const replacement=async()=>{replacements++;throw Error('replacement after first paired runner');};
  const h={...hooks()}, ports={...runners((input,s)=>{originalCalls++;return receipt(input,s);})};
  ports.single=async input=>{
    originalCalls++;ports.fixed=replacement;ports.adaptive=replacement;
    h.attestReceipt=replacement;h.scoreFinal=replacement;return receipt(input,'single');
  };
  const result=await runPairedComparison(m,ports,h);
  assert.equal(result.status,'measured');assert.equal(originalCalls,3);assert.equal(replacements,0);
});

test('separate profile/admission reads alone and unavailable joint record never promote measured use', async () => {
  const p=createPolicyProfile([await paired()]);
  for (const joint of ['missing','unavailable'] as const) {
    const a={run_id:'current-'+joint,manifest:manifest('new-'+joint)};
    const {readCurrentUse: _joint,...separate}=authority();
    const auth=joint==='missing'?separate:{...separate,readCurrentUse:async()=>null};
    const result=await consumePolicyProfile(p,a,runners((m,s)=>receipt(m,s,'live',a.run_id)),auth,{signal:new AbortController().signal});
    assert.equal(result.qualification,'unconfirmed_use');assert.equal(result.current_use,null);
  }
});

test('joint readback must bind exact profile/run/manifest/original D and carry an actual fence origin', async () => {
  const p=createPolicyProfile([await paired()]);
  for (const mutation of ['profile','run','manifest','deadline','fence'] as const) {
    const a={run_id:'bad-joint-'+mutation,manifest:manifest('new-'+mutation)},base=authority();
    const auth={...base,readCurrentUse:async()=>{
      const w=(await base.readCurrentUse!(p,a))!;
      return mutation==='profile'?{...w,profile_digest:sha('wrong-profile')}:
        mutation==='run'?{...w,run_id:'wrong-run'}:mutation==='manifest'?{...w,manifest_sha256:sha('wrong-manifest')}:
        mutation==='deadline'?{...w,deadline_ms:w.deadline_ms+1}:{...w,current_fence:null};
    }};
    await assert.rejects(consumePolicyProfile(p,a,runners((m,s)=>receipt(m,s,'live',a.run_id)),auth,{signal:new AbortController().signal}),/CURRENT_USE_BINDING|CURRENT_USE_ORIGIN/);
  }
});

test('expired original admission stops before execution rather than inventing another timeout', async () => {
  let calls=0;const m={...manifest(),deadline_ms:Date.now()-1};
  await assert.rejects(runPairedComparison(m,runners((input,s)=>{calls++;return receipt(input,s);}),hooks()),/ORIGINAL_PARENT_ENDED/);
  assert.equal(calls,0);
});

test('paired cancel leaves outcome unknown and blocks unstarted arms without retry', async () => {
  const parent=new AbortController();let calls=0;
  const ports=Object.fromEntries(STRATEGIES.map(s=>[s,async()=>{calls++;parent.abort();await new Promise(()=>{});return undefined;}])) as unknown as StrategyRunners;
  const result=await runPairedComparison(manifest(),ports,{...hooks(),signal:parent.signal});
  assert.equal(result.status,'unavailable');assert.equal(calls,1);
  assert.ok(STRATEGIES.every(s=>result.arms[s].receipt===null));
});

test('malformed nonfinite metrics and unequal baseline model policy fail closed', async () => {
  const result=await paired(manifest(),(m,s)=>({...receipt(m,s),measurements:{...receipt(m,s).measurements,cost:Number.NaN}}));
  assert.equal(result.status,'invalid');
  assert.throws(()=>validateManifest({...manifest(),models:{...manifest().models,single:{caller:'different-baseline-model',selector:null}}}),/UNEQUAL_CALLER_MODELS/);
});

test('all offline records are explicitly test doubles, not real provider/native quality proof', () => {
  const r=receipt(manifest(),'adaptive');assert.equal(r.usage,null);
  assert.deepEqual(r.original,{kind:'TEST_ONLY_EXECUTION_RECORD'});assert.equal(r.retry_count,0);
});
