import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,existsSync,statSync,rmSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {CONTRACT_VERSION} from '../contract/c0.mts';
import type {Result} from '../contract/c0.mts';
import {createWorkMcpHandler} from '../mcp/work.mts';
import type {HostWorkService} from '../mcp/work.mts';
import {inspectParentReceipt,runParentOperation,ParentClientError} from '../../examples/work-parent.mts';
import type {ParentTransport,ParentMessage} from '../../examples/work-parent.mts';
import {renderParentText,renderParentError,renderParentHelp} from '../../examples/work-parent-view.mts';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const request='Compare the available documents.';
const answer='TEST_ONLY answer from the original host result.';
const outcome=(status:'needs_host'|'complete'='complete'):Result=>({contract_version:CONTRACT_VERSION,
  run_id:'TEST_ONLY-original-run',status,answer:status==='complete'?answer:null,unresolved:[],provenance:['TEST_ONLY-observation'],
  pending:status==='complete'?[]:['remaining-work'],usage:{operations_started:1,decisions_started:0,
    by_kind:{worker:1,tool:0,caller:0,decision:0},tokens:null,cost:null},authority:'advisory_only',automatic_apply:false});
function fixture(t:{after:(fn:()=>void)=>void}) {
  const directory=mkdtempSync(join(tmpdir(),'jev-parent-view-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  return {directory,receipt:join(directory,"client receipt 'original'.json"),state:join(directory,'host-state')};
}
function connection(options:{start?:Result;drop?:'start'|'continue';close?:boolean;preflightFailure?:boolean;beforeConnect?:()=>void}={}) {
  const calls:string[]=[],requests:unknown[]=[];let connections=0;
  const host:HostWorkService={authorize:async()=>true,
    start:async()=>{calls.push('start');return options.start??outcome();},
    continue:async()=>{calls.push('continue');return outcome();},
    status:async()=>{calls.push('status');return outcome();},
    cancel:async()=>{throw Error('TEST_ONLY unused cancel');}};
  const handler=createWorkMcpHandler(host,{principal:'TEST_ONLY-transport',signal:new AbortController().signal});
  const connect=async():Promise<ParentTransport>=>{
    connections++;options.beforeConnect?.();
    return {request:async message=>{
      requests.push(structuredClone(message));if(options.preflightFailure)throw new ParentClientError('PARENT_RPC_INVALID');
      const reply=await handler(message);
      if(message.method==='tools/call'&&(message.params as {name:string}).name===`work_${options.drop}_v1`)
        throw new ParentClientError('PARENT_REPLY_UNKNOWN');
      return JSON.stringify(reply);
    },notify:async message=>{await handler(message);},close:async()=>options.close??true};
  };
  return {connect,calls,requests,connections:()=>connections};
}
function cli(args:string[]) {
  return spawnSync(process.execPath,['--experimental-strip-types',join(root,'examples/work-parent.mts'),...args],
    {cwd:root,env:{PATH:process.env.PATH??''},encoding:'utf8',timeout:15000});
}
const context=(receipt:string,journal:ReturnType<typeof inspectParentReceipt>['journal'])=>({receiptPath:receipt,
  command:['node','/tmp/example client/work-parent.mjs'],journal});

test('generated original ID is durable before connecting and identical omitted-ID start is a cached receipt read',async t=>{
  const f=fixture(t),binding=connection({beforeConnect:()=>{
    const durable=inspectParentReceipt(f.receipt).journal;
    assert.match(durable.request_id,/^parent-[a-f0-9-]+$/);assert.equal(durable.history[0].disposition,'prepared');
  }});
  const first=await runParentOperation({receiptPath:f.receipt,operation:'start',request,stateDirectory:f.state,connect:binding.connect});
  const before=readFileSync(f.receipt),modified=statSync(f.receipt).mtimeMs;
  const repeated=await runParentOperation({receiptPath:f.receipt,operation:'start',request,connect:binding.connect});
  assert.equal(first.request_id,repeated.request_id);assert.equal(repeated.delivery,'saved_client_receipt');assert.equal(repeated.result_is_cached,true);
  assert.equal(repeated.current_operation,null);assert.equal(binding.connections(),1);assert.deepEqual(binding.calls,['start']);
  assert.deepEqual(readFileSync(f.receipt),before);assert.equal(statSync(f.receipt).mtimeMs,modified);
  await assert.rejects(runParentOperation({receiptPath:f.receipt,operation:'start',request:'Another request',connect:binding.connect}),/PARENT_REQUEST_CONFLICT/);
  await assert.rejects(runParentOperation({receiptPath:f.receipt,operation:'start',request,requestId:'',connect:binding.connect}),/PARENT_ARGUMENTS_INVALID/);
  await assert.rejects(runParentOperation({receiptPath:f.receipt,operation:'start',request,requestId:'different-id',connect:binding.connect}),/PARENT_REQUEST_CONFLICT/);
  assert.equal(binding.connections(),1);assert.deepEqual(readFileSync(f.receipt),before);
  assert.deepEqual(Object.keys(first).sort(),['kind','request_id','run_id','status','text','next_operation','result','client_journal_sha256',
    'result_is_cached','delivery','current_operation','qualification'].sort());
});
test('inspect and help are read-only, cached, safely quoted, and never construct an absent host state',async t=>{
  const f=fixture(t),binding=connection();await runParentOperation({receiptPath:f.receipt,operation:'start',request,stateDirectory:f.state,connect:binding.connect});
  const bytes=readFileSync(f.receipt),mtime=statSync(f.receipt).mtimeMs,inspection=inspectParentReceipt(f.receipt);
  assert.equal(inspection.message.delivery,'saved_client_receipt');assert.equal(inspection.message.result_is_cached,true);
  assert.equal(inspection.message.current_operation,null);assert.equal(Object.isFrozen(inspection.journal.history),true);
  const text=renderParentText(inspection.message,context(f.receipt,inspection.journal));
  assert.match(text,/Saved answer \(cached/);assert.match(text,/Saved receipt view only; no host was contacted/);
  assert.match(text,/Original run: TEST_ONLY-original-run/);assert.match(text,/--operation inspect --format text/);
  assert.ok(text.includes("'client")===false);assert.ok(text.includes("'\\''original'\\''"));
  const viewed=cli(['--receipt',f.receipt,'--operation','inspect','--format','text']);assert.equal(viewed.status,0,viewed.stderr);
  assert.match(viewed.stdout,/Saved answer \(cached/);assert.doesNotMatch(viewed.stdout,/Answer \(fresh/);
  const json=cli(['--receipt',f.receipt,'--operation','inspect']);assert.equal(json.status,0,json.stderr);
  assert.deepEqual(JSON.parse(json.stdout),inspection.message);
  const same=cli(['--receipt',f.receipt,'--request',request]);assert.equal(same.status,0,same.stderr);assert.equal(JSON.parse(same.stdout).request_id,inspection.journal.request_id);
  const help=cli(['--help','--receipt',join(f.directory,'absent','receipt.json')]);assert.equal(help.status,0,help.stderr);assert.match(help.stdout,/--operation inspect/);
  const invalid=cli(['--receipt',join(f.directory,'absent','receipt.json'),'--format','unsupported']);assert.equal(invalid.status,1);assert.match(invalid.stderr,/PARENT_FORMAT_INVALID/);assert.doesNotMatch(invalid.stderr,/\n\s+at /);
  assert.equal(existsSync(join(f.directory,'absent')),false);assert.equal(existsSync(f.state),false);assert.equal(existsSync(f.receipt+'.lock'),false);
  assert.deepEqual(readFileSync(f.receipt),bytes);assert.equal(statSync(f.receipt).mtimeMs,mtime);assert.equal(binding.connections(),1);
});
test('unknown first start keeps its generated ID and offers inspect without a fabricated status or retry',async t=>{
  const f=fixture(t),binding=connection({drop:'start'});
  const unknown=await runParentOperation({receiptPath:f.receipt,operation:'start',request,stateDirectory:f.state,connect:binding.connect});
  assert.equal(unknown.status,'response_unknown');assert.equal(unknown.run_id,null);
  const inspection=inspectParentReceipt(f.receipt),text=renderParentText(inspection.message,context(f.receipt,inspection.journal)),before=readFileSync(f.receipt);
  assert.match(text,/Earlier operation unresolved: start/);assert.match(text,/--operation inspect/);assert.doesNotMatch(text,/--operation status|--operation continue/);
  const cached=await runParentOperation({receiptPath:f.receipt,operation:'start',request,connect:binding.connect});assert.equal(cached.request_id,unknown.request_id);
  const rejected=cli(['--receipt',f.receipt,'--operation','continue','--format','text']);assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/original run ID is not available/);assert.doesNotMatch(rejected.stderr,/\n\s+at /);
  assert.equal(binding.connections(),1);assert.deepEqual(binding.calls,['start']);assert.deepEqual(readFileSync(f.receipt),before);assert.equal(existsSync(f.state),false);
});
test('fresh verified answer is foregrounded while older unknown continuation and unconfirmed close stay visible',async t=>{
  const f=fixture(t),start=connection({start:outcome('needs_host')});
  await runParentOperation({receiptPath:f.receipt,operation:'start',request,stateDirectory:f.state,connect:start.connect});
  const lost=connection({drop:'continue',close:false});await runParentOperation({receiptPath:f.receipt,operation:'continue',connect:lost.connect});
  const old=inspectParentReceipt(f.receipt).journal.history[1],status=connection();
  const current=await runParentOperation({receiptPath:f.receipt,operation:'status',connect:status.connect}),inspection=inspectParentReceipt(f.receipt);
  assert.equal(current.status,'response_unknown');assert.equal(current.result_is_cached,false);assert.equal(current.result!.answer,answer);
  const text=renderParentText(current,context(f.receipt,inspection.journal));
  assert.match(text,/^Answer \(fresh verified host result\):\nTEST_ONLY answer/);assert.match(text,/Current operation: status — verified; host close confirmed/);
  assert.match(text,/Earlier operation unresolved: continue/);assert.match(text,/Host close unconfirmed for continue/);
  assert.match(text,/--operation status/);assert.doesNotMatch(text,/--operation continue/);
  assert.deepEqual(inspection.journal.history[1],old);
  const before=readFileSync(f.receipt);await assert.rejects(runParentOperation({receiptPath:f.receipt,operation:'continue',connect:lost.connect}),/PARENT_RECONCILIATION_REQUIRED/);
  const rejected=cli(['--receipt',f.receipt,'--operation','continue','--format','text']);assert.equal(rejected.status,1);
  assert.match(rejected.stderr,/Continue was blocked before connecting/);assert.match(rejected.stderr,/--operation inspect/);assert.doesNotMatch(rejected.stderr,/\n\s+at /);
  assert.equal(lost.connections(),1);assert.deepEqual(readFileSync(f.receipt),before);assert.equal(existsSync(f.state),false);
});
test('failed current readback labels the previous answer cached and exposes the failure without a continuation command',async t=>{
  const f=fixture(t),start=connection();await runParentOperation({receiptPath:f.receipt,operation:'start',request,stateDirectory:f.state,connect:start.connect});
  const failed=connection({preflightFailure:true}),message=await runParentOperation({receiptPath:f.receipt,operation:'status',connect:failed.connect});
  assert.equal(message.status,'readback_unconfirmed');assert.equal(message.result_is_cached,true);assert.equal(message.current_operation!.error,'PARENT_RPC_INVALID');
  const inspection=inspectParentReceipt(f.receipt),text=renderParentText(message,context(f.receipt,inspection.journal));
  assert.match(text,/^Saved answer \(cached/);assert.match(text,/Current error: PARENT_RPC_INVALID/);assert.doesNotMatch(text,/Answer \(fresh|--operation continue/);
  assert.match(text,/--operation inspect/);assert.match(text,/after checking the original connection and host permissions/);assert.deepEqual(failed.calls,[]);
  const saved=renderParentText(inspection.message,context(f.receipt,inspection.journal));
  assert.match(saved,/Saved answer \(cached/);assert.match(saved,/Last saved operation: status — prepared/);assert.match(saved,/Saved error: PARENT_RPC_INVALID/);
  assert.doesNotMatch(saved,/Answer \(fresh|--operation continue/);
  const withoutLocator=renderParentText(message);
  assert.match(withoutLocator,/The original run is known/);assert.match(withoutLocator,/no saved receipt path/);
  assert.doesNotMatch(withoutLocator,/A status call needs the actual original run ID|--operation status|--operation continue/);
});
test('older unconfirmed close blocks the continuation hint after a later verified unfinished status',async t=>{
  const f=fixture(t),start=connection({start:outcome('needs_host'),close:false});
  await runParentOperation({receiptPath:f.receipt,operation:'start',request,stateDirectory:f.state,connect:start.connect});
  const status=connection(); // Return saved unfinished work from a TEST_ONLY original host.
  const pausedResult=outcome('needs_host'),handler=createWorkMcpHandler({authorize:async()=>true,start:async()=>pausedResult,
    continue:async()=>pausedResult,status:async()=>pausedResult,cancel:async()=>pausedResult},{principal:'TEST_ONLY',signal:new AbortController().signal});
  const message=await runParentOperation({receiptPath:f.receipt,operation:'status',connect:async()=>({request:async m=>JSON.stringify(await handler(m)),notify:async()=>{},close:async()=>true})});
  assert.equal(message.result_is_cached,false);assert.equal(message.next_operation,'host_readback_or_reconciliation');
  const inspection=inspectParentReceipt(f.receipt),text=renderParentText(message,context(f.receipt,inspection.journal));
  assert.match(text,/Host close unconfirmed for start/);assert.doesNotMatch(text,/--operation continue/);
  await assert.rejects(runParentOperation({receiptPath:f.receipt,operation:'continue',connect:status.connect}),/PARENT_HOST_CLOSE_UNCONFIRMED/);assert.equal(status.connections(),0);
});
test('pure error view and text sanitization retain safe inspect guidance without raw stack or terminal control effects',()=>{
  const error=renderParentError(new ParentClientError('PARENT_RECONCILIATION_REQUIRED'),{receiptPath:'/tmp/saved receipt.json'});
  assert.match(error,/blocked before connecting/);assert.match(error,/--operation inspect/);assert.doesNotMatch(error,/--operation continue|\n\s+at /);
  const result=outcome(),message:ParentMessage={kind:'ordinary-parent-message',request_id:'TEST_ONLY',run_id:result.run_id,status:'complete',text:'unused',
    next_operation:'none',result:{...result,answer:'Answer\u001b[31m\rspoof'},client_journal_sha256:'test',result_is_cached:false,
    delivery:'transport_operation',current_operation:{operation:'status',disposition:'verified',error:null,transport_closed:true},qualification:'client projection only; actual host origins and effects require their own evidence'};
  const text=renderParentText(message);assert.match(text,/Answer\\u001b\[31m\\u000dspoof/);assert.doesNotMatch(text,/\u001b|\r/);
});
test('complete command arguments with terminal controls are withheld, not escaped into another executable path',async t=>{
  const f=fixture(t),binding=connection();
  const message=await runParentOperation({receiptPath:f.receipt,operation:'start',request,stateDirectory:f.state,connect:binding.connect});
  const inspection=inspectParentReceipt(f.receipt),unsafe=/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/;
  for(const character of ['\n','\t','\u0000','\u001b','\u007f','\u0085','\u009b','\u2028','\u2029']){
    const path='original'+character+'receipt.json';
    const receiptContext={receiptPath:path,command:['node','client.mjs'],journal:inspection.journal};
    for(const text of [renderParentText(message,receiptContext),renderParentError(new ParentClientError('PARENT_RECONCILIATION_REQUIRED'),receiptContext)]){
      assert.match(text,/No executable command is shown/);assert.match(text,/not replacement paths/);
      assert.doesNotMatch(text,unsafe);assert.doesNotMatch(text,/--receipt|--operation (inspect|status|continue)/);
      assert.doesNotMatch(text,/no saved receipt path/);
    }
    const prefixContext={receiptPath:f.receipt,command:['node','install'+character+'client.mjs'],journal:inspection.journal};
    for(const text of [renderParentText(message,prefixContext),renderParentError(new ParentClientError('PARENT_RECONCILIATION_REQUIRED'),prefixContext),renderParentHelp(prefixContext)]){
      assert.match(text,/No executable command is shown/);assert.doesNotMatch(text,unsafe);
      assert.doesNotMatch(text,/--receipt|--operation (inspect|status|continue)/);
    }
  }
  const body={...message,result:{...message.result!,answer:'Keep\nordinary\tformat; C1:\u009b31m; LS:\u2028; PS:\u2029'}};
  const safe=renderParentText(body);assert.match(safe,/Keep\nordinary\tformat/);
  assert.match(safe,/C1:\\u009b31m; LS:\\u2028; PS:\\u2029/);assert.doesNotMatch(safe,unsafe);
  assert.equal(body.result.answer,'Keep\nordinary\tformat; C1:\u009b31m; LS:\u2028; PS:\u2029');
  const normal=renderParentText(message,context(f.receipt,inspection.journal));
  assert.match(normal,/--operation inspect --format text/);assert.ok(normal.includes("'\\''original'\\''"));
  const literal=renderParentError(new ParentClientError('PARENT_RECEIPT_NOT_FOUND'),{receiptPath:'/tmp/literal-\\u000a.json'});
  assert.match(literal,/--receipt '\/tmp\/literal-\\u000a.json'/);assert.doesNotMatch(literal,/No executable command is shown/);
  assert.equal(binding.connections(),1);
});
test('actual CLI preserves control-bearing receipt bytes and JSON while text/error suppress every executable hint',async t=>{
  const f=fixture(t),binding=connection();await runParentOperation({receiptPath:f.receipt,operation:'start',request,stateDirectory:f.state,connect:binding.connect});
  const bytes=readFileSync(f.receipt),path=join(f.directory,'receipt\n\u001b[31m\u0085\u2028.json');writeFileSync(path,bytes);
  const shadow=join(f.directory,'receipt\\u000a\\u001b[31m\\u0085\\u2028.json');writeFileSync(shadow,'different existing path; do not target it');
  const mtime=statSync(path).mtimeMs,jsonBefore=cli(['--receipt',path,'--operation','inspect']);assert.equal(jsonBefore.status,0,jsonBefore.stderr);
  const text=cli(['--receipt',path,'--operation','inspect','--format','text']);assert.equal(text.status,0,text.stderr);
  assert.match(text.stdout,/No executable command is shown/);assert.match(text.stdout,/Receipt: .*\\u000a\\u001b\[31m\\u0085\\u2028.json/);
  assert.doesNotMatch(text.stdout,/[\u001b\u007f-\u009f\u2028\u2029]/);assert.doesNotMatch(text.stdout,/--receipt|--operation (inspect|status|continue)/);
  const error=cli(['--receipt',path+'.absent','--operation','inspect','--format','text']);assert.equal(error.status,1);
  assert.match(error.stderr,/No executable command is shown/);assert.doesNotMatch(error.stderr,/[\u001b\u007f-\u009f\u2028\u2029]/);
  assert.doesNotMatch(error.stderr,/--receipt|--operation (inspect|status|continue)/);
  const jsonAfter=cli(['--receipt',path,'--operation','inspect']);assert.equal(jsonAfter.status,0,jsonAfter.stderr);
  assert.equal(jsonAfter.stdout,jsonBefore.stdout);assert.deepEqual(readFileSync(path),bytes);assert.equal(statSync(path).mtimeMs,mtime);
  assert.equal(readFileSync(shadow,'utf8'),'different existing path; do not target it');assert.equal(existsSync(f.state),false);
});
test('actual help from a control-bearing install path refuses the full program without losing normal help',t=>{
  const f=fixture(t),prefix=join(f.directory,'install\n\u001b[31m\u0085\u2028');
  for(const relative of ['examples/work-parent.mts','examples/work-parent-view.mts','adaptive/src/controller.mts','adaptive/contract/c0.mts','adaptive/contract/checkpoint-v1.mts']){
    const destination=join(prefix,relative);mkdirSync(resolve(destination,'..'),{recursive:true});copyFileSync(join(root,relative),destination);
  }
  const actual=spawnSync(process.execPath,['--experimental-strip-types',join(prefix,'examples/work-parent.mts'),'--help'],
    {env:{PATH:process.env.PATH??''},encoding:'utf8',timeout:15000});
  assert.equal(actual.status,0,actual.stderr);assert.match(actual.stdout,/No executable command is shown/);
  assert.doesNotMatch(actual.stdout,/[\u001b\u007f-\u009f\u2028\u2029]/);assert.doesNotMatch(actual.stdout,/--receipt|--operation (inspect|status|continue)/);
  const normal=cli(['--help']);assert.equal(normal.status,0,normal.stderr);assert.match(normal.stdout,/--operation inspect --format text/);
  assert.doesNotMatch(normal.stdout,/No executable command is shown/);assert.equal(existsSync(f.state),false);
});
