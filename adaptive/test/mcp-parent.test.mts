import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runParentOperation,openReferenceParentTransport,ParentClientError} from '../../examples/work-parent.mts';
import type {ParentMessage,ParentTransport} from '../../examples/work-parent.mts';
import {digest} from '../src/controller.mts';

const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const hash=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
const root=fileURLToPath(new URL('../../',import.meta.url));
const entry=fileURLToPath(new URL('../../examples/work-parent.mts',import.meta.url));
const request='Calculate the total and mean';
const requestId='ordinary-parent-1';
function hostClaim(state:string,runId?:string){
  const matches=readdirSync(state).filter(name=>name.startsWith('request-')&&name.endsWith('.json')).map(name=>({path:join(state,name),body:read(join(state,name))}))
    .filter(({body})=>{if(runId&&body.run_id!==runId)return false;const meta=read(join(state,body.run_id,'admission.json'));
      return body.principal==='local-reference-owner'&&body.request_digest===hash(request)&&meta.request_id===requestId&&meta.run_id===body.run_id&&
        meta.principal===body.principal&&meta.request_digest===body.request_digest&&body.meta_digest===digest(meta);});
  assert.equal(matches.length,1);return matches[0];
}
const evidence=process.env.JEV_PARENT_EVIDENCE_DIR;
function proof(name:string,value:unknown){if(evidence){mkdirSync(evidence,{recursive:true,mode:0o700});writeFileSync(join(evidence,name+'.json'),JSON.stringify(value,null,2)+'\n',{mode:0o600});}}
function fixture(t:any){const directory=mkdtempSync(join(tmpdir(),'jev-parent-')),state=join(directory,'host'),receipt=join(directory,'parent.json');
  t.after(()=>rmSync(directory,{recursive:true,force:true}));return {directory,state,receipt};}
function cli(args:string[]){const result=spawnSync(process.execPath,['--experimental-strip-types',entry,...args],{cwd:root,encoding:'utf8',timeout:15000,
  env:{PATH:process.env.PATH??'',LANG:'C.UTF-8'}});assert.equal(result.status,0,result.stderr);assert.equal(result.error,undefined);const lines=result.stdout.trim().split('\n');
  assert.equal(lines.length,1);return {message:JSON.parse(lines[0]) as ParentMessage,stdout:result.stdout,stderr:result.stderr,exit_code:result.status};}
function files(directory:string){return Object.fromEntries(readdirSync(directory).sort().map(name=>[name,hash(readFileSync(join(directory,name)))]));}
function connecting(state:string,pause=true,wrap?:(actual:ParentTransport)=>ParentTransport){let calls=0;
  return {get calls(){return calls;},connect:async()=>{calls++;const actual=openReferenceParentTransport(state,{pauseAfterRead:pause});return wrap?wrap(actual):actual;}};}
function lostReply(actual:ParentTransport,seen:any[]):ParentTransport{return {
  request:async message=>{const raw=await actual.request(message);seen.push({message,raw});if(message.method==='tools/call')throw new ParentClientError('TEST_ONLY_LOST_RESPONSE');return raw;},
  notify:message=>actual.notify(message),close:()=>actual.close(),
};}

