/** Bounded reference host: scripted planner/final, actual local reads/calculation, no model call. */
import {readFileSync,writeFileSync,mkdirSync,renameSync,openSync,closeSync,unlinkSync,existsSync,lstatSync,fstatSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createWork,restoreWork} from '../adaptive/sdk/index.mts';
import type {WorkHost,WorkSnapshot,PlannerPort,Registration} from '../adaptive/sdk/index.mts';
import type {Task,Observation,TaskRequest,Result} from '../adaptive/contract/c0.mts';
import {CONTRACT_VERSION} from '../adaptive/contract/c0.mts';
import {digest} from '../adaptive/src/controller.mts';
import type {HostWorkService} from '../adaptive/mcp/work.mts';
const hash=(raw:string|Uint8Array)=>createHash('sha256').update(raw).digest('hex');
const id=(s:string)=>/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(s);
const catalog:Registration[]=[
  {capability:{id:'read-file',kind:'worker',authorized:true,parallel:true,cancellable:true},description:'Read only the packaged reference files',input_description:'operation=read; one registered source'},
  {capability:{id:'calculate',kind:'tool',authorized:true,parallel:false,cancellable:true},description:'Calculate total and mean from the accepted numbers read',input_description:'operation=statistics; one explicit accepted read'},
  {capability:{id:'compare-text',kind:'tool',authorized:true,parallel:false,cancellable:true},description:'Compare exact sentences from two accepted policy reads',input_description:'operation=compare; explicit accepted reads A and B'},
  {capability:{id:'report',kind:'caller',authorized:true,parallel:false,cancellable:true},description:'Create a fresh scripted reference answer from actual accepted reads',input_description:'operation=report; explicit accepted reads'},
];
function atomic(path:string,value:unknown){const tmp=path+'.'+process.pid+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});renameSync(tmp,path);}
function read(path:string){return JSON.parse(readFileSync(path,'utf8'));}
export function openReferenceHost(directory:string,options:{pauseAfterRead?:boolean}={}){
  const directoryPath=resolve(directory);mkdirSync(directoryPath,{recursive:true,mode:0o700});
  const lock=join(directoryPath,'writer.lock'),fd=openSync(lock,'wx',0o600),lockToken=randomUUID();writeFileSync(fd,lockToken);
  const lockIdentity=fstatSync(fd);
  let closed=false;
  const ownsLock=()=>{try{const actual=lstatSync(lock);return !closed&&actual.isFile()&&actual.dev===lockIdentity.dev&&actual.ino===lockIdentity.ino&&readFileSync(lock,'utf8')===lockToken;}catch{return false;}};
  const close=()=>{if(!closed){const owned=ownsLock();closed=true;closeSync(fd);if(owned)unlinkSync(lock);}};
  const assets=fileURLToPath(new URL('./work-data/',import.meta.url));
  const assetNames={numbers:'numbers.json',a:'policy-a.txt',b:'policy-b.txt'};
  const sourceFiles=Object.fromEntries(Object.entries(assetNames).map(([k,v])=>[k,join(assets,v)]));
  const dir=(runId:string)=>{if(!id(runId))throw Error('invalid_run_id');return join(directoryPath,runId);};
  const claimPath=(requestId:string)=>{if(!id(requestId))throw Error('invalid_request_id');return join(directoryPath,'request-'+requestId+'.json');};
  function loadMeta(runId:string){const meta=read(join(dir(runId),'admission.json')),claim=read(claimPath(meta.request_id));
    if(meta.run_id!==runId||claim.run_id!==runId||claim.principal!==meta.principal||claim.request_digest!==meta.request_digest||claim.meta_digest!==digest(meta))throw Error('saved_admission_unconfirmed');return meta;}
  function validSnapshot(s:WorkSnapshot){try{const {digest:sha,...body}=s,{digest:cpSha,...cpBody}=s.checkpoint;
    return sha===digest(body)&&cpSha===digest(cpBody)&&s.checkpoint.state.request.run_id===s.admission.run_id;}catch{return false;}}
  function loadSnapshot(runId:string):WorkSnapshot{const s=read(join(dir(runId),'snapshot.json'));
    if(!validSnapshot(s)||s.checkpoint.state.request.run_id!==runId)throw Error('saved_snapshot_unconfirmed');return s;}
  function currentSnapshot(s:WorkSnapshot){try{const runId=s.checkpoint.state.request.run_id,d=dir(runId),head=read(join(d,'head.json')),stored=loadSnapshot(runId);
    return ownsLock()&&validSnapshot(s)&&head.run_id===runId&&head.digest===s.digest&&digest(stored)===digest(s);}catch{return false;}}
  function assertCaller(action:string,args:any,caller:{principal:string;signal:AbortSignal}){
    if(!ownsLock()||caller.principal!=='local-reference-owner'||caller.signal.aborted||action!=='start'&&loadMeta(args.run_id).principal!==caller.principal)throw Error('reference_caller_or_writer_denied');}
  let mutationBusy=false;
  async function exclusive<T>(action:string,args:unknown,caller:{principal:string;signal:AbortSignal},operation:()=>Promise<T>){
    assertCaller(action,args,caller);if(mutationBusy)throw Error('reference_writer_busy');mutationBusy=true;
    try{return await operation();}finally{mutationBusy=false;}}
  function makeBindings(meta:any,resumed:boolean){
    const d=dir(meta.run_id),abort=new AbortController();
    const current=()=>{try{return ownsLock()&&meta.principal==='local-reference-owner'&&digest(loadMeta(meta.run_id))===digest(meta)&&
      Object.entries(meta.source_hashes).every(([key,value])=>hash(readFileSync(sourceFiles[key]))===value);}catch{return false;}};
    const frameCurrent=(frame:TaskRequest)=>current()&&frame.run_id===meta.run_id&&frame.input_revision==='reference-r1';
    const observationPath=(o:Observation)=>join(d,'observation-'+o.id+'.json');
    const host:WorkHost={
      signal:abort.signal,
      finalCapability:'report',
      checks:{validateInput:(cap,input)=>!!input&&typeof input==='object'&&!Array.isArray(input)&&
        Object.keys(input).length===1&&['read-file:read','calculate:statistics','compare-text:compare','report:report'].includes(cap+':'+(input as any).operation),
        authorize:(task,sources)=>current()&&catalog.some(c=>c.capability.id===task.capability)&&sources.every(s=>Object.hasOwn(sourceFiles,s.id)&&hash(s.text)===meta.source_hashes[s.id]),
        isCurrent:frameCurrent,acceptNativeAdmission:(a,request)=>current()&&digest(a)===digest(meta.admission)&&request.run_id===meta.run_id},
      authorizeEntry:current,
      authorizePlanner:context=>current()&&!context.signal.aborted&&context.deadline_ms===meta.admission.deadline_ms&&context.request.run_id===meta.run_id,
      save:async(snapshot)=>{if(!current()||!validSnapshot(snapshot))throw Error('save_authority_or_snapshot');atomic(join(d,'snapshot.json'),snapshot);atomic(join(d,'head.json'),{digest:snapshot.digest,run_id:meta.run_id});},
      readback:async currentSaved=>currentSnapshot(currentSaved),
      acceptSnapshot:async snapshot=>current()&&currentSnapshot(snapshot)&&digest(snapshot.admission)===digest(meta.admission),
      verifyPlannerOrigin:async(reply,pending)=>reply.mode==='scripted'&&(reply.origin as any)?.kind==='reference-planner'&&
        (reply.origin as any).invocation===pending.id&&(reply.origin as any).input_digest===pending.input_digest,
      worker:async(frame)=>{
        const began=performance.now();let value:any,evidence:string[];
        if(frame.capability==='read-file'){
          const source=frame.sources[0],raw=readFileSync(sourceFiles[source.id]);
          if(hash(raw)!==meta.source_hashes[source.id])throw Error('source_changed');
          value={text:raw.toString('utf8'),sha256:hash(raw),bytes:raw.length};evidence=[source.id];
        }else if(frame.capability==='compare-text'){
          const a=frame.reads['read-a'],b=frame.reads['read-b'];if(!a||!b)throw Error('missing_explicit_policy_reads');
          const sentences=(text:string)=>text.split(/(?<=[.!?])\s+/).map(s=>s.trim()).filter(Boolean),as=sentences((a.value as any).text),bs=sentences((b.value as any).text);
          value={unchanged:as.filter(s=>bs.includes(s)),only_a:as.filter(s=>!bs.includes(s)),only_b:bs.filter(s=>!as.includes(s)),method:'exact sentence comparison; no semantic/model judgment'};evidence=[a.id,b.id];
        }else{
          const input=Object.values(frame.reads)[0];const numbers=JSON.parse((input.value as any).text);
          if(!Array.isArray(numbers)||!numbers.length||!numbers.every(n=>typeof n==='number'&&Number.isFinite(n)))throw Error('invalid_numbers');
          const total=numbers.reduce((sum,n)=>sum+n,0);value={total,mean:total/numbers.length,count:numbers.length};evidence=[input.id];
        }
        atomic(join(d,'io-'+frame.task_id+'.json'),{run_id:frame.run_id,task_id:frame.task_id,attempt_id:frame.attempt_id,
          input_digest:frame.input_digest,value,latency_ms:performance.now()-began,scope:'actual local filesystem/read/calculation; scripted reference operation; no provider'});
        return {contract_version:CONTRACT_VERSION,id:'observation:'+frame.task_id,run_id:frame.run_id,task_id:frame.task_id,attempt_id:frame.attempt_id,
          input_revision:frame.input_revision,input_digest:frame.input_digest,status:'completed',value,evidence,mode:'scripted',usage:{tokens:null,cost:null}};
      },
      archiveObservation:async record=>atomic(observationPath(record.observation),record),
      verifyObservationOrigin:async(observation,frame)=>{
        const path=observationPath(observation);if(!existsSync(path))return false;const record=read(path);
        return record.observation_sha256===digest(observation)&&digest(record.frame)===digest(frame);
      },
      authorizeReconcile:async()=>current(),
      decision:async()=>{throw Error('reference_host_has_no_Jev_allocation_or_decision_connection');},
      final:async frame=>{
        const began=performance.now(),reads=Object.values(frame.reads);
        const stats=reads.find(o=>o.task_id==='statistics'),comparison=reads.find(o=>o.task_id==='compare-policies');
        const answer=stats?`Total: ${(stats.value as any).total}; mean: ${(stats.value as any).mean}; count: ${(stats.value as any).count}.`:
          `Unchanged: ${(comparison!.value as any).unchanged.join(' ')||'(none)'}\nOnly A: ${(comparison!.value as any).only_a.join(' ')||'(none)'}\nOnly B: ${(comparison!.value as any).only_b.join(' ')||'(none)'}\nMethod: exact sentence comparison.`;
        const raw=Buffer.from(JSON.stringify({run_id:frame.run_id,task_id:frame.task_id,attempt_id:frame.attempt_id,input_digest:frame.input_digest,
          answer:answer+'\nScripted reference planner/final; actual local work. Jev and native models were not called.',
          provenance:reads.map(o=>({observation_id:o.id,claim:'Returned from the actual registered reference operation.'})),unresolved:[]})+'\n');
        const origin={kind:'reference-fresh-final',run_id:frame.run_id,input_digest:frame.input_digest,raw_sha256:hash(raw)};
        return {raw,new_native_call:false,mode:'scripted',origin,usage:{tokens:null,cost:null},latency_ms:performance.now()-began};
      },
      verifyFinalOrigin:async(reply,frame)=>reply.mode==='scripted'&&(reply.origin as any).kind==='reference-fresh-final'&&
        (reply.origin as any).run_id===frame.run_id&&(reply.origin as any).input_digest===frame.input_digest&&(reply.origin as any).raw_sha256===hash(reply.raw),
      archiveFinal:async record=>{writeFileSync(join(d,'final-'+record.raw_sha256+'.json'),record.raw,{mode:0o600});atomic(join(d,'final-origin.json'),{frame:record.frame,origin:record.origin,raw_sha256:record.raw_sha256});},
      evidenceText:observation=>[JSON.stringify(observation.value),String((observation.value as any)?.text??'')],
    };
    const receipt=(context:any)=>({mode:'scripted' as const,origin:{kind:'reference-planner',invocation:context.invocation.id,input_digest:context.invocation.input_digest},usage:{tokens:null,cost:null},latency_ms:null});
    const task=(taskId:string,cap:string,operation:string,sources:string[],reads:string[]):Task=>({id:taskId,purpose:taskId,capability:cap,input_revision:'reference-r1',input:{operation},sources,reads,after:reads,output:cap==='report'?'ordinary answer':'structured evidence'});
    const planner:PlannerPort={initial:async context=>({
      ...receipt(context),tasks:meta.kind==='statistics'?[task('read-numbers','read-file','read',['numbers'],[]),task('statistics','calculate','statistics',[],['read-numbers']),task('report','report','report',[],['statistics'])]:
        [task('read-a','read-file','read',['a'],[]),task('read-b','read-file','read',['b'],[]),task('compare-policies','compare-text','compare',[],['read-a','read-b']),task('report','report','report',[],['compare-policies'])],
    }),next:async context=>({...receipt(context),action:options.pauseAfterRead&&!resumed&&context.observations.length>=1?
      {kind:'pause',reason:'Reference caller requested a durable pause before the next work'}:{kind:'dispatch'}})};
    const restoreChecks={...host.checks,acceptCheckpoint:(checkpoint:any)=>current()&&checkpoint.digest===loadSnapshot(meta.run_id).checkpoint.digest,
      verifySettlement:()=>false}; // This example does not fabricate external settlement evidence.
    return {host,planner,restoreChecks};
  }
  async function saveOutcome(runId:string,outcome:any){
    const d=dir(runId),snapshot=outcome.snapshot,meta=loadMeta(runId);
    if(!ownsLock()||!validSnapshot(snapshot)||snapshot.checkpoint.state.request.run_id!==runId||digest(snapshot.admission)!==digest(meta.admission))throw Error('outcome_binding');
    // outcome() captures a new checkpoint timestamp. Persist that exact returned wrapper before binding its result.
    atomic(join(d,'snapshot.json'),snapshot);atomic(join(d,'head.json'),{digest:snapshot.digest,run_id:runId});
    const body={snapshot_digest:snapshot.digest,result:outcome.result,qualification:{planner:'scripted',final:'scripted',actual_local_io:true,real_Jev_calls:0,real_native_calls:0}},record={...body,digest:digest(body)};
    atomic(join(d,'result.json'),record);atomic(join(d,'head.json'),{digest:snapshot.digest,run_id:runId,result_digest:record.digest});
    if(!currentSnapshot(snapshot))throw Error('outcome_readback');return outcome.result as Result;
  }
  function status(runId:string):Result{const d=dir(runId),record=read(join(d,'result.json')),snapshot=loadSnapshot(runId),head=read(join(d,'head.json')),{digest:sha,...body}=record;
    if(!currentSnapshot(snapshot)||sha!==digest(body)||head.result_digest!==sha||record.snapshot_digest!==snapshot.digest||record.result.run_id!==runId||
      digest(snapshot.admission)!==digest(loadMeta(runId).admission))throw Error('saved_result_unconfirmed_requires_reconciliation');
    // Project expiry of unfinished work without rewriting historical evidence or clearing pending effects.
    return record.result.status==='needs_host'&&Date.now()>=snapshot.admission.deadline_ms?
      {...record.result,status:'hold',unresolved:[...new Set([...record.result.unresolved,'deadline_exhausted'])]}:record.result;}
  const service:HostWorkService={
    authorize:async(action,args,caller)=>{try{assertCaller(action,args,caller);return true;}catch{return false;}},
    start:(args,caller)=>exclusive('start',args,caller,async()=>{
      const claim=claimPath(args.request_id),requestDigest=hash(args.request);
      if(existsSync(claim)){const old=read(claim);if(old.principal!==caller.principal||old.request_digest!==requestDigest)throw Error('request_conflict');return status(old.run_id);}
      const kind=/total|mean|average|calculate|合計|平均|計算/i.test(args.request)?'statistics':/compare|比較/i.test(args.request)?'comparison':null;
      if(!kind)throw Error('reference_request_unsupported');
      const run_id='reference-'+randomUUID(),d=dir(run_id);mkdirSync(d,{mode:0o700});
      const admitted_at_ms=Date.now(),admission={run_id,profile_id:'local-reference',timeout_ms:180000,admitted_at_ms,deadline_ms:admitted_at_ms+180000};
      const needed=kind==='statistics'?['numbers']:['a','b'];const source_hashes=Object.fromEntries(needed.map(k=>[k,hash(readFileSync(sourceFiles[k]))]));
      const meta={run_id,principal:caller.principal,request_id:args.request_id,admission,kind,source_hashes,request_digest:requestDigest};atomic(join(d,'admission.json'),meta);
      const claimfd=openSync(claim,'wx',0o600);writeFileSync(claimfd,JSON.stringify({run_id,principal:caller.principal,request_digest:requestDigest,meta_digest:digest(meta)}));closeSync(claimfd);
      const bindings=makeBindings(meta,false);
      const work=createWork({requestText:args.request,frame:{run_id,input_revision:'reference-r1',requested_output:'ordinary answer with actual evidence',
        sources:needed.map(k=>({id:k,revision:source_hashes[k],text:readFileSync(sourceFiles[k],'utf8'),origin:'packaged reference file',range:'whole file',omitted:false})),
        budget:{max_operations:8,max_decisions:0,max_plan_versions:4,max_parallel:2,timeout_ms:180000}},catalog,admission,...bindings,maxPlannerCalls:5});
      return saveOutcome(run_id,await work.run({signal:caller.signal}));
    }),
    continue:(args,caller)=>exclusive('continue',args,caller,async()=>{
      const prior=status(args.run_id);if(prior.status!=='needs_host')return prior;
      const meta=loadMeta(args.run_id),snapshot=loadSnapshot(args.run_id),bindings=makeBindings(meta,true);
      const work=await restoreWork(snapshot,{catalog,admission:meta.admission,...bindings});
      await work.continue();return saveOutcome(args.run_id,await work.run({signal:caller.signal}));
    }),
    status:async(args,caller)=>{assertCaller('status',args,caller);return status(args.run_id);},
    cancel:(args,caller)=>exclusive('cancel',args,caller,async()=>{
      const prior=status(args.run_id);if(prior.status!=='needs_host')return prior;
      const meta=loadMeta(args.run_id),bindings=makeBindings(meta,true);const work=await restoreWork(loadSnapshot(args.run_id),{catalog,admission:meta.admission,...bindings});
      return saveOutcome(args.run_id,await work.cancel(args.reason));
    }),
  };
  return {service,close,scope:'scripted reference planner/final; actual local I/O; no Jev/native calls; not J1/whole Goal completion'};
}
