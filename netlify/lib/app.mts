import {mcpOriginAllowed,EXPECTED_MCP_ORIGINS} from './mcp_origin.mts';
import {REPAIR_RELEASE} from './repair_release.mts';
import {Fault,json,record,boundedJSON,evaluate,validateInput,toolDefinition} from './gateway.mts';
import {evaluateWithTrace} from './fabric-gateway.mts';
import {verifyTraceFinish} from './decision-fabric.mts';
import {PUBLIC_TOOL_NAME,publicPlanDefinition,publicPlanEnabled,runPublicPlan} from './public-plan.mts';
import type {Env,Sender} from './gateway.mts';
import {config,ORIGIN,RESOURCE,SCOPE,challenge,protectedMetadata,serverMetadata,connectPage,connectedPage,register,activate,authorization,exchange,revoke,bearer,form,limit,session} from './auth.mts';
import type {Store} from './auth.mts';
import {QUESTION_SETS} from './questions.mts';
export const APP_VERSION='0.3.0';
function responseError(e:any){const f=e instanceof Fault?e:new Fault('INTERNAL_ERROR',500);return json({error:f.code},f.status,f.status===401?{'www-authenticate':challenge()}:f.status===429?{'retry-after':'60'}:{});}
function methodError(allow:string){return json({error:'METHOD_NOT_ALLOWED'},405,{allow});}
export function tools(get:Env){const t=toolDefinition();return [{...t,description:'Use TypeSafe Jev for bounded probabilistic decisions on supplied observations. Select ops-liveness-v0 (run/receipt/liveness), roi-delta-v0 (changed race facts and affected analyses), music-routing-v0 (post-analysis music operation routing), or synthetic-smoke-v0. Unknown evidence must remain unknown. State is sent to TypeSafe and incurs API charges; never include credentials or unnecessary private material. Results are advisory and do not execute, dispatch, bet, or apply changes.',securitySchemes:[{type:'oauth2',scopes:[SCOPE]}],_meta:{securitySchemes:[{type:'oauth2',scopes:[SCOPE]}]}},...(publicPlanEnabled(get)?[{...publicPlanDefinition(),securitySchemes:[{type:'oauth2',scopes:[SCOPE]}],_meta:{securitySchemes:[{type:'oauth2',scopes:[SCOPE]}]}}]:[])];}
export async function app(req:Request,get:Env,store:Store,send:Sender=fetch,ip='unknown'){
 const path=new URL(req.url).pathname;
 try {
  // Do not trust forwarded hosts or permit a preview hostname to issue production tokens.
  if(new URL(req.url).origin!==ORIGIN)throw new Fault('HOST_NOT_ALLOWED',403);
  // OAuth/MCP requests can originate from server-side ChatGPT infrastructure with
  // implementation-specific Origin headers. Do not use Origin as API authentication.
  // /oauth/session retains its own strict same-origin check; all other protected
  // surfaces rely on bearer/OAuth/session binding and signed state.
  if(path.startsWith('/.well-known/')){
   if(req.method!=='GET')return methodError('GET');
   if(['/.well-known/oauth-protected-resource','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-protected-resource/v1/decision'].includes(path))return json(protectedMetadata());
   if(path==='/.well-known/oauth-authorization-server')return json(serverMetadata());
   return json({error:'NOT_FOUND'},404);
  }
  if(path==='/health'){
   if(!['GET','HEAD'].includes(req.method))return methodError('GET, HEAD');
   let configured=false,enabled=false;try{const c=config(get);configured=true;enabled=c.enabled===true;}catch{}
   const data={service:'jev-decision-fabric',version:APP_VERSION,repair_release:REPAIR_RELEASE,status:configured&&get('TYPESAFE_API_KEY')?'ready_for_authenticated_use':'setup_required',oauth:'implemented_code_pkce_refresh',authentication_configured:configured,live_enabled:enabled,provider_key_present:!!get('TYPESAFE_API_KEY'),question_sets:Object.keys(QUESTION_SETS),chatgpt_end_to_end:'requires_user_connection',automatic_apply:false};
   return req.method==='HEAD'?new Response(null,{headers:{'cache-control':'no-store'}}):json(data);
  }
  if(path==='/connect')return req.method==='GET'?connectPage():methodError('GET');
  if(path==='/connected'){if(req.method!=='GET')return methodError('GET');session(req,config(get));return connectedPage();}
  const c=config(get);
  if(path==='/oauth/register'){
   if(req.method!=='POST')return methodError('POST');
   if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Fault('JSON_REQUIRED',415);
   return json(await register(await boundedJSON(req,12000),store,c,ip),201);
  }
  if(path==='/oauth/session'){
   if(req.method!=='POST')return methodError('POST');
   await limit(store,'session-'+ip,20,60000);
   if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Fault('JSON_REQUIRED',415);
   return await activate(req,await boundedJSON(req,2000),store,c);
  }
  if(path==='/oauth/authorize'){
   if(!['GET','POST'].includes(req.method))return methodError('GET, POST');
   await limit(store,'authorize-'+ip,120,60000);
   return await authorization(req,store,c,req.method==='POST'?await form(req):undefined);
  }
  if(path==='/oauth/token'||path==='/oauth/revoke'){
   if(req.method!=='POST')return methodError('POST');
   await limit(store,'token-'+ip,120,60000);const p=await form(req);
   return json(path.endsWith('/token')?await exchange(req,p,store,c):await revoke(req,p,store,c));
  }
  const providerEnv:Env=k=>k==='JEV_PROVIDER_MODE'?'typesafe-direct':k==='TYPESAFE_BASE_URL'?'https://api.typesafe.ai':get(k);
  const run=async(input:any,who:any)=>{
   if(!c.enabled)throw new Fault('LIVE_EVALUATION_DISABLED',503);
   const v=validateInput(input);
   // Probe authorization is temporary; never grants the owner's browser session.
   await limit(store,'inference-minute-'+who.sub,who.sub==='probe'?10:120,60000);
   await limit(store,'inference-day-'+who.sub,who.sub==='probe'?10:5000,86400000);
   if(get('JEV_FABRIC_ENABLED')!=='true')return {value:{...await evaluate(v,providerEnv,send),gateway_version:APP_VERSION},headers:{}};
   const observed=await evaluateWithTrace(v,providerEnv,store,send,who.sub,{signal:req.signal,comparison_mode:'primary-only'});
   const readback=await verifyTraceFinish(store,who.sub,observed.run);
   return {value:{...observed.value,gateway_version:APP_VERSION},headers:{...observed.headers,'x-jev-trace-readback':readback?'verified':'unverified'}};
  };
  if(path==='/v1/decision'){
   if(req.method!=='POST')return methodError('POST');
   const who=await bearer(req,store,c);
   if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Fault('JSON_REQUIRED',415);
   const observed=await run(await boundedJSON(req,160*1024),who);return json(observed.value,200,observed.headers);
  }
  if(path==='/mcp'){
   if(!mcpOriginAllowed(req.headers.get('origin'),EXPECTED_MCP_ORIGINS))throw new Fault('MCP_ORIGIN_NOT_ALLOWED',403);
   // Authentication at transport level makes the initial ChatGPT tool scan start OAuth.
   const who=await bearer(req,store,c);
   if(req.method!=='POST')return methodError('POST');
   if(!req.headers.get('content-type')?.startsWith('application/json'))throw new Fault('JSON_REQUIRED',415);
   const accept=req.headers.get('accept')||'';if(!accept.includes('application/json')||!accept.includes('text/event-stream'))throw new Fault('MCP_ACCEPT_REQUIRED',406);
   const pv=req.headers.get('mcp-protocol-version');if(pv&&!['2025-03-26','2025-06-18','2025-11-25'].includes(pv))throw new Fault('UNSUPPORTED_PROTOCOL');
   const b=await boundedJSON(req,160*1024);
   if(!record(b)||b.jsonrpc!=='2.0'||typeof b.method!=='string')return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}},400);
   if(!Object.hasOwn(b,'id'))return new Response(null,{status:202});
   if(!(typeof b.id==='string'||Number.isSafeInteger(b.id)))return json({jsonrpc:'2.0',id:null,error:{code:-32600,message:'Invalid Request'}},400);
   const ok=(r:any,headers:Record<string,string>={})=>json({jsonrpc:'2.0',id:b.id,result:r},200,headers);
   if(b.method==='initialize')return ok({protocolVersion:['2025-03-26','2025-06-18','2025-11-25'].includes(b.params?.protocolVersion)?b.params.protocolVersion:'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:'jev-decision-fabric',version:APP_VERSION},instructions:'Evaluate selected state only; all outputs are advisory. No autonomous dispatch or automatic Apply.'});
   if(b.method==='ping')return ok({});
   if(b.method==='tools/list')return ok({tools:tools(get)});
   if(b.method!=='tools/call')return json({jsonrpc:'2.0',id:b.id,error:{code:-32601,message:'Method not found'}});
   if(!record(b.params)||(b.params.name!=='decision_evaluate'&&!(b.params.name===PUBLIC_TOOL_NAME&&publicPlanEnabled(get))))return json({jsonrpc:'2.0',id:b.id,error:{code:-32602,message:'Unknown tool'}});
   try{
    if(b.params.name===PUBLIC_TOOL_NAME){
      if(!c.enabled)throw new Fault('LIVE_EVALUATION_DISABLED',503);
      const result=await runPublicPlan(b.params.arguments,providerEnv,store,send,who.sub,{signal:req.signal,beforeCall:async()=>{
        const current=await bearer(req,store,c);
        if(current.sub!==who.sub)throw new Fault('UNAUTHORIZED',401);
        await limit(store,'inference-minute-'+who.sub,who.sub==='probe'?10:120,60000);
        await limit(store,'inference-day-'+who.sub,who.sub==='probe'?10:5000,86400000);
      }});
      const readback=await verifyTraceFinish(store,who.sub,result);
      return ok({structuredContent:result,content:[{type:'text',text:JSON.stringify(result)}],isError:false},
        {'x-jev-trace-id':result.id,'x-jev-trace-status':result.trace.persisted?'stored':'incomplete',
         'x-jev-trace-readback':readback?'verified':'unverified'});
    }
    const observed=await run(b.params.arguments,who);const r=observed.value;return ok({structuredContent:r,content:[{type:'text',text:JSON.stringify(r)}],isError:false},observed.headers);}
   catch(e){const f=e instanceof Fault?e:new Fault('INTERNAL_ERROR',500);return ok({isError:true,content:[{type:'text',text:f.code}]});}
  }
  return json({error:'NOT_FOUND'},404);
 }catch(e){return responseError(e);}
}
