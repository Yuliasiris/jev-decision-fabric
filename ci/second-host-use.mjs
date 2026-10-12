/** GitHub-hosted caller of the unchanged public CSV consumer. No SDK/host reimplementation. */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,cpSync,readdirSync,lstatSync,statSync} from 'node:fs';
import {resolve,join,relative,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';

const SOURCE = '8564d529fca55f5be4683ec53c05348ac71e5729';
const VERSION = '0.4.0-preview.6';
const LOCK = '0917885a5f08b19251f85985a4d62dd8b65a7885aa1ecbca6b5ade6fb8bbc266';
const [sourceArg,packArg,distributionArg,evidenceArg,...extra] = process.argv.slice(2);
const preflightOnly=extra.length===1&&extra[0]==='--preflight-only';
const demand=(ok,code)=>{if(!ok)throw Error(code);};
demand(sourceArg&&packArg&&distributionArg&&evidenceArg&&(extra.length===0||preflightOnly),'CALLER_ARGUMENTS_REQUIRED');
const source=resolve(sourceArg),packPath=resolve(packArg),distribution=resolve(distributionArg),evidence=resolve(evidenceArg);
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const json=path=>JSON.parse(readFileSync(path,'utf8'));
const save=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,JSON.stringify(value,null,2)+'\n');};
const identity=path=>{const raw=readFileSync(path),s=statSync(path,{bigint:true});return {bytes:raw.length,sha256:sha(raw),mtime_ns:String(s.mtimeNs)};};
const equal=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const commands=[];
let stage='PREFLIGHT_DIAGNOSTICS',admissionAttempted=false;
const safeCode=value=>typeof value==='string'&&/^[A-Z_0-9]+$/.test(value)?value:'CALLER_CHECK_FAILED';
const safeLabel=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(value)?value:null;
const safePath=value=>typeof value==='string'&&/^[A-Za-z0-9_./-]{1,300}$/.test(value)&&!value.startsWith('/')&&!value.split('/').includes('..')?value:null;
const marker=(kind,value)=>console.log('JEV_SECOND_CALLER_'+kind+' '+JSON.stringify(value));
function prefixDiagnostics(){
  const result={mode:preflightOnly?'preflight_only':'actual_use',actual_node:safeLabel(process.version),expected_node:'v22.13.0',
    expected_source_commit:SOURCE,expected_version:VERSION,expected_source_lock_sha256:LOCK,expected_package_files:137,
    source_lock_sha256:null,source_lock_read_error:null,package_version:null,package_read_error:null,
    pack_json_bytes:null,pack_json_sha256:null,pack_records:null,pack_version:null,pack_name:null,pack_filename:null,pack_bytes:null,pack_files_count:null,pack_files:null,pack_read_error:null,
    admission_attempted:false,C0_operations_started:0};
  try{result.source_lock_sha256=sha(readFileSync(join(source,'package-lock.json')));}catch(e){result.source_lock_read_error=safeCode(e.code);}
  try{result.package_version=safeLabel(json(join(source,'package.json')).version);}catch(e){result.package_read_error=safeCode(e.code);}
  try{const raw=readFileSync(packPath);result.pack_json_bytes=raw.length;result.pack_json_sha256=sha(raw);const packed=JSON.parse(raw);result.pack_records=Array.isArray(packed)?packed.length:null;
    result.pack_version=safeLabel(packed?.[0]?.version);result.pack_name=safeLabel(packed?.[0]?.name);
    result.pack_filename=safeLabel(packed?.[0]?.filename);result.pack_bytes=Number.isSafeInteger(packed?.[0]?.size)?packed[0].size:null;
    result.pack_files_count=Array.isArray(packed?.[0]?.files)?packed[0].files.length:null;
    result.pack_files=Array.isArray(packed?.[0]?.files)?packed[0].files.map(x=>({path:safePath(x?.path),bytes:Number.isSafeInteger(x?.size)?x.size:null})):null;
  }catch(e){result.pack_read_error=e instanceof SyntaxError?'PACK_JSON_INVALID':safeCode(e.code);}
  save(join(evidence,'preflight.json'),result);marker('PREFLIGHT',result);
}
const cleanEnv={PATH:process.env.PATH??'',LANG:'C.UTF-8',NPM_CONFIG_AUDIT:'false',NPM_CONFIG_FUND:'false',NPM_CONFIG_CACHE:join(evidence,'npm-cache'),
  NPM_CONFIG_USERCONFIG:join(evidence,'npm-config/empty-user.npmrc'),NPM_CONFIG_GLOBALCONFIG:join(evidence,'npm-config/empty-global.npmrc')};
