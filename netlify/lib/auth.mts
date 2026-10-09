import {REPAIR_RELEASE} from './repair_release.mts';
/** Single-owner OAuth service. No third-party identity account or TypeSafe key in browser. */
import {createHash,createHmac,randomBytes,timingSafeEqual} from 'node:crypto';
import {Fault,json,record} from './gateway.mts';
import type {Env} from './gateway.mts';
export const ORIGIN='https://jev-decision-fabric.example';
export const RESOURCE=ORIGIN+'/mcp';
export const SCOPE='decisions:read';
export const COOKIE='__Host-jev-session';
export type Store={get:(k:string)=>Promise<any>; create:(k:string,v:any)=>Promise<boolean>; cas:(k:string,change:(v:any)=>any)=>Promise<any>};
export type AuthConfig={key:string; owner_hash:string; owner_until:number; probe_hash:string; probe_until:number; enabled:boolean};
export function config(get:Env):AuthConfig {
  let c:any; try{c=JSON.parse(get('JEV_AUTH_CONFIG')||'');}catch{throw new Fault('AUTH_NOT_CONFIGURED',503);}
  if(!c || typeof c.key!=='string'||!/^[a-f0-9]{64,128}$/.test(c.key)||typeof c.owner_hash!=='string'||!/^[a-f0-9]{64}$/.test(c.owner_hash)||!Number.isSafeInteger(c.owner_until)||typeof c.probe_hash!=='string'||!/^[a-f0-9]{64}$/.test(c.probe_hash)||!Number.isSafeInteger(c.probe_until)||typeof c.enabled!=='boolean') throw new Fault('AUTH_NOT_CONFIGURED',503);
  // Optional, one-use CI probe is separate from the owner's enrollment and expires.
  // It cannot change signing keys, owner hashes, grants or the live switch.
  const raw=get('JEV_REPAIR_PROBE');
  if(raw){try{const p=JSON.parse(raw);const now=Date.now();
   if(p.release===REPAIR_RELEASE&&/^[a-f0-9]{64}$/.test(p.token_sha256)&&Number.isSafeInteger(p.expires_at)&&p.expires_at>now&&p.expires_at<=now+3600000){
    return {...c,probe_hash:p.token_sha256,probe_until:p.expires_at};
   }
  }catch{}}
  return c;
}
export function hash(s:string){return createHash('sha256').update(s).digest('hex');}
export function equal(a:string,b:string){if(typeof a!=='string'||typeof b!=='string')return false;const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);}
export function random(){return randomBytes(32).toString('base64url');}
export function sign(kind:string,data:any,c:AuthConfig,ttl:number,now=Date.now()){
 const p=Buffer.from(JSON.stringify({...data,kind,iss:ORIGIN,iat:Math.floor(now/1000),exp:Math.floor(now/1000)+ttl})).toString('base64url');
 return p+'.'+createHmac('sha256',Buffer.from(c.key,'hex')).update(kind+'.'+p).digest('base64url');
}
export function verify(token:unknown,kind:string,c:AuthConfig,now=Date.now()):any {
 if(typeof token!=='string'||token.length>16000)throw new Fault('INVALID_TOKEN',401);
 const parts=token.split('.');if(parts.length!==2)throw new Fault('INVALID_TOKEN',401);
 const [p,mac]=parts;const expected=createHmac('sha256',Buffer.from(c.key,'hex')).update(kind+'.'+p).digest('base64url');
 if(!equal(mac,expected))throw new Fault('INVALID_TOKEN',401);
 let d:any;try{d=JSON.parse(Buffer.from(p,'base64url').toString());}catch{throw new Fault('INVALID_TOKEN',401);}
 if(!record(d)||d.kind!==kind||d.iss!==ORIGIN||!Number.isSafeInteger(d.exp)||!Number.isSafeInteger(d.iat)||d.exp<=now/1000||d.iat>now/1000+10)throw new Fault('INVALID_TOKEN',401);
 return d;
}
export function challenge(){return `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource", scope="${SCOPE}"`;}
export function protectedMetadata(){return {resource:RESOURCE,authorization_servers:[ORIGIN],scopes_supported:[SCOPE,'offline_access'],bearer_methods_supported:['header'],resource_name:'Jev Decision Fabric'};}
export function serverMetadata(){return {issuer:ORIGIN,authorization_endpoint:ORIGIN+'/oauth/authorize',token_endpoint:ORIGIN+'/oauth/token',registration_endpoint:ORIGIN+'/oauth/register',revocation_endpoint:ORIGIN+'/oauth/revoke',response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],token_endpoint_auth_methods_supported:['none','client_secret_post','client_secret_basic'],code_challenge_methods_supported:['S256'],scopes_supported:[SCOPE,'offline_access'],authorization_response_iss_parameter_supported:true};}
export function validRedirect(s:unknown):s is string {
 if(typeof s!=='string'||s.length>2048)return false;
 try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password&&!u.hash&&!u.port&&['chatgpt.com','chat.openai.com'].includes(u.hostname)&&u.pathname!=='/';}catch{return false;}
}
export function scopes(s:unknown){if(s===undefined||s===null||s==='')return SCOPE+' offline_access';if(typeof s!=='string')throw new Fault('invalid_scope');const a=[...new Set(s.split(' ').filter(Boolean))];if(!a.includes(SCOPE)||a.some(x=>![SCOPE,'offline_access'].includes(x)))throw new Fault('invalid_scope');return a.join(' ');}
export function cookie(req:Request){return req.headers.get('cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);}
export function session(req:Request,c:AuthConfig){const d=verify(cookie(req),'session',c);if(!['owner','probe'].includes(d.sub))throw new Fault('INVALID_SESSION',401);return d;}
function htmlEscape(s:string){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));}
export function html(body:string,nonce:string,headers:Record<string,string>={}){return new Response(`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Jev 接続</title><link rel="stylesheet" href="/style.css"><main>${body}</main></html>`,{headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':`default-src 'none'; style-src 'self'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self' https://chatgpt.com https://chat.openai.com; base-uri 'none'; frame-ancestors 'none'`,...headers}});}
export function connectPage(){const n=random();return html(`<h1>このブラウザをJevに接続</h1><p>この専用リンクで、あなたのブラウザだけに接続許可を保存します。TypeSafeのキーを入力する必要はありません。</p><p>リンクは他人へ共有しないでください。1回だけ使用できます。</p><button id="go">このブラウザを許可</button><p id="status" role="status"></p><script nonce="${n}">const token=location.hash.slice(1);history.replaceState(null,'','/connect');const b=document.getElementById('go'),s=document.getElementById('status');if(!token){b.disabled=true;s.textContent='専用リンクを開いてください。既に許可済みならChatGPTの接続画面へ戻ってください。'}b.onclick=async()=>{b.disabled=true;s.textContent='確認中…';try{const r=await fetch('/oauth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});if(!r.ok)throw Error();location.replace('/connected')}catch{s.textContent='リンクが期限切れ、使用済み、または接続に失敗しました。ChatGPTへこの表示を伝えてください。'}};</script>`,n);}
export function connectedPage(){return html('<h1>ブラウザの許可を保存しました</h1><p>同じブラウザでChatGPTの「新規プラグイン」へ戻ってください。</p><p>URL：</p><code>'+RESOURCE+'</code><p>認証：OAuth。接続時に表示されるJev画面で「許可して戻る」を押します。</p><p>この画面にはTypeSafeキーはありません。</p>',random());}
export async function limit(store:Store,key:string,max:number,window:number,now=Date.now()){
 const bucket=Math.floor(now/window);await store.cas('rate/'+hash(key)+'/'+bucket,v=>{const n=(v?.n||0)+1;if(n>max)throw new Fault('RATE_LIMITED',429);return {n,until:(bucket+1)*window};});
}
export async function register(body:any,store:Store,c:AuthConfig,ip:string){
 if(!record(body)||!Array.isArray(body.redirect_uris)||body.redirect_uris.length<1||body.redirect_uris.length>5||!body.redirect_uris.every(validRedirect))throw new Fault('invalid_redirect_uri');
 const method=body.token_endpoint_auth_method||'client_secret_basic';
 if(!['none','client_secret_basic','client_secret_post'].includes(method))throw new Fault('invalid_client_metadata');
 if(body.grant_types&&(!Array.isArray(body.grant_types)||body.grant_types.some((x:any)=>!['authorization_code','refresh_token'].includes(x))))throw new Fault('invalid_client_metadata');
 if(body.response_types&&(!Array.isArray(body.response_types)||body.response_types.some((x:any)=>x!=='code')))throw new Fault('invalid_client_metadata');
 await limit(store,'register-'+ip,30,3600000);
 const client_id=random(),secret=method==='none'?undefined:random();
 const cl={client_id,redirect_uris:[...new Set(body.redirect_uris)],token_endpoint_auth_method:method,secret_hash:secret?hash(secret):null,client_name:typeof body.client_name==='string'?body.client_name.slice(0,100):'ChatGPT',scope:scopes(body.scope)};
 if(!await store.create('client/'+client_id,cl))throw new Fault('registration_failed',503);
 return {...cl,secret_hash:undefined,client_secret:secret,client_id_issued_at:Math.floor(Date.now()/1000),client_secret_expires_at:0,grant_types:['authorization_code','refresh_token'],response_types:['code']};
}
export async function activate(req:Request,body:any,store:Store,c:AuthConfig){
 if(req.headers.get('origin')!==ORIGIN)throw new Fault('ORIGIN_NOT_ALLOWED',403);
 const t=body?.token;if(typeof t!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(t))throw new Fault('INVALID_LINK',401);
 const h=hash(t);let sub='';if(equal(h,c.owner_hash)&&Date.now()<c.owner_until)sub='owner';else if(equal(h,c.probe_hash)&&Date.now()<c.probe_until)sub='probe';else throw new Fault('INVALID_LINK',401);
 if(!await store.create('enroll/'+h,{used_at:Date.now()}))throw new Fault('LINK_ALREADY_USED',409);
 const ttl=sub==='owner'?30*86400:900;return json({connected:true},200,{'set-cookie':`${COOKIE}=${sign('session',{sub,sid:random()},c,ttl)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${ttl}`});
}
export async function authorization(req:Request,store:Store,c:AuthConfig,body?:any){
 const initial=async(p:URLSearchParams)=>{
  for(const k of ['client_id','redirect_uri','resource','scope','state','code_challenge','code_challenge_method','response_type'])if(p.getAll(k).length>1)throw new Fault('invalid_request');
  const cid=p.get('client_id')||'';if(!/^[A-Za-z0-9_-]{43}$/.test(cid))throw new Fault('invalid_client');const cl=await store.get('client/'+cid);
  const red=p.get('redirect_uri');if(!cl||!validRedirect(red)||!cl.redirect_uris.includes(red))throw new Fault('invalid_redirect_uri');
  if(p.get('response_type')!=='code'||p.get('code_challenge_method')!=='S256'||!/^[A-Za-z0-9_-]{43}$/.test(p.get('code_challenge')||''))throw new Fault('invalid_request');
  if(p.has('resource')&&p.get('resource')!==RESOURCE)throw new Fault('invalid_target');
  const scope=scopes(p.get('scope'));if(scope.split(' ').some(x=>!cl.scope.split(' ').includes(x)))throw new Fault('invalid_scope');const state=p.get('state')||'';if(state.length>2048)throw new Fault('invalid_request');
  let s:any;try{s=session(req,c);}catch{return html('<h1>本人確認が必要です</h1><p>ChatGPTから受け取った「ブラウザを許可する」専用リンクを同じブラウザで一度開いてから、この画面を再読込してください。</p><p>TypeSafeのAPIキーは、ここへ入力しません。</p>',random());}
  const tx=sign('consent',{refresh_consent:true,cid,redirect_uri:red,scope,state,challenge:p.get('code_challenge'),sid:s.sid,sub:s.sub,jti:random()},c,300);
  return html(`<h1>ChatGPTへJevの利用を許可</h1><p>接続先：${htmlEscape(cl.client_name)}</p><p>チャットが選んだ状態をTypeSafeへ送り、判断と確率を受け取ります。TypeSafeのAPI使用料が発生します。GitHub・曲・スプレッドシートの書き換えや自動配送は行いません。</p><p>許可すると、同じ権限で接続を最長30日間更新します。APIキーそのものはChatGPTへ渡しません。</p><form method="POST" action="/oauth/authorize"><input type="hidden" name="transaction" value="${htmlEscape(tx)}"><button name="approve" value="yes">許可して戻る</button> <button name="approve" value="no">キャンセル</button></form><p>送信後に動かない場合は連打せず、ChatGPT側の接続状態を確認してください。</p>`,random());
 };
 if(req.method==='GET')return initial(new URL(req.url).searchParams);
 if(req.method==='POST'){
  // Some OAuth clients initiate authorization with form POST instead of query GET.
  // Treat such a POST as a read-only authorization request; only our signed consent
  // transaction is a state-changing POST and remains same-origin protected below.
  if(record(body)&&!Object.hasOwn(body,'transaction')){
   const p=new URLSearchParams();
   for(const k of ['client_id','redirect_uri','resource','scope','state','code_challenge','code_challenge_method','response_type']){
    const v=body[k];if(typeof v==='string')p.set(k,v);else if(v!==undefined&&v!==null)throw new Fault('invalid_request');
   }
   return initial(p);
  }
  // Consent remains protected by the HttpOnly SameSite session cookie plus a signed,
  // single-use transaction bound to that session. Origin is not used as OAuth client auth.
  const s=session(req,c),tx=verify(body?.transaction,'consent',c);
  if(tx.sid!==s.sid||tx.sub!==s.sub)throw new Fault('CSRF_MISMATCH',403);
  const cl=await store.get('client/'+tx.cid);if(!cl||!cl.redirect_uris.includes(tx.redirect_uri))throw new Fault('invalid_client');
  if(!['yes','no'].includes(body?.approve))throw new Fault('invalid_request');
  const decision=body.approve;
  const consentKey='consent/'+tx.jti;
  const existing=await store.get(consentKey);
  const replay=async(prior:any)=>{
   if(!prior||prior.sid!==s.sid||prior.sub!==s.sub||prior.cid!==tx.cid||typeof prior.location!=='string')throw new Fault('CONSENT_ALREADY_USED',409);
   if(prior.decision!==decision)return consentRecovery('CONSENT_DECISION_CHANGED','この同意は別の選択ですでに処理されています。過去の許可へ読み替えません。');
   if(prior.expires_at<=Date.now())return consentRecovery('CONSENT_RESULT_EXPIRED','同意の転送先の有効期限が切れました。古い認可コードは再送しません。');
   if(prior.code_hash&&await store.get('code-used/'+prior.code_hash))return consentRecovery('CONSENT_COMPLETED','この同意は受け付け済みです。ChatGPT側の接続状態を確認してください。');
   return new Response(null,{status:303,headers:{location:prior.location,'cache-control':'no-store','referrer-policy':'no-referrer'}});
  };
  if(existing)return replay(existing);
  const r=new URL(tx.redirect_uri);r.searchParams.set('iss',ORIGIN);r.searchParams.set('state',tx.state);
  let code:string|undefined;
  if(decision==='no')r.searchParams.set('error','access_denied');
  else {code=sign('code',{...tx,jti:random(),aud:RESOURCE},c,60);r.searchParams.set('code',code);}
  const location=r.toString();
  const expires_at=code?verify(code,'code',c).exp*1000:tx.exp*1000;
  const saved={used_at:Date.now(),sid:s.sid,sub:s.sub,cid:tx.cid,decision,location,expires_at,code_hash:code?hash(code):null};
  if(!await store.create(consentKey,saved))return replay(await store.get(consentKey));
  return new Response(null,{status:303,headers:{location,'cache-control':'no-store','referrer-policy':'no-referrer'}});
 }
 throw new Fault('METHOD_NOT_ALLOWED',405);
}

function consentRecovery(code:string,message:string){
 const r=html('<h1>接続の状態を確認してください</h1><p>'+message+'</p><p>未接続の場合は、ChatGPTの既存プラグインから新しい認証を開始してください。APIキーや本人登録をやり直す必要はありません。</p><p>診断：<code>'+code+'</code></p>',random());
 return new Response(r.body,{status:409,headers:r.headers});
}
async function clientAuth(req:Request,p:any,store:Store){
 let cid=p.client_id,secret=p.client_secret;const b=req.headers.get('authorization');
 if(b){if(!b.startsWith('Basic ')||p.client_secret)throw new Fault('invalid_client',401);let x:string;try{x=Buffer.from(b.slice(6),'base64').toString('utf8');const pos=x.indexOf(':');if(pos<1)throw new Error('malformed Basic');cid=decodeURIComponent(x.slice(0,pos));secret=decodeURIComponent(x.slice(pos+1));}catch{throw new Fault('invalid_client',401);}if(p.client_id&&p.client_id!==cid)throw new Fault('invalid_client',401);}
 if(typeof cid!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(cid))throw new Fault('invalid_client',401);
 const cl=await store.get('client/'+cid);if(!cl)throw new Fault('invalid_client',401);
 const m=cl.token_endpoint_auth_method;
 if(m==='none'){if(secret||b)throw new Fault('invalid_client',401);}
 else if(typeof secret!=='string'||!equal(hash(secret),cl.secret_hash)||(m==='client_secret_basic'&&!b)||(m==='client_secret_post'&&!!b))throw new Fault('invalid_client',401);
 return cl;
}
function tokens(g:any,c:AuthConfig){const remain=Math.floor((g.until-Date.now())/1000),ttl=Math.min(900,remain);if(ttl<=0)throw new Fault('invalid_grant');return {access_token:sign('access',{sub:g.sub,gid:g.gid,cid:g.cid,aud:RESOURCE,scope:g.scope},c,ttl),token_type:'Bearer',expires_in:ttl,scope:g.scope,...((g.refresh_consent===true||g.scope.split(' ').includes('offline_access'))?{refresh_token:sign('refresh',{gid:g.gid,cid:g.cid,aud:RESOURCE,seq:g.seq},c,remain)}:{})};}
export async function exchange(req:Request,p:any,store:Store,c:AuthConfig){
 const cl=await clientAuth(req,p,store);if(p.resource&&p.resource!==RESOURCE)throw new Fault('invalid_target');
 if(p.grant_type==='authorization_code'){
  let d:any;try{d=verify(p.code,'code',c);}catch{throw new Fault('invalid_grant');}
  if(d.cid!==cl.client_id||d.redirect_uri!==p.redirect_uri||d.aud!==RESOURCE||!cl.redirect_uris.includes(d.redirect_uri)||typeof p.code_verifier!=='string'||!/^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier))throw new Fault('invalid_grant');
  const ch=createHash('sha256').update(p.code_verifier).digest('base64url');if(!equal(ch,d.challenge))throw new Fault('invalid_grant');
  if(!await store.create('code-used/'+hash(p.code),{used_at:Date.now()}))throw new Fault('invalid_grant');
  const g={gid:random(),cid:cl.client_id,sub:d.sub,scope:d.scope,refresh_consent:d.refresh_consent===true,seq:0,revoked:false,until:Date.now()+(d.sub==='probe'?900000:30*86400000)};
  if(!await store.create('grant/'+g.gid,g))throw new Fault('STATE_BUSY',503);return tokens(g,c);
 }
 if(p.grant_type==='refresh_token'){
  let d:any;try{d=verify(p.refresh_token,'refresh',c);}catch{throw new Fault('invalid_grant');}
  if(d.cid!==cl.client_id||d.aud!==RESOURCE)throw new Fault('invalid_grant');
  const g=await store.cas('grant/'+d.gid,v=>{if(!v||v.revoked||v.until<=Date.now()||v.cid!==cl.client_id||v.seq!==d.seq)throw new Fault('invalid_grant');if(p.scope&&scopes(p.scope)!==v.scope)throw new Fault('invalid_scope');return {...v,seq:v.seq+1};});
  return tokens(g,c);
 }
 throw new Fault('unsupported_grant_type');
}
export async function bearer(req:Request,store:Store,c:AuthConfig){
 const t=req.headers.get('authorization')?.match(/^Bearer ([^\s]+)$/i)?.[1];let d:any;try{d=verify(t,'access',c);}catch{throw new Fault('UNAUTHORIZED',401);}
 if(d.aud!==RESOURCE||!d.scope?.split(' ').includes(SCOPE)||!['owner','probe'].includes(d.sub))throw new Fault('UNAUTHORIZED',401);
 const g=await store.get('grant/'+d.gid);if(!g||g.revoked||g.until<=Date.now()||g.cid!==d.cid||g.sub!==d.sub||g.scope!==d.scope)throw new Fault('UNAUTHORIZED',401);return d;
}
export async function revoke(req:Request,p:any,store:Store,c:AuthConfig){
 const cl=await clientAuth(req,p,store);let d:any;try{d=verify(p.token,'refresh',c);}catch{try{d=verify(p.token,'access',c);}catch{return {};}}
 if(d.cid===cl.client_id)await store.cas('grant/'+d.gid,v=>v?{...v,revoked:true}:null);return {};
}
export async function form(req:Request){if(!req.headers.get('content-type')?.startsWith('application/x-www-form-urlencoded'))throw new Fault('FORM_REQUIRED',415);const data=await boundedText(req,20000);const p=new URLSearchParams(data),o:any=Object.create(null);for(const [k,v]of p){if(Object.hasOwn(o,k))throw new Fault('invalid_request');o[k]=v;}return o;}
async function boundedText(req:Request,max:number){const reader=req.body?.getReader();if(!reader)throw new Fault('invalid_request');let n=0;const chunks:Uint8Array[]=[];for(;;){const {done,value}=await reader.read();if(done)break;n+=value.length;if(n>max){await reader.cancel();throw new Fault('BODY_TOO_LARGE',413);}chunks.push(value);}return Buffer.concat(chunks).toString('utf8');}
