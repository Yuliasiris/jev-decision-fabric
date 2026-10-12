/** Runnable public-only arithmetic wiring fixture. None of these runners is an LLM/Jev. */
import {readFile, writeFile} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {EVALUATION_VERSION, digest, runPairedComparison, createPolicyProfile,
  consumePolicyProfile} from '../adaptive/evaluation/index.mts';
import type {ArmReceipt, ConditionManifest, Grade, JSONValue, RunContext, Strategy,
  StrategyRunners} from '../adaptive/evaluation/index.mts';

const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const numbersFile = new URL('./work-data/numbers.json', import.meta.url);
const sourceBytes = await readFile(numbersFile), sourceSHA = sha(sourceBytes);
if (digest(JSON.parse(sourceBytes.toString('utf8'))) !== digest([120,240,360]))
  throw Error('This example requires the packaged synthetic fixture [120,240,360]');
const implementationSHA = sha(await readFile(fileURLToPath(import.meta.url)));
const questions = new Map<string, {request: string; operation: 'total' | 'mean'}>();
const toolRegistry = [
  {id:'numbers.read',capability:'read',model:null},
  {id:'numbers.statistics',capability:'calculate',model:null},
  {id:'numbers.final',capability:'ordinary-final',model:'scripted-local-code'},
] as const;
function makeManifest(case_id: string, split: 'design' | 'held-out', operation: 'total' | 'mean'): ConditionManifest {
  const request = operation==='total' ? 'What is the total of the packaged numbers?' : 'What is their arithmetic mean?';
  questions.set(case_id,{request,operation});
  return {version:EVALUATION_VERSION,case_id,task_class:'synthetic-number-statistics',split,
    input_sha256:digest({request,source_sha256:sourceSHA}),sources:[{id:'numbers',sha256:sourceSHA}],
    capabilities:['read','calculate','ordinary-final'],tools:toolRegistry,
    models:{single:{caller:'scripted-local-code',selector:null},fixed:{caller:'scripted-local-code',selector:null},
      adaptive:{caller:'scripted-local-code',selector:'scripted-numeric-validity-guard'}},
    implementation_sha256:{single:implementationSHA,fixed:implementationSHA,adaptive:implementationSHA},
    budget:{max_operations:4,max_decisions:1,max_plan_versions:2,max_parallel:1,timeout_ms:5000},
    deadline_ms:Date.now()+5000,scoring_sha256:sha(independentScore.toString())};
}
function current(m: ConditionManifest, context: RunContext) {
  if(context.signal.aborted || Date.now()>=m.deadline_ms || context.deadline_ms!==m.deadline_ms)
    throw Error('Original local admission ended');
  const q=questions.get(m.case_id);
  if(!q || m.input_sha256!==digest({request:q.request,source_sha256:sourceSHA}))
    throw Error('Unknown local case/input binding');
  return q;
}
async function runLocal(m: ConditionManifest, context: RunContext, strategy: Strategy): Promise<ArmReceipt> {
  const began=performance.now(), q=current(m,context), run=context.run_id??randomUUID();
  const calls: ArmReceipt['actual_tools'][number][]=[];
  const runTool = async <T,>(id: typeof toolRegistry[number]['id'], action: () => Promise<T> | T): Promise<T> => {
    current(m,context);
    if(calls.length>=m.budget.max_operations)throw Error('Original operation budget exhausted');
    const start=performance.now(), value=await action();current(m,context);
    const tool=toolRegistry.find(t=>t.id===id)!;
    calls.push({call_id:run+':'+id,tool_id:id,model:tool.model,input_sha256:m.input_sha256,
      original:{kind:'actual-local-scripted-operation',operation:id,elapsed_ms:performance.now()-start,
        value:value as JSONValue,mode:'scripted'}});
    return value;
  };
  // All three arms have the same callable tool pool and source. Only their local control route differs.
  const bytes=await runTool('numbers.read',async()=>{
    const raw=await readFile(numbersFile,{signal:context.signal});
    if(sha(raw)!==sourceSHA)throw Error('Packaged source changed during admission');
    return {text:raw.toString('utf8'),sha256:sha(raw),bytes:raw.length};
  });
  const values: unknown=JSON.parse(bytes.text);
  if(!Array.isArray(values)||values.length!==3||!values.every(v=>typeof v==='number'&&Number.isFinite(v)))
    throw Error('Unreadable numeric fixture');
  const decision = strategy==='adaptive' ? {kind:'scripted-local-guard',choice:'calculate',
    accepted_read_sha256:bytes.sha256,physical_provider_calls:0} : null;
  const stats=await runTool('numbers.statistics',()=>{
    const total=(values as number[]).reduce((sum,n)=>sum+n,0);
    return {count:values.length,total,mean:total/values.length};
  });
  const observation=run+':accepted-numbers';
  const final=await runTool('numbers.final',()=>({answer:q.operation==='total'?stats.total:stats.mean,
    operation:q.operation,source_sha256:bytes.sha256,provenance:[observation],mode:'scripted'}));
  const rawFinal=JSON.stringify(final);
  return {version:EVALUATION_VERSION,strategy,case_id:m.case_id,run_id:run,manifest_sha256:digest(m),
    input_sha256:m.input_sha256,sources:m.sources,capabilities:m.capabilities,models:m.models[strategy],
    implementation_sha256:m.implementation_sha256[strategy],budget:m.budget,deadline_ms:m.deadline_ms,
    mode:'scripted',outcome:'complete',error_kind:null,actual_tools:calls,
    accepted_reads:[{source_id:'numbers',sha256:bytes.sha256,observation_id:observation}],
    final:{raw_sha256:sha(rawFinal),original:{raw_utf8:rawFinal,new_model_call:false},provenance:[observation]},
    usage:null,measurements:{latency_ms:performance.now()-began,latency_scope:'local-arm-entry-through-scripted-final',
      cost:null,cost_unit:null,original:{kind:'actual-local-monotonic-timing',cost:'unmeasured'}},retry_count:0,
    original:{kind:'local-arithmetic-execution-receipt',control_route:strategy==='single'?'one capable code caller':
      strategy==='fixed'?'fixed read-calculate-final sequence':'scripted guard after current read',decision,
      source_file:'packaged examples/work-data/numbers.json',source_sha256:sourceSHA,
      operations_started:calls.length,provider_calls:0,native_model_calls:0}};
}

