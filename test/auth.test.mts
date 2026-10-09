import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {app,APP_VERSION} from '../netlify/lib/app.mts';
import {ORIGIN,RESOURCE,SCOPE,COOKIE,random,hash,sign,verify,validRedirect,config,form,limit} from '../netlify/lib/auth.mts';
import type {Store,AuthConfig} from '../netlify/lib/auth.mts';
import {QUESTION_SETS} from '../netlify/lib/questions.mts';

class Memory implements Store {
 rows=new Map<string,any>();
 async get(k:string){return structuredClone(this.rows.get(k)??null);}
 async create(k:string,v:any){if(this.rows.has(k))return false;this.rows.set(k,structuredClone(v));return true;}
 async cas(k:string,f:(v:any)=>any){const v=f(structuredClone(this.rows.get(k)??null));if(v!==null)this.rows.set(k,structuredClone(v));return structuredClone(v);}
}
function fixture(){
 const owner=random(),probe=random();
 const c:AuthConfig={key:'ab'.repeat(32),owner_hash:hash(owner),probe_hash:hash(probe),owner_until:Date.now()+86400000,probe_until:Date.now()+3600000,enabled:true};
 const store=new Memory(),calls:any[]=[];
 const send=(async(url:any,init:any)=>{calls.push({url,init});const q=JSON.parse(init.body).questions;const answers=Object.fromEntries(Object.entries(q).map(([k,v]:[string,any])=>[k,v.type==='noul'?{noul:.76,discard:'FAKE_PRIVATE'}:{choice:Object.keys(v.criteria)[0],confidence:.5,probabilities:Object.fromEntries(Object.keys(v.criteria).map((o,i)=>[o,i===0?1:0])),discard:'FAKE_PRIVATE'}]));return Response.json({answers,model:'jev-test',usage:{input_tokens:100,extra:'FAKE_PRIVATE'}});}) as typeof fetch;
 const get=(k:string)=>k==='JEV_AUTH_CONFIG'?JSON.stringify(c):k==='TYPESAFE_API_KEY'?'FAKE_TYPESAFE_KEY':undefined;
 const call=(path:string,method='GET',body?:any,headers:Record<string,string>={})=>app(new Request(ORIGIN+path,{method,headers:{...(body!==undefined?{'content-type':'application/json'}:{}),...headers},body:body!==undefined?(typeof body==='string'?body:JSON.stringify(body)):undefined}),get,store,send,'test-ip');
 return {owner,probe,c,store,calls,get,call};
}
async function activate(f:any,sub='owner'){
 const r=await f.call('/oauth/session','POST',{token:sub==='owner'?f.owner:f.probe},{origin:ORIGIN});assert.equal(r.status,200,await r.clone().text());return r.headers.get('set-cookie').split(';')[0];
}
async function client(f:any,method='none',extra:any={}){
 const r=await f.call('/oauth/register','POST',{redirect_uris:['https://chatgpt.com/connector_platform_oauth_redirect'],token_endpoint_auth_method:method,client_name:'test-client',...extra});assert.equal(r.status,201,await r.clone().text());return r.json();
}
function tokenHeaders(cl:any){return cl.token_endpoint_auth_method==='client_secret_basic'?{authorization:'Basic '+Buffer.from(cl.client_id+':'+cl.client_secret).toString('base64')}:{ };}
function formFields(cl:any){return {client_id:cl.client_id,...(cl.token_endpoint_auth_method==='client_secret_post'?{client_secret:cl.client_secret}:{})};}
function postForm(f:any,path:string,data:any,headers:Record<string,string>={}){return f.call(path,'POST',new URLSearchParams(data).toString(),{'content-type':'application/x-www-form-urlencoded',...headers});}
async function code(f:any,cl:any,sessionCookie:string,overrides:any={}){
 const verifier=random(),ch=createHash('sha256').update(verifier).digest('base64url');
 const params={client_id:cl.client_id,redirect_uri:cl.redirect_uris[0],response_type:'code',code_challenge_method:'S256',code_challenge:ch,resource:RESOURCE,scope:SCOPE+' offline_access',state:'test-state',...overrides};
 const page=await f.call('/oauth/authorize?'+new URLSearchParams(params),'GET',undefined,{cookie:sessionCookie});assert.equal(page.status,200);const txt=await page.text();const tx=txt.match(/name="transaction" value="([^"]+)"/)?.[1];assert.ok(tx,txt);
 const consent=await postForm(f,'/oauth/authorize',{transaction:tx,approve:'yes'},{cookie:sessionCookie,origin:ORIGIN});assert.equal(consent.status,303,await consent.clone().text());const u=new URL(consent.headers.get('location')!);assert.equal(u.origin,'https://chatgpt.com');assert.equal(u.searchParams.get('iss'),ORIGIN);assert.equal(u.searchParams.get('state'),'test-state');
 return {code:u.searchParams.get('code'),verifier,tx,params};
}
async function token(f:any,cl:any,co:any,overrides:any={}){
 const r=await postForm(f,'/oauth/token',{...formFields(cl),grant_type:'authorization_code',code:co.code,redirect_uri:cl.redirect_uris[0],code_verifier:co.verifier,resource:RESOURCE,...overrides},tokenHeaders(cl));return r;
}
async function connected(f:any,method='none',sub='owner'){
 const cookie=await activate(f,sub),cl=await client(f,method),co=await code(f,cl,cookie);const r=await token(f,cl,co);assert.equal(r.status,200,await r.clone().text());return {cookie,cl,co,...await r.json()};
}
function rpc(method:string,params:any={}){return {jsonrpc:'2.0',id:1,method,params};}
const rpcHeaders=(token:string)=>({authorization:'Bearer '+token,accept:'application/json, text/event-stream'});