// Preserve platform network/CA configuration without printing or archiving its values.
for(const key of ['HTTP_PROXY','HTTPS_PROXY','NO_PROXY','ALL_PROXY','http_proxy','https_proxy','no_proxy','all_proxy','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR'])
  if(process.env[key])cleanEnv[key]=process.env[key];
function run(label,executable,args,cwd,timeout=45000){
  const start=performance.now(),p=spawnSync(executable,args,{cwd,env:cleanEnv,encoding:'utf8',timeout,maxBuffer:8*1024*1024});
  const rawOutput=executable!=='npm',safeOutput=JSON.stringify({raw_output_retained:false,reason:'npm network output may contain platform configuration values',exit_code:p.status,error_class:p.error?.code??null})+'\n';
  writeFileSync(join(evidence,label+'.stdout.txt'),rawOutput?(p.stdout??''):safeOutput);writeFileSync(join(evidence,label+'.stderr.txt'),rawOutput?(p.stderr??''):safeOutput);
  commands.push({label,executable,args,cwd,exit_code:p.status,error_class:p.error?.code??null,elapsed_ms:performance.now()-start,raw_output_retained:rawOutput});
  save(join(evidence,'commands.json'),commands);demand(!p.error&&p.status===0,'CALLER_OPERATION_UNCONFIRMED_NO_RETRY');return p.stdout;
}
function files(directory,excluded=[]){
  const result={};
  function visit(path){for(const name of readdirSync(path).sort()){const p=join(path,name),r=relative(directory,p);if(excluded.some(x=>r===x||r.startsWith(x+'/')))continue;
    const s=lstatSync(p);demand(!s.isSymbolicLink(),'ARCHIVE_SYMLINK_REFUSED');
    if(s.isDirectory())visit(p);else if(s.isFile())result[relative(directory,p)]=identity(p);}}
  visit(directory);return result;
}
function packageName(path){return path.slice(path.lastIndexOf('node_modules/')+'node_modules/'.length);}
function tuples(lock,omitProject=false){return Object.entries(lock.packages).filter(([p,r])=>p&&!r.dev&&(!omitProject||packageName(p)!=='jev-decision-fabric'))
  .map(([p,r])=>({name:packageName(p),version:r.version,resolved:r.resolved,integrity:r.integrity})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));}
