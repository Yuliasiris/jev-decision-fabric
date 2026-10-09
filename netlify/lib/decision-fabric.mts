/** Bounded in-request decision composition. Not a scheduler or an authority service. */
import { createHash, randomUUID } from 'node:crypto';

export type Kind = 'choice' | 'noul' | 'score';
export type Status = 'answered' | 'unsupported' | 'unavailable' | 'unauthorized' |
  'invalid' | 'timeout' | 'cancelled' | 'stale' | 'rate_limited' | 'error' | 'budget_exhausted' | 'skipped';
export type Question =
  | {type: 'choice'; instructions: string; criteria: Record<string, string | null>}
  | {type: 'noul'; instructions: string; criteria?: {true?: string; false?: string}}
  | {type: 'score'; instructions: string; min: number; max: number; rubric: string}
  | {type: 'score'; instructions: string; criteria: readonly string[]};
export type Answer = {kind: Kind; value: string | number;
  probabilities?: Record<string, number>; confidence?: number;
  /** Native ordinal meanings; never reconstructed from the score alone. */
  legend?: Record<string, string>};
export type Capability = Readonly<{id: string; mode: 'primary' | 'shadow' | 'off';
  verified: boolean; kinds: readonly Kind[]; modalities: readonly ('text' | 'image')[];
  evidence: string | null}>;
export type RequestData = Readonly<{question_set: string; questions: Record<string, Question>;
  state: unknown; modalities: readonly ('text' | 'image')[]; revision: string}>;
/** Supplied by the trusted host, never deserialized from state or model output. */
export type Scope = Readonly<{readers: readonly string[]}>;
export type NativeReply = {model?: string | null; answers: Record<string, unknown>;
  usage?: Record<string, number> | null};
export type Outcome = Readonly<{provider: string; mode: Capability['mode']; status: Status;
  model: string | null; question_set: string; question_hash: string; state_hash: string;
  revision: string; answers: Record<string, Answer> | null; usage: Record<string, number> | null;
  response_hash: string | null; elapsed_ms: number; authority: 'advisory_only'; automatic_apply: false}>;
export type Invocation = Readonly<{request: RequestData; signal: AbortSignal;
  upstream: Readonly<Record<string, Outcome>>}>;
export type Provider = Readonly<{capability: Capability; invoke: (input: Invocation) => Promise<unknown>}>;
export type Followup = 'continue' | 'need_evidence' | 'reframe' | 'hold';
export type CompletionRule =
  | {kind:'choice'; accept:readonly string[]; otherwise:Followup; confidence_at_least?:number; margin_at_least?:number}
  | {kind:'noul'|'score'; accept:readonly (readonly [number,number])[]; otherwise:Followup};
export type AssessmentAction = 'accept' | Followup | 'mixed';
export type Assessment = Readonly<{action:AssessmentAction;
  /** Preserve each question's requested follow-up; do not impose a universal priority. */
  by_question:Readonly<Record<string,'accept'|Followup>>; unmet_questions:readonly string[];
  basis:'explicit_question_policy'|'legacy_value_policy'}>;
export type Step = Readonly<{id: string; provider: string; request: RequestData; scope: Scope;
  /** Ordering dependencies do not convey access to their results. */
  after?: readonly string[]; reads?: readonly string[];
  /** Optional host-validated completion rule, separate from a model's confidence. */
  completion?: Readonly<Record<string,CompletionRule>>}>;
export type Topology = 'single' | 'cascade' | 'cross-check' | 'compose' | 'escalate';
export type Plan = Readonly<{topology: Topology; steps: readonly Step[]; primary: string;
  policy_id: string; max_calls: number; timeout_ms: number;
  /** Per-question threshold for native confidence. Missing confidence is not imputed. */
  required_confidence?: Readonly<Record<string, number>>;
  noul_tolerance?: number}>;