test('public ordinary parent uses actual subprocess MCP, saves pause, resumes same work and receives a normal answer',async t=>{
  const {state,receipt}=fixture(t);
  const first=cli(['--state',state,'--receipt',receipt,'--request',request,'--request-id',requestId,'--pause-after-read']);
  assert.equal(first.message.kind,'ordinary-parent-message');assert.equal(first.message.status,'needs_host');assert.equal(first.message.next_operation,'continue');
  const run=first.message.run_id!;assert.match(run,/^reference-/);
  const paused=read(join(state,run,'snapshot.json')),admission=read(join(state,run,'admission.json')),io=readFileSync(join(state,run,'io-read-numbers.json'));
  assert.equal(paused.planner_calls_started,2);assert.equal(paused.checkpoint.state.operations,1);
  const parentFirst=read(receipt);assert.equal(parentFirst.request,request);assert.equal(parentFirst.request_id,requestId);assert.equal(parentFirst.state_directory,state);
  assert.equal(parentFirst.history[0].disposition,'verified');assert.equal(parentFirst.history[0].transport_closed,true);
  assert.deepEqual(parentFirst.history[0].raw_responses.map((raw:string)=>JSON.parse(raw).id),[1,2,3]);
  assert.equal(JSON.parse(parentFirst.history[0].raw_responses[1]).result.tools.length,4);
  assert.equal(existsSync(join(state,'writer.lock')),false);
  const second=cli(['--receipt',receipt,'--operation','continue']);
  assert.equal(second.message.status,'complete');assert.equal(second.message.next_operation,'none');assert.equal(second.message.run_id,run);
  assert.match(second.message.text,/Total: 720; mean: 240; count: 3/);assert.match(second.message.text,/Scripted reference planner\/final/);
  assert.deepEqual(second.message.result!.provenance,['observation:statistics']);assert.equal(second.message.result!.usage.tokens,null);assert.equal(second.message.result!.usage.cost,null);
  const completed=read(join(state,run,'snapshot.json'));
  assert.deepEqual(completed.admission,paused.admission);assert.deepEqual(completed.checkpoint.state.request.budget,paused.checkpoint.state.request.budget);
  assert.equal(completed.admission.deadline_ms,admission.admission.deadline_ms);assert.deepEqual(readFileSync(join(state,run,'io-read-numbers.json')),io);
  const before=files(join(state,run)),third=cli(['--receipt',receipt,'--operation','status']);
  assert.deepEqual(third.message.result,second.message.result);assert.deepEqual(files(join(state,run)),before);
  const parentFinal=read(receipt);assert.deepEqual(parentFinal.history.map((e:any)=>e.tool),['work_start_v1','work_continue_v1','work_status_v1']);
  assert.equal(parentFinal.history.every((e:any)=>e.disposition==='verified'&&e.transport_closed===true),true);
  const rawFinal=readFileSync(join(state,run,'final-'+completed.final_receipt.raw_sha256+'.json'),'utf8');
  proof('success',{first,second,third,client_journal:parentFinal,admission,paused,completed,original_read_sha256:hash(io),host_files:before,raw_final_utf8:rawFinal,
    scope:'actual local parent/server processes and file I/O; scripted planner/final; no provider/native calls'});
});

test('an identical client start reads its own saved receipt and conflicting request is refused before connecting',async t=>{
  const {state,receipt}=fixture(t),binding=connecting(state);
  const initial=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  const original=readFileSync(receipt,'utf8');
  const same=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  assert.deepEqual(same.result,initial.result);assert.equal(same.delivery,'saved_client_receipt');assert.equal(same.result_is_cached,true);assert.equal(same.current_operation,null);
  assert.equal(initial.delivery,'transport_operation');assert.equal(initial.result_is_cached,false);assert.equal(binding.calls,1);assert.equal(readFileSync(receipt,'utf8'),original);
  await assert.rejects(runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request:'Compare other material',requestId,connect:binding.connect}),/PARENT_REQUEST_CONFLICT/);
  assert.equal(binding.calls,1);assert.equal(readFileSync(receipt,'utf8'),original);assert.equal(existsSync(receipt+'.lock'),false);
  proof('local-idempotency',{initial,same,physical_connections:binding.calls,client_journal:read(receipt)});
});

