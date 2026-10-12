import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTRACT_VERSION} from '../contract/c0.mts';
import type {Result} from '../contract/c0.mts';
import {callWorkTool,createWorkMcpHandler,workToolDefinitions,WorkToolError} from '../mcp/work.mts';
import type {HostWorkService} from '../mcp/work.mts';
import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createWork} from '../sdk/index.mts';
import type {PlannerContext, PlannerPort, Registration, Task, WorkHost, WorkSnapshot} from '../sdk/index.mts';
const result = (): Result => ({contract_version: CONTRACT_VERSION, run_id: 'actual-run', status: 'needs_host', answer: null,
  unresolved: ['readback_needed'], provenance: [], pending: ['task-1'], authority: 'advisory_only', automatic_apply: false,
  usage: {operations_started: 1, decisions_started: 0, by_kind: {worker: 1, tool: 0, caller: 0, decision: 0}, tokens: null, cost: null}});
const caller = () => ({principal: 'host-authenticated-caller', signal: new AbortController().signal});
function service() {
  const calls: unknown[] = [];
  const host: HostWorkService = {authorize: async (...args) => {calls.push(['authorize',...args]);return true;},
    start: async (...args) => {calls.push(['start',...args]);return result();},
    continue: async (...args) => {calls.push(['continue',...args]);return result();},
    status: async (...args) => {calls.push(['status',...args]);return result();},
    cancel: async (...args) => {calls.push(['cancel',...args]);return result();}};
  return {host,calls};
}
test('unbound work service advertises no tools and never invents a running host',async()=>{
  assert.deepEqual(workToolDefinitions(),[]);
  await assert.rejects(callWorkTool(undefined,'work_start_v1',{request:'compare',request_id:'once'},caller()),/WORK_UNAVAILABLE/);
});
test('ordinary start forwards exact text and stable request id only after host authorization',async()=>{
  const {host,calls}=service(),ctx=caller(),args={request:'Compare the current documents',request_id:'request-1'};
  const response=await callWorkTool(host,'work_start_v1',args,ctx);
  assert.equal((calls[0] as any[])[0],'authorize');assert.equal((calls[1] as any[])[0],'start');
  assert.deepEqual((calls[1] as any[])[1],args);assert.equal((calls[1] as any[])[2],ctx);
  assert.equal(response.structuredContent.usage.cost,null);assert.equal(response.structuredContent.status,'needs_host');
});
test('model grant/provider/frame fields are rejected before any host access',async()=>{
  for(const extra of [{authorized:true},{provider:'a-model'},{frame:{}},{principal:'owner'}]){
    const {host,calls}=service();await assert.rejects(callWorkTool(host,'work_start_v1',{request:'compare',request_id:'once',...extra},caller()),/WORK_ARGUMENTS_INVALID/);assert.deepEqual(calls,[]);
  }
});
test('host denial, unknown and cancellation while authorizing do not reach effects',async()=>{
  for(const answer of [false,undefined]){
    const {host,calls}=service();host.authorize=async()=>answer as boolean;
    await assert.rejects(callWorkTool(host,'work_continue_v1',{run_id:'actual-run'},caller()),/WORK_NOT_AUTHORIZED/);assert.deepEqual(calls,[]);
  }
  const {host,calls}=service(),abort=new AbortController();host.authorize=async()=>{abort.abort();return true;};
  await assert.rejects(callWorkTool(host,'work_continue_v1',{run_id:'actual-run'},{principal:'real',signal:abort.signal}),/WORK_NOT_AUTHORIZED/);assert.deepEqual(calls,[]);
});
test('continue/status/cancel retain the supplied original run id; adapter has no retry loop',async()=>{
  for(const [name,method,args] of [['work_continue_v1','continue',{run_id:'actual-run'}],['work_status_v1','status',{run_id:'actual-run'}],['work_cancel_v1','cancel',{run_id:'actual-run',reason:'cancel this original task'}]] as const){
    const {host,calls}=service();await callWorkTool(host,name,args,caller());assert.equal(calls.length,3);assert.equal((calls[1] as any[])[0],method);assert.deepEqual((calls[1] as any[])[1],args);assert.equal((calls[2] as any[])[0],'authorize');
  }
  const {host,calls}=service();host.continue=async()=>{calls.push('one-unknown-effect');throw new Error('private secret detail');};
  await assert.rejects(callWorkTool(host,'work_continue_v1',{run_id:'actual-run'},caller()),(e:unknown)=>e instanceof WorkToolError&&e.code==='WORK_FAILURE');assert.equal(calls.length,2);
});
test('revocation or abort during the host operation prevents returned answer disclosure',async()=>{
  const {host,calls}=service();let authorized=0;host.authorize=async()=>++authorized===1;
  await assert.rejects(callWorkTool(host,'work_status_v1',{run_id:'actual-run'},caller()),/WORK_NOT_AUTHORIZED/);
  assert.equal(calls.length,1);assert.equal((calls[0] as any[])[0],'status');
  const abort=new AbortController(),other=service();other.host.status=async()=>{abort.abort();return result();};
  await assert.rejects(callWorkTool(other.host,'work_status_v1',{run_id:'actual-run'},{principal:'real',signal:abort.signal}),/WORK_NOT_AUTHORIZED/);
});
test('required request body and cancellation reason must be actual text',async()=>{
  for(const args of [{request:undefined,request_id:'once'},{request:null,request_id:'once'}]){
    const {host,calls}=service();await assert.rejects(callWorkTool(host,'work_start_v1',args,caller()),/WORK_ARGUMENTS_INVALID/);assert.deepEqual(calls,[]);
  }
  const {host,calls}=service();await assert.rejects(callWorkTool(host,'work_cancel_v1',{run_id:'actual-run',reason:undefined},caller()),/WORK_ARGUMENTS_INVALID/);assert.deepEqual(calls,[]);
});
test('callback results cannot claim automatic Apply or a different contract',async()=>{
  for(const bad of [{automatic_apply:true},{contract_version:'not-c0'}]){
    const {host}=service();host.status=async()=>({...result(),...bad} as Result);
    await assert.rejects(callWorkTool(host,'work_status_v1',{run_id:'actual-run'},caller()),/WORK_FAILURE/);
  }
});
test('existing-run operations reject a result from another run',async()=>{
  for(const name of ['work_continue_v1','work_status_v1','work_cancel_v1']){
    const {host}=service();
    const args=name==='work_cancel_v1'?{run_id:'run-A',reason:'cancel A'}:{run_id:'run-A'};
    await assert.rejects(callWorkTool(host,name,args,caller()),/WORK_FAILURE/);
  }
});
test('post-operation authorization cannot mutate the exact validated response snapshot',async()=>{
  const {host}=service(),mutable=result();let count=0;
  host.status=async()=>mutable;
  host.authorize=async()=>{if(++count===2){(mutable as any).run_id='another-run';(mutable as any).authority='apply';(mutable as any).automatic_apply=true;(mutable as any).answer='changed';}return true;};
  const returned=await callWorkTool(host,'work_status_v1',{run_id:'actual-run'},caller());
  assert.equal(returned.structuredContent.run_id,'actual-run');assert.equal(returned.structuredContent.authority,'advisory_only');
  assert.equal(returned.structuredContent.automatic_apply,false);assert.equal(returned.structuredContent.answer,null);
  assert.deepEqual(JSON.parse(returned.content[0].text),returned.structuredContent);
});
test('real JSON-RPC handler lists only bound work tools and returns ordinary status shape',async()=>{
  const {host}=service(),handler=createWorkMcpHandler(host,caller());
  assert.equal(await handler({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  const listed=await handler({jsonrpc:'2.0',id:1,method:'tools/list'});assert.equal((listed as any).result.tools.length,4);
  const response=await handler({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'work_status_v1',arguments:{run_id:'actual-run'}}});assert.equal((response as any).result.structuredContent.run_id,'actual-run');
  const legacy=await handler({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'decision_run_v1',arguments:{}}});assert.equal((legacy as any).result.isError,true);assert.equal((legacy as any).result.content[0].text,'WORK_UNAVAILABLE');
});

test('continuation discovery reflects extra real SDK planner calls when the same run pauses again',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'jev-mcp-continuation-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const snapshotPath=join(directory,'snapshot.json'),sourcePath=join(directory,'source.txt');
  const sourceText='TEST_ONLY input; the remaining request still needs caller information.';
  await writeFile(sourcePath,sourceText);
  const now=Date.now(),run_id='mcp-continuation-'+randomUUID();
  const admission={run_id,profile_id:'TEST_ONLY-original-parent',admitted_at_ms:now,deadline_ms:now+60000,timeout_ms:60000};
  const budget={max_operations:8,max_decisions:0,max_plan_versions:4,max_parallel:1,timeout_ms:60000};
  const catalog:Registration[]=[
    {capability:{id:'reader',kind:'tool',authorized:true,parallel:false,cancellable:true},description:'Read the test-owned local source',input_description:'operation=read'},
    {capability:{id:'reporter',kind:'caller',authorized:true,parallel:false,cancellable:true},description:'Unused test final port',input_description:'operation=report'},
  ];
  const tasks:Task[]=[
    {id:'read',purpose:'Read available input',capability:'reader',input_revision:'test-r1',input:{operation:'read'},sources:['input'],reads:[],after:[],output:'Actual local source observation'},
    {id:'report',purpose:'Answer only after missing information arrives',capability:'reporter',input_revision:'test-r1',input:{operation:'report'},sources:[],reads:['read'],after:['read'],output:'Grounded final'},
  ];
  const physicalPlannerInvocations:PlannerContext['invocation'][]=[];
  const plannerReceipt={mode:'scripted' as const,origin:{TEST_ONLY:true},usage:{tokens:null,cost:null},latency_ms:null};
  const readSnapshot=async()=>JSON.parse(await readFile(snapshotPath,'utf8')) as WorkSnapshot;
  const recordPhysicalInvocation=async(context:PlannerContext)=>{
    const durable=await readSnapshot();
    assert.deepEqual(durable.pending_planner,context.invocation);
    assert.equal(durable.planner_calls_started,physicalPlannerInvocations.length+1);
    assert.equal(context.deadline_ms,admission.deadline_ms);
    physicalPlannerInvocations.push(structuredClone(context.invocation));
  };
  const planner:PlannerPort={
    initial:async context=>{await recordPhysicalInvocation(context);return {...plannerReceipt,tasks};},
    next:async context=>{await recordPhysicalInvocation(context);return {...plannerReceipt,action:{kind:'pause',reason:'TEST_ONLY missing caller information'}};},
  };
  let workerCalls=0;
  const unexpected=async():Promise<never>=>{throw Error('TEST_ONLY unused execution port');};
  const host:WorkHost={
    signal:new AbortController().signal,finalCapability:'reporter',
    checks:{validateInput:(capability,input)=>!!input&&typeof input==='object'&&!Array.isArray(input)&&
      input.operation===(capability==='reader'?'read':'report'),
      authorize:(_task,sources)=>sources.every(source=>source.id==='input'&&source.text===sourceText),
      isCurrent:()=>true,acceptNativeAdmission:original=>original.run_id===run_id&&original.deadline_ms===admission.deadline_ms},
    authorizeEntry:()=>true,
    save:async snapshot=>{await writeFile(snapshotPath,JSON.stringify(snapshot));},
    readback:async snapshot=>(await readSnapshot()).digest===snapshot.digest,
    acceptSnapshot:async snapshot=>(await readSnapshot()).digest===snapshot.digest,
    authorizeReconcile:()=>true,authorizePlanner:()=>true,
    verifyPlannerOrigin:outcome=>outcome.mode==='scripted'&&!!outcome.origin&&typeof outcome.origin==='object'&&
      !Array.isArray(outcome.origin)&&outcome.origin.TEST_ONLY===true,
    verifyObservationOrigin:()=>true,
    archiveObservation:async record=>{await writeFile(join(directory,'observation.json'),JSON.stringify(record));},
    worker:async frame=>{
      workerCalls++;
      const text=await readFile(sourcePath,'utf8');assert.equal(text,frame.sources[0].text);
      return {contract_version:CONTRACT_VERSION,id:'observation:read',run_id:frame.run_id,task_id:frame.task_id,
        attempt_id:frame.attempt_id,input_revision:frame.input_revision,input_digest:frame.input_digest,
        status:'completed',value:{text},evidence:['input'],mode:'scripted',usage:{tokens:null,cost:null}};
    },
    decision:unexpected,final:unexpected,archiveFinal:unexpected,verifyFinalOrigin:()=>false,evidenceText:()=>[],
  };
  const work=createWork({requestText:'Read available input, then wait for my missing information.',
    frame:{run_id,input_revision:'test-r1',requested_output:'A grounded answer after caller input',
      sources:[{id:'input',revision:'test-r1',text:sourceText,origin:'TEST_ONLY local file',range:'whole file',omitted:false}],budget},
    admission,catalog,host,planner,maxPlannerCalls:5});
  const paused=await work.run();
  assert.equal(paused.sdk_status,'PAUSED');assert.equal(paused.result.status,'needs_host');
  assert.equal(physicalPlannerInvocations.length,2);assert.equal(workerCalls,1);
  const originalCheckpoint=paused.snapshot.checkpoint;
  const service:HostWorkService={authorize:async()=>true,start:unexpected,
    continue:async(args,ctx)=>{
      assert.equal(args.run_id,run_id);await work.continue();return (await work.run({signal:ctx.signal})).result;
    },
    status:async()=>work.outcome().result,cancel:async args=>(await work.cancel(args.reason)).result};
  const ctx=caller(),handler=createWorkMcpHandler(service,ctx);
  const listed=await handler({jsonrpc:'2.0',id:1,method:'tools/list'});
  assert.ok(listed&&'result' in listed);
  const definitions=(listed.result as {tools:ReturnType<typeof workToolDefinitions>}).tools;
  const continuation=definitions.find(tool=>tool.name==='work_continue_v1');assert.ok(continuation);
  const counts=[physicalPlannerInvocations.length],parentOperations=[paused.usage.parent_operations_started];
  for(const expectedCount of [3,4]){
    const response=await callWorkTool(service,'work_continue_v1',{run_id},ctx),outcome=work.outcome();
    assert.equal(response.structuredContent.status,'needs_host');assert.equal(response.structuredContent.answer,null);
    assert.equal(outcome.sdk_status,'PAUSED');assert.equal(outcome.snapshot.pending_planner,null);
    assert.equal(physicalPlannerInvocations.length,expectedCount);assert.equal(workerCalls,1);
    assert.equal(outcome.snapshot.checkpoint.state.deadline_ms,originalCheckpoint.state.deadline_ms);
    assert.deepEqual(outcome.snapshot.admission,admission);
    assert.deepEqual(outcome.snapshot.checkpoint.state.request.budget,budget);
    assert.equal(outcome.snapshot.planner_calls_started,expectedCount);
    const durable=await readSnapshot();
    assert.equal(durable.planner_calls_started,expectedCount);assert.equal(durable.pending_planner,null);
    assert.deepEqual(durable.admission,admission);assert.deepEqual(durable.checkpoint.state.request.budget,budget);
    assert.equal(durable.checkpoint.state.deadline_ms,originalCheckpoint.state.deadline_ms);
    counts.push(physicalPlannerInvocations.length);parentOperations.push(outcome.usage.parent_operations_started);
  }
  assert.deepEqual(counts,[2,3,4]);assert.deepEqual(parentOperations,[3,4,5]);
  assert.deepEqual(physicalPlannerInvocations.map(invocation=>invocation.id),['planner:1','planner:2','planner:3','planner:4']);
  await callWorkTool(service,'work_status_v1',{run_id},ctx);assert.equal(physicalPlannerInvocations.length,4);
  assert.equal(definitions.find(tool=>tool.name==='work_start_v1')?.annotations.idempotentHint,true);
  console.log(JSON.stringify({qualification:'TEST_ONLY scripted planner callbacks through real SDK; actual local source/save/readback; no provider calls',
    explicit_same_run_continuations:2,physical_planner_calls:counts,parent_operations:parentOperations,
    same_original_budget_and_deadline:true,worker_calls:workerCalls,advertised_continue_idempotent:continuation.annotations.idempotentHint}));
  assert.equal(continuation.annotations.idempotentHint,false);
});