export type TraceStore = {create: (key: string, value: unknown) => Promise<boolean>};
export type ReadableTraceStore = TraceStore & {get:(key:string)=>Promise<any>};
export type RunResult = Readonly<{id: string; topology: Topology;
  status: Status | 'unresolved' | 'disagreement' | 'escalation_needed'; selected: Outcome | null;
  outcomes: Readonly<Record<string, Outcome>>; assessments:Readonly<Record<string,Assessment>>;
  /** Singular convenience only; null when several distinct follow-ups remain. */
  next_action:Followup|null; next_actions:readonly Followup[];
  comparison: 'not_run' | 'agree' | 'disagree' | 'incomparable';
  trace: {persisted: boolean; records: number}; calls_started: number;
  authority: 'advisory_only'; automatic_apply: false}>;
export type Host = {providers: readonly Provider[]; store: TraceStore; principal: string;
  evidence_mode?: 'live_transport' | 'injected_transport' | 'recorded_response' | 'unverified';
  signal?: AbortSignal; isCurrent?: (revision: string) => boolean; trace_timeout_ms?: number};
const STATUSES = new Set<Status>(['answered','unsupported','unavailable','unauthorized','invalid',
  'timeout','cancelled','stale','rate_limited','error','budget_exhausted','skipped']);