test('lost start response keeps the real request identity and unknown run, with no resend or fabricated status call',async t=>{
  const {state,receipt}=fixture(t),seen:any[]=[],binding=connecting(state,true,actual=>lostReply(actual,seen));
  const unknown=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  assert.equal(unknown.status,'response_unknown');assert.equal(unknown.run_id,null);assert.equal(unknown.result,null);assert.equal(unknown.next_operation,'host_readback_or_reconciliation');
  const saved=read(receipt);assert.equal(saved.request_id,requestId);assert.equal(saved.history[0].disposition,'response_unknown');assert.equal(saved.history[0].transport_closed,true);
  const repeated=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  assert.equal(repeated.status,unknown.status);assert.equal(repeated.run_id,null);assert.equal(repeated.delivery,'saved_client_receipt');assert.equal(repeated.current_operation,null);
  assert.equal(binding.calls,1);assert.equal(seen.filter(x=>x.message.method==='tools/call').length,1);
  await assert.rejects(runParentOperation({receiptPath:receipt,operation:'status',connect:binding.connect}),/PARENT_ORIGINAL_RUN_UNAVAILABLE/);
  await assert.rejects(runParentOperation({receiptPath:receipt,operation:'continue',connect:binding.connect}),/PARENT_ORIGINAL_RUN_UNAVAILABLE/);
  const originalHostClaim=hostClaim(state).body;assert.match(originalHostClaim.run_id,/^reference-/);
  assert.equal(read(join(state,originalHostClaim.run_id,'snapshot.json')).checkpoint.state.operations,1);
  assert.equal(binding.calls,1);
  proof('lost-start',{unknown,repeated,client_journal:saved,actual_host_claim:originalHostClaim,actual_transport_seen:seen,
    note:'TEST_ONLY response-loss after actual host reply; client does not consume the test witness run_id'});
});

test('lost continue response is never retried; explicit status reads original result while uncertainty stays visible',async t=>{
  const {state,receipt}=fixture(t),start=connecting(state);
  const paused=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:start.connect});
  const seen:any[]=[],continuation=connecting(state,false,actual=>lostReply(actual,seen));
  const unknown=await runParentOperation({receiptPath:receipt,operation:'continue',connect:continuation.connect});
  assert.equal(unknown.run_id,paused.run_id);assert.equal(unknown.status,'response_unknown');assert.equal(unknown.result!.status,'needs_host');
  await assert.rejects(runParentOperation({receiptPath:receipt,operation:'continue',connect:continuation.connect}),/PARENT_RECONCILIATION_REQUIRED/);
  assert.equal(continuation.calls,1);assert.equal(seen.filter(x=>x.message.method==='tools/call').length,1);
  const before=files(join(state,paused.run_id!)),statusBinding=connecting(state,false);
  const status=await runParentOperation({receiptPath:receipt,operation:'status',connect:statusBinding.connect});
  assert.equal(status.result!.status,'complete');assert.equal(status.status,'response_unknown');assert.equal(status.next_operation,'host_readback_or_reconciliation');
  assert.deepEqual(files(join(state,paused.run_id!)),before);
  await assert.rejects(runParentOperation({receiptPath:receipt,operation:'continue',connect:continuation.connect}),/PARENT_RECONCILIATION_REQUIRED/);
  assert.equal(continuation.calls,1);
  proof('lost-continue',{paused,unknown,status,client_journal:read(receipt),actual_transport_seen:seen,host_files:before});
});

