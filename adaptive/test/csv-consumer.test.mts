import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,symlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const source=resolve(process.env.CSV_CONSUMER_SOURCE_ROOT??join(repository,'consumers/csv-audit'));
const sdk=resolve(process.env.CSV_SDK_PACKAGE_ROOT??repository);
const hash=(raw:string|Buffer)=>createHash('sha256').update(raw).digest('hex');
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'csv-consumer-')),app=join(root,'app');mkdirSync(app);mkdirSync(join(root,'node_modules'));
  // The application resolves public package exports, never private/source-relative SDK paths.
  symlinkSync(sdk,join(root,'node_modules/jev-decision-fabric'),'dir');
  for(const name of ['index.mjs','package.json'])copyFileSync(join(source,name),join(app,name));
  const file=join(root,'own-ledger.csv'),state=join(root,'state');
  writeFileSync(file,'item,net\nServices,10.25\nReturn,-2.5\nServices,0.005\n');
  const invoke=(args:string[],clockOffset=0)=>{
    const preloads:string[]=[];
    if(clockOffset){const clock=join(root,'test-clock.mjs');writeFileSync(clock,`const original=Date.now;Date.now=()=>original()+${clockOffset};`);preloads.push('--import',clock);}
    const p=spawnSync(process.execPath,[...preloads,join(app,'index.mjs'),...args],{cwd:root,encoding:'utf8',timeout:15000});
    assert.equal(p.error,undefined);return {exit:p.status,json:JSON.parse(p.stdout),human:p.stderr};};
  const start=(extra:string[]=[])=>invoke(['--request','Audit this CSV and total the net column','--file',file,'--column','net','--unit','credits','--state',state,...extra]);
  return {root,file,state,invoke,start,close:()=>rmSync(root,{recursive:true,force:true})};
}
test('own CSV: actual read, graceful pause, separate process resume, same original SDK run and provenance',()=>{
  const f=fixture();try{
    const p=f.start(['--pause-after-read']);assert.equal(p.exit,0);assert.equal(p.json.state,'PAUSED');assert.equal(p.json.usage.parent_operations_started,3);
    const cp=JSON.parse(readFileSync(join(f.state,'snapshot.json'),'utf8'));
    const r=f.invoke(['--operation','resume','--state',f.state]);assert.equal(r.exit,0);assert.equal(r.json.state,'COMPLETE');
    assert.equal(r.json.run_id,p.json.run_id);assert.equal(r.json.deadline_ms,p.json.deadline_ms);assert.deepEqual(r.json.budget,p.json.budget);
    assert.equal(r.json.source.sha256,hash(readFileSync(f.file)));assert.equal(r.json.source.sha256,p.json.source.sha256);
    assert.match(r.json.result.answer,/total 7\.755 credits/);assert.match(r.json.result.answer,/Duplicate item labels: Services \(2\)/);
    assert.ok(r.human.includes(r.json.result.answer));assert.equal(r.json.usage.parent_operations_started,7);
    assert.equal(r.json.result.usage.by_kind.worker,1);assert.equal(r.json.result.usage.by_kind.tool,1);assert.equal(r.json.result.usage.by_kind.caller,1);
    const read=r.json.accepted_observations.find((o:any)=>o.task_id==='read-csv');assert.equal(read.attempt_id,p.json.accepted_observations[0].attempt_id);
    assert.equal(read.input_digest,p.json.accepted_observations[0].input_digest);assert.equal(read.value.text,readFileSync(f.file,'utf8'));
    const after=JSON.parse(readFileSync(join(f.state,'snapshot.json'),'utf8'));assert.deepEqual(after.admission,cp.admission);
    assert.deepEqual(after.checkpoint.state.request,cp.checkpoint.state.request);assert.equal(after.checkpoint.state.restore_history.length,1);
    assert.equal(r.json.qualification.real_Jev_calls,0);assert.equal(r.json.qualification.real_native_calls,0);assert.equal(r.json.qualification.tokens,null);
    const before=readFileSync(join(f.state,'snapshot.json'));writeFileSync(f.file,'different after completion');
    const status=f.invoke(['--operation','status','--state',f.state]);assert.equal(status.exit,0);assert.equal(status.json.delivery,'saved_original_result');assert.equal(status.json.result.answer,r.json.result.answer);
    assert.deepEqual(readFileSync(join(f.state,'snapshot.json')),before);
  }finally{f.close();}
});
test('known invalid CSV is archived as invalid; no partial total, final or automatic retry',()=>{
  const f=fixture();try{
    writeFileSync(f.file,'item,net\nValid,5\nBroken,no-number\n');const r=f.start();assert.equal(r.exit,2);assert.equal(r.json.state,'STOPPED');
    assert.equal(r.json.result.status,'failed');assert.equal(r.json.result.answer,null);assert.equal(r.json.final_receipt,null);
    const s=JSON.parse(readFileSync(join(f.state,'snapshot.json'),'utf8')),bad=s.checkpoint.state.observations.find((x:any)=>x.observation.status==='invalid');
    assert.ok(bad);assert.equal(bad.adoption,'accepted');assert.equal(bad.observation.value.partial_total,null);assert.match(bad.observation.value.error,/csv_invalid_number/);
    const snapshot=readFileSync(join(f.state,'snapshot.json'));const retry=f.invoke(['--operation','resume','--state',f.state]);
    assert.equal(retry.json.delivery,'saved_original_result');assert.deepEqual(readFileSync(join(f.state,'snapshot.json')),snapshot);
  }finally{f.close();}
});
test('source change refuses resume; exact original bytes repair the same operation/run before D',()=>{
  const f=fixture();try{
    const original=readFileSync(f.file),p=f.start(['--pause-after-read']),before=readFileSync(join(f.state,'snapshot.json'));
    writeFileSync(f.file,'item,net\nChanged,999\n');const refused=f.invoke(['--operation','resume','--state',f.state]);
    assert.equal(refused.exit,1);assert.equal(refused.json.state,'OPERATION_REFUSED');assert.match(refused.json.error,/source_changed/);
    assert.deepEqual(readFileSync(join(f.state,'snapshot.json')),before);assert.ok(!existsSync(join(f.state,'writer.lock')));
    writeFileSync(f.file,original);const repaired=f.invoke(['--operation','resume','--state',f.state]);assert.equal(repaired.json.state,'COMPLETE');
    assert.equal(repaired.json.run_id,p.json.run_id);assert.equal(repaired.json.deadline_ms,p.json.deadline_ms);assert.equal(repaired.json.result.usage.by_kind.worker,1);
  }finally{f.close();}
});
test('corrupt saved snapshot refuses reads/reentry; exact private backup restores the original run',()=>{
  const f=fixture();try{
    const p=f.start(['--pause-after-read']),path=join(f.state,'snapshot.json'),original=readFileSync(path);
    const corrupted=JSON.parse(original.toString());corrupted.admission.deadline_ms++;writeFileSync(path,JSON.stringify(corrupted));
    const refused=f.invoke(['--operation','resume','--state',f.state]);assert.equal(refused.exit,1);assert.match(refused.json.error,/saved_snapshot_corrupt/);
    assert.equal(JSON.parse(readFileSync(path,'utf8')).admission.deadline_ms,corrupted.admission.deadline_ms);
    writeFileSync(path,original);const repaired=f.invoke(['--operation','resume','--state',f.state]);assert.equal(repaired.json.state,'COMPLETE');assert.equal(repaired.json.run_id,p.json.run_id);
  }finally{f.close();}
});
test('an existing writer lock is preserved; no forced lock break, archive mutation or new admission',()=>{
  const f=fixture();try{
    f.start(['--pause-after-read']);const before=readFileSync(join(f.state,'snapshot.json')),lock=join(f.state,'writer.lock');writeFileSync(lock,'another-owner');
    const r=f.invoke(['--operation','resume','--state',f.state]);assert.equal(r.exit,1);assert.match(r.json.error,/writer_locked_no_automatic_break/);
    assert.equal(readFileSync(lock,'utf8'),'another-owner');assert.deepEqual(readFileSync(join(f.state,'snapshot.json')),before);
  }finally{f.close();}
});
test('repeat start returns history and changed request is refused without refreshing original admission',()=>{
  const f=fixture();try{
    const p=f.start(['--pause-after-read']),snapshot=readFileSync(join(f.state,'snapshot.json')),again=f.start();
    assert.equal(again.json.delivery,'saved_original_result');assert.equal(again.json.run_id,p.json.run_id);assert.deepEqual(readFileSync(join(f.state,'snapshot.json')),snapshot);
    const r=f.invoke(['--request','Total another audit','--file',f.file,'--column','net','--unit','credits','--state',f.state]);
    assert.equal(r.exit,1);assert.match(r.json.error,/existing_state_request_conflict/);assert.deepEqual(readFileSync(join(f.state,'snapshot.json')),snapshot);
  }finally{f.close();}
});
test('expired readback labels current expiry for status and repeat start; original history remains immutable',()=>{
  const f=fixture();try{
    const p=f.start(['--pause-after-read']),before=readFileSync(join(f.state,'snapshot.json'));
    const status=f.invoke(['--operation','status','--state',f.state],180001);
    assert.equal(status.json.state,'PAUSED');assert.equal(status.json.current_state,'EXPIRED_UNFINISHED');assert.equal(status.json.resumable,false);
    assert.match(status.human,/EXPIRED_UNFINISHED/);assert.match(status.json.next_operation,/Original deadline expired/);
    const repeat=f.invoke(['--request','Audit this CSV and total the net column','--file',f.file,'--column','net','--unit','credits','--state',f.state],180001);
    assert.equal(repeat.json.current_state,'EXPIRED_UNFINISHED');assert.equal(repeat.json.run_id,p.json.run_id);
    const resume=f.invoke(['--operation','resume','--state',f.state],180001);assert.equal(resume.exit,1);assert.match(resume.json.error,/original_deadline_expired_no_refresh/);
    assert.deepEqual(readFileSync(join(f.state,'snapshot.json')),before);
  }finally{f.close();}
});
test('quotation delimiters in caller file path, labels and unit safely display without changing original evidence',()=>{
  const f=fixture();try{
    const quoted=join(f.root,'own`ledger.csv');writeFileSync(quoted,'item,net\nService`,10.25\nService`,0.005\n');
    const r=f.invoke(['--request','Audit CSV and total the net column','--file',quoted,'--column','net','--unit','credits`','--state',f.state]);
    assert.equal(r.exit,0);assert.equal(r.json.state,'COMPLETE');assert.match(r.json.result.answer,/credits\\u0060/);assert.match(r.json.result.answer,/Service\\u0060/);
    assert.equal(r.json.source.unit,'credits`');assert.equal(r.json.source.file,quoted);
    const audit=r.json.accepted_observations.find((o:any)=>o.task_id==='audit-csv');assert.equal(audit.value.duplicate_items[0].item,'Service`');
  }finally{f.close();}
});
test('corrupted original final frame/origin is refused; exact archive backup restores original result without effects',()=>{
  const f=fixture();try{
    const p=f.start(),path=join(f.state,'final-origin.json'),original=readFileSync(path),snapshot=readFileSync(join(f.state,'snapshot.json'));
    const bad=JSON.parse(original.toString());bad.frame.run_id='wrong-run';writeFileSync(path,JSON.stringify(bad));
    const refused=f.invoke(['--operation','status','--state',f.state]);assert.equal(refused.exit,1);assert.match(refused.json.error,/saved_final_archive_corrupt/);
    assert.deepEqual(readFileSync(join(f.state,'snapshot.json')),snapshot);writeFileSync(path,original);
    const repaired=f.invoke(['--operation','status','--state',f.state]);assert.equal(repaired.exit,0);assert.equal(repaired.json.result.answer,p.json.result.answer);assert.equal(repaired.json.delivery,'saved_original_result');
    const another=JSON.parse(original.toString());another.origin.kind='changed-origin';writeFileSync(path,JSON.stringify(another));
    assert.equal(f.invoke(['--operation','status','--state',f.state]).exit,1);writeFileSync(path,original);
  }finally{f.close();}
});