mkdirSync(evidence,{recursive:false});
let status='FAILED';
try{
  prefixDiagnostics();stage='CALLER_CONTEXT';
  demand(process.env.GITHUB_ACTIONS==='true'&&process.env.GITHUB_REPOSITORY==='Yuliasiris/jev-decision-fabric'&&
    process.env.GITHUB_REF==='refs/heads/p0/second-host-use-20261013','EXISTING_GITHUB_CALLER_CONTEXT_REQUIRED');
  demand(process.version==='v22.13.0','FIXED_NODE_RUNTIME_REQUIRED');
  demand(/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA??''),'CALLER_COMMIT_REQUIRED');
  const caller=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  stage='CALLER_COMMIT';
  demand(run('caller-source-head','git',['rev-parse','HEAD'],caller).trim()===process.env.GITHUB_SHA,'CALLER_COMMIT_MISMATCH');
  const harness=identity(fileURLToPath(import.meta.url)),workflow=identity(join(caller,'.github/workflows/second-host-use.yml'));
  mkdirSync(join(evidence,'npm-config'));for(const key of ['NPM_CONFIG_USERCONFIG','NPM_CONFIG_GLOBALCONFIG'])writeFileSync(cleanEnv[key],'',{flag:'wx'});
  stage='PUBLIC_SOURCE_COMMIT';
  const head=run('public-source-head','git',['rev-parse','HEAD'],source).trim();demand(head===SOURCE,'SOURCE_COMMIT_MISMATCH');
  stage='PUBLIC_VERSION_LOCK';
  const sourceLockBytes=readFileSync(join(source,'package-lock.json')),sourceLock=JSON.parse(sourceLockBytes),pkg=json(join(source,'package.json'));
  demand(pkg.version===VERSION&&sha(sourceLockBytes)===LOCK,'PUBLIC_VERSION_LOCK_MISMATCH');
  stage='PUBLIC_PACKAGE_IDENTITY';
  const packed=json(packPath);demand(packed.length===1&&packed[0].name==='jev-decision-fabric'&&packed[0].version===VERSION&&packed[0].files.length===137,'PUBLIC_PACKAGE_IDENTITY');
  stage='PUBLIC_TARBALL_NAME';
  demand(packed[0].filename==='jev-decision-fabric-'+VERSION+'.tgz','PUBLIC_TARBALL_NAME');
  if(preflightOnly){
    status='PREFLIGHT_PASS_ONLY';save(join(evidence,'preflight-result.json'),{status,stage,source_commit:SOURCE,version:VERSION,admission_attempted:false,C0_operations_started:0,source_runtime_executed:false});
    marker('PREFLIGHT_RESULT',json(join(evidence,'preflight-result.json')));
  }else{
  stage='PUBLIC_DISTRIBUTION_COPY';
  const tarball=join(distribution,packed[0].filename),tarIdentity=identity(tarball);
  copyFileSync(tarball,join(evidence,'built-package.tgz'));copyFileSync(packPath,join(evidence,'pack-result.json'));
  writeFileSync(join(evidence,'source-lock.json'),sourceLockBytes);
  const consumer=join(evidence,'consumer');mkdirSync(consumer);
  for(const name of ['index.mjs','package.json','sample.csv'])copyFileSync(join(source,'consumers/csv-audit',name),join(consumer,name));
  const sourceTuples=tuples(sourceLock);demand(sourceTuples.length===46,'SOURCE_RUNTIME_CLOSURE');
  const overrides={};for(const t of sourceTuples){demand(t.version&&t.integrity&&new URL(t.resolved).hostname==='registry.npmjs.org','PUBLIC_DEPENDENCY_ORIGIN');
    demand(!overrides[t.name]||overrides[t.name]===t.version,'MULTIPLE_RUNTIME_VERSION_REQUIRES_SCOPED_BINDING');overrides[t.name]=t.version;}
  const consumerPackage=json(join(consumer,'package.json'));consumerPackage.overrides=overrides;save(join(consumer,'package.json'),consumerPackage);
  stage='NORMAL_PACKAGE_INSTALL';
  run('install','npm',['install','--ignore-scripts','--no-audit','--no-fund',tarball],consumer,120000);
  demand(equal(tuples(json(join(consumer,'package-lock.json')),true),sourceTuples),'INSTALLED_RUNTIME_TUPLES_DIFFER');
  stage='INSTALLED_PROJECT_BYTES';
  const installed=join(consumer,'node_modules/jev-decision-fabric'),projectFiles=[];
  for(const entry of packed[0].files){demand(!entry.path.startsWith('/')&&!entry.path.split('/').includes('..'),'PUBLIC_PACKAGE_PATH');
    const origin=join(source,entry.path),actual=join(installed,entry.path);demand(!lstatSync(actual).isSymbolicLink()&&readFileSync(origin).equals(readFileSync(actual)),'INSTALLED_PROJECT_BYTES_DIFFER');
    projectFiles.push({path:entry.path,bytes:identity(actual).bytes,sha256:identity(actual).sha256});}
  const sample=join(consumer,'sample.csv'),sourceSample=identity(join(source,'consumers/csv-audit/sample.csv'));
  demand(readFileSync(sample).equals(readFileSync(join(source,'consumers/csv-audit/sample.csv'))),'PUBLIC_SAMPLE_BYTES_DIFFER');
  copyFileSync(sample,join(evidence,'sample-input.csv'));
  const state=join(evidence,'owned-state'),entry=join(consumer,'index.mjs');
  const invoke=(name,args)=>{stage='CONSUMER_'+name.toUpperCase();const raw=run(name,process.execPath,[entry,...args],consumer);const result=JSON.parse(raw);save(join(evidence,name+'.received.json'),result);
    marker('RECEIVED',{operation:name,projection:'actual public sample consumer stdout; raw record retained unchanged in artifact',record:result});return result;};
  admissionAttempted=true;
  const paused=invoke('start',['--request','Audit this CSV and total the amount column','--file',sample,'--column','amount','--unit','USD','--state',state,'--pause-after-read']);
  demand(paused.state==='PAUSED'&&paused.delivery==='current_operation','SAVED_PAUSE_REQUIRED');
  const readObservation=paused.accepted_observations.filter(x=>x.task_id==='read-csv');
  demand(readObservation.length===1&&readObservation[0].value.actual_registered_read===true,'ONE_ACCEPTED_REGISTERED_READ_REQUIRED');
  const readArchive=join(state,'observation-'+sha(Buffer.from(readObservation[0].id))+'.json');
  const admission=json(join(state,'admission.json')),snapshot=json(join(state,'snapshot.json')),read=identity(readArchive),admissionIdentity=identity(join(state,'admission.json'));
  const originalAdmission=admission.admission,originalBudget=snapshot.checkpoint.state.request.budget,archivedRead=json(readArchive);
  demand(originalAdmission.run_id===paused.run_id&&paused.deadline_ms===originalAdmission.deadline_ms&&equal(paused.budget,originalBudget),'PAUSED_ORIGINAL_LIMITS');
  demand(archivedRead.frame.run_id===paused.run_id&&archivedRead.observation.id===readObservation[0].id&&
    ['task_id','attempt_id','input_digest'].every(k=>archivedRead.frame[k]===readObservation[0][k]&&archivedRead.observation[k]===readObservation[0][k]),'ORIGINAL_READ_ARCHIVE_FRAME');
  const originalState=files(state);cpSync(state,join(evidence,'phase-paused-state'),{recursive:true});
  const completed=invoke('resume',['--operation','resume','--state',state]);
  demand(completed.state==='COMPLETE'&&completed.delivery==='current_operation'&&completed.run_id===paused.run_id,'SAME_RUN_COMPLETE_REQUIRED');
  demand(completed.deadline_ms===originalAdmission.deadline_ms&&equal(completed.budget,originalBudget),'COMPLETED_ORIGINAL_LIMITS');
  demand(equal(json(join(state,'admission.json')),admission),'ORIGINAL_ADMISSION_CHANGED');
  demand(equal(identity(join(state,'admission.json')),admissionIdentity),'ORIGINAL_ADMISSION_BYTES_OR_MTIME_CHANGED');
  demand(equal(json(join(state,'snapshot.json')).admission,snapshot.admission),'ORIGINAL_SNAPSHOT_ADMISSION_CHANGED');
  demand(equal(json(join(state,'snapshot.json')).checkpoint.state.request.budget,snapshot.checkpoint.state.request.budget),'ORIGINAL_BUDGET_CHANGED');
  demand(equal(identity(readArchive),read),'ORIGINAL_READ_REPLAYED_OR_CHANGED');
  demand(equal(completed.accepted_observations.filter(x=>x.task_id==='read-csv'),readObservation),'ORIGINAL_READ_ATTEMPT_CHANGED');
  const finishedState=files(state);cpSync(state,join(evidence,'phase-completed-state'),{recursive:true});
  const saved=invoke('status',['--operation','status','--state',state]);
  demand(saved.state==='COMPLETE'&&saved.delivery==='saved_original_result'&&saved.run_id===paused.run_id,'SAVED_STATUS_REQUIRED');
  demand(saved.deadline_ms===originalAdmission.deadline_ms&&equal(saved.budget,originalBudget),'STATUS_ORIGINAL_LIMITS');
  demand(equal(saved.accepted_observations.filter(x=>x.task_id==='read-csv'),readObservation),'STATUS_ORIGINAL_READ_ATTEMPT');
  demand(equal(files(state),finishedState),'READ_ONLY_STATUS_CHANGED_ARCHIVE');
  demand(completed.result.answer.includes('1289.74 USD')&&completed.result.answer.includes('Consulting (2)')&&completed.result.provenance.length>0,'PUBLIC_SAMPLE_RESULT_REQUIRED');
  demand(completed.source.sha256===sourceSample.sha256,'ACTUAL_SOURCE_PROVENANCE_REQUIRED');
  demand(completed.qualification.real_Jev_calls===0&&completed.qualification.real_native_calls===0,'SCRIPTED_QUALIFICATION_REQUIRED');
  save(join(evidence,'caller-received.json'),{request:'Audit this CSV and total the amount column',result:completed,saved_status:saved,received_by:'This GitHub-hosted Node caller parsed the actual consumer stdout; external workflow/artifact readback remains Root-owned'});
  save(join(evidence,'receipt.json'),{status:'PASS',source_commit:SOURCE,version:VERSION,source_lock_sha256:LOCK,tarball:tarIdentity,installed_project_files:projectFiles,installed_runtime_tuples:sourceTuples,
    caller:{kind:'GitHub-hosted Actions Node caller',repository:process.env.GITHUB_REPOSITORY,ref:process.env.GITHUB_REF,workflow_sha:process.env.GITHUB_SHA,run_id:process.env.GITHUB_RUN_ID,run_attempt:process.env.GITHUB_RUN_ATTEMPT,platform:process.platform,arch:process.arch,node:process.version,harness,workflow},
    input:{kind:'Public README sample CSV only',...sourceSample},run_id:paused.run_id,original_admission:originalAdmission,original_budget:originalBudget,
    accepted_original_read:readObservation[0],original_meta_file:admissionIdentity,
    original_read_attempt_unchanged:true,status_archive_bytes_sha_mtime_unchanged:true,paused_archive:originalState,completed_archive:finishedState,
    answer:completed.result.answer,provenance:completed.result.provenance,qualification:{actual_file_IO:true,planner_final:'scripted',Jev_native_paid_calls:0,J1_complete:false,whole_Goal_complete:false,external_job_result_readback_required:true,archive_binary_download_verified:false,job_result_and_archive_binary_are_separate:true},
    retry_count:0,source_runtime_modified:false,new_secret_key_contract_or_service:false});
  status='PASS';
  const receipt=json(join(evidence,'receipt.json'));marker('RECEIPT',{status:receipt.status,source_commit:SOURCE,version:VERSION,source_lock_sha256:LOCK,
    run_id:receipt.run_id,original_admission:receipt.original_admission,original_budget:receipt.original_budget,accepted_original_read:receipt.accepted_original_read,
    original_read_attempt_unchanged:receipt.original_read_attempt_unchanged,status_archive_bytes_sha_mtime_unchanged:receipt.status_archive_bytes_sha_mtime_unchanged,
    answer:receipt.answer,provenance:receipt.provenance,harness_sha256:receipt.caller.harness.sha256,workflow_sha256:receipt.caller.workflow.sha256,
    qualification:receipt.qualification,artifact_receipt_sha256:sha(readFileSync(join(evidence,'receipt.json'))),archive_binary_download_verified:false});
  }
}catch(error){status='FAILED';const failure={status:'UNCONFIRMED_NO_RETRY',error:safeCode(error?.message),stage,mode:preflightOnly?'preflight_only':'actual_use',
    admission_attempted:admissionAttempted,C0_operations_started:admissionAttempted?null:0,source_commit:SOURCE,new_native_paid_calls:0,automatic_retry:false};
  save(join(evidence,'failure.json'),failure);marker('FAILURE',failure);}
// Upload only public sample/results and original archive, never dependencies/cache or credentials.
const manifest=files(evidence,['consumer','npm-cache','npm-config']);
save(join(evidence,'public-artifact-files.json'),manifest);
console.log(JSON.stringify({status,evidence:'second-caller-evidence',scope:'Job/result readback and archive blob readback are separate; scripted/native0'}));
if(status!=='PASS'&&status!=='PREFLIGHT_PASS_ONLY')process.exitCode=1;
