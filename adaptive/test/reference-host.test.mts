import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,unlinkSync,rmSync,existsSync,renameSync,readdirSync,statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openReferenceHost,referenceObservationArchiveMatches} from '../../examples/work-host.mts';
import {createWork,restoreWork} from '../sdk/index.mts';
import type {WorkHost,WorkSnapshot,TaskRequest,Observation,Registration} from '../sdk/index.mts';
import {CONTRACT_VERSION} from '../contract/c0.mts';
import {digest} from '../src/controller.mts';
const caller=()=>({principal:'local-reference-owner',signal:new AbortController().signal});
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
const alter=(path:string,change:(body:any)=>void)=>{const body=read(path);change(body);writeFileSync(path,JSON.stringify(body));};
const hash=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
const key=(directory:string,kind:string,id:string)=>join(directory,kind+'-'+hash(id)+'.json');
const image=(path:string)=>({sha256:hash(readFileSync(path)),mtime_ms:statSync(path).mtimeMs});
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
    assert.equal(readFileSync(join(directory,run,'snapshot.json'),'utf8'),before);assert.equal(existsSync(key(directory,'request','intruder-request')),false);
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
test('new reference archives use stable SHA filenames while preserving colon-bearing identities',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'jev-ref-safe-key-')),host=openReferenceHost(directory,{pauseAfterRead:true}),requestId='ordinary:parent.1';
  try{
    const result=await host.service.start({request:'Calculate total and mean',request_id:requestId},caller()),d=join(directory,result.run_id);
    assert.equal(result.status,'needs_host');assert.equal(read(join(d,'admission.json')).request_id,requestId);
    const claims=readdirSync(directory).filter(name=>name.startsWith('request-'));
    assert.deepEqual(claims,['request-'+hash(requestId)+'.json']);
    const archives=readdirSync(d).filter(name=>name.startsWith('observation-'));
    assert.deepEqual(archives,['observation-'+hash('observation:read-numbers')+'.json']);
    for(const name of [...claims,...archives])assert.match(name,/^(request|observation)-[0-9a-f]{64}\.json$/);
    const record=read(join(d,archives[0]));assert.equal(record.observation.id,'observation:read-numbers');
    assert.equal(referenceObservationArchiveMatches(d,record.observation,record.frame),true);
    assert.equal(existsSync(join(directory,'request-'+requestId+'.json')),false);
    assert.equal(existsSync(join(d,'observation-'+record.observation.id+'.json')),false);
  }finally{host.close();rmSync(directory,{recursive:true,force:true});}
});
test('legacy saved layout reopens the original claim and continues without rewriting old evidence or repeating its read',async()=>{
  await fixture(async(directory,first,run)=>{
    const d=join(directory,run),claim=join(directory,'request-same-request.json'),archive=join(d,'observation-observation:read-numbers.json');
    renameSync(key(directory,'request','same-request'),claim);renameSync(key(d,'observation','observation:read-numbers'),archive);
    const original=read(join(d,'snapshot.json')),paths=[claim,archive,join(d,'io-read-numbers.json')],before=paths.map(image);
    const historical=[join(d,'snapshot.json'),join(d,'result.json'),join(d,'head.json')],historicalBefore=historical.map(image);
    first.close();const second=openReferenceHost(directory);
    try{
      const same=await second.service.start({request:'Calculate total and mean',request_id:'same-request'},caller());
      assert.equal(same.run_id,run);assert.equal(same.status,'needs_host');assert.deepEqual(historical.map(image),historicalBefore);
      assert.equal(existsSync(key(directory,'request','same-request')),false);
      const done=await second.service.continue({run_id:run},caller());assert.equal(done.status,'complete');
      assert.match(done.answer!,/Total: 720; mean: 240/);assert.deepEqual(paths.map(image),before);
      const resumed=read(join(d,'snapshot.json'));assert.deepEqual(resumed.admission,original.admission);
      assert.deepEqual(resumed.checkpoint.state.request.budget,original.checkpoint.state.request.budget);
      assert.equal(done.usage.by_kind.worker,1);assert.equal(done.usage.operations_started,3);
      assert.equal(readdirSync(directory).filter(name=>name.startsWith('reference-')).length,1);
      assert.equal(existsSync(key(directory,'request','same-request')),false);
      assert.equal(existsSync(key(d,'observation','observation:read-numbers')),false);
      assert.equal(existsSync(key(d,'observation','observation:statistics')),true);
    }finally{second.close();}
  });
});
test('archive matcher requires original ID, body, recorded digest and frame and fails closed on dual locator conflicts',async()=>{
  await fixture(async(directory,_host,run)=>{
    const d=join(directory,run),path=key(d,'observation','observation:read-numbers'),record=read(path),original=readFileSync(path);
    const legacy=join(d,'observation-'+record.observation.id+'.json');writeFileSync(legacy,original);
    const before=[path,legacy].map(image);assert.equal(referenceObservationArchiveMatches(d,record.observation,record.frame),true);
    assert.deepEqual([path,legacy].map(image),before);
    for(const change of [
      (r:any)=>{r.observation.id='observation:other';},
      (r:any)=>{r.observation.value={text:'changed'};},
      (r:any)=>{r.observation_sha256='0'.repeat(64);},
      (r:any)=>{r.frame.attempt_id='another-attempt';},
      (r:any)=>{r.unconfirmed_metadata=true;},
    ]){
      writeFileSync(legacy,original);alter(legacy,change);
      assert.equal(referenceObservationArchiveMatches(d,record.observation,record.frame),false);
    }
    writeFileSync(legacy,original);writeFileSync(path,'not JSON');
    assert.equal(referenceObservationArchiveMatches(d,record.observation,record.frame),false); // No downgrade to intact legacy.
    unlinkSync(path);assert.equal(referenceObservationArchiveMatches(d,record.observation,record.frame),true);
    assert.equal(referenceObservationArchiveMatches(d,{...record.observation,id:'../other'},record.frame),false);
  });
});
test('dual request claims must agree before any repeat start, status or continuation effect',async()=>{
  await fixture(async(directory,host,run)=>{
    const stable=key(directory,'request','same-request'),legacy=join(directory,'request-same-request.json'),raw=readFileSync(stable);
    writeFileSync(legacy,raw);const before=[stable,legacy].map(image);
    assert.equal((await host.service.status({run_id:run},caller())).status,'needs_host');assert.deepEqual([stable,legacy].map(image),before);
    alter(legacy,body=>{body.request_digest='0'.repeat(64);});
    const originalSnapshot=image(join(directory,run,'snapshot.json'));
    await assert.rejects(host.service.start({request:'Calculate total and mean',request_id:'same-request'},caller()),/saved_request_claim_conflict/);
    await assert.rejects(host.service.status({run_id:run},caller()));await assert.rejects(host.service.continue({run_id:run},caller()));
    assert.deepEqual(image(join(directory,run,'snapshot.json')),originalSnapshot);
    assert.equal(existsSync(join(directory,run,'io-statistics.json')),false);
    assert.equal(readdirSync(directory).filter(name=>name.startsWith('reference-')).length,1);
  });
});
test('a legacy locator pointing to another original request ID cannot become an idempotent success',async()=>{
  await fixture(async(directory,host,run)=>{
    // This copied locator models a case-insensitive legacy-name alias; Linux itself is not a Windows qualification.
    const alias='SAME-request',path=join(directory,'request-'+alias+'.json');writeFileSync(path,readFileSync(key(directory,'request','same-request')));
    const before=image(join(directory,run,'snapshot.json'));
    await assert.rejects(host.service.start({request:'Calculate total and mean',request_id:alias},caller()),/request_conflict/);
    assert.deepEqual(image(join(directory,run,'snapshot.json')),before);assert.equal(existsSync(key(directory,'request',alias)),false);
    assert.equal(readdirSync(directory).filter(name=>name.startsWith('reference-')).length,1);
  });
});
test('a present malformed legacy claim never becomes an absent claim or admits another run',async()=>{
  for(const value of [null,false,0,'',[],{}, {run_id:'some-run',principal:'local-reference-owner',request_digest:0,meta_digest:null}]){
    const directory=mkdtempSync(join(tmpdir(),'jev-ref-invalid-claim-')),requestId='claimed:old',legacy=join(directory,'request-'+requestId+'.json');
    writeFileSync(legacy,JSON.stringify(value));const before=image(legacy),host=openReferenceHost(directory);
    try{
      await assert.rejects(host.service.start({request:'Calculate total and mean',request_id:requestId},caller()),/saved_request_claim_unconfirmed/);
      assert.deepEqual(image(legacy),before);assert.equal(existsSync(key(directory,'request',requestId)),false);
      assert.equal(readdirSync(directory).filter(name=>name.startsWith('reference-')).length,0);
    }finally{host.close();rmSync(directory,{recursive:true,force:true});}
  }
});
test('restored SDK reconciles an actual read from an unchanged legacy archive without resending the pending worker',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'jev-ref-legacy-reconcile-')),source=join(directory,'source.txt');writeFileSync(source,'7,11');
  const catalog:Registration[]=[
    {capability:{id:'reader',kind:'tool',authorized:true,parallel:false,cancellable:true},description:'Fixture current local read',input_description:'operation=read'},
    {capability:{id:'report',kind:'caller',authorized:true,parallel:false,cancellable:true},description:'Fixture final',input_description:'operation=report'},
  ];
  const now=Date.now(),run_id='legacy-reconcile',admission={run_id,profile_id:'local-fixture',timeout_ms:180000,admitted_at_ms:now,deadline_ms:now+180000};
  const durable=join(directory,'snapshot.json');let saved!:WorkSnapshot,actual!:Observation,frame!:TaskRequest,workerCalls=0,archiveCalls=0;
  const current=()=>hash(readFileSync(source))===hash('7,11');
  const unavailable=async():Promise<never>=>{throw Error('unexpected physical or planner call');};
  const host:WorkHost={signal:new AbortController().signal,finalCapability:'report',
    checks:{validateInput:()=>true,authorize:()=>current(),isCurrent:f=>current()&&f.run_id===run_id,
      acceptNativeAdmission:a=>digest(a)===digest(admission)},authorizeEntry:current,authorizePlanner:current,verifyPlannerOrigin:()=>true,
    save:async s=>{writeFileSync(durable,JSON.stringify(s));saved=s;},readback:async s=>digest(read(durable))===digest(s),
    acceptSnapshot:s=>digest(read(durable))===digest(s)&&current(),authorizeReconcile:(_input,s)=>current()&&digest(s.admission)===digest(admission),
    verifyObservationOrigin:(o,f)=>referenceObservationArchiveMatches(directory,o,f),
    archiveObservation:async record=>{archiveCalls++;assert.equal(referenceObservationArchiveMatches(directory,record.observation,record.frame),true);},
    worker:async f=>{workerCalls++;frame=f;const raw=readFileSync(source);actual={contract_version:CONTRACT_VERSION,id:'observation:read',
      run_id,task_id:f.task_id,attempt_id:f.attempt_id,input_revision:f.input_revision,input_digest:f.input_digest,status:'completed',
      value:{text:raw.toString('utf8')},evidence:['source'],mode:'scripted',usage:{tokens:null,cost:null}};
      writeFileSync(join(directory,'observation-'+actual.id+'.json'),JSON.stringify({frame:f,observation:actual,observation_sha256:digest(actual)}));
      throw Error('fixture ACK lost after the actual read and original archive');},
    decision:unavailable,final:unavailable,verifyFinalOrigin:()=>false,archiveFinal:unavailable,evidenceText:()=>[]};
  const receipt={mode:'scripted' as const,origin:{fixture_only:true},usage:{tokens:null,cost:null},latency_ms:null};
  const planner={initial:async()=>({...receipt,tasks:[{id:'read',purpose:'Read current file',capability:'reader',input_revision:'original',
    input:{operation:'read'},sources:['source'],reads:[],after:[],output:'original read'},
    {id:'report',purpose:'Report the accepted read',capability:'report',input_revision:'original',input:{operation:'report'},sources:[],reads:['read'],after:['read'],output:'answer'}]}),
    next:async()=>({...receipt,action:{kind:'dispatch' as const}})};
  try{
    const first=await createWork({requestText:'Read my local file',frame:{run_id,input_revision:'original',requested_output:'actual observation',
      sources:[{id:'source',revision:hash('7,11'),text:'7,11',origin:'fixture file',range:'whole',omitted:false}],
      budget:{max_operations:8,max_decisions:0,max_plan_versions:4,max_parallel:1,timeout_ms:180000}},catalog,admission,host,planner,maxPlannerCalls:5}).run();
    assert.equal(first.sdk_status,'NEEDS_RECONCILIATION');assert.equal(workerCalls,1);
    const original=saved,legacy=join(directory,'observation-'+actual.id+'.json'),before=image(legacy),readBefore=image(source);
    const resumed=await restoreWork(original,{catalog,admission,host,planner:{initial:unavailable,next:unavailable},
      restoreChecks:{...host.checks,acceptCheckpoint:cp=>cp.digest===original.checkpoint.digest,verifySettlement:()=>false}});
    const reconciled=await resumed.reconcile({observation:actual});
    assert.equal(reconciled.snapshot.checkpoint.state.entries[0].state,'done');assert.equal(workerCalls,1);assert.equal(archiveCalls,1);
    assert.deepEqual(image(legacy),before);assert.deepEqual(image(source),readBefore);assert.equal(existsSync(key(directory,'observation',actual.id)),false);
    assert.deepEqual(reconciled.snapshot.admission,original.admission);assert.deepEqual(reconciled.snapshot.checkpoint.state.request.budget,original.checkpoint.state.request.budget);
    assert.equal(reconciled.result.usage.operations_started,1);assert.equal(reconciled.snapshot.planner_calls_started,original.planner_calls_started);
    assert.equal(reconciled.snapshot.checkpoint.state.entries[0].request!.attempt_id,frame.attempt_id);
    const duplicate=await resumed.reconcile({observation:actual});assert.equal(duplicate.result.usage.operations_started,1);assert.equal(workerCalls,1);
    assert.deepEqual(image(legacy),before);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
