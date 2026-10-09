/** Existing OAuth application -> bounded fabric -> unchanged Jev evaluation. */
import {evaluate, validateInput, validateAnswers, sha, Fault} from './gateway.mts';
import type {Env, Sender} from './gateway.mts';
import {QUESTION_SETS} from './questions.mts';
import {runPlan, normalize, DecisionError, pendingOpenAIDecisions} from './decision-fabric.mts';
import type {Provider, Capability, Outcome, RequestData, TraceStore, RunResult} from './decision-fabric.mts';

export const JEV_CAPABILITY: Capability = Object.freeze({id:'jev',mode:'primary',verified:true,
  kinds:['choice','noul'] as const,modalities:['text'] as const,evidence:'existing-gateway-question-contract-v0'});
export type LegacyResult = Awaited<ReturnType<typeof evaluate>>;
export type FabricCall = {value:LegacyResult; headers:Record<string,string>; run:RunResult};

export function requestFor(input:unknown):RequestData {
  const v=validateInput(input);
  // Same question bytes and state hashing as the existing gateway; no client-supplied policy.
  return {question_set:v.question_set,questions:structuredClone(QUESTION_SETS[v.question_set]),
    state:structuredClone(v.state),modalities:['text'],revision:sha(v.state)};
}
/** Also accepts captured *real* tool replies, without replaying a paid request. */
export function inspectLegacyReply(input:unknown,raw:unknown):Outcome {
  const r=requestFor(input);
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Fault('INVALID_PROVIDER_RESPONSE',502);
  const v=raw as Record<string,any>;
  if(v.provider!=='typesafe-direct'||v.question_set!==r.question_set||
      v.state_sha256!==sha(r.state)||v.question_set_sha256!==sha(r.questions)||
      v.authority!=='advisory_only'||v.automatic_apply!==false)throw new Fault('INVALID_PROVIDER_RESPONSE',502);
  validateAnswers(v,r.questions);
  const o=normalize({model:v.resolved_model,answers:v.answers,usage:v.usage},JEV_CAPABILITY,r,
    typeof v.latency_ms==='number'?v.latency_ms:0);
  if(o.status!=='answered')throw new Fault('INVALID_PROVIDER_RESPONSE',502);
  return o;
}
function statusOf(error:unknown):ConstructorParameters<typeof DecisionError>[0] {
  if(!(error instanceof Fault))return 'error';
  if(error.status===429)return 'rate_limited';
  if(error.status===401||error.status===403)return 'unauthorized';
  if(error.code==='INVALID_PROVIDER_RESPONSE')return 'invalid';
  if(error.status===503)return 'unavailable';
  if(error.status===504)return 'timeout';
  return 'error';
}
export type FabricOptions = {signal?:AbortSignal; shadow?:Provider; shadowAuthorized?:boolean;
  /** Trusted application setup, not fields accepted by decision_evaluate. */
  timeout_ms?:number; trace_timeout_ms?:number; comparison_mode?:'synchronous'|'primary-only'};
export async function evaluateWithTrace(input:unknown,get:Env,store:TraceStore,
  send:Sender,principal:string,options:FabricOptions={}):Promise<FabricCall> {
  const r=requestFor(input);
  let legacy:LegacyResult|undefined, originalError:unknown;
  const primary:Provider={capability:JEV_CAPABILITY,invoke:async({request,signal})=>{
    const cancellable:Sender=(url,init)=>send(url,{...init,
      signal:init?.signal?AbortSignal.any([signal,init.signal]):signal});
    try {
      legacy=await evaluate({question_set:request.question_set,state:request.state},get,cancellable);
      inspectLegacyReply({question_set:request.question_set,state:request.state},legacy);
      return {model:legacy.resolved_model,answers:legacy.answers,usage:legacy.usage};
    } catch(e){originalError=e;throw new DecisionError(statusOf(e));}
  }};
  const shadow=options.shadow??pendingOpenAIDecisions();
  if(shadow.capability.mode!=='shadow'||shadow.capability.id==='jev')throw new Fault('INVALID_SHADOW_CONFIGURATION',503);
  const readers=options.shadowAuthorized?['jev',shadow.capability.id]:['jev'];
  if(options.comparison_mode!==undefined&&!['synchronous','primary-only'].includes(options.comparison_mode))throw new Fault('INVALID_COMPARISON_MODE',400);
  const compare=options.comparison_mode!=='primary-only';
  const steps=compare?[
    {id:'primary',provider:'jev',request:r,scope:{readers}},
    {id:'shadow',provider:shadow.capability.id,request:r,scope:{readers}},
  ]:[{id:'primary',provider:'jev',request:r,scope:{readers:['jev']}}];
  const run=await runPlan({topology:compare?'cross-check':'single',primary:'primary',
    policy_id:compare?'jev-primary-shadow-v1':'jev-primary-only-v1',max_calls:compare?2:1,
    timeout_ms:options.timeout_ms??18000,steps
  },{providers:[primary,shadow],store,principal,evidence_mode:send===globalThis.fetch?'live_transport':'injected_transport',signal:options.signal,trace_timeout_ms:options.trace_timeout_ms});
  // Preserve the old error and result contracts. No automatic retry on trace/shadow failure.
  if(options.signal?.aborted)throw new Fault('PROVIDER_NETWORK_ABORTED',504);
  if(originalError)throw originalError;
  if(!legacy)throw new Fault(run.status==='timeout'?'PROVIDER_NETWORK_TIMEOUT':'FABRIC_PRIMARY_UNAVAILABLE',504);
  if(run.outcomes.primary.status!=='answered')throw new Fault('INVALID_PROVIDER_RESPONSE',502);
  return {value:legacy,run,headers:{'x-jev-trace-id':run.id,
    'x-jev-trace-status':run.trace.persisted?'stored':'incomplete',
    'x-jev-shadow-status':run.outcomes.shadow?.status??'not_requested'}};
}