const KINDS = new Set<Kind>(['choice','noul','score']);
const TOPOLOGIES = new Set<Topology>(['single','cascade','cross-check','compose','escalate']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
export class DecisionError extends Error {
  status: Exclude<Status, 'answered'>;
  constructor(status: Exclude<Status, 'answered'>) { super(status); this.status = status; }
}
function object(v: unknown): v is Record<string, any> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(v));
}
function fail(): never { throw new DecisionError('invalid'); }
function validID(v: unknown): v is string { return typeof v === 'string' && ID.test(v); }
function unit(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1; }
function exact(v: Record<string, any>, keys: readonly string[]) {
  if (Object.keys(v).some(k => !keys.includes(k))) fail();
}
export function canonical(v: unknown, depth = 0): string {
  if (depth > 40) fail();
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) fail(); return JSON.stringify(v); }
  if (Array.isArray(v)) return '[' + Array.from(v, x => canonical(x, depth + 1)).join(',') + ']';
  if (object(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k)+':'+canonical(v[k], depth+1)).join(',') + '}';
  return fail();
}
export function digest(v: unknown): string { return createHash('sha256').update(canonical(v)).digest('hex'); }
function freeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') { for (const x of Object.values(v)) freeze(x); Object.freeze(v); }
  return v;
}
function validateRequest(r: RequestData) {
  if (!object(r)) fail();
  exact(r, ['question_set','questions','state','modalities','revision']);
  if (!validID(r.question_set) || typeof r.revision !== 'string' || r.revision.length > 256 ||
      !Array.isArray(r.modalities) || !r.modalities.length ||
      r.modalities.some(m => !['text','image'].includes(m)) || !object(r.questions)) fail();
  const ids = Object.keys(r.questions);
  if (!ids.length || ids.length > 64 || ids.some(id => !validID(id))) fail();
  for (const q of Object.values(r.questions)) {
    if (!object(q) || !KINDS.has(q.type) || typeof q.instructions !== 'string' || q.instructions.length > 16000) fail();
    if (q.type === 'choice') {
      exact(q,['type','instructions','criteria']);
      if (!object(q.criteria) || Object.keys(q.criteria).length < 2 || Object.keys(q.criteria).length > 64 ||
          Object.entries(q.criteria).some(([k,v]) => !validID(k) || !(typeof v === 'string' || v === null))) fail();
    } else if (q.type === 'noul') {
      exact(q,['type','instructions','criteria']);
      if (q.criteria !== undefined && (!object(q.criteria) || Object.entries(q.criteria).some(([k,v]) =>
          !['true','false'].includes(k) || typeof v !== 'string'))) fail();
    } else {
      if ('criteria' in q) {
        exact(q,['type','instructions','criteria']);
        if (!Array.isArray(q.criteria)||q.criteria.length<2||q.criteria.length>64||
            q.criteria.some((v:unknown)=>typeof v!=='string'||!v.trim()||v.length>16000))fail();
      } else {
        exact(q,['type','instructions','min','max','rubric']);
        if (!Number.isFinite(q.min) || !Number.isFinite(q.max) || q.min >= q.max || typeof q.rubric !== 'string') fail();
      }
    }
  }
  if (Buffer.byteLength(canonical(r)) > 256*1024) fail();
}
function validateCapability(c: Capability) {
  if (!object(c) || !validID(c.id) || !['primary','shadow','off'].includes(c.mode) ||
      typeof c.verified !== 'boolean' || !Array.isArray(c.kinds) || c.kinds.some(k => !KINDS.has(k)) ||
      !Array.isArray(c.modalities) || c.modalities.some(m => !['text','image'].includes(m)) ||
      !(c.evidence === null || (typeof c.evidence === 'string' && c.evidence.length <= 256)) ||
      (c.verified && !c.evidence)) fail();
}
function usageOf(raw: unknown): Record<string, number> | null {
  if (raw === undefined || raw === null) return null;
  if (!object(raw) || Object.keys(raw).length > 16 || Object.entries(raw).some(([k,v]) =>
      !validID(k) || typeof v !== 'number' || !Number.isFinite(v) || v < 0)) fail();
  return {...raw};
}
/** Normalize only reported values. Provider identity and status never come from model text. */
export function normalize(raw: unknown, c: Capability, r: RequestData, elapsed = 0): Outcome {
  validateCapability(c); validateRequest(r);
  const base = outcome(c,r,'invalid',elapsed);
  try {
    if (!object(raw) || !object(raw.answers) || (raw.status !== undefined && raw.status !== 'answered')) fail();
    if (Buffer.byteLength(canonical(raw)) > 512*1024) fail();
    if (Object.keys(raw.answers).length !== Object.keys(r.questions).length) fail();
    if (raw.model !== undefined && raw.model !== null && (typeof raw.model !== 'string' || !validID(raw.model))) fail();
    const answers: Record<string,Answer> = Object.create(null);
    for (const [id,q] of Object.entries(r.questions)) {
      const a = raw.answers[id];
      if (!object(a)) fail();
      let value: string | number;
      const ordinal=q.type==='score' && 'criteria' in q;
      const fields = q.type === 'choice' ? ['type','choice','probabilities','confidence'] :
        q.type === 'noul' ? ['type','noul','confidence'] : ordinal ?
        ['type','score','confidence','legend','probabilities'] : ['type','score','confidence'];
      exact(a, fields);
      if(a.type!==undefined && a.type!==q.type)fail();
      if (q.type === 'choice') { if (typeof a.choice !== 'string' || !Object.hasOwn(q.criteria,a.choice)) fail(); value = a.choice; }
      else if (q.type === 'noul') { if (!unit(a.noul)) fail(); value = a.noul; }
      else {
        const min='criteria' in q?0:q.min, max='criteria' in q?q.criteria.length-1:q.max;
        if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < min || a.score > max) fail();
        value = a.score;
      }
      const answer: Answer = {kind:q.type,value};
      if(q.type==='score' && 'criteria' in q){
        const keys=q.criteria.map((_,i)=>String(i));
        if(!object(a.legend)||!object(a.probabilities)||
            Object.keys(a.legend).length!==keys.length||Object.keys(a.probabilities).length!==keys.length||
            keys.some((k,i)=>a.legend[k]!==q.criteria[i]||!unit(a.probabilities[k])))fail();
        // SystemOne rounds each probability and its native expectation to four decimals.
        // Bound their independent rounding errors, rather than normalize or invent a value.
        const sum=keys.reduce((v,k)=>v+a.probabilities[k],0);
        const expected=keys.reduce((v,k,i)=>v+i*a.probabilities[k],0);
        const massError=0.00005*keys.length+1e-9;
        const expectationError=0.00005*(keys.length*(keys.length-1)/2+1)+1e-9;
        if(Math.abs(sum-1)>massError||Math.abs(expected-Number(value))>expectationError)fail();
        answer.legend={...a.legend};answer.probabilities={...a.probabilities};
      }
      if (a.confidence !== undefined) { if (!unit(a.confidence)) fail(); answer.confidence = a.confidence; }
      if (a.probabilities !== undefined && !ordinal) {
        if (q.type !== 'choice' || !object(a.probabilities)) fail();
        const keys = Object.keys(q.criteria);
        if (Object.keys(a.probabilities).length !== keys.length || keys.some(k => !unit(a.probabilities[k])) ||
            Math.abs(keys.reduce((s,k)=>s+a.probabilities[k],0)-1) > .015) fail();
        answer.probabilities = {...a.probabilities};
      }
      answers[id] = answer;
    }
    return freeze({...base,status:'answered',model:raw.model ?? null,answers,
      response_hash:digest(raw),usage:usageOf(raw.usage)});
  } catch { return base; }
}
function outcome(c: Capability, r: RequestData, status: Status, elapsed = 0): Outcome {
  if (!STATUSES.has(status)) fail();
  return freeze({provider:c.id,mode:c.mode,status,model:null,question_set:r.question_set,
    question_hash:digest(r.questions),state_hash:digest(r.state),revision:r.revision,
    answers:null,usage:null,response_hash:null,elapsed_ms:Math.round(elapsed*100)/100,
    authority:'advisory_only',automatic_apply:false});
}
const FOLLOWUPS = new Set<Followup>(['continue','need_evidence','reframe','hold']);
function validateCompletion(s:Pick<Step,'request'|'completion'>){
  if(s.completion===undefined)return;
  if(!object(s.completion)||!Object.keys(s.completion).length)fail();
  for(const [id,rule] of Object.entries(s.completion)){
    const q=s.request.questions[id];
    if(!q||!object(rule)||rule.kind!==q.type||!FOLLOWUPS.has(rule.otherwise)||
        !Array.isArray(rule.accept)||!rule.accept.length||rule.accept.length>64)fail();
    if(rule.kind==='choice'){
      exact(rule,['kind','accept','otherwise','confidence_at_least','margin_at_least']);
      if(q.type!=='choice'||new Set(rule.accept).size!==rule.accept.length||
         rule.accept.some((v:unknown)=>typeof v!=='string'||!Object.hasOwn(q.criteria,v))||
         (rule.confidence_at_least!==undefined&&!unit(rule.confidence_at_least))||
         (rule.margin_at_least!==undefined&&!unit(rule.margin_at_least)))fail();
    }else{
      exact(rule,['kind','accept','otherwise']);
      const min=q.type==='score'&&'min' in q?q.min:0;
      const max=q.type==='score'?('criteria' in q?q.criteria.length-1:q.max):1;
      if(rule.accept.some((v:unknown)=>!Array.isArray(v)||v.length!==2||
          v.some(x=>typeof x!=='number'||!Number.isFinite(x))||v[0]>v[1]||v[0]<min||v[1]>max))fail();
    }
  }
}
function assess(o:Outcome,p:Plan,s:Step):Assessment {
  const basis=s.completion?'explicit_question_policy':'legacy_value_policy';
  if(o.status!=='answered'||!o.answers)return {action:'continue',by_question:{},unmet_questions:[],basis};
  const byQuestion:Record<string,'accept'|Followup>=Object.create(null);const unmet:string[]=[];
  for(const id of Object.keys(p.required_confidence??{}))if(!Object.hasOwn(o.answers,id)){
    byQuestion[id]='continue';unmet.push(id);
  }
  for(const [id,a] of Object.entries(o.answers)){
    const rule=s.completion?.[id];let valid=a.value!=='unknown';
    if(rule){
      if(rule.kind==='choice'){
        valid=typeof a.value==='string'&&rule.accept.includes(a.value);
        if(rule.confidence_at_least!==undefined)valid=valid&&a.confidence!==undefined&&a.confidence>=rule.confidence_at_least;
        if(rule.margin_at_least!==undefined){
          if(!a.probabilities)valid=false;
          else {const selected=a.probabilities[String(a.value)];const others=Object.entries(a.probabilities).filter(([key])=>key!==a.value).map(([,value])=>value);valid=valid&&selected!==undefined&&others.length>0&&selected-Math.max(...others)>=rule.margin_at_least;}
        }
      }else valid=typeof a.value==='number'&&rule.accept.some(([lo,hi])=>Number(a.value)>=lo&&Number(a.value)<=hi);
    }
    if(Object.hasOwn(p.required_confidence??{},id))valid=valid&&a.confidence!==undefined&&a.confidence>=p.required_confidence![id];
    const action:'accept'|Followup=valid?'accept':(rule?.otherwise??'continue');
    byQuestion[id]=action;if(!valid)unmet.push(id);
  }
  const actions=[...new Set(Object.values(byQuestion).filter((x):x is Followup=>x!=='accept'))];
  const action:AssessmentAction=actions.length===0?'accept':actions.length===1?actions[0]:'mixed';
  return {action,by_question:byQuestion,unmet_questions:[...new Set(unmet)],basis};
}
function comparable(a: Outcome,b: Outcome): boolean {
  return a.status === 'answered' && b.status === 'answered' && a.question_hash === b.question_hash &&
    a.state_hash === b.state_hash && a.revision === b.revision;
}
function agrees(a: Outcome,b: Outcome,p: Plan): boolean {
  return comparable(a,b) && Object.entries(a.answers!).every(([id,x]) => {
    const y=b.answers![id];
    return x.kind === y.kind && (x.kind === 'noul' ? Math.abs(Number(x.value)-Number(y.value)) <= (p.noul_tolerance ?? 0) : x.value === y.value);
  });
}
function validatePlan(p: Plan, providers: Map<string,Provider>) {
  if (!object(p)) fail();
  exact(p,['topology','steps','primary','policy_id','max_calls','timeout_ms','required_confidence','noul_tolerance']);
  if (!TOPOLOGIES.has(p.topology) || !validID(p.policy_id) || !validID(p.primary) ||
      !Number.isInteger(p.max_calls) || p.max_calls<1 || p.max_calls>8 ||
      !Number.isInteger(p.timeout_ms) || p.timeout_ms<1 || p.timeout_ms>60000 ||
      !Array.isArray(p.steps) || !p.steps.length || p.steps.length>8) fail();
  if (p.required_confidence !== undefined && (!object(p.required_confidence) ||
      Object.entries(p.required_confidence).some(([k,v])=>!validID(k)||!unit(v)))) fail();
  if (p.noul_tolerance !== undefined && !unit(p.noul_tolerance)) fail();
  const seen = new Set<string>();
  for (const s of p.steps) {
    if (!object(s)) fail(); exact(s,['id','provider','request','scope','after','reads','completion']);
    if (!validID(s.id)||seen.has(s.id)||!providers.has(s.provider)||!object(s.scope)||
        !Array.isArray(s.scope.readers)||s.scope.readers.some(x=>!validID(x))) fail();
    exact(s.scope,['readers']); validateRequest(s.request); validateCompletion({request:s.request,completion:s.completion});
    for (const refs of [s.after ?? [],s.reads ?? []]) {
      if (!Array.isArray(refs)||new Set(refs).size!==refs.length||refs.some(id=>!seen.has(id))) fail();
    }
    seen.add(s.id);
  }
  const primaries = p.steps.filter(s=>providers.get(s.provider)!.capability.mode==='primary');
  if (p.steps[0].id!==p.primary || !seen.has(p.primary) || !primaries.length || primaries[0].id!==p.primary) fail();
  if(p.topology!=='cross-check'){let shadowSeen=false;for(const s of p.steps){if(providers.get(s.provider)!.capability.mode!=='primary')shadowSeen=true;else if(shadowSeen)fail();}}
  if (p.topology==='single' && primaries.length!==1) fail();
  if (p.topology==='cross-check') {
    if (p.steps.length<2 || p.steps.some(s=>(s.reads?.length??0)||(s.after?.length??0))) fail();
    const first = p.steps[0].request;
    if (p.steps.some(s=>digest(s.request)!==digest(first))) fail();
  }
  if (p.topology!=='compose' && p.steps.some(s=>s.reads?.length)) fail();
  if (p.topology==='compose' && p.steps.length<2) fail();
  // Shadow results may be inspected, but must never become primary input.
  for (const s of p.steps) if (providers.get(s.provider)!.capability.mode==='primary' &&
      s.reads?.some((id:string)=>providers.get(p.steps.find(x=>x.id===id)!.provider)!.capability.mode!=='primary')) fail();
}
async function limited<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DecisionError('cancelled');
  return await new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(new DecisionError('cancelled'));
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve().then(()=>{if(signal.aborted)throw new DecisionError('cancelled');return work();}).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

