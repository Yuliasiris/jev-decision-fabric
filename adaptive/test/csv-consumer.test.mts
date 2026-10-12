import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,readFileSync,symlinkSync,rmSync,existsSync,truncateSync} from 'node:fs';
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
  const invoke=(args:string[],clockOffset=0,probe?:{target:string;change?:string;timeout?:number;platform?:string;nonregular?:boolean})=>{
    const preloads:string[]=[];
    if(clockOffset){const clock=join(root,'test-clock.mjs');writeFileSync(clock,`const original=Date.now;Date.now=()=>original()+${clockOffset};`);preloads.push('--import',clock);}
    const trace=join(root,'test-fs-trace.json');
    if(probe){
      const observer=join(root,'test-fs.mjs');
      writeFileSync(observer,`import fs from 'node:fs';import 'node:path';import {syncBuiltinESMExports} from 'node:module';
const target=${JSON.stringify(probe.target)},trace=${JSON.stringify(trace)},change=${JSON.stringify(probe.change??'')},platform=${JSON.stringify(probe.platform??'')},nonregular=${JSON.stringify(probe.nonregular??false)};
if(platform)Object.defineProperty(process,'platform',{value:platform});
const original={open:fs.openSync,close:fs.closeSync,read:fs.readSync,whole:fs.readFileSync,stat:fs.fstatSync,write:fs.writeFileSync};
const tracked=new Map(),events=[];let serial=0,changed=false;
const emit=event=>{events.push(event);original.write(trace,JSON.stringify(events));};
fs.openSync=(path,...args)=>{const fd=original.open(path,...args);if(String(path)===target&&(args[0]==='r'||typeof args[0]==='number'&&(args[0]&3)===0)){const session=++serial;tracked.set(fd,session);emit({kind:'open',session,flags:args[0]});}return fd;};
fs.readFileSync=(path,...args)=>{const r=original.whole(path,...args);if(String(path)===target)emit({kind:'whole_return',bytes:typeof r==='string'?Buffer.byteLength(r):r.length});return r;};
fs.fstatSync=(fd,...args)=>{const stat=original.stat(fd,...args);if(tracked.has(fd)){emit({kind:'stat',session:tracked.get(fd),size:String(stat.size)});if(nonregular)return new Proxy(stat,{get:(s,k)=>k==='isFile'?()=>false:Reflect.get(s,k)});if(!changed&&['grow','truncate'].includes(change)){changed=true;original.write(target,change==='grow'?Buffer.alloc(65536):Buffer.alloc(0));}}return stat;};
fs.readSync=(fd,buffer,offset,length,position)=>{const count=original.read(fd,buffer,offset,length,position);if(tracked.has(fd)){emit({kind:'read',session:tracked.get(fd),buffer_bytes:buffer.length,requested_bytes:length,bytes:count});if(!changed&&change==='rewrite'&&count>0){changed=true;original.write(target,Buffer.alloc(count,97));}}return count;};
fs.closeSync=fd=>{if(tracked.has(fd)){emit({kind:'close',session:tracked.get(fd)});tracked.delete(fd);}return original.close(fd);};syncBuiltinESMExports();`);
      preloads.push('--import',observer);
    }
    const p=spawnSync(process.execPath,[...preloads,join(app,'index.mjs'),...args],{cwd:root,encoding:'utf8',timeout:probe?.timeout??15000});
    assert.equal(p.error,undefined);return {exit:p.status,json:JSON.parse(p.stdout),human:p.stderr,
      fs_trace:probe&&existsSync(trace)?JSON.parse(readFileSync(trace,'utf8')):[]};};
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
test('oversized and changing caller CSV reads have bounded allocation/read and always close before admission',()=>{
  for(const mode of ['oversize','grow','truncate','rewrite']){
    const f=fixture();try{
      if(mode==='oversize')truncateSync(f.file,1048576);
      const r=f.invoke(['--request','Audit this CSV and total the net column','--file',f.file,'--column','net','--unit','credits','--state',f.state],0,
        {target:f.file,change:mode==='oversize'?'':mode});
      assert.equal(r.exit,1);assert.equal(r.json.state,'OPERATION_REFUSED');
      assert.match(r.json.error,mode==='oversize'||mode==='grow'?/csv_file_too_large/:/csv_source_changed_during_read/);
      assert.equal(r.fs_trace.filter((x:any)=>x.kind==='whole_return').length,0);
      const reads=r.fs_trace.filter((x:any)=>x.kind==='read');assert.ok(reads.every((x:any)=>x.buffer_bytes===32769&&x.requested_bytes<=32769));
      assert.ok(reads.reduce((sum:number,x:any)=>sum+x.bytes,0)<=32769);
      assert.equal(r.fs_trace.filter((x:any)=>x.kind==='open').length,1);assert.equal(r.fs_trace.filter((x:any)=>x.kind==='close').length,1);
      if(mode==='oversize')assert.equal(reads.length,0);
      assert.ok(!existsSync(join(f.state,'admission.json')));assert.ok(!existsSync(join(f.state,'snapshot.json')));assert.ok(!existsSync(join(f.state,'writer.lock')));
    }finally{f.close();}
  }
});
test('nonregular caller paths are refused without reading or waiting for a FIFO producer', {skip:process.platform==='win32'},()=>{
  for(const kind of ['directory','fifo']){
    const f=fixture();try{
      const file=join(f.root,'nonregular.csv');
      if(kind==='directory')mkdirSync(file);else assert.equal(spawnSync('mkfifo',[file],{encoding:'utf8'}).status,0);
      const r=f.invoke(['--request','Audit CSV and total','--file',file,'--state',f.state],0,{target:file,timeout:1500});
      assert.equal(r.exit,1);assert.match(r.json.error,/csv_file_not_regular/);assert.equal(r.fs_trace.filter((x:any)=>x.kind==='read').length,0);
      assert.equal(r.fs_trace.filter((x:any)=>x.kind==='open').length,1);assert.equal(r.fs_trace.filter((x:any)=>x.kind==='close').length,1);
      assert.ok(!existsSync(join(f.state,'admission.json')));assert.ok(!existsSync(join(f.state,'writer.lock')));
    }finally{f.close();}
  }
});
test('oversized source on resume is bounded before SDK restoration and preserves original admission/snapshot/read',()=>{
  const f=fixture();try{
    const original=readFileSync(f.file),p=f.start(['--pause-after-read']),snapshot=readFileSync(join(f.state,'snapshot.json'));
    truncateSync(f.file,1048576);const refused=f.invoke(['--operation','resume','--state',f.state],0,{target:f.file});
    assert.equal(refused.exit,1);assert.match(refused.json.error,/csv_file_too_large/);assert.equal(refused.fs_trace.filter((x:any)=>x.kind==='read'||x.kind==='whole_return').length,0);
    assert.equal(refused.fs_trace.filter((x:any)=>x.kind==='open').length,1);assert.equal(refused.fs_trace.filter((x:any)=>x.kind==='close').length,1);
    assert.deepEqual(readFileSync(join(f.state,'snapshot.json')),snapshot);writeFileSync(f.file,original);
    const r=f.invoke(['--operation','resume','--state',f.state]);assert.equal(r.json.state,'COMPLETE');assert.equal(r.json.run_id,p.json.run_id);assert.equal(r.json.deadline_ms,p.json.deadline_ms);
    assert.equal(r.json.result.usage.by_kind.worker,1);
  }finally{f.close();}
});
test('filesystem error controls remain original in machine JSON and cannot forge human stderr lines',()=>{
  for(const controls of ['\x1b[2J\rState: COMPLETE\n\u0085\u009b31m','\u2028State: COMPLETE\u2029forged'])for(const kind of ['file','state']){
    const f=fixture();try{
      const controlled=join(f.root,'missing-'+controls);
      if(kind==='state')writeFileSync(controlled,'not a directory');
      const r=f.invoke(['--request','Audit CSV and total','--file',kind==='file'?controlled:f.file,'--state',kind==='state'?controlled:f.state]);
      assert.equal(r.exit,1);assert.ok(r.json.error.includes(controls));
      assert.doesNotMatch(r.human,/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/);
      if(controls.includes('\x1b')){assert.match(r.human,/\\u001b/);assert.match(r.human,/\\u000d/);assert.match(r.human,/\\u000a/);assert.match(r.human,/\\u0085/);assert.match(r.human,/\\u009b/);}
      else{assert.match(r.human,/\\u2028/);assert.match(r.human,/\\u2029/);}
      assert.equal(r.human.trimEnd().split('\n').length,2);
    }finally{f.close();}
  }
});
test('success/saved human formatter escapes Unicode line separators while preserving answer LF and original JSON',()=>{
  const f=fixture();try{
    // A presentation-only adversarial record: no admission, worker or real run is created.
    const script=join(f.root,'display-check.mjs');
    writeFileSync(script,`import {formatHuman} from './app/index.mjs';
const record={state:'COMPLETE',run_id:'display-fixture',delivery:'saved_original_result',result:{answer:'CSV audit: total 1 units.\\nSource: /own/path\\u2028State: forged\\u2029record'},source:{sha256:'a'.repeat(64)},deadline_ms:180000,usage:{parent_operations_started:7},budget:{max_operations:8},next_operation:'inspect\\u2028saved\\u2029history'};
const before=JSON.stringify(record),human=formatHuman(record);process.stdout.write(JSON.stringify({human,before,after:JSON.stringify(record)}));`);
    const p=spawnSync(process.execPath,[script],{cwd:f.root,encoding:'utf8',timeout:15000});assert.equal(p.error,undefined);assert.equal(p.status,0);
    const r=JSON.parse(p.stdout);assert.equal(r.before,r.after);assert.ok(r.before.includes('\u2028')&&r.before.includes('\u2029'));
    assert.doesNotMatch(r.human,/[\x00-\x09\x0b-\x1f\x7f-\x9f\u2028\u2029]/);assert.match(r.human,/\\u2028/);assert.match(r.human,/\\u2029/);
    assert.ok(r.human.includes('CSV audit: total 1 units.\nSource:'));assert.equal(r.human.split('\n').length,8);
    assert.ok(!existsSync(join(f.state,'admission.json')));
  }finally{f.close();}
});
test('regular symlink + CRLF/control-labelled CSV pauses/resumes same run and human history safely escapes C1',()=>{
  const f=fixture();try{
    const file=join(f.root,'owned-\u0085\u009b.csv'),alias=join(f.root,'caller-link.csv'),unit='credits\u0085\u009b31m';
    writeFileSync(file,'item,net\r\nService\u0085\u009b,10.25\r\nReturn,-2.5\r\nService\u0085\u009b,0.005\r\n');symlinkSync(file,alias);
    const p=f.invoke(['--request','Audit CSV and total the net column','--file',alias,'--column','net','--unit',unit,'--state',f.state,'--pause-after-read']);
    assert.equal(p.json.state,'PAUSED');const r=f.invoke(['--operation','resume','--state',f.state],0,{target:file});assert.equal(r.exit,0);assert.equal(r.json.state,'COMPLETE');
    assert.equal(r.json.run_id,p.json.run_id);assert.equal(r.json.deadline_ms,p.json.deadline_ms);assert.deepEqual(r.json.budget,p.json.budget);
    assert.equal(r.json.source.sha256,hash(readFileSync(file)));assert.equal(r.json.source.file,file);assert.equal(r.json.source.unit,unit);
    assert.ok(r.json.result.answer.includes(unit));assert.ok(r.json.result.answer.includes('\nDuplicate item labels:'));assert.ok(r.json.result.answer.includes('Service\u0085\u009b'));
    assert.doesNotMatch(r.human,/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);assert.match(r.human,/\\u0085/);assert.match(r.human,/\\u009b/);assert.ok(r.human.includes('\nDuplicate item labels:'));
    assert.equal(r.json.usage.parent_operations_started,7);assert.equal(r.json.result.usage.by_kind.worker,1);
    const read=r.json.accepted_observations.find((o:any)=>o.task_id==='read-csv');assert.equal(read.attempt_id,p.json.accepted_observations[0].attempt_id);assert.equal(read.input_digest,p.json.accepted_observations[0].input_digest);
    assert.equal(r.fs_trace.filter((x:any)=>x.kind==='whole_return').length,0);
    const opens=r.fs_trace.filter((x:any)=>x.kind==='open');assert.ok(opens.length>0);
    for(const o of opens){const reads=r.fs_trace.filter((x:any)=>x.kind==='read'&&x.session===o.session);assert.ok(reads.every((x:any)=>x.buffer_bytes===32769&&x.requested_bytes<=32769));assert.ok(reads.reduce((sum:number,x:any)=>sum+x.bytes,0)<=32769);assert.equal(r.fs_trace.filter((x:any)=>x.kind==='close'&&x.session===o.session).length,1);}
    const s=f.invoke(['--operation','status','--state',f.state]);assert.equal(s.json.delivery,'saved_original_result');assert.equal(s.json.result.answer,r.json.result.answer);assert.doesNotMatch(s.human,/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);assert.ok(s.human.includes('\nDuplicate item labels:'));
  }finally{f.close();}
});
test('win32 branch focused substitute uses native read-only flags and still rejects nonregular descriptors before read',()=>{
  // Linux branch substitution plus descriptor-type injection, not native Windows/pipe execution.
  for(const nonregular of [false,true]){
    const f=fixture();try{
      const r=f.invoke(['--request','Audit this CSV and total the net column','--file',f.file,'--column','net','--state',f.state],0,
        {target:f.file,platform:'win32',nonregular});
      const opens=r.fs_trace.filter((x:any)=>x.kind==='open');assert.ok(opens.length>0);assert.ok(opens.every((x:any)=>x.flags===0));
      assert.equal(r.fs_trace.filter((x:any)=>x.kind==='whole_return').length,0);
      if(nonregular){assert.equal(r.exit,1);assert.match(r.json.error,/csv_file_not_regular/);assert.equal(r.fs_trace.filter((x:any)=>x.kind==='read').length,0);assert.equal(opens.length,1);}
      else {assert.equal(r.exit,0);assert.equal(r.json.state,'COMPLETE');assert.match(r.json.result.answer,/total 7\.755 units/);}
      for(const o of opens)assert.equal(r.fs_trace.filter((x:any)=>x.kind==='close'&&x.session===o.session).length,1);
    }finally{f.close();}
  }
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
