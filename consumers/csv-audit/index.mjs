/** A local, scripted CSV recipe over the public SDK. No Jev/model or remote host. */
import {createWork, restoreWork, SDK_VERSION} from 'jev-decision-fabric';
import {CONTRACT_VERSION} from 'jev-decision-fabric/contract';
import {digest} from 'jev-decision-fabric/controller';
import {readFileSync, readSync, constants, writeFileSync, mkdirSync, openSync, closeSync, fsyncSync, renameSync,
  unlinkSync, existsSync, lstatSync, fstatSync, realpathSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw new Error(code); };
// Final quote validation treats these characters as quotation delimiters.
// Encode presentation only; original labels/unit/path remain unchanged in evidence.
const display = value => String(value).replace(/["`“”「」『』\x00-\x1f\x7f]/g,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
// Human fields cannot issue terminal controls or create additional diagnostic lines.
// Only the recipe answer's deliberate LF separators are retained; JSON stays original.
const terminalText = (value,answer=false) => String(value).replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g,c=>
  answer&&c==='\n'?'\n':'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const TIMEOUT_MS = 180000;
const MAX_BYTES = 32768;
const BUDGET = Object.freeze({max_operations:8,max_decisions:0,max_plan_versions:3,max_parallel:1,timeout_ms:TIMEOUT_MS});
const catalog = [
  {capability:{id:'csv-read',kind:'worker',authorized:true,parallel:false,cancellable:true},description:'Read the explicitly bound local CSV',input_description:'operation=read'},
  {capability:{id:'csv-audit',kind:'tool',authorized:true,parallel:false,cancellable:true},description:'Validate numeric CSV and calculate exact decimal statistics',input_description:'operation=audit'},
  {capability:{id:'csv-report',kind:'caller',authorized:true,parallel:false,cancellable:true},description:'Fresh scripted answer from accepted CSV read and audit',input_description:'operation=report'},
];
export const QUALIFICATION = Object.freeze({scope:'local numeric CSV recipe',planner:'scripted',final:'scripted',
  actual_local_io:true,real_Jev_calls:0,real_native_calls:0,tokens:null,cost:null,
  production_crash_recovery:false,external_host_adoption:false});

function decode(raw) { try { return new TextDecoder('utf-8',{fatal:true}).decode(raw); } catch { fail('csv_invalid_utf8'); } }
function decimal(value) {
  if (!/^-?\d{1,18}(?:\.\d{1,6})?$/.test(value)) fail('csv_invalid_number');
  const negative=value.startsWith('-'), unsigned=negative?value.slice(1):value;
  const [whole,fraction='']=unsigned.split('.');
  return (negative?-1n:1n)*(BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0')));
}
function printDecimal(value) {
  const sign=value<0n?'-':'', absolute=value<0n?-value:value;
  const fraction=String(absolute%1000000n).padStart(6,'0').replace(/0+$/,'');
  return sign+String(absolute/1000000n)+(fraction?'.'+fraction:'');
}
/** Deliberately bounded: item,<column>, no quotes/commas/newlines inside a cell. */
export function auditCsv(text, column='amount', unit='units') {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(column)||column==='item') fail('csv_invalid_column');
  const lines=text.replace(/\r\n/g,'\n').split('\n'); if(lines.at(-1)==='')lines.pop();
  if(lines[0]!==`item,${column}`)fail('csv_header_mismatch');
  if(lines.length<2||lines.length>1001)fail('csv_row_count');
  const labels=new Map();let total=0n,min=null,max=null;
  for(let i=1;i<lines.length;i++) {
    const cells=lines[i].split(',');
    if(cells.length!==2||cells.some(c=>c.includes('"')||/[\x00-\x1f\x7f]/.test(c))||!cells[0].trim()||cells[0]!==cells[0].trim()||cells[1]!==cells[1].trim())fail('csv_invalid_row_'+(i+1));
    const value=decimal(cells[1]);total+=value;min=min===null||value<min?value:min;max=max===null||value>max?value:max;
    labels.set(cells[0],(labels.get(cells[0])??0)+1);
  }
  return {column,unit,rows:lines.length-1,total:printDecimal(total),minimum:printDecimal(min),maximum:printDecimal(max),
    duplicate_items:[...labels].filter(([,count])=>count>1).map(([item,count])=>({item,count})),
    arithmetic:'exact decimal; maximum six fractional digits; no conversion of units'};
}
function atomic(path,value) {
  const temp=path+'.'+randomUUID()+'.tmp',fd=openSync(temp,'wx',0o600);
  try{writeFileSync(fd,JSON.stringify(value,null,2)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(temp,path);
}
function read(path){return JSON.parse(readFileSync(path,'utf8'));}
function sealed(body){return {...body,digest:digest(body)};}
function unseal(value,code){if(!value||typeof value!=='object'||Array.isArray(value))fail(code);const {digest:hash,...body}=value;if(hash!==digest(body))fail(code);return body;}
function validSnapshot(s){try{const {digest:h,...body}=s,{digest:ch,...cb}=s.checkpoint;return h===digest(body)&&ch===digest(cb)&&s.admission.run_id===s.checkpoint.state.request.run_id;}catch{return false;}}
function openStore(directory) {
  const root=resolve(directory);mkdirSync(root,{recursive:true,mode:0o700});
  if(lstatSync(root).isSymbolicLink())fail('state_directory_symlink');
  const lock=join(root,'writer.lock');let fd;try{fd=openSync(lock,'wx',0o600);}catch(e){if(e.code==='EEXIST')fail('writer_locked_no_automatic_break');throw e;}
  const token=randomUUID();writeFileSync(fd,token);const identity=fstatSync(fd);let closed=false;
  const owns=()=>{try{const now=lstatSync(lock);return !closed&&now.isFile()&&now.dev===identity.dev&&now.ino===identity.ino&&readFileSync(lock,'utf8')===token;}catch{return false;}};
  return {root,owns,close(){if(!closed){const owned=owns();closed=true;closeSync(fd);if(owned)unlinkSync(lock);}},
    path:name=>join(root,name),loadMeta(){return unseal(read(join(root,'admission.json')),'saved_admission_corrupt');},
    loadSnapshot(){const s=read(join(root,'snapshot.json'));if(!validSnapshot(s))fail('saved_snapshot_corrupt');return s;}};
}
function readCsvBytes(file){
  // POSIX FIFO open must not wait for a producer. Windows CreateFile does not
  // wait for an absent/busy pipe; libuv fstat marks pipe handles nonregular.
  // Only win32 uses its native read-only open, never an unknown-platform fallback.
  let flags=constants.O_RDONLY;
  if(process.platform!=='win32'){
    if(!(constants.O_NONBLOCK>0))fail('csv_nonblocking_open_unsupported');
    flags|=constants.O_NONBLOCK;
  }
  const fd=openSync(file,flags);
  try{
    const before=fstatSync(fd,{bigint:true});
    if(!before.isFile())fail('csv_file_not_regular');
    if(before.size>BigInt(MAX_BYTES))fail('csv_file_too_large');
    // A size hint is not an allocation budget: the same FD may grow after fstat.
    const buffer=Buffer.alloc(MAX_BYTES+1);let length=0;
    while(length<buffer.length){
      const count=readSync(fd,buffer,length,buffer.length-length,length);
      if(count===0)break;length+=count;
    }
    if(length>MAX_BYTES)fail('csv_file_too_large');
    const after=fstatSync(fd,{bigint:true});
    if(!after.isFile()||before.size!==after.size||after.size!==BigInt(length)||
      before.mtimeNs!==after.mtimeNs||before.ctimeNs!==after.ctimeNs)fail('csv_source_changed_during_read');
    return buffer.subarray(0,length);
  }finally{closeSync(fd);}
}
function rawSource(meta){const raw=readCsvBytes(meta.file);if(sha(raw)!==meta.source_sha256)fail('source_changed_original_run_preserved');return raw;}
function assertBindings(store,meta,snapshot){
  if(!store.owns()||!validSnapshot(snapshot)||digest(store.loadMeta())!==digest(meta)||
    digest(snapshot.admission)!==digest(meta.admission)||snapshot.checkpoint.state.request.run_id!==meta.run_id||
    digest(snapshot.checkpoint.state.request.budget)!==digest(BUDGET)||snapshot.catalog_digest!==digest(catalog)||
    snapshot.final_capability!=='csv-report')fail('saved_run_binding_corrupt');
  const request=snapshot.checkpoint.state.request;
  if(request.objective!==meta.request||request.input_revision!==meta.revision||request.sources.length!==1||
    request.sources[0].id!=='csv'||request.sources[0].revision!==meta.source_sha256||
    sha(Buffer.from(request.sources[0].text))!==meta.source_sha256)fail('saved_request_binding_corrupt');
}
function loadRecord(store,meta){
  const snapshot=store.loadSnapshot();assertBindings(store,meta,snapshot);
  const record=unseal(read(store.path('result.json')),'saved_result_corrupt');
  if(record.snapshot_digest!==snapshot.digest||record.run_id!==meta.run_id||record.result.run_id!==meta.run_id||
    record.deadline_ms!==meta.admission.deadline_ms||digest(record.budget)!==digest(BUDGET))fail('saved_result_binding_corrupt');
  const state=snapshot.checkpoint.state;
  if(record.result.status!==state.status||record.result.answer!==state.answer||digest(record.result.provenance)!==digest(state.provenance)||
    record.result.usage.operations_started!==state.operations||record.result.usage.decisions_started!==state.decisions||
    record.usage.parent_operations_started!==state.operations+snapshot.planner_calls_started||
    record.source.sha256!==meta.source_sha256||record.source.file!==meta.file||record.request!==meta.request||
    digest(record.qualification)!==digest(QUALIFICATION))fail('saved_result_projection_corrupt');
  const completed=state.observations.filter(r=>r.adoption==='accepted'&&r.observation.status==='completed').map(r=>r.observation)
    .map(o=>({id:o.id,task_id:o.task_id,attempt_id:o.attempt_id,input_digest:o.input_digest,value:o.value}));
  if(digest(record.accepted_observations)!==digest(completed)||digest(record.final_receipt)!==digest(snapshot.final_receipt))fail('saved_evidence_projection_corrupt');
  for(const {observation,adoption} of state.observations){
    if(adoption!=='accepted'||observation.task_id==='report-csv')continue;
    const archived=read(store.path('observation-'+sha(observation.id)+'.json'));
    const frame=state.entries.find(e=>e.task.id===observation.task_id)?.request;
    if(!frame||archived.observation_sha256!==digest(observation)||digest(archived.observation)!==digest(observation)||digest(archived.frame)!==digest(frame))fail('saved_observation_archive_corrupt');
  }
  if(record.state==='COMPLETE'){
    const origin=read(store.path('final-origin.json')),raw=readFileSync(store.path('final-'+origin.raw_sha256+'.json'));
    const frame=state.entries.find(e=>e.task.id==='report-csv')?.request,final=JSON.parse(raw);
    if(!frame||sha(raw)!==origin.raw_sha256||origin.raw_sha256!==record.final_receipt?.raw_sha256||final.answer!==record.result.answer||
      digest(origin.frame)!==digest(frame)||digest(origin.origin)!==digest(snapshot.final_receipt.origin)||
      !['run_id','task_id','attempt_id','input_digest'].every(k=>final[k]===frame[k]))fail('saved_final_archive_corrupt');
  }
  return {snapshot,record};
}
function bindings(store,meta,resumed){
  const abort=new AbortController();
  const current=()=>{try{return store.owns()&&digest(store.loadMeta())===digest(meta)&&sha(rawSource(meta))===meta.source_sha256;}catch{return false;}};
  const obsPath=id=>store.path('observation-'+sha(id)+'.json');
  const archived=(observation,frame)=>{try{const r=read(obsPath(observation.id));return r.observation_sha256===digest(observation)&&digest(r.observation)===digest(observation)&&digest(r.frame)===digest(frame);}catch{return false;}};
  const receipt=context=>({mode:'scripted',origin:{kind:'csv-recipe',invocation:context.invocation.id,input_digest:context.invocation.input_digest},usage:{tokens:null,cost:null},latency_ms:null});
  const task=(id,cap,operation,sources,reads)=>({id,capability:cap,purpose:id,input_revision:meta.revision,input:{operation},sources,reads,after:reads,output:cap==='csv-report'?'ordinary CSV answer':'CSV evidence'});
  const planner={initial:async context=>({...receipt(context),tasks:[task('read-csv','csv-read','read',['csv'],[]),task('audit-csv','csv-audit','audit',[],['read-csv']),task('report-csv','csv-report','report',[],['read-csv','audit-csv'])]}),
    next:async context=>({...receipt(context),action:meta.pause_after_read&&!resumed&&context.observations.some(o=>o.task_id==='read-csv')?
      {kind:'pause',reason:'Caller requested saved pause after the accepted CSV read'}:{kind:'dispatch'}})};
  const host={signal:abort.signal,finalCapability:'csv-report',
    checks:{validateInput:(cap,input)=>!!input&&Object.keys(input).length===1&&input.operation===({'csv-read':'read','csv-audit':'audit','csv-report':'report'}[cap]),
      authorize:(task,sources)=>current()&&catalog.some(c=>c.capability.id===task.capability)&&task.input_revision===meta.revision&&sources.every(s=>s.id==='csv'&&s.revision===meta.source_sha256&&!s.omitted&&sha(s.text)===meta.source_sha256),
      isCurrent:frame=>current()&&frame.run_id===meta.run_id&&frame.input_revision===meta.revision,
      acceptNativeAdmission:(a,request)=>current()&&digest(a)===digest(meta.admission)&&request.run_id===meta.run_id},
    authorizeEntry:current,
    authorizePlanner:context=>current()&&!context.signal.aborted&&context.deadline_ms===meta.admission.deadline_ms&&context.request.run_id===meta.run_id,
    save:async snapshot=>{if(!current())fail('save_authority');assertBindings(store,meta,snapshot);atomic(store.path('snapshot.json'),snapshot);},
    readback:async snapshot=>store.owns()&&digest(store.loadSnapshot())===digest(snapshot),
    acceptSnapshot:async snapshot=>current()&&digest(snapshot)===digest(store.loadSnapshot())&&digest(snapshot.admission)===digest(meta.admission),
    authorizeReconcile:async()=>false,
    verifyPlannerOrigin:async(reply,pending)=>reply.mode==='scripted'&&reply.origin?.kind==='csv-recipe'&&reply.origin.invocation===pending.id&&reply.origin.input_digest===pending.input_digest,
    worker:async frame=>{
      let value,status='completed',evidence;
      if(frame.capability==='csv-read'){const raw=rawSource(meta);value={text:decode(raw),source:{file:meta.file,sha256:sha(raw),bytes:raw.length,revision:meta.source_sha256},actual_registered_read:true};evidence=['csv'];}
      else if(frame.capability==='csv-audit'){
        const prior=frame.reads['read-csv'];if(!prior||prior.status!=='completed')fail('missing_accepted_csv_read');
        try{value={...auditCsv(prior.value.text,meta.column,meta.unit),source:prior.value.source,read_observation_id:prior.id};}
        catch(error){status='invalid';value={error:error.message,source:prior.value.source,read_observation_id:prior.id,partial_total:null};}
        evidence=[prior.id];
      }else fail('unregistered_worker');
      return {contract_version:CONTRACT_VERSION,id:'csv-observation:'+frame.task_id,run_id:frame.run_id,task_id:frame.task_id,attempt_id:frame.attempt_id,input_revision:frame.input_revision,input_digest:frame.input_digest,status,value,evidence,mode:'scripted',usage:{tokens:null,cost:null}};
    },
    archiveObservation:async record=>{const path=obsPath(record.observation.id);if(existsSync(path)){if(!archived(record.observation,record.frame))fail('observation_archive_conflict');return;}atomic(path,record);},
    verifyObservationOrigin:async(observation,frame)=>archived(observation,frame),
    decision:async()=>fail('csv_recipe_has_no_Jev_or_decision_allocation'),
    final:async frame=>{
      const began=performance.now(),audit=frame.reads['audit-csv'],source=frame.reads['read-csv'];
      if(!audit||!source||audit.status!=='completed'||source.status!=='completed')fail('missing_completed_csv_evidence');
      const a=audit.value;
      const answer=`CSV audit: ${a.rows} rows; total ${a.total} ${display(a.unit)}; minimum ${a.minimum} ${display(a.unit)}; maximum ${a.maximum} ${display(a.unit)}.\n`+
        `Duplicate item labels: ${a.duplicate_items.length? a.duplicate_items.map(d=>display(d.item)+' ('+d.count+')').join(', '):'none'}.\n`+
        `Source: ${display(a.source.file)}; column ${a.column}; SHA256 ${a.source.sha256}; bytes ${a.source.bytes}.\n`+
        'Exact decimal arithmetic. Local scripted planner/final; actual file I/O. Jev and native models were not called.';
      const raw=Buffer.from(JSON.stringify({run_id:frame.run_id,task_id:frame.task_id,attempt_id:frame.attempt_id,input_digest:frame.input_digest,answer,
        provenance:[{observation_id:source.id,claim:'Actual registered read of the bound CSV bytes and SHA256.'},{observation_id:audit.id,claim:'Validation and exact decimal audit of that accepted read.'}],unresolved:[]}));
      return {raw,mode:'scripted',new_native_call:false,origin:{kind:'csv-fresh-final',run_id:meta.run_id,input_digest:frame.input_digest,raw_sha256:sha(raw)},usage:{tokens:null,cost:null},latency_ms:performance.now()-began};
    },
    verifyFinalOrigin:async(reply,frame)=>reply.mode==='scripted'&&!reply.new_native_call&&reply.origin?.kind==='csv-fresh-final'&&reply.origin.run_id===meta.run_id&&reply.origin.input_digest===frame.input_digest&&reply.origin.raw_sha256===sha(reply.raw),
    archiveFinal:async record=>{const path=store.path('final-'+record.raw_sha256+'.json');if(existsSync(path)&&sha(readFileSync(path))!==record.raw_sha256)fail('final_archive_conflict');if(!existsSync(path))writeFileSync(path,record.raw,{mode:0o600,flag:'wx'});atomic(store.path('final-origin.json'),{frame:record.frame,origin:record.origin,raw_sha256:record.raw_sha256});},
    evidenceText:observation=>[JSON.stringify(observation.value),String(observation.value?.text??'')],
  };
  const restoreChecks={...host.checks,acceptCheckpoint:checkpoint=>current()&&checkpoint.digest===store.loadSnapshot().checkpoint.digest,verifySettlement:()=>false};
  return {host,planner,restoreChecks};
}
async function saveOutcome(store,meta,outcome){
  const snapshot=outcome.snapshot;assertBindings(store,meta,snapshot);atomic(store.path('snapshot.json'),snapshot);
  if(digest(store.loadSnapshot())!==digest(snapshot))fail('outcome_readback');
  const accepted=outcome.records.observations.filter(r=>r.adoption==='accepted'&&r.observation.status==='completed').map(r=>r.observation);
  const record={schema:'csv-consumer-result-v1',sdk_version:SDK_VERSION,run_id:meta.run_id,request:meta.request,
    state:outcome.sdk_status,result:outcome.result,snapshot_digest:snapshot.digest,deadline_ms:meta.admission.deadline_ms,budget:BUDGET,
    source:{file:meta.file,column:meta.column,unit:meta.unit,sha256:meta.source_sha256,revision:meta.source_sha256},
    usage:outcome.usage,qualification:QUALIFICATION,
    accepted_observations:accepted.map(o=>({id:o.id,task_id:o.task_id,attempt_id:o.attempt_id,input_digest:o.input_digest,value:o.value})),
    final_receipt:outcome.final_receipt,next_operation:outcome.sdk_status==='COMPLETE'?'status: inspect this original result':outcome.sdk_status==='PAUSED'?'resume: continue this same run before its original deadline':outcome.sdk_status==='NEEDS_RECONCILIATION'?'Original effect readback required; no automatic retry or lock break':'Inspect the saved invalid/error observation; correct input only in a new explicit state directory'};
  atomic(store.path('result.json'),sealed(record));return record;
}
function savedDelivery(record,meta){
  const expired=record.state==='PAUSED'&&Date.now()>=meta.admission.deadline_ms;
  return {...record,delivery:'saved_original_result',current_operation:'read saved original result; no source re-read or effects',
    current_state:expired?'EXPIRED_UNFINISHED':record.state,resumable:record.state==='PAUSED'&&!expired,
    next_operation:expired?'Original deadline expired: inspect history; a new audit requires an explicit new state directory':record.next_operation};
}

/** Host-owned local archive around the original SDK snapshot, not another state engine. */
export async function runConsumer(options){
  const operation=options.operation??'start';if(!['start','resume','status'].includes(operation)||!options.state)fail('operation_or_state_required');
  const store=openStore(options.state);
  try{
    if(operation==='start'){
      if(typeof options.request!=='string'||!options.request.trim()||options.request.length>4000||!/audit|total|sum|合計|監査/i.test(options.request))fail('request_requires_csv_audit_or_total');
      if(!options.file)fail('explicit_csv_file_required');
      const file=realpathSync(resolve(options.file)),column=options.column??'amount',unit=options.unit??'units';
      if(!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(column)||column==='item'||typeof unit!=='string'||!unit.trim()||unit.length>40||/[\r\n\x00-\x1f]/.test(unit))fail('column_or_unit_invalid');
      if(existsSync(store.path('admission.json'))){const meta=store.loadMeta();if(meta.request!==options.request||meta.file!==file||meta.column!==column||meta.unit!==unit)fail('existing_state_request_conflict');return savedDelivery(loadRecord(store,meta).record,meta);}
      const raw=readCsvBytes(file),text=decode(raw);
      const run_id='csv-'+randomUUID(),now=Date.now(),admission={run_id,profile_id:'local-scripted-csv',timeout_ms:TIMEOUT_MS,admitted_at_ms:now,deadline_ms:now+TIMEOUT_MS};
      const meta={run_id,file,request:options.request,column,unit,source_sha256:sha(raw),revision:'csv-r1',admission,pause_after_read:options.pauseAfterRead===true};
      atomic(store.path('admission.json'),sealed(meta));
      const work=createWork({requestText:meta.request,frame:{run_id,input_revision:meta.revision,requested_output:'CSV audit and exact total with source provenance',
        sources:[{id:'csv',revision:meta.source_sha256,text,origin:file,range:'whole file',omitted:false}],budget:BUDGET},catalog,admission,...bindings(store,meta,false),maxPlannerCalls:5});
      return {...await saveOutcome(store,meta,await work.run()),delivery:'current_operation'};
    }
    const meta=store.loadMeta(),{snapshot,record}=loadRecord(store,meta);
    if(operation==='status')return savedDelivery(record,meta);
    if(record.state==='COMPLETE'||record.state==='STOPPED')return savedDelivery(record,meta);
    if(record.state!=='PAUSED')fail('original_effect_readback_required_no_retry');
    if(Date.now()>=meta.admission.deadline_ms)fail('original_deadline_expired_no_refresh');
    rawSource(meta); // Check unchanged source before any SDK restoration/persistence.
    const work=await restoreWork(snapshot,{catalog,admission:meta.admission,...bindings(store,meta,true)});
    await work.continue();return {...await saveOutcome(store,meta,await work.run()),delivery:'current_operation'};
  }finally{store.close();}
}
export function formatHuman(record){
  return [`State: ${terminalText(record.current_state??record.state)}; original saved state: ${terminalText(record.state)}; run: ${terminalText(record.run_id)}`,`Delivery: ${terminalText(record.delivery)}`,terminalText(record.result.answer??'No completed answer.',true),
    `Source SHA256: ${terminalText(record.source.sha256)}`,`Original deadline: ${new Date(record.deadline_ms).toISOString()}`,
    `Parent operations: ${terminalText(record.usage.parent_operations_started)}/${terminalText(record.budget.max_operations)}; Jev/native calls: 0; token/cost: unknown`,
    `Next: ${terminalText(record.next_operation)}`].join('\n');
}
function args(argv){
  const options={};let json=false;
  for(let i=0;i<argv.length;i++){const name=argv[i];if(name==='--json'){json=true;continue;}if(name==='--pause-after-read'){options.pauseAfterRead=true;continue;}
    if(!['--operation','--request','--file','--state','--column','--unit'].includes(name)||!argv[i+1]||argv[i+1].startsWith('--'))fail('invalid_cli_arguments');options[name.slice(2)]=argv[++i];}
  return {options,json};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const {options,json}=args(process.argv.slice(2)),record=await runConsumer(options);
    if(!json)process.stderr.write(formatHuman(record)+'\n');process.stdout.write(JSON.stringify(record,null,2)+'\n');
    if(record.state==='STOPPED'||record.state==='NEEDS_RECONCILIATION')process.exitCode=2;
  }catch(error){const record={schema:'csv-consumer-error-v1',state:'OPERATION_REFUSED',error:error.message,
    next_operation:'Inspect the original state/input and this error. No automatic retry, new admission, or lock break occurred.',qualification:QUALIFICATION};
    process.stderr.write('Operation refused: '+terminalText(record.error)+'\n'+terminalText(record.next_operation)+'\n');process.stdout.write(JSON.stringify(record,null,2)+'\n');process.exitCode=1;}
}