/** Separate scoring reads the actual public asset again; no runner conclusion or provider gold is trusted. */
async function independentScore(r: ArmReceipt, m: ConditionManifest): Promise<Grade> {
  const raw=await readFile(numbersFile);if(sha(raw)!==m.sources[0].sha256)throw Error('Scorer source changed');
  const numbers=JSON.parse(raw.toString('utf8')) as number[], operation=questions.get(m.case_id)!.operation;
  let total=0;for(const value of numbers)total+=value;
  const expected=operation==='total'?total:total/numbers.length;
  const original=r.final!.original as {raw_utf8:string};
  if(sha(original.raw_utf8)!==r.final!.raw_sha256)throw Error('Scorer final bytes changed');
  const answer=JSON.parse(original.raw_utf8) as {answer:number;source_sha256:string;provenance:string[]};
  return {quality:answer.answer===expected?1:0,evidence:answer.source_sha256===sha(raw)&&
    digest(answer.provenance)===digest(r.final!.provenance)?1:0,
    unnecessary_work:r.actual_tools.length===3?0:null,unnecessary_holds:r.outcome==='complete'?0:null,
    rework:null,re_explanation:null,original:{kind:'independent-synthetic-arithmetic-check',
      scoring_sha256:m.scoring_sha256,source_sha256:sha(raw),expected,actual:answer.answer,
      broader_quality:'not_evaluated',repeat_or_reexplanation:'not_measured'}};
}

const runners: StrategyRunners={single:(m,c)=>runLocal(m,c,'single'),fixed:(m,c)=>runLocal(m,c,'fixed'),
  adaptive:(m,c)=>runLocal(m,c,'adaptive')};
const parent=new AbortController();
const hooks={signal:parent.signal,scoreFinal:independentScore,
  attestReceipt:async()=>{throw Error('Scripted fixtures cannot request live attestation');}};
const design=await runPairedComparison(makeManifest('design-total-fixture','design','total'),runners,hooks);
const held=await runPairedComparison(makeManifest('held-out-mean-wiring-fixture','held-out','mean'),runners,hooks);
const profile=createPolicyProfile([design,held]);
const admission={run_id:randomUUID(),manifest:makeManifest('next-fresh-mean-fixture','held-out','mean')};
const claims=new Set<string>();
const use=await consumePolicyProfile(profile,admission,runners,{
  verifyProfile:async p=>p.digest===profile.digest,
  authorizeAdmission:async a=>a.run_id===admission.run_id && a.manifest.deadline_ms===admission.manifest.deadline_ms &&
    !parent.signal.aborted && Date.now()<a.manifest.deadline_ms && sha(await readFile(numbersFile))===sourceSHA,
  reserveFreshUse:async a=>{if(claims.has(a.run_id))return false;claims.add(a.run_id);return true;},
  attestReceipt:async()=>{throw Error('There is no live runtime record in this offline example');},
  readCurrentUse:async()=>null,
},{signal:parent.signal});
const output={example:'synthetic-number-statistics-offline',dataset:{label:'packaged SYNTHETIC fixture, not unfamiliar real evaluation',
  values:[120,240,360],sha256:sourceSHA},requests:Object.fromEntries(questions),design,held_out:held,profile,next_fresh_use:use,
  qualification:{comparison:'diagnostic_only',real_LLM_or_Jev_quality:'not_evaluated',adaptive_superiority:'not_evaluated',
    split:'separate request/case IDs for wiring; same known synthetic asset, not a held-out competence study',
    local_io:'actual packaged-file reads and arithmetic',cost:null,rework:null,re_explanation:null,
    profile_choice:'fixed/no-Jev because no qualified live gain',current_joint_proof:'unavailable',
    claim_scope:'in-process create-only offline claim, not durable-host qualification',provider_calls:0,native_model_calls:0,retries:0}};
if(process.argv.length>3)throw Error('Usage: work-comparison.mjs [NEW_RESULT_JSON]');
if(process.argv[2])await writeFile(resolve(process.argv[2]),JSON.stringify(output,null,2)+'\n',{flag:'wx'});
else process.stdout.write(JSON.stringify(output,null,2)+'\n');
