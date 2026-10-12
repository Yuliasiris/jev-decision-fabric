/** Scoped host readiness pattern; actual temporary file I/O, no native/model or external transport. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createWork, restoreWork} from '../sdk/index.mts';
import type {WorkHost, PlannerPort, WorkSnapshot, Task, TaskRequest, Observation, Registration, CreateWorkOptions} from '../sdk/index.mts';
import {CONTRACT_VERSION} from '../contract/c0.mts';
const sha = (raw: string | Uint8Array) => createHash('sha256').update(raw).digest('hex');
const descriptor = {mode: 'scripted' as const, usage: {tokens: null, cost: null}, latency_ms: null};
function readTask(id: 'A' | 'B', expected: string | null): Task {
  return {id, capability: 'current-file-reader', purpose: 'Inspect the supplied ' + id + ' independently',
    input_revision: id === 'A' ? 'A-r1' : expected ? 'B-r2' : 'B-not-provided',
    input: {operation: 'read', resource_id: id, expected_sha256: expected}, sources: [id], reads: [], after: [], output: 'verified-file-view'};
}
function reportTask(reads: string[]): Task {
  return {id: 'report', capability: 'ordinary-reporter', purpose: 'Compare actual read views and preserve unresolved conformance',
    input_revision: 'request-r1', input: {operation: 'report'}, sources: [], reads, after: reads, output: 'ordinary grounded comparison'};
}
async function readinessHost(t: any, initialStrategy: 'register-all' | 'defer-missing' = 'defer-missing') {
  const dir = await mkdtemp(join(tmpdir(), 'jev-input-readiness-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const a = 'Specification A requires limit 4.';
  await writeFile(join(dir, 'A.txt'), a);
  const paths = {A: join(dir, 'A.txt'), B: join(dir, 'B.txt')}; // Existing registered input locations, never model paths.
  const originalTime = Date.now(), run_id = 'missing-input-' + randomUUID();
  const admission = {run_id, profile_id:'test-only-existing-parent',timeout_ms:60000,
    admitted_at_ms:originalTime,deadline_ms:originalTime+60000};
  const catalog: Registration[] = [
    {capability:{id:'current-file-reader',kind:'tool',authorized:true,parallel:true,cancellable:true},
      description:'Read A or B only when its independently registered current file exists and its actual hash matches',
      input_description:'operation=read; registered resource_id; actual current expected_sha256'},
    {capability:{id:'ordinary-reporter',kind:'caller',authorized:true,parallel:false,cancellable:true},
      description:'Produce fresh frame-bound comparison from actual accepted file views',input_description:'operation=report'}];
  const calls = {initial:0,next:0,workerA:0,workerB:0,decision:0,final:0};
  const journal: Record<string,unknown>[] = [], observed = new Map<string, Observation>();
  let writerGeneration=1;
  let saved!: WorkSnapshot, bCurrent: {text:string; sha256:string} | null = null;
  let lastNative: {raw_sha256:string; frame_digest:string} | null = null;
  function readyInput(input: any) {
    return input?.operation === 'read' && (input.resource_id === 'A' ? input.expected_sha256 === sha(a) :
      input.resource_id === 'B' && !!bCurrent && input.expected_sha256 === bCurrent.sha256);
  }
  const origin = (context: any, pending: string[]) => ({fixture_only:true, native_model_called:false,
    request_id:run_id, caller_invocation:context.invocation.id,
    requested_units:['A','B'], pending_inputs:pending, observed_readiness:{A:'READY',B:bCurrent?'READY':'MISSING'}});
  const planner: PlannerPort = {
    initial: async context => {
      calls.initial++; assert.match(context.request.objective,/independently/);
      assert.equal(context.request.sources.find(s=>s.id==='B')!.omitted,true);
      const ready = readTask('A',sha(a));
      const tasks = initialStrategy === 'register-all' ? [readTask('B',null),ready,reportTask(['A','B'])] :
        [ready,reportTask(['A'])];
      return {...descriptor,origin:origin(context,['B']),tasks};
    },
    next: async context => {
      calls.next++;
      if (!bCurrent) return {...descriptor,origin:origin(context,['B']),action:{kind:'pause',
        reason:'pending input B: current file has not been supplied; A completed independently. Reentry: supply B and continue under the original parent limits.'}};
      if (!context.observations.some(o=>o.task_id==='B')) return {...descriptor,origin:origin(context,[]),action:{kind:'choose',
        candidates:[{id:'admit-now-ready-B',purpose:'Read newly supplied current B',reason:'Trusted host input B is now readable with actual hash',
          evidence:['obs:A'],patch:{remove:[],upsert:[readTask('B',bCurrent.sha256),reportTask(['A','B'])]}}]}};
      return {...descriptor,origin:origin(context,[]),action:{kind:'dispatch'}};
    }
  };
  const host: WorkHost = {
    signal:new AbortController().signal,finalCapability:'ordinary-reporter',
    checks:{validateInput:(cap,input:any)=>cap==='ordinary-reporter'?input?.operation==='report':
      input?.operation==='read'&&['A','B'].includes(input.resource_id)&&
      (input.expected_sha256===null||/^[a-f0-9]{64}$/.test(input.expected_sha256)),
      authorize:(task,_sources,reads)=>task.capability==='ordinary-reporter' ?
        Object.values(reads).every(o=>sha(JSON.stringify(observed.get(o.id)))===sha(JSON.stringify(o))) :
        readyInput(task.input)&&task.sources.length===1&&task.sources[0]===(task.input as any).resource_id,
      isCurrent:frame=>frame.capability==='ordinary-reporter' ? Object.values(frame.reads).every(o=>
        o.task_id==='A'? (o.value as any).actual_source.sha256===sha(a) :
          !!bCurrent&&(o.value as any).actual_source.sha256===bCurrent.sha256) :
        readyInput(frame.input)&&frame.sources.length===1&&frame.sources[0].id===(frame.input as any).resource_id,
      acceptNativeAdmission:current=>JSON.stringify(current)===JSON.stringify(admission)},
    authorizeEntry:()=>writerGeneration===1,
    save:async(snapshot,reason)=>{await writeFile(join(dir,'checkpoint.json'),JSON.stringify(snapshot));saved=snapshot;
      journal.push({event:'saved',reason,digest:snapshot.digest,deadline:snapshot.checkpoint.state.deadline_ms});},
    readback:async snapshot=>JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8')).digest===snapshot.digest,
    acceptSnapshot:async snapshot=>JSON.parse(await readFile(join(dir,'checkpoint.json'),'utf8')).digest===snapshot.digest,
    authorizePlanner:context=>context.request.run_id===run_id&&context.deadline_ms===admission.deadline_ms,
    verifyPlannerOrigin:(reply,frame)=>(reply.origin as any).request_id===run_id&&(reply.origin as any).caller_invocation===frame.id,
    authorizeReconcile:()=>true,
    archiveObservation:async record=>{await writeFile(join(dir,record.frame.task_id+'-original-observation.json'),JSON.stringify(record.observation));},
    verifyObservationOrigin:async(o,frame)=>o.input_digest===frame.input_digest&&
      sha(await readFile(join(dir,frame.task_id+'-original-observation.json')))==sha(JSON.stringify(o)),
    worker:async frame=>{
      assert.ok(readyInput(frame.input)); const resource=(frame.input as any).resource_id as 'A'|'B';
      if(resource==='A')calls.workerA++;else calls.workerB++;
      const bytes=await readFile(paths[resource]);assert.equal(sha(bytes),(frame.input as any).expected_sha256);
      assert.ok(readyInput(frame.input));
      const actual_source={id:resource,revision:frame.input_revision,text:bytes.toString('utf8'),
        origin:paths[resource],range:'whole',omitted:false,sha256:sha(bytes)};
      const observation:Observation={contract_version:CONTRACT_VERSION,id:'obs:'+resource,run_id:frame.run_id,
        task_id:frame.task_id,attempt_id:frame.attempt_id,input_revision:frame.input_revision,input_digest:frame.input_digest,
        status:'completed',value:{excerpt:actual_source.text,actual_source},evidence:[resource],mode:'scripted',usage:{tokens:null,cost:null}};
      observed.set(observation.id,observation);journal.push({event:'actual-file-read',resource,actual_source,input_digest:frame.input_digest});
      return observation;
    },
    decision:async(input,context)=>{calls.decision++;assert.ok(saved.checkpoint.state.pending_decision);
      assert.equal(context.boundary.parent_deadline_ms,admission.deadline_ms);
      return {candidate_id:input.candidates[0].id,status:'selected',mode:'injected',record:{fixture_only:true,real_jev:false}};},
    final:async frame=>{
      calls.final++;assert.ok(frame.reads.A&&frame.reads.B);
      const raw=Buffer.from(JSON.stringify({run_id:frame.run_id,task_id:frame.task_id,attempt_id:frame.attempt_id,
        input_digest:frame.input_digest,answer:'A requires 4; the newly supplied B reports 6. The documents disagree.',
        provenance:[{observation_id:frame.reads.A.id,claim:'A requires limit 4.'},
          {observation_id:frame.reads.B.id,claim:'Fresh current B reports limit 6.'}],
        unresolved:['The documents disagree; actual runtime conformance remains unverified.']}));
      lastNative={raw_sha256:sha(raw),frame_digest:frame.input_digest};
      return {...descriptor,origin:{fixture_only:true,current_generated_record:lastNative},raw,new_native_call:false};
    },
    archiveFinal:async record=>writeFile(join(dir,'raw-final.json'),record.raw),
    verifyFinalOrigin:reply=>!!lastNative&&sha(reply.raw)===lastNative.raw_sha256,
    evidenceText:o=>[(o.value as any).excerpt]
  };
  const options: CreateWorkOptions = {requestText:'Compare A and B. Inspect any ready document independently while B is missing; retain uncertainty and continue after it is supplied.',
    frame:{run_id,input_revision:'request-r1',requested_output:'A grounded comparison, with pending input and unresolved conformance stated',
      sources:[{id:'A',revision:'A-r1',text:a,origin:paths.A,range:'whole',omitted:false},
        {id:'B',revision:'B-not-provided',text:'',origin:paths.B,range:'not supplied',omitted:true}],
      budget:{max_operations:8,max_decisions:1,max_plan_versions:4,max_parallel:2,timeout_ms:60000}},
    catalog,admission,planner,host,maxPlannerCalls:4};
  return {options,host,planner,catalog,calls,journal,dir,saved:()=>saved,
    provideB:async(text:string)=>{await writeFile(paths.B,text);bCurrent={text,sha256:sha(text)};await access(paths.B);},
    restore:async(snapshot:WorkSnapshot)=>{const generation=++writerGeneration;
      const restoredHost={...host,authorizeEntry:()=>writerGeneration===generation};
      observed.clear(); // Rehydrate original authority records from disk, not the retired instance's cache.
      for(const [taskId,original] of snapshot.checkpoint.state.accepted){
        const archived=JSON.parse(await readFile(join(dir,taskId+'-original-observation.json'),'utf8'));
        assert.equal(sha(JSON.stringify(archived)),sha(JSON.stringify(original)));observed.set(archived.id,archived);
      }
      return restoreWork(snapshot,{catalog,admission,planner,host:restoredHost,
      restoreChecks:{...host.checks,acceptCheckpoint:cp=>cp.digest===snapshot.checkpoint.digest,
        verifySettlement:()=>false}});}};
}

test('pre-registering unauthorized missing B holds the whole immutable run before independent A',async t=>{
  const f=await readinessHost(t,'register-all'),out=await createWork(f.options).run();
  assert.equal(out.result.status,'hold');assert.deepEqual(out.result.unresolved,['unauthorized']);
  assert.equal(f.calls.workerA,0);assert.equal(f.calls.workerB,0);assert.equal(f.calls.final,0);
});
test('ordinary planner defers missing input: real independent A saves, B later resumes under same D and budget without rereading A',async t=>{
  const f=await readinessHost(t),run=createWork(f.options),paused=await run.run();
  assert.equal(f.calls.workerA,1);assert.equal(f.calls.workerB,0);assert.equal(f.calls.final,0);
  assert.equal(paused.sdk_status,'PAUSED');assert.equal(paused.result.status,'needs_host');
  assert.match(paused.snapshot.paused_reason!,/pending input B/);
  assert.deepEqual((paused.planner_receipts.at(-1)!.origin as any).pending_inputs,['B']);
  assert.equal(paused.records.observations.length,1);assert.equal(paused.records.observations[0].adoption,'accepted');
  const originalA=JSON.stringify(paused.snapshot.checkpoint.state.accepted[0]);
  const originalBudget=paused.snapshot.checkpoint.state.request.budget,originalD=paused.snapshot.checkpoint.state.deadline_ms;
  assert.equal(paused.usage.parent_operations_started,3);
  const restored=await f.restore(f.saved());
  await assert.rejects(run.run(),/entry_authority/); // Prior owner is retired at restore.
  const stillWaiting=await restored.run();
  assert.equal(stillWaiting.sdk_status,'PAUSED');assert.equal(f.calls.workerA,1);assert.equal(f.calls.next,1);
  await f.provideB('Implementation explanation B reports limit 6.');
  await restored.continue();const completed=await restored.run();
  assert.equal(completed.sdk_status,'COMPLETE');assert.equal(f.calls.workerA,1);assert.equal(f.calls.workerB,1);
  assert.equal(f.calls.decision,1);assert.equal(f.calls.final,1);
  assert.equal(completed.snapshot.checkpoint.state.deadline_ms,originalD);
  assert.deepEqual(completed.snapshot.checkpoint.state.request.budget,originalBudget);
  assert.equal(completed.usage.parent_operations_started,8);assert.equal(completed.snapshot.planner_calls_started,4);
  assert.equal(JSON.stringify(completed.snapshot.checkpoint.state.accepted[0]),originalA);
  assert.equal(completed.snapshot.checkpoint.state.request.sources[1].text,'');
  assert.equal(completed.snapshot.checkpoint.state.request.sources[1].omitted,true);
  const observedB=completed.records.observations.find(o=>o.observation.task_id==='B')!.observation;
  assert.equal((observedB.value as any).actual_source.revision,'B-r2');
  assert.equal((observedB.value as any).actual_source.omitted,false);
  assert.equal((observedB.value as any).actual_source.text,'Implementation explanation B reports limit 6.');
  assert.deepEqual(completed.result.provenance,['obs:A','obs:B']);
  assert.deepEqual(completed.result.unresolved,['The documents disagree; actual runtime conformance remains unverified.']);
  assert.deepEqual(f.journal.filter(x=>x.event==='actual-file-read').map(x=>x.resource),['A','B']);
  assert.equal(completed.result.usage.cost,null); // No price invented; injected decision is not real Jev.
  if(process.env.JEV_SDK_READINESS_EVIDENCE)await writeFile(process.env.JEV_SDK_READINESS_EVIDENCE,JSON.stringify({
    schema:'jev.sdk.missing-input.actual-local-proof.v1',evidence_mode:'LOCAL_ACTUAL_FILE_IO_SCRIPTED_CALLER_INJECTED_DECISION',
    real_jev:false,new_native_calls:0,network_calls:0,canonical_db_changes:0,
    partial:paused,completed,journal:f.journal,calls:f.calls,originalD,originalBudget,
    raw_final_utf8:await readFile(join(f.dir,'raw-final.json'),'utf8'),
    old_owner_fenced:true,prior_A_preserved:true,source_snapshot_B_kept_omitted:true,
    actual_B_input_revision:'B-r2',actual_work_sequences:['A','B'],scope:'Registered existing reader; later supplied source; same-process SDK restore with disk archive rehydration. Not a real hosted runtime or empirical model qualification.'
  },null,2)+'\n');
});

test('a planner cannot relabel registered A bytes as missing B by changing source references',async t=>{
  const f=await readinessHost(t),initial=f.planner.initial;
  f.planner.initial=async ctx=>{const proposed=await initial(ctx);const tasks=proposed.tasks.map(t=>t.id==='A'?{...t,sources:['B']}:t);
    return {...proposed,tasks};};
  const outcome=await createWork(f.options).run();assert.equal(outcome.result.status,'hold');
  assert.equal(f.calls.workerA,0);assert.equal(f.calls.workerB,0);assert.equal(f.calls.final,0);
});