/** Every run is finite and owned by its invoking host; no automatic retries or dispatch. */
export async function runPlan(input: Plan, host: Host): Promise<RunResult> {
  if(typeof host.principal!=='string'||!host.principal||host.principal.length>256||
    !['live_transport','injected_transport','recorded_response','unverified'].includes(host.evidence_mode??'unverified'))fail();
  const providers=new Map<string,Provider>();
  for(const provider of host.providers){
    validateCapability(provider.capability);
    if(providers.has(provider.capability.id)||typeof provider.invoke!=='function') fail();
    providers.set(provider.capability.id,{...provider,capability:freeze(structuredClone(provider.capability))});
  }
  validatePlan(input,providers);
  const plan=freeze(structuredClone(input));
  const id=randomUUID(), namespace='fabric/'+digest(host.principal)+'/'+id;
  const controller=new AbortController();
  const onCancel=()=>controller.abort();
  if(host.signal?.aborted) controller.abort();
  host.signal?.addEventListener('abort',onCancel,{once:true});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;controller.abort();},plan.timeout_ms);
  const outcomes:Record<string,Outcome>=Object.create(null);
  const assessments:Record<string,Assessment>=Object.create(null);
  const readers:Record<string,Set<string>>=Object.create(null);
  let calls=0,reservations=0,seq=0,records=0,traceOK=true;
  const journal=async(event:Record<string,unknown>)=>{
    const n=seq++;
    const stop=new AbortController();
    const t=setTimeout(()=>stop.abort(),Math.min(2000,Math.max(1,host.trace_timeout_ms??500)));
    try {
      const saved=await limited(()=>host.store.create(namespace+'/'+String(n).padStart(3,'0'),
        {schema:'jev.fabric.trace.v1',run_id:id,seq:n,time:new Date().toISOString(),...event}),stop.signal);
      if(!saved) traceOK=false; else records++;
    } catch {traceOK=false;} finally {clearTimeout(t);}
  };
  const execute=async(s:Step,skip=false):Promise<Outcome>=>{
    const provider=providers.get(s.provider)!,c=provider.capability;
    readers[s.id]=new Set(s.scope.readers);
    const upstream:Record<string,Outcome>=Object.create(null);
    for(const dependency of s.reads??[]){
      for(const r of [...readers[s.id]]) if(!readers[dependency].has(r))readers[s.id].delete(r);
      upstream[dependency]=outcomes[dependency];
    }
    const r=freeze({...s.request,state:Object.keys(upstream).length?
      {observation:s.request.state,prior_results:upstream}:s.request.state});
    let status:Status|null=skip?'skipped':null;
    if(!status && controller.signal.aborted)status=timedOut?'timeout':'cancelled';
    if(!status && host.isCurrent && !host.isCurrent(r.revision))status='stale';
    if(!status && (c.mode==='off'||!c.verified))status='unavailable';
    if(!status && !readers[s.id].has(c.id))status='unauthorized';
    if(!status && (s.reads??[]).some(d=>outcomes[d].status!=='answered'))status='skipped';
    if(!status && (Object.values(r.questions).some(q=>!c.kinds.includes(q.type))||r.modalities.some(m=>!c.modalities.includes(m))))status='unsupported';
    if(!status && reservations>=plan.max_calls)status='budget_exhausted';
    if(status){const o=outcome(c,r,status);outcomes[s.id]=o;await journal({event:'step_end',step:s.id,outcome:{...o,revision:undefined}});return o;}
    // Reserve before awaiting storage/network: parallel work shares the same finite budget.
    reservations++;
    await journal({event:'step_start',step:s.id,provider:c.id,mode:c.mode,question_set:r.question_set,
      question_hash:digest(r.questions),state_hash:digest(r.state),reads:s.reads??[],after:s.after??[],revision_hash:digest(r.revision)});
    const started=performance.now();let o:Outcome;
    try {
      if(controller.signal.aborted)throw new DecisionError('cancelled');
      const raw=await limited(()=>{
        if(host.isCurrent && !host.isCurrent(r.revision))throw new DecisionError('stale');
        calls++;
        return provider.invoke({request:r,upstream,signal:controller.signal});
      },controller.signal);
      o=normalize(raw,c,r,performance.now()-started);
    } catch(error){
      const kind=error instanceof DecisionError && STATUSES.has(error.status)?error.status:'error';
      o=outcome(c,r,controller.signal.aborted?(timedOut?'timeout':'cancelled'):kind,performance.now()-started);
    }
    if(host.isCurrent && !host.isCurrent(r.revision))o=outcome(c,r,'stale',performance.now()-started);
    outcomes[s.id]=o;
    // Store only normalized finite values. No input, upstream content, headers or exception text.
    await journal({event:'step_end',step:s.id,outcome:{...o,revision:undefined}});
    return o;
  };
  let selected:Outcome|null=null,comparison:RunResult['comparison']='not_run';
  let status:RunResult['status']='unresolved';
  let next_action:Followup|null=null,next_actions:Followup[]=[];
  const setNext=(assessment:Assessment)=>{
    next_actions=[...new Set(Object.values(assessment.by_question).filter((x):x is Followup=>x!=='accept'))];
    next_action=next_actions.length===1?next_actions[0]:null;
  };
  const setNextFromSteps=(steps:readonly Step[])=>{
    next_actions=[...new Set(steps.flatMap(s=>Object.values(assessments[s.id]?.by_question??{}))
      .filter((x):x is Followup=>x!=='accept'))];
    next_action=next_actions.length===1?next_actions[0]:null;
  };
  try {
    await journal({event:'start',evidence_mode:host.evidence_mode??'unverified',topology:plan.topology,policy_id:plan.policy_id,max_calls:plan.max_calls,
      timeout_ms:plan.timeout_ms,plan_hash:digest(plan),authority:'advisory_only',automatic_apply:false});
    if(plan.topology==='cross-check'){
      await Promise.all(plan.steps.map(s=>execute(s)));
      for(const s of plan.steps)assessments[s.id]=assess(outcomes[s.id],plan,s);
    }
    else {
      let satisfied=false,stopForEvidence=false;
      for(const s of plan.steps){
        const c=providers.get(s.provider)!.capability;
        const skip=c.mode==='primary'&&(stopForEvidence||(satisfied&&['cascade','escalate'].includes(plan.topology))); 
        const o=await execute(s,skip);
        const assessment=assessments[s.id]=assess(o,plan,s);
        if(c.mode==='primary'&&!skip){
          if(assessment.action==='accept'){selected=o;satisfied=true;next_action=null;next_actions=[];}
          else if(assessment.action==='continue'){setNext(assessment);if(plan.topology==='compose'){selected=null;satisfied=false;}}
          else {selected=null;satisfied=false;stopForEvidence=true;setNext(assessment);}
        }
      }
    }
    const primary=outcomes[plan.primary];
    const primarySteps=plan.steps.filter(s=>providers.get(s.provider)!.capability.mode==='primary');
    if(plan.topology==='single') selected=primary;
    if(plan.topology==='cross-check'){
      const other=plan.steps.filter(s=>s.id!==plan.primary).map(s=>outcomes[s.id]);
      comparison=other.every(o=>comparable(primary,o))?(other.every(o=>agrees(primary,o,plan))?'agree':'disagree'):'incomparable';
      const voters=primarySteps.filter(s=>s.id!==plan.primary).map(s=>outcomes[s.id]);
      if(voters.length===0) selected=primary; // Shadow never overrides the primary decision.
      else if(voters.every(o=>agrees(primary,o,plan))&&primarySteps.every(s=>assessments[s.id].action==='accept'))selected=primary;
      else {
        status=voters.some(o=>comparable(primary,o)&&!agrees(primary,o,plan))?'disagreement':'unresolved';
        // A shadow may not request extra work for the primary caller. Preserve every
        // distinct primary follow-up instead of imposing a universal priority order.
        setNextFromSteps(primarySteps);
      }
    }
    if(selected){
      const selectedStep=plan.steps.find(s=>outcomes[s.id]===selected)!;
      const assessment=assessments[selectedStep.id];
      status=selected.status==='answered'?(assessment.action==='accept'?'answered':'unresolved'):selected.status;
      if(assessment.action!=='accept')setNext(assessment);else {next_action=null;next_actions=[];}
    }
    else if(plan.topology==='escalate'&&(next_actions.length===0||next_actions.every(x=>x==='continue')))status='escalation_needed';
    if(selected && host.isCurrent && !host.isCurrent(selected.revision)){selected=null;status='stale';}
    // A shadow's deadline cannot erase a completed primary answer. Explicit caller cancellation still can.
    if(controller.signal.aborted && !(timedOut && selected && selected.status==='answered' && primarySteps.every(s=>outcomes[s.id]?.status==='answered'))){selected=null;status=timedOut?'timeout':'cancelled';}
    await journal({event:'finish',status,selected_provider:selected?.provider??null,comparison,calls_started:calls,assessments,next_action,next_actions,
      trace_complete_before_finish:traceOK,authority:'advisory_only',automatic_apply:false});
    return freeze({id,topology:plan.topology,status,selected,outcomes,assessments,next_action,next_actions,comparison,
      trace:{persisted:traceOK,records},calls_started:calls,authority:'advisory_only',automatic_apply:false});
  } finally { clearTimeout(timer);host.signal?.removeEventListener('abort',onCancel); }
}

/** Private persistence verification: read only the final trace record and expose no contents. */
export async function verifyTraceFinish(store:ReadableTraceStore,principal:string,run:RunResult):Promise<boolean>{
  if(!run.trace.persisted||run.trace.records<1||typeof principal!=='string'||!principal)return false;
  const seq=run.trace.records-1;
  const key='fabric/'+digest(principal)+'/'+run.id+'/'+String(seq).padStart(3,'0');
  try{
    const v=await store.get(key);
    return object(v)&&v.schema==='jev.fabric.trace.v1'&&v.run_id===run.id&&v.seq===seq&&v.event==='finish'&&
      v.status===run.status&&v.authority==='advisory_only'&&v.automatic_apply===false;
  }catch{return false;}
}

/** Deliberately not a fabricated Decisions HTTP adapter. No verified wire contract yet. */
export function pendingOpenAIDecisions():Provider {
  return {capability:{id:'openai_decisions',mode:'shadow',verified:false,kinds:[],modalities:[],evidence:null},
    invoke:async()=>{throw new DecisionError('unavailable');}};
}