test('known-run status reads a fresh result after lost continuation and unconfirmed close without clearing history or replaying work',async t=>{
  const {state,receipt}=fixture(t),start=connecting(state);
  const paused=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:start.connect});
  const original=read(join(state,paused.run_id!,'snapshot.json')),io=readFileSync(join(state,paused.run_id!,'io-read-numbers.json'));
  const seen:any[]=[],continuation=connecting(state,false,actual=>({
    ...lostReply(actual,seen),
    close:async()=>{assert.equal(await actual.close(),true);return false;}, // TEST_ONLY unconfirmed transport after real host cleanup.
  }));
  const unknown=await runParentOperation({receiptPath:receipt,operation:'continue',connect:continuation.connect});
  assert.equal(unknown.status,'response_unknown');assert.equal(unknown.current_operation!.transport_closed,false);
  const oldEntry=read(receipt).history[1],before=files(join(state,paused.run_id!)),statusBinding=connecting(state,false),replies:any[]=[];
  const current=await runParentOperation({receiptPath:receipt,operation:'status',connect:async()=>{
    const actual=await statusBinding.connect();return {...actual,request:async message=>{replies.push(message);return actual.request(message);}};
  }});
  assert.equal(statusBinding.calls,1);assert.equal(replies.filter(m=>m.method==='tools/call').length,1);
  assert.equal(replies.find(m=>m.method==='tools/call').params.name,'work_status_v1');
  assert.equal(current.status,'response_unknown');assert.equal(current.result!.status,'complete');assert.equal(current.result_is_cached,false);
  assert.equal(current.current_operation!.operation,'status');assert.equal(current.current_operation!.disposition,'verified');
  assert.equal(current.current_operation!.transport_closed,true);assert.equal(current.current_operation!.error,null);
  assert.equal(current.next_operation,'host_readback_or_reconciliation');assert.doesNotMatch(current.text,/Total: 720/);
  assert.deepEqual(read(receipt).history[1],oldEntry);assert.equal(oldEntry.disposition,'response_unknown');assert.equal(oldEntry.transport_closed,false);
  assert.deepEqual(files(join(state,paused.run_id!)),before);assert.deepEqual(readFileSync(join(state,paused.run_id!,'io-read-numbers.json')),io);
  const saved=read(join(state,paused.run_id!,'snapshot.json'));assert.deepEqual(saved.admission,original.admission);
  assert.deepEqual(saved.checkpoint.state.request.budget,original.checkpoint.state.request.budget);assert.equal(current.result!.usage.by_kind.worker,1);
  const journalBefore=readFileSync(receipt,'utf8');let replayConnections=0;
  await assert.rejects(runParentOperation({receiptPath:receipt,operation:'continue',connect:async()=>{replayConnections++;throw Error('TEST_ONLY forbidden replay');}}),/PARENT_RECONCILIATION_REQUIRED/);
  assert.equal(replayConnections,0);assert.equal(readFileSync(receipt,'utf8'),journalBefore);
  proof('status-after-unconfirmed-lost-continue',{paused,unknown,current,old_entry:oldEntry,client_journal:read(receipt),actual_requests:replies,host_files:before,replayConnections});
});

test('a verified result with unconfirmed earlier close permits read-only status while mutating continuation remains blocked',async t=>{
  const {state,receipt}=fixture(t),start=connecting(state,false,actual=>({...actual,close:async()=>{assert.equal(await actual.close(),true);return false;}}));
  const first=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:start.connect});
  assert.equal(first.status,'readback_unconfirmed');assert.equal(first.result!.status,'complete');
  const originalEntry=read(receipt).history[0],before=files(join(state,first.run_id!)),binding=connecting(state,false);
  const current=await runParentOperation({receiptPath:receipt,operation:'status',connect:binding.connect});
  assert.equal(current.status,'complete');assert.equal(current.result_is_cached,false);assert.deepEqual(current.result,first.result);
  assert.deepEqual(read(receipt).history[0],originalEntry);assert.equal(originalEntry.disposition,'verified');assert.equal(originalEntry.transport_closed,false);
  const journalBefore=readFileSync(receipt,'utf8');let mutationConnections=0;
  await assert.rejects(runParentOperation({receiptPath:receipt,operation:'continue',connect:async()=>{mutationConnections++;throw Error('TEST_ONLY forbidden mutation');}}),/PARENT_HOST_CLOSE_UNCONFIRMED/);
  assert.equal(mutationConnections,0);assert.equal(readFileSync(receipt,'utf8'),journalBefore);assert.deepEqual(files(join(state,first.run_id!)),before);
  proof('status-after-unconfirmed-verified-close',{first,current,original_entry:originalEntry,client_journal:read(receipt),host_files:before,mutationConnections});
});

