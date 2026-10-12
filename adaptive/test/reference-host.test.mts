import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openReferenceHost} from '../../examples/work-host.mts';
const caller=()=>({principal:'local-reference-owner',signal:new AbortController().signal});
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const alter=(path:string,change:(body:any)=>void)=>{const body=read(path);change(body);writeFileSync(path,JSON.stringify(body));};
async function fixture(check:(directory:string,host:ReturnType<typeof openReferenceHost>,run:string)=>Promise<void>){
  const directory=mkdtempSync(join(tmpdir(),'jev-ref-regression-')),host=openReferenceHost(directory,{pauseAfterRead:true});
  try{const result=await host.service.start({request:'Calculate total and mean',request_id:'same-request'},caller());
    assert.equal(result.status,'needs_host');await check(directory,host,result.run_id);
  }finally{host.close();rmSync(directory,{recursive:true,force:true});}
}
test('actual local pause/resume/status retains original admission, budget and read effect',async()=>{
  await fixture(async(directory,first,run)=>{
    const original=read(join(directory,run,'snapshot.json')),ioPath=join(directory,run,'io-read-numbers.json'),io=readFileSync(ioPath,'utf8');
    first.close();const second=openReferenceHost(directory);try{
      const done=await second.service.continue({run_id:run},caller());assert.equal(done.status,'complete');assert.match(done.answer!,/Total: 720; mean: 240/);
      assert.deepEqual(await second.service.status({run_id:run},caller()),done);
      assert.deepEqual(await second.service.start({request:'Calculate total and mean',request_id:'same-request'},caller()),done);
      assert.deepEqual(await second.service.continue({run_id:run},caller()),done);
      const resumed=read(join(directory,run,'snapshot.json'));
      assert.deepEqual(resumed.admission,original.admission);assert.deepEqual(resumed.checkpoint.state.request.budget,original.checkpoint.state.request.budget);
      assert.equal(readFileSync(ioPath,'utf8'),io);assert.equal(done.usage.decisions_started,0);
      await assert.rejects(second.service.start({request:'Different calculation',request_id:'same-request'},caller()),/request_conflict/);
    }finally{second.close();}
  });
});
test('direct reference service rejects another principal and cancelled caller',async()=>{
  await fixture(async(directory,host,run)=>{
    const before=readFileSync(join(directory,run,'snapshot.json'),'utf8'),intruder={...caller(),principal:'intruder'};
    await assert.rejects(host.service.start({request:'Calculate',request_id:'intruder-request'},intruder));
    for(const method of ['status','continue','cancel'] as const)
      await assert.rejects(host.service[method]({run_id:run,reason:'intruder'} as any,intruder));
    const abort=new AbortController();abort.abort();await assert.rejects(host.service.continue({run_id:run},{principal:'local-reference-owner',signal:abort.signal}));
    assert.equal(readFileSync(join(directory,run,'snapshot.json'),'utf8'),before);assert.equal(existsSync(join(directory,'request-intruder-request.json')),false);
  });
});
test('changed admission metadata under the same deadline refuses continuation before more I/O',async()=>{
  await fixture(async(directory,host,run)=>{
    const before=readFileSync(join(directory,run,'snapshot.json'),'utf8');
    alter(join(directory,run,'admission.json'),body=>{body.kind='comparison';});
    await assert.rejects(host.service.continue({run_id:run},caller()));assert.equal(readFileSync(join(directory,run,'snapshot.json'),'utf8'),before);
    assert.equal(existsSync(join(directory,run,'io-statistics.json')),false);
  });
});
test('modified stored checkpoint with unchanged digest strings is unconfirmed',async()=>{
  await fixture(async(directory,host,run)=>{
    alter(join(directory,run,'snapshot.json'),body=>{body.checkpoint.state.reason=['changed'];});
    await assert.rejects(host.service.status({run_id:run},caller()));
  });
});
test('modified result with unchanged snapshot binding is unconfirmed',async()=>{
  await fixture(async(directory,host,run)=>{
    alter(join(directory,run,'result.json'),body=>{body.result.answer='Unverified answer';body.result.status='complete';});
    await assert.rejects(host.service.status({run_id:run},caller()));
  });
});
test('replaced writer lease rejects effects/readback and close preserves replacement',async()=>{
  await fixture(async(directory,host,run)=>{
    const lock=join(directory,'writer.lock');unlinkSync(lock);writeFileSync(lock,'replacement-writer');
    await assert.rejects(host.service.continue({run_id:run},caller()));await assert.rejects(host.service.status({run_id:run},caller()));
    host.close();assert.equal(readFileSync(lock,'utf8'),'replacement-writer');assert.equal(existsSync(join(directory,run,'io-statistics.json')),false);
  });
});
test('status projects original deadline exhaustion while keeping saved evidence and pending work',async()=>{
  await fixture(async(directory,host,run)=>{
    const snapshotPath=join(directory,run,'snapshot.json'),before=readFileSync(snapshotPath,'utf8'),snapshot=JSON.parse(before),oldNow=Date.now;
    try{Date.now=()=>snapshot.admission.deadline_ms+1;
      const status=await host.service.status({run_id:run},caller());assert.equal(status.status,'hold');assert.ok(status.unresolved.includes('deadline_exhausted'));
      assert.deepEqual(status.pending,read(join(directory,run,'result.json')).result.pending);assert.equal(readFileSync(snapshotPath,'utf8'),before);
      assert.deepEqual(await host.service.continue({run_id:run},caller()),status);assert.equal(existsSync(join(directory,run,'io-statistics.json')),false);
      assert.deepEqual(await host.service.status({run_id:run},caller()),status);
      assert.deepEqual(await host.service.start({request:'Calculate total and mean',request_id:'same-request'},caller()),status);
      assert.deepEqual(await host.service.cancel({run_id:run,reason:'Already expired'},caller()),status);assert.equal(readFileSync(snapshotPath,'utf8'),before);
    }finally{Date.now=oldNow;}
  });
});
test('document comparison uses actual registered reads and derived exact sentence differences',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'jev-ref-docs-')),host=openReferenceHost(directory);
  try{const result=await host.service.start({request:'Compare the two policy documents',request_id:'compare'},caller());
    assert.equal(result.status,'complete');assert.match(result.answer!,/Unchanged: Returns are accepted within thirty days\./);
    assert.match(result.answer!,/Only A: Shipping takes five days\./);assert.match(result.answer!,/Only B: Shipping takes three days\./);
    const work=read(join(directory,result.run_id,'io-compare-policies.json'));assert.deepEqual(work.value.unchanged,['Returns are accepted within thirty days.']);
    assert.equal(result.usage.by_kind.worker,2);assert.equal(result.usage.by_kind.tool,1);assert.equal(result.usage.decisions_started,0);
  }finally{host.close();rmSync(directory,{recursive:true,force:true});}
});
for(const concurrentAction of ['continue','cancel'] as const)test('one reference writer rejects concurrent continue/'+concurrentAction+' before a second restoration',async()=>{
  await fixture(async(directory,host,run)=>{
    const original=read(join(directory,run,'snapshot.json'));
    const results=await Promise.allSettled([host.service.continue({run_id:run},caller()),host.service[concurrentAction]({run_id:run,reason:'Concurrent request'} as any,caller())]);
    assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');
    if(results[1].status==='rejected')assert.match(String(results[1].reason),/reference_writer_busy/);
    const done=await host.service.status({run_id:run},caller()),saved=read(join(directory,run,'snapshot.json'));
    assert.equal(done.status,'complete');assert.equal(done.usage.operations_started,3);assert.deepEqual(saved.admission,original.admission);
    assert.equal(saved.checkpoint.state.events.filter((event:any)=>event.kind==='task_requested'&&event.task_id==='statistics').length,1);
    assert.deepEqual(await host.service.start({request:'Calculate total and mean',request_id:'same-request'},caller()),done);
  });
});
