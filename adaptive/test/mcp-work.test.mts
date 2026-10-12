import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTRACT_VERSION} from '../contract/c0.mts';
import type {Result} from '../contract/c0.mts';
import {callWorkTool,createWorkMcpHandler,workToolDefinitions,WorkToolError} from '../mcp/work.mts';
import type {HostWorkService} from '../mcp/work.mts';
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