test('actual host rejects a conflicting request_id from a separate client journal without creating another run',async t=>{
  const {directory,state,receipt}=fixture(t),start=connecting(state,false);
  const first=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:start.connect});
  const before=files(join(state,first.run_id!)),claimPath=hostClaim(state,first.run_id!).path,claim=readFileSync(claimPath,'utf8'),other=join(directory,'conflicting-parent.json'),binding=connecting(state,false);
  const rejected=await runParentOperation({receiptPath:other,operation:'start',stateDirectory:state,request:'Compare the two policy texts',requestId,connect:binding.connect});
  assert.equal(rejected.run_id,null);assert.equal(rejected.status,'response_unknown');assert.equal(binding.calls,1);
  const journal=read(other),reply=JSON.parse(journal.history[0].raw_responses[2]);
  assert.equal(reply.result.isError,true);assert.equal(reply.result.content[0].text,'WORK_FAILURE');
  assert.deepEqual(files(join(state,first.run_id!)),before);assert.equal(readFileSync(hostClaim(state,first.run_id!).path,'utf8'),claim);
  assert.equal(readdirSync(state).filter(name=>name.startsWith('reference-')).length,1);
  await runParentOperation({receiptPath:other,operation:'start',stateDirectory:state,request:'Compare the two policy texts',requestId,connect:binding.connect});assert.equal(binding.calls,1);
  proof('host-id-conflict',{first,rejected,raw_reply:journal.history[0].raw_responses[2],client_journal:journal,original_host_files:before});
});

test('a mismatched text/structured reply remains unconfirmed after actual execution',async t=>{
  const {state,receipt}=fixture(t);let sends=0;
  const binding=connecting(state,false,actual=>({
    request:async message=>{const raw=await actual.request(message);if(message.method!=='tools/call')return raw;sends++;
      const reply=JSON.parse(raw);reply.result.content[0].text=JSON.stringify({...reply.result.structuredContent,answer:'TEST_ONLY_CHANGED_TEXT'});return JSON.stringify(reply);},
    notify:message=>actual.notify(message),close:()=>actual.close(),
  }));
  const unknown=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  assert.equal(unknown.status,'response_unknown');assert.equal(unknown.run_id,null);assert.equal(sends,1);assert.equal(read(receipt).history[0].error,'PARENT_TOOL_RESPONSE_UNCONFIRMED');
  proof('mismatched-reply',{unknown,client_journal:read(receipt),actual_tool_sends:sends});
});

test('oversized tool reply is rejected before journal storage and does not make the saved request unreadable',async t=>{
  const {state,receipt}=fixture(t),binding=connecting(state,false,actual=>({
    request:async message=>{const raw=await actual.request(message);return message.method==='tools/call'?raw+' '.repeat(512*1024):raw;},
    notify:message=>actual.notify(message),close:()=>actual.close(),
  }));
  const unknown=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  assert.equal(unknown.status,'response_unknown');assert.equal(read(receipt).history[0].error,'PARENT_REPLY_TOO_LARGE');assert.equal(read(receipt).history[0].raw_responses.length,2);
  assert.equal(Buffer.byteLength(readFileSync(receipt,'utf8'))<512*1024,true);
  const repeated=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  assert.equal(repeated.status,unknown.status);assert.equal(repeated.run_id,null);assert.equal(repeated.delivery,'saved_client_receipt');assert.equal(binding.calls,1);
  proof('oversized-reply',{unknown,client_journal:read(receipt),physical_connections:binding.calls});
});

