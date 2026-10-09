/** Versioned finite-plan entry. The host, not input/model text, owns providers and ACLs. */
import { evaluate, validateInput, Fault } from './gateway.mts';
import type { Env, Sender } from './gateway.mts';
import { QUESTION_SETS } from './questions.mts';
import { requestFor, inspectLegacyReply, JEV_CAPABILITY } from './fabric-gateway.mts';
import { runPlan, canonical, DecisionError } from './decision-fabric.mts';
import type { Plan, Step, Provider, TraceStore, CompletionRule, RunResult } from './decision-fabric.mts';

const ID=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const TOPOLOGIES=['single','cascade','cross-check','compose','escalate'] as const;
const COMPLETION=['return_values','hold_on_unknown','need_evidence_on_unknown'] as const;
export const PUBLIC_TOOL_NAME='decision_run_v1';
function invalid():never{throw new Fault('INVALID_FINITE_PLAN',400);}
function record(v:unknown):v is Record<string,any>{return v!==null&&typeof v==='object'&&!Array.isArray(v)&&[Object.prototype,null].includes(Object.getPrototypeOf(v));}
function keys(v:Record<string,any>,allowed:readonly string[]){if(Object.keys(v).some(k=>!allowed.includes(k)))invalid();}
function refs(v:unknown,seen:Set<string>):string[]{
  if(v===undefined)return [];
  if(!Array.isArray(v)||v.length>8||new Set(v).size!==v.length||v.some(id=>typeof id!=='string'||!seen.has(id)))invalid();
  return [...v];
}
/** No arbitrary questions, endpoints, credentials, grant scopes, or stored-record reads. */
export function compilePublicPlan(input:unknown):Plan {
  if(!record(input))invalid();
  keys(input,['version','topology','steps','max_calls','timeout_ms']);
  if(input.version!==1||!TOPOLOGIES.includes(input.topology)||!Array.isArray(input.steps)||
      input.steps.length<1||input.steps.length>8)invalid();
  if(Buffer.byteLength(canonical(input))>128*1024)invalid();
  const maxCalls=input.max_calls??input.steps.length, timeout=input.timeout_ms??18000;
  if(!Number.isInteger(maxCalls)||maxCalls<1||maxCalls>8||!Number.isInteger(timeout)||timeout<1||timeout>18000)invalid();
  const seen=new Set<string>();
  const steps:Step[]=input.steps.map((raw:unknown)=>{
    if(!record(raw))invalid();
    keys(raw,['id','question_set','state','after','reads','completion']);
    if(typeof raw.id!=='string'||!ID.test(raw.id)||seen.has(raw.id)||!Object.hasOwn(raw,'state'))invalid();
    // Reuse the original fixed question version and its validator, not copied question bodies.
    let request:ReturnType<typeof requestFor>;
    try{request=requestFor(validateInput({question_set:raw.question_set,state:raw.state}));}catch{invalid();}
    const after=refs(raw.after,seen),reads=refs(raw.reads,seen);
    const policy=raw.completion??'return_values';
    if(!COMPLETION.includes(policy))invalid();
    const completion:Record<string,CompletionRule>=Object.create(null);
    for(const [id,q] of Object.entries(request.questions)){
      if(q.type==='choice'){
        const accept=Object.keys(q.criteria).filter(k=>policy==='return_values'||k!=='unknown');
        if(!accept.length)invalid();
        completion[id]={kind:'choice',accept,otherwise:policy==='need_evidence_on_unknown'?'need_evidence':'hold'};
      }else if(q.type==='noul'){
        // A probability of 0.5 is valid data. Do not turn it into a universal retry threshold.
        completion[id]={kind:'noul',accept:[[0,1]],otherwise:'hold'};
      }else invalid(); // No current fixed gateway question set exposes native ordinal Score.
    }
    seen.add(raw.id);
    return {id:raw.id,provider:'jev',request,scope:{readers:['jev']},
      ...(after.length?{after}:{}),...(reads.length?{reads}:{}),completion};
  });
  if(input.topology==='single'&&steps.length!==1)invalid();
  if(input.topology==='compose'&&steps.length<2)invalid();
  if(input.topology!=='compose'&&steps.some(s=>s.reads?.length))invalid();
  if(input.topology==='cross-check'&&(steps.length<2||steps.some(s=>s.after?.length||s.reads?.length)||
      steps.some(s=>canonical(s.request)!==canonical(steps[0].request))))invalid();
  return {topology:input.topology,steps,primary:steps[0].id,policy_id:'public-fixed-question-plan-v1',max_calls:maxCalls,timeout_ms:timeout};
}
export function publicPlanDefinition(){
  return {name:PUBLIC_TOOL_NAME,title:'Run a bounded Jev decision plan',
    description:'Evaluate a caller-specified finite plan using the four existing Jev question sets. Only TypeSafe Jev is connected. Repeated steps using Jev are not independent providers. Compose forwards only explicitly named prior results. return_values returns native probabilities, including 0.5 and unknown; it does not certify truth. hold_on_unknown and need_evidence_on_unknown react only to a literal unknown Choice. No automatic tool dispatch, data acquisition, Apply, or background execution. Each executed step sends its supplied state to TypeSafe and may incur a charge. Do not pass secrets or unnecessary private data.',
    inputSchema:{type:'object',additionalProperties:false,required:['version','topology','steps'],properties:{
      version:{const:1},topology:{type:'string',enum:[...TOPOLOGIES]},max_calls:{type:'integer',minimum:1,maximum:8},
      timeout_ms:{type:'integer',minimum:1,maximum:18000},steps:{type:'array',minItems:1,maxItems:8,items:{
        type:'object',additionalProperties:false,required:['id','question_set','state'],properties:{
          id:{type:'string',pattern:ID.source},question_set:{type:'string',enum:Object.keys(QUESTION_SETS)},state:{type:'object'},
          after:{type:'array',uniqueItems:true,items:{type:'string'}},reads:{type:'array',uniqueItems:true,items:{type:'string'}},
          completion:{type:'string',enum:[...COMPLETION],default:'return_values'}
        }
      }}
    }},annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:true}};
}
export function publicPlanEnabled(get:Env):boolean {
  return get('JEV_FABRIC_ENABLED')==='true'&&get('JEV_FABRIC_PLAN_ENABLED')==='true';
}
function faultStatus(e:unknown):ConstructorParameters<typeof DecisionError>[0]{
  if(!(e instanceof Fault))return 'error';
  if(e.status===429)return 'rate_limited';if(e.status===401||e.status===403)return 'unauthorized';
  if(e.code==='INVALID_PROVIDER_RESPONSE')return 'invalid';
  if(e.status===504)return 'timeout';if(e.status===503)return 'unavailable';return 'error';
}
export async function runPublicPlan(input:unknown,get:Env,store:TraceStore,send:Sender,principal:string,
    options:{signal?:AbortSignal;beforeCall:()=>Promise<void>;trace_timeout_ms?:number}):Promise<RunResult>{
  if(!publicPlanEnabled(get))throw new Fault('FINITE_PLAN_DISABLED',503);
  const plan=compilePublicPlan(input);
  const provider:Provider={capability:JEV_CAPABILITY,invoke:async({request,signal})=>{
    try{
      if(signal.aborted)throw new DecisionError('cancelled');
      // Rate-limit every attempted underlying evaluation, not merely the outer tool call.
      await options.beforeCall();
      if(signal.aborted)throw new DecisionError('cancelled');
      const sender:Sender=(url,init)=>send(url,{...init,signal:init?.signal?AbortSignal.any([signal,init.signal]):signal});
      const value=await evaluate({question_set:request.question_set,state:request.state},get,sender);
      inspectLegacyReply({question_set:request.question_set,state:request.state},value);
      return {model:value.resolved_model,answers:value.answers,usage:value.usage};
    }catch(e){if(e instanceof DecisionError)throw e;throw new DecisionError(faultStatus(e));}
  }};
  return runPlan(plan,{providers:[provider],store,principal,signal:options.signal,
    trace_timeout_ms:options.trace_timeout_ms,evidence_mode:send===globalThis.fetch?'live_transport':'injected_transport'});
}
