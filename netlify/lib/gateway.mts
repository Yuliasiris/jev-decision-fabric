import { createHash, timingSafeEqual } from 'node:crypto';
import { QUESTION_SETS } from './questions.mts';

export const VERSION = '0.2.1';
export const PROTOCOL = '2025-06-18';
export type Env = (name: string) => string | undefined;
export type Sender = typeof fetch;
export class Fault extends Error {
  status: number;
  code: string;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}
export function env(name: string): string | undefined { return Netlify.env.get(name); }
export function json(value: unknown, status = 200, headers: Record<string,string> = {}) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers } });
}
export function record(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (record(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export function sha(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export async function boundedJSON(message: Request | Response, maxBytes: number): Promise<unknown> {
  const length = message.headers.get('content-length');
  if (length && Number(length) > maxBytes) throw new Fault('BODY_TOO_LARGE', 413);
  if (!message.body) throw new Fault('INVALID_JSON');
  const reader = message.body.getReader();
  const parts: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Fault('BODY_TOO_LARGE', 413); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let at = 0;
  for (const p of parts) { bytes.set(p,at); at += p.length; }
  try { return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes)); }
  catch { throw new Fault('INVALID_JSON'); }
}
export function checkOrigin(req: Request) {
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin && origin !== 'https://chatgpt.com') throw new Fault('ORIGIN_NOT_ALLOWED',403);
}
export function checkBearer(req: Request, get: Env) {
  const expected = get('JEV_GATEWAY_TOKEN');
  if (!expected || expected.length < 32) throw new Fault('ACCESS_CONTROL_NOT_CONFIGURED',503);
  const actual = req.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];
  if (!actual || actual.length > 1024) throw new Fault('UNAUTHORIZED',401);
  const a=Buffer.from(actual), b=Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a,b)) throw new Fault('UNAUTHORIZED',401);
}
export function validateInput(input: unknown): {question_set: string, state: any} {
  if (!record(input)) throw new Fault('INVALID_REQUEST',422);
  if (Object.keys(input).some(k => !['question_set','state'].includes(k))) throw new Fault('UNEXPECTED_FIELD',422);
  const name = input.question_set;
  if (typeof name !== 'string' || !Object.hasOwn(QUESTION_SETS,name)) throw new Fault('UNKNOWN_QUESTION_SET',422);
  const state = input.state;
  if (!(typeof state === 'string' || Array.isArray(state) || record(state))) throw new Fault('INVALID_STATE',422);
  let serialized: string;
  try { serialized = JSON.stringify(state); } catch { throw new Fault('INVALID_STATE',422); }
  if (Buffer.byteLength(serialized) > 128*1024) throw new Fault('STATE_TOO_LARGE',413);
  return { question_set: name, state };
}
function probability(n: unknown) { return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1; }
export function validateAnswers(result: unknown, questions: Record<string,any>) {
  if (!record(result) || !record(result.answers)) throw new Fault('INVALID_PROVIDER_RESPONSE',502);
  const answers = result.answers;
  const ids = Object.keys(questions);
  if (Object.keys(answers).length !== ids.length) throw new Fault('INVALID_PROVIDER_RESPONSE',502);
  for (const id of ids) {
    const answer = answers[id]; const q = questions[id];
    if (!record(answer)) throw new Fault('INVALID_PROVIDER_RESPONSE',502);
    if (q.type === 'noul') {
      if (!probability(answer.noul)) throw new Fault('INVALID_PROVIDER_RESPONSE',502);
    } else {
      const options = Object.keys(q.criteria);
      if (typeof answer.choice !== 'string' || !Object.hasOwn(q.criteria,answer.choice) || !record(answer.probabilities)) throw new Fault('INVALID_PROVIDER_RESPONSE',502);
      if (Object.keys(answer.probabilities).length !== options.length || options.some(k => !probability(answer.probabilities[k]))) throw new Fault('INVALID_PROVIDER_RESPONSE',502);
      const sum = options.reduce((n,k)=>n+answer.probabilities[k],0);
      if (Math.abs(sum-1)>0.015 || !probability(answer.confidence)) throw new Fault('INVALID_PROVIDER_RESPONSE',502);
    }
  }
  return result;
}
export async function evaluate(input: unknown, get: Env = env, send: Sender = fetch) {
  const valid=validateInput(input);
  // Explicit direct-provider configuration: never silently spend Netlify AI credits.
  if (get('JEV_PROVIDER_MODE') !== 'typesafe-direct') throw new Fault('PROVIDER_NOT_CONFIGURED',503);
  const key=get('TYPESAFE_API_KEY')?.trim();
  const base=get('TYPESAFE_BASE_URL');
  if (key && /[^\x20-\x7e]/.test(key)) throw new Fault('PROVIDER_KEY_FORMAT_INVALID',503);
  if (!key || (base && base.replace(/\/$/,'') !== 'https://api.typesafe.ai')) throw new Fault('TYPESAFE_DIRECT_KEY_REQUIRED',503);
  const model=get('JEV_MODEL') || 'jev-latest';
  if (!/^jev-[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new Fault('MODEL_NOT_ALLOWED',503);
  const questions=structuredClone(QUESTION_SETS[valid.question_set]);
  const started=performance.now();
  let response: Response;
  try {
    response=await send('https://api.typesafe.ai/v1/systemone', {
      method:'POST', headers:{'content-type':'application/json', authorization:`Bearer ${key}`},
      body:JSON.stringify({model,state:valid.state,questions}),
      signal:AbortSignal.timeout(15000), redirect:'error',
    });
  } catch (error:any) {
    // Enumerate transport causes only. Never return messages, URLs, headers, or the key.
    const code=error?.cause?.code || error?.code;
    const allowed=['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ECONNRESET','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT'];
    const kind=allowed.includes(code)?code:error?.name==='TimeoutError'?'TIMEOUT':error?.name==='AbortError'?'ABORTED':error?.cause?.message==='unexpected redirect'?'REDIRECT_BLOCKED':'UNKNOWN';
    throw new Fault('PROVIDER_NETWORK_'+kind,504);
  }
  if (!response.ok) { await response.body?.cancel(); throw new Fault(response.status===429?'PROVIDER_RATE_LIMITED':`PROVIDER_HTTP_${response.status}`,response.status===429?429:502); }
  let raw: unknown;
  try { raw=await boundedJSON(response,512*1024); } catch { throw new Fault('INVALID_PROVIDER_RESPONSE',502); }
  const result=validateAnswers(raw,questions);
  return {
    provider:'typesafe-direct', gateway_version:VERSION,
    requested_model:model, resolved_model:typeof result.model==='string'?result.model:null,
    question_set:valid.question_set, state_sha256:sha(valid.state), question_set_sha256:sha(questions),
    answers:Object.fromEntries(Object.entries(result.answers).map(([id,a]:[string,any])=>[id,questions[id].type==='noul'?{noul:a.noul}:{choice:a.choice,probabilities:a.probabilities,confidence:a.confidence}])), usage:record(result.usage)?Object.fromEntries(Object.entries(result.usage).filter(([,v])=>typeof v==='number'&&Number.isFinite(v)&&v>=0)):null,
    latency_ms:Math.round((performance.now()-started)*100)/100,
    authority:'advisory_only', automatic_apply:false,
  };
}
export function failure(error: unknown) {
  const e=error instanceof Fault?error:new Fault('INTERNAL_ERROR',500);
  return json({error:e.code},e.status,e.status===401?{'www-authenticate':'Bearer realm="jev-decision-fabric"'}:{});
}
export async function rest(req: Request, get: Env = env, send: Sender = fetch) {
  try {
    checkOrigin(req);
    if (req.method!=='POST') return json({error:'METHOD_NOT_ALLOWED'},405,{allow:'POST'});
    checkBearer(req,get);
    if (get('REST_LIVE_ENABLED')!=='true') throw new Fault('LIVE_EVALUATION_DISABLED',503);
    if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Fault('JSON_REQUIRED',415);
    return json(await evaluate(await boundedJSON(req,160*1024),get,send));
  } catch(error) { return failure(error); }
}
export function toolDefinition() {
  return {
    name:'decision_evaluate', title:'Jev typed decision evaluation',
    description:'Evaluate supplied state against a server-side question set using TypeSafe. Sends supplied state to an external provider and may incur API charges. Does not dispatch work, modify repositories, sheets or songs. Authentication and explicit live enablement are required. This deployment does not yet implement ChatGPT OAuth.',
    inputSchema:{type:'object',additionalProperties:false,required:['question_set','state'],properties:{
      question_set:{type:'string',enum:Object.keys(QUESTION_SETS)},state:{anyOf:[{type:'string'},{type:'object'},{type:'array'}]},
    }},
    annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:false,openWorldHint:true},
  };
}
export async function mcp(req: Request, get: Env = env, send: Sender = fetch) {
  try {
    checkOrigin(req);
    if (req.method!=='POST') return json({error:'METHOD_NOT_ALLOWED'},405,{allow:'POST'});
    if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) throw new Fault('JSON_REQUIRED',415);
    const accept=req.headers.get('accept')||'';
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) throw new Fault('MCP_ACCEPT_REQUIRED',406);
    const version=req.headers.get('mcp-protocol-version');
    if (version && !['2025-03-26',PROTOCOL].includes(version)) throw new Fault('UNSUPPORTED_PROTOCOL',400);
    const body=await boundedJSON(req,160*1024);
    if (!record(body) || body.jsonrpc!=='2.0' || typeof body.method!=='string') return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}},400);
    const hasId=Object.hasOwn(body,'id');
    const id=body.id;
    if (hasId && !(typeof id==='string' || (typeof id==='number' && Number.isFinite(id)))) return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}},400);
    if (!hasId) return new Response(null,{status:202,headers:{'cache-control':'no-store'}});
    const ok=(result:unknown)=>json({jsonrpc:'2.0',id,result});
    if(body.method==='initialize') return ok({protocolVersion:PROTOCOL,capabilities:{tools:{listChanged:false}},serverInfo:{name:'jev-decision-fabric',version:VERSION},instructions:'Discovery only until authenticated live use is configured. No dispatch or automatic Apply.'});
    if(body.method==='ping') return ok({});
    if(body.method==='tools/list') return ok({tools:[toolDefinition()]});
    if(body.method!=='tools/call') return json({jsonrpc:'2.0',id,error:{code:-32601,message:'Method not found'}});
    if(!record(body.params) || body.params.name!=='decision_evaluate') return json({jsonrpc:'2.0',id,error:{code:-32602,message:'Unknown tool'}});
    // A public discovery endpoint must never become a public paid-inference endpoint.
    if(get('MCP_LIVE_ENABLED')!=='true') return ok({isError:true,content:[{type:'text',text:'LIVE_EVALUATION_DISABLED: authentication/OAuth and provider setup are pending.'}]});
    checkBearer(req,get);
    const result=await evaluate(body.params.arguments,get,send);
    return ok({structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}]});
  } catch(error) { return failure(error); }
}
export function health(req: Request, get: Env = env) {
  if(!['GET','HEAD'].includes(req.method)) return json({error:'METHOD_NOT_ALLOWED'},405,{allow:'GET, HEAD'});
  const data={service:'jev-decision-fabric',version:VERSION,status:'deployed_setup_required',
    mcp:'discovery_available',chatgpt_oauth:'not_implemented',
    mcp_live_enabled:get('MCP_LIVE_ENABLED')==='true',rest_live_enabled:get('REST_LIVE_ENABLED')==='true',
    access_control_configured:(get('JEV_GATEWAY_TOKEN')?.length??0)>=32,
    direct_provider_enabled:get('JEV_PROVIDER_MODE')==='typesafe-direct',
    question_sets:Object.keys(QUESTION_SETS)};
  return req.method==='HEAD'?new Response(null,{headers:{'cache-control':'no-store'}}):json(data);
}