test('failed current status never projects a cached complete result as a successful readback',async t=>{
  const {state,receipt}=fixture(t),binding=connecting(state,false);
  const initial=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  assert.equal(initial.status,'complete');
  const before=files(join(state,initial.run_id!));
  const wrongReply=connecting(state,false,actual=>({
    request:async message=>{const raw=await actual.request(message);if(message.method==='tools/call'){const reply=JSON.parse(raw);reply.id=999;return JSON.stringify(reply);}return raw;},
    notify:message=>actual.notify(message),close:()=>actual.close(),
  }));
  const failed=await runParentOperation({receiptPath:receipt,operation:'status',connect:wrongReply.connect});
  assert.equal(failed.status,'readback_unconfirmed');assert.equal(failed.result_is_cached,true);assert.deepEqual(failed.result,initial.result);
  assert.equal(failed.current_operation!.operation,'status');assert.equal(failed.current_operation!.disposition,'response_unknown');assert.equal(failed.current_operation!.error,'PARENT_RPC_INVALID');
  assert.equal(failed.next_operation,'host_readback_or_reconciliation');assert.doesNotMatch(failed.text,/Total: 720/);assert.deepEqual(files(join(state,initial.run_id!)),before);
  const preflight=await runParentOperation({receiptPath:receipt,operation:'status',connect:async()=>{throw new ParentClientError('TEST_ONLY_CONNECTION_UNAVAILABLE');}});
  assert.equal(preflight.status,'readback_unconfirmed');assert.equal(preflight.result_is_cached,true);assert.equal(preflight.current_operation!.disposition,'prepared');
  assert.equal(preflight.current_operation!.error,'TEST_ONLY_CONNECTION_UNAVAILABLE');assert.equal(preflight.next_operation,'host_readback_or_reconciliation');
  const confirmed=await runParentOperation({receiptPath:receipt,operation:'status',connect:binding.connect});
  assert.equal(confirmed.status,'complete');assert.equal(confirmed.result_is_cached,false);assert.deepEqual(confirmed.result,initial.result);assert.deepEqual(files(join(state,initial.run_id!)),before);
  proof('failed-status',{initial,failed,preflight,confirmed,client_journal:read(receipt),host_files:before});
});

test('failed continuation preflight exposes the old paused result as cached instead of offering continuation',async t=>{
  const {state,receipt}=fixture(t),binding=connecting(state);
  const initial=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  const before=files(join(state,initial.run_id!));
  const failed=await runParentOperation({receiptPath:receipt,operation:'continue',connect:async()=>{throw new ParentClientError('TEST_ONLY_CONNECTION_UNAVAILABLE');}});
  assert.equal(failed.status,'readback_unconfirmed');assert.equal(failed.result_is_cached,true);assert.equal(failed.result!.status,'needs_host');
  assert.equal(failed.next_operation,'host_readback_or_reconciliation');assert.equal(failed.current_operation!.operation,'continue');assert.equal(failed.current_operation!.disposition,'prepared');
  assert.deepEqual(files(join(state,initial.run_id!)),before);assert.equal(binding.calls,1);
  proof('failed-continuation-preflight',{initial,failed,client_journal:read(receipt),host_files:before});
});

test('unavailable work tool stops before any call and early host exit is an ordinary saved preflight failure',async t=>{
  const {directory,state,receipt}=fixture(t);let sends=0;
  const binding=connecting(state,false,actual=>({
    request:async message=>{const raw=await actual.request(message);if(message.method==='tools/call')sends++;
      if(message.method==='tools/list'){const reply=JSON.parse(raw);reply.result.tools=[{name:'decision_evaluate',inputSchema:{}}];return JSON.stringify(reply);}return raw;},
    notify:message=>actual.notify(message),close:()=>actual.close(),
  }));
  const unbound=await runParentOperation({receiptPath:receipt,operation:'start',stateDirectory:state,request,requestId,connect:binding.connect});
  assert.equal(unbound.status,'not_started');assert.equal(unbound.run_id,null);assert.equal(unbound.next_operation,'host_readback_or_reconciliation');assert.equal(sends,0);
  assert.deepEqual(readdirSync(state),[]);
  // An existing host lock makes the actual child exit before initialization; no EPIPE escapes the journal path.
  writeFileSync(join(state,'writer.lock'),'TEST_ONLY_EXISTING_HOST_WRITER');
  const closedReceipt=join(directory,'closed-parent.json'),closed=await runParentOperation({receiptPath:closedReceipt,operation:'start',stateDirectory:state,request,requestId,
    connect:async()=>openReferenceParentTransport(state,{replyTimeoutMs:500})});
  assert.equal(closed.status,'not_started');assert.equal(closed.run_id,null);assert.equal(read(closedReceipt).history[0].transport_closed,false);
  assert.equal(readFileSync(join(state,'writer.lock'),'utf8'),'TEST_ONLY_EXISTING_HOST_WRITER');
  proof('preflight',{unbound,unbound_journal:read(receipt),closed,closed_journal:read(closedReceipt),actual_tool_sends:sends});
});