test('configuration rejects incomplete and malformed records',()=>{for(const c of ['', '{}',JSON.stringify({key:'a'.repeat(64),owner_hash:'b'.repeat(64)})])assert.throws(()=>config(()=>c));});
test('OAuth metadata is valid without paid provider credentials',async()=>{const f=fixture();const pr=await (await f.call('/.well-known/oauth-protected-resource/mcp')).json();assert.equal(pr.resource,RESOURCE);const a=await (await f.call('/.well-known/oauth-authorization-server')).json();assert.ok(a.code_challenge_methods_supported.includes('S256'));assert.equal(a.registration_endpoint,ORIGIN+'/oauth/register');});
test('health exposes presence, never secrets',async()=>{const f=fixture();const text=await (await f.call('/health')).text();assert.match(text,/"provider_key_present":true/);assert.ok(!text.includes(f.owner));assert.ok(!text.includes(f.c.key));assert.ok(!text.includes('FAKE_TYPESAFE_KEY'));});
test('unauthenticated MCP returns a protected-resource OAuth challenge',async()=>{const f=fixture();const r=await f.call('/mcp','POST',rpc('initialize'));assert.equal(r.status,401);assert.match(r.headers.get('www-authenticate')!,/oauth-protected-resource/);assert.equal(f.calls.length,0);});
test('unauthenticated REST cannot call paid inference',async()=>{const f=fixture();assert.equal((await f.call('/v1/decision','POST',{})).status,401);assert.equal(f.calls.length,0);});
for(const uri of ['http://chatgpt.com/x','https://chatgpt.com.evil.test/x','https://evil.test/x','https://chatgpt.com:444/x','https://x@chatgpt.com/x','https://chatgpt.com/x#fragment','javascript:bad'])test('reject redirect '+uri,()=>assert.equal(validRedirect(uri),false));
test('registration rejects untrusted redirects',async()=>{const f=fixture();assert.equal((await f.call('/oauth/register','POST',{redirect_uris:['https://evil.test/callback']})).status,400);});
test('activation requires explicit same-origin POST',async()=>{const f=fixture();assert.equal((await f.call('/oauth/session','POST',{token:f.owner})).status,403);assert.equal(f.calls.length,0);});
test('read-only browser navigation tolerates opaque/external Origin while activation remains same-origin',async()=>{const f=fixture();for(const origin of ['null','https://example.invalid','https://chatgpt.com']){const r=await f.call('/connect','GET',undefined,{origin});assert.equal(r.status,200,origin+': '+await r.clone().text());}assert.equal((await f.call('/oauth/session','POST',{token:f.owner},{origin:'null'})).status,403);assert.equal(f.calls.length,0);});
test('one-time owner activation sets host-only protected cookie',async()=>{const f=fixture();const r=await f.call('/oauth/session','POST',{token:f.owner},{origin:ORIGIN});assert.equal(r.status,200);const c=r.headers.get('set-cookie')!;for(const x of ['__Host-','Secure','HttpOnly','SameSite=Lax','Path=/'])assert.ok(c.includes(x));assert.ok(!c.includes('Domain='));const twice=await f.call('/oauth/session','POST',{token:f.owner},{origin:ORIGIN});assert.equal(twice.status,409);});
test('probe activation is not owner and short lived',async()=>{const f=fixture();const c=await activate(f,'probe');const d=verify(c.slice(c.indexOf('=')+1),'session',f.c);assert.equal(d.sub,'probe');assert.ok(d.exp-d.iat<=900);});
test('expired and wrong enrollment links rejected',async()=>{const f=fixture();f.c.owner_until=0;assert.equal((await f.call('/oauth/session','POST',{token:f.owner},{origin:ORIGIN})).status,401);assert.equal((await f.call('/oauth/session','POST',{token:random()},{origin:ORIGIN})).status,401);});
for(const method of ['none','client_secret_post','client_secret_basic'])test('complete OAuth PKCE flow '+method,async()=>{const f=fixture();const c=await connected(f,method);assert.equal(c.token_type,'Bearer');assert.ok(c.refresh_token);assert.equal(f.calls.length,0);});
test('consent rejects CSRF wrong owner session',async()=>{const f=fixture();const a=await activate(f),cl=await client(f),co=await code(f,cl,a);const foreign=COOKIE+'='+sign('session',{sub:'owner',sid:random()},f.c,600);assert.equal((await postForm(f,'/oauth/authorize',{transaction:co.tx,approve:'yes'},{cookie:foreign,origin:ORIGIN})).status,403);});
test('consent retry is idempotent for the same signed transaction and session',async()=>{const f=fixture();const a=await activate(f),cl=await client(f),co=await code(f,cl,a);const first=await postForm(f,'/oauth/authorize',{transaction:co.tx,approve:'yes'},{cookie:a,origin:ORIGIN});const second=await postForm(f,'/oauth/authorize',{transaction:co.tx,approve:'yes'},{cookie:a,origin:ORIGIN});assert.equal(first.status,303);assert.equal(second.status,303);assert.equal(second.headers.get('location'),first.headers.get('location'));});
test('authorization requires S256 and rejects query parameter duplicates',async()=>{const f=fixture(),cl=await client(f);const p=new URLSearchParams({client_id:cl.client_id,redirect_uri:cl.redirect_uris[0],response_type:'code',code_challenge:random(),code_challenge_method:'plain'});assert.equal((await f.call('/oauth/authorize?'+p)).status,400);p.set('code_challenge_method','S256');p.append('client_id',cl.client_id);assert.equal((await f.call('/oauth/authorize?'+p)).status,400);});
test('ChatGPT may initiate authorization by form POST without weakening consent POST CSRF',async()=>{
 const f=fixture(),a=await activate(f),cl=await client(f);
 const verifier=random(),ch=createHash('sha256').update(verifier).digest('base64url');
 const init={client_id:cl.client_id,redirect_uri:cl.redirect_uris[0],response_type:'code',code_challenge_method:'S256',code_challenge:ch,resource:RESOURCE,scope:SCOPE+' offline_access',state:'post-init'};
 for(const origin of ['https://chatgpt.com','null']){
  const r=await postForm(f,'/oauth/authorize',init,{cookie:a,origin});
  assert.equal(r.status,200,origin+': '+await r.clone().text());
  assert.match(await r.text(),/ChatGPTへJevの利用を許可/);
 }
 const consentWithoutSession=await postForm(f,'/oauth/authorize',{transaction:'bogus',approve:'yes'},{origin:'https://chatgpt.com'});
 assert.equal(consentWithoutSession.status,401);
});
test('authorization cannot request scopes outside client registration',async()=>{const f=fixture(),cl=await client(f,'none',{scope:SCOPE}),a=await activate(f);const p=new URLSearchParams({client_id:cl.client_id,redirect_uri:cl.redirect_uris[0],response_type:'code',code_challenge:random(),code_challenge_method:'S256',scope:SCOPE+' offline_access'});assert.equal((await f.call('/oauth/authorize?'+p,'GET',undefined,{cookie:a})).status,400);});
test('wrong PKCE rejected without consuming correct code',async()=>{const f=fixture(),a=await activate(f),cl=await client(f),co=await code(f,cl,a);assert.equal((await token(f,cl,co,{code_verifier:random()})).status,400);assert.equal((await token(f,cl,co)).status,200);});
test('code cannot be reused, including concurrent consumption',async()=>{const f=fixture(),a=await activate(f),cl=await client(f),co=await code(f,cl,a);const r=await Promise.all([token(f,cl,co),token(f,cl,co)]);assert.deepEqual(r.map(x=>x.status).sort(),[200,400]);});
test('wrong resource and redirect rejected',async()=>{const f=fixture(),a=await activate(f),cl=await client(f),co=await code(f,cl,a);assert.equal((await token(f,cl,co,{resource:'https://evil.test'})).status,400);assert.equal((await token(f,cl,co,{redirect_uri:'https://chatgpt.com/different'})).status,400);});
test('client mismatch and wrong secret are rejected',async()=>{const f=fixture(),a=await activate(f),cl=await client(f,'client_secret_post'),other=await client(f),co=await code(f,cl,a);assert.equal((await token(f,other,co)).status,400);assert.equal((await token(f,cl,co,{client_secret:'wrong'})).status,401);});
test('refresh rotates, rejects stale reuse and revocation blocks access',async()=>{const f=fixture(),c=await connected(f,'client_secret_post');const fields={...formFields(c.cl),grant_type:'refresh_token',refresh_token:c.refresh_token,resource:RESOURCE};const r=await postForm(f,'/oauth/token',fields);assert.equal(r.status,200);const fresh=await r.json();assert.notEqual(fresh.refresh_token,c.refresh_token);assert.equal((await postForm(f,'/oauth/token',fields)).status,400);const rev=await postForm(f,'/oauth/revoke',{...formFields(c.cl),token:fresh.refresh_token});assert.equal(rev.status,200);assert.equal((await f.call('/mcp','POST',rpc('tools/list'),rpcHeaders(fresh.access_token))).status,401);});
test('refresh cannot increase scopes or switch resource',async()=>{const f=fixture(),c=await connected(f);const fields={...formFields(c.cl),grant_type:'refresh_token',refresh_token:c.refresh_token};assert.equal((await postForm(f,'/oauth/token',{...fields,scope:'write'})).status,400);assert.equal((await postForm(f,'/oauth/token',{...fields,resource:'https://evil.test'})).status,400);});
test('forged, expired and wrong-audience bearer tokens fail',async()=>{const f=fixture(),c=await connected(f);const d=verify(c.access_token,'access',f.c);for(const t of [c.access_token+'x',sign('access',{...d,aud:'elsewhere'},f.c,300),sign('access',d,f.c,-10)])assert.equal((await f.call('/mcp','POST',rpc('tools/list'),rpcHeaders(t))).status,401);});
test('token kind confusion rejected',()=>{const f=fixture();const sessionToken=sign('session',{sub:'owner'},f.c,600);assert.throws(()=>verify(sessionToken,'access',f.c));});
test('MCP initializes and advertises all configured question sets with OAuth',async()=>{const f=fixture(),c=await connected(f);const r=await f.call('/mcp','POST',rpc('initialize',{protocolVersion:'2025-06-18'}),rpcHeaders(c.access_token));assert.equal((await r.json()).result.serverInfo.version,APP_VERSION);const list=await (await f.call('/mcp','POST',rpc('tools/list'),rpcHeaders(c.access_token))).json();assert.equal(list.result.tools.length,1);assert.equal(list.result.tools[0].securitySchemes[0].type,'oauth2');assert.equal(list.result.tools[0].inputSchema.properties.question_set.enum.length,4);});
test('authenticated MCP and REST use provider once each without leaking data',async()=>{const f=fixture(),c=await connected(f,'none','probe');const input={question_set:'synthetic-smoke-v0',state:{next_work_ready:true}};const r=await f.call('/mcp','POST',rpc('tools/call',{name:'decision_evaluate',arguments:input}),rpcHeaders(c.access_token));const text=await r.text();assert.match(text,/"noul":0.76/);assert.ok(!text.includes('FAKE_TYPESAFE_KEY'));assert.ok(!text.includes('FAKE_PRIVATE'));assert.equal(f.calls.length,1);assert.equal((await f.call('/v1/decision','POST',input,rpcHeaders(c.access_token))).status,200);assert.equal(f.calls.length,2);assert.equal(f.calls[0].url,'https://api.typesafe.ai/v1/systemone');});
test('all domain question sets retain missing-evidence alternatives',()=>{assert.equal(Object.keys(QUESTION_SETS['ops-liveness-v0']).length,16);for(const id of ['roi-delta-v0','music-routing-v0']){assert.equal(Object.keys(QUESTION_SETS[id]).length,8);for(const q of Object.values(QUESTION_SETS[id]))assert.ok(Object.hasOwn(q.criteria!,'unknown'));}});
test('missing provider key produces no network',async()=>{const f=fixture(),c=await connected(f);const request=new Request(ORIGIN+'/v1/decision',{method:'POST',headers:{...rpcHeaders(c.access_token),'content-type':'application/json'},body:JSON.stringify({question_set:'synthetic-smoke-v0',state:{}})});const r=await app(request,k=>k==='TYPESAFE_API_KEY'?undefined:f.get(k),f.store,f.send);assert.equal(r.status,503);assert.equal(f.calls.length,0);});
test('disabled paid inference does not affect token verification and has no network',async()=>{const f=fixture(),c=await connected(f);f.c.enabled=false;const r=await f.call('/v1/decision','POST',{question_set:'synthetic-smoke-v0',state:{}},rpcHeaders(c.access_token));assert.equal(r.status,503);assert.equal(f.calls.length,0);});
test('provider errors do not reveal upstream secret or body and never auto-retry',async()=>{const f=fixture(),c=await connected(f);let calls=0;const send=(async()=>{calls++;return new Response('FAKE_TYPESAFE_KEY',{status:401})}) as typeof fetch;const r=await app(new Request(ORIGIN+'/v1/decision',{method:'POST',headers:{...rpcHeaders(c.access_token),'content-type':'application/json'},body:JSON.stringify({question_set:'synthetic-smoke-v0',state:{}})}),f.get,f.store,send);assert.equal(r.status,502);assert.equal((await r.json()).error,'PROVIDER_HTTP_401');assert.equal(calls,1);});
test('MCP validates explicit Origin separately from bearer auth',async()=>{const f=fixture(),c=await connected(f);const h=rpcHeaders(c.access_token);assert.equal((await f.call('/mcp','POST',rpc('tools/list'),{...h,origin:'https://evil.test'})).status,403);assert.equal((await f.call('/mcp','POST',rpc('tools/list'),{origin:'https://evil.test',accept:'application/json, text/event-stream'})).status,403);assert.equal((await f.call('/mcp','GET',undefined,h)).status,405);const host=await app(new Request('https://preview.netlify.app/health'),f.get,f.store);assert.equal(host.status,403);});
test('rate limit uses serialized state',async()=>{const s=new Memory();const outcomes=await Promise.allSettled(Array.from({length:12},()=>limit(s,'same',10,60000,1000)));assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,10);});
test('registration rate limiting is bounded',async()=>{const f=fixture();for(let i=0;i<30;i++)await client(f);const r=await f.call('/oauth/register','POST',{redirect_uris:['https://chatgpt.com/callback'],token_endpoint_auth_method:'none'});assert.equal(r.status,429);});
test('form parser rejects duplicate fields',async()=>{await assert.rejects(()=>form(new Request(ORIGIN+'/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:'client_id=a&client_id=b'})));});
test('private connect fragment is absent from delivered HTML and consent page scripts escaped',async()=>{const f=fixture();const page=await f.call('/connect');assert.ok(!((await page.text()).includes(f.owner)));const a=await activate(f),cl=await client(f,'none',{client_name:'<script>alert(1)</script>'});const p=new URLSearchParams({client_id:cl.client_id,redirect_uri:cl.redirect_uris[0],response_type:'code',code_challenge:random(),code_challenge_method:'S256'});const r=await f.call('/oauth/authorize?'+p,'GET',undefined,{cookie:a});const text=await r.text();assert.ok(text.includes('&lt;script&gt;'));assert.ok(!text.includes('<script>alert'));assert.match(r.headers.get('content-security-policy')!,/frame-ancestors 'none'/);assert.match(r.headers.get('content-security-policy')!,/form-action 'self' https:\/\/chatgpt\.com https:\/\/chat\.openai\.com/);});

test('consent decision change never replays an earlier allow code',async()=>{
 const f=fixture(),a=await activate(f),cl=await client(f),co=await code(f,cl,a);
 const r=await postForm(f,'/oauth/authorize',{transaction:co.tx,approve:'no'},{cookie:a,origin:ORIGIN});
 assert.equal(r.status,409);assert.equal(r.headers.get('location'),null);assert.match(await r.text(),/CONSENT_DECISION_CHANGED/);
});
test('consent retry after code expiry is a recoverable page, not an expired redirect',async()=>{
 const f=fixture(),a=await activate(f),cl=await client(f),co=await code(f,cl,a);const real=Date.now;
 try{Date.now=()=>real()+61000;const r=await postForm(f,'/oauth/authorize',{transaction:co.tx,approve:'yes'},{cookie:a,origin:ORIGIN});assert.equal(r.status,409);assert.equal(r.headers.get('location'),null);assert.match(await r.text(),/CONSENT_RESULT_EXPIRED/);}finally{Date.now=real;}
});
test('consent after exchange does not replay an already-consumed code',async()=>{
 const f=fixture(),c=await connected(f);const r=await postForm(f,'/oauth/authorize',{transaction:c.co.tx,approve:'yes'},{cookie:c.cookie,origin:ORIGIN});
 assert.equal(r.status,409);assert.match(await r.text(),/CONSENT_COMPLETED/);assert.equal(r.headers.get('location'),null);
});
test('explicit persistence consent works with actual decisions:read scope only',async()=>{
 const f=fixture(),a=await activate(f),cl=await client(f,'none',{scope:SCOPE}),co=await code(f,cl,a,{scope:SCOPE});
 const r=await token(f,cl,co);assert.equal(r.status,200);const v=await r.json();assert.equal(v.scope,SCOPE);assert.ok(v.refresh_token);assert.equal(v.expires_in,900);
 const renewed=await postForm(f,'/oauth/token',{client_id:cl.client_id,grant_type:'refresh_token',refresh_token:v.refresh_token,resource:RESOURCE});
 assert.equal(renewed.status,200);assert.equal((await renewed.json()).scope,SCOPE);assert.equal(f.calls.length,0);
});
test('refresh after simulated access expiry preserves scope without new consent',async()=>{
 const f=fixture(),a=await activate(f),cl=await client(f,'none',{scope:SCOPE}),co=await code(f,cl,a,{scope:SCOPE});
 const v=await (await token(f,cl,co)).json();const real=Date.now;
 try{Date.now=()=>real()+901000;
  assert.equal((await f.call('/mcp','POST',rpc('tools/list'),rpcHeaders(v.access_token))).status,401);
  const r=await postForm(f,'/oauth/token',{client_id:cl.client_id,grant_type:'refresh_token',refresh_token:v.refresh_token,resource:RESOURCE});assert.equal(r.status,200);
  const n=await r.json();assert.equal((await f.call('/mcp','POST',rpc('tools/list'),rpcHeaders(n.access_token))).status,200);
 }finally{Date.now=real;}
});
test('MCP allows known HTTPS origins and missing origin; rejects opaque origin',async()=>{
 const f=fixture(),c=await connected(f);for(const o of [ORIGIN,'https://chatgpt.com','https://chat.openai.com'])assert.equal((await f.call('/mcp','POST',rpc('tools/list'),{...rpcHeaders(c.access_token),origin:o})).status,200);
 for(const o of ['null','https://chatgpt.com.evil.test','http://chatgpt.com','https://chatgpt.com/path'])assert.equal((await f.call('/mcp','POST',rpc('tools/list'),{...rpcHeaders(c.access_token),origin:o})).status,403);
});
test('repair probe override is release-bound, time-bounded and cannot replace owner',()=>{
 const f=fixture(),p={release:'oauth-recovery-20260920-a',token_sha256:hash(random()),expires_at:Date.now()+1800000};
 const get=(x:string)=>x==='JEV_REPAIR_PROBE'?JSON.stringify(p):f.get(x);
 const c=config(get);assert.equal(c.probe_hash,p.token_sha256);assert.equal(c.owner_hash,f.c.owner_hash);assert.equal(c.key,f.c.key);
 p.expires_at=Date.now()-1;assert.equal(config(get).probe_hash,f.c.probe_hash);
 p.expires_at=Date.now()+1800000;p.release='other';assert.equal(config(get).probe_hash,f.c.probe_hash);
});
test('health identifies the exact repair release without any credentials',async()=>{
 const f=fixture();const r=await (await f.call('/health')).json();assert.equal(r.repair_release,'oauth-recovery-20260920-a');
});
