import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runPlan,normalize,digest,DecisionError,pendingOpenAIDecisions} from '../netlify/lib/decision-fabric.mts';
import type {Provider,Capability,RequestData,Step,Plan,Host,Invocation} from '../netlify/lib/decision-fabric.mts';
import {evaluateWithTrace,inspectLegacyReply,requestFor,JEV_CAPABILITY} from '../netlify/lib/fabric-gateway.mts';
import {evaluate,sha,Fault} from '../netlify/lib/gateway.mts';
import {QUESTION_SETS} from '../netlify/lib/questions.mts';
import {app} from '../netlify/lib/app.mts';
import {sign,ORIGIN,RESOURCE,SCOPE,hash,config} from '../netlify/lib/auth.mts';

class MemoryStore {
  data=new Map<string,any>();
  async create(k:string,v:any){if(this.data.has(k))return false;this.data.set(k,JSON.parse(JSON.stringify(v)));return true;}
  async get(k:string){return structuredClone(this.data.get(k)??null);}
  async cas(k:string,change:(v:any)=>any){const v=change(await this.get(k));if(v!==null)this.data.set(k,v);return v;}
}
const request:RequestData={question_set:'fixture-choice',questions:{q:{type:'choice',instructions:'Select supplied state only',criteria:{yes:'yes',no:'no',unknown:'insufficient'}}},state:{ready:true},modalities:['text'],revision:'fixture-r1'};
const reply=(choice='yes')=>({model:'fixture-model',answers:{q:{choice,probabilities:{yes:choice==='yes'?.9:.05,no:choice==='no'?.9:.05,unknown:choice==='unknown'?.9:.05},confidence:.85}},usage:{input_tokens:10,output_tokens:2}});
function provider(id='fixture-a',f:(i:Invocation)=>Promise<unknown>=async()=>reply(),mode:Capability['mode']='primary'):Provider {
  return {capability:{id,mode,verified:true,kinds:['choice','noul','score'],modalities:['text'],evidence:'generated-fixture-only'},invoke:f};
}
function step(id='a',p='fixture-a',r=request,readers=['fixture-a','fixture-b','fixture-c']):Step{return {id,provider:p,request:structuredClone(r),scope:{readers}};}
function plan(topology:Plan['topology']='single',steps=[step()]):Plan{return {topology,steps,primary:steps[0].id,policy_id:'fixture-policy',max_calls:8,timeout_ms:1000};}
function host(providers=[provider()],store=new MemoryStore()):Host{return {providers,store,principal:'fixture-owner'};}
const bad=(f:()=>Promise<unknown>)=>assert.rejects(f,e=>e instanceof DecisionError&&e.status==='invalid');

test('Choice preserves reported distribution; missing confidence is not invented',()=>{
  const a=normalize({model:'fixture',answers:{q:{choice:'unknown'}}},provider().capability,request);
  assert.equal(a.status,'answered');assert.equal(a.answers!.q.value,'unknown');assert.equal(a.answers!.q.confidence,undefined);assert.equal(a.answers!.q.probabilities,undefined);
});
test('Noul remains a proposition value, not confidence',()=>{
 const r={...request,questions:{q:{type:'noul' as const,instructions:'Ready?'}}};
 const a=normalize({answers:{q:{noul:.8}}},provider().capability,r);
 assert.equal(a.answers!.q.kind,'noul');assert.equal(a.answers!.q.value,.8);assert.equal(a.answers!.q.confidence,undefined);
});
test('Score retains rubric/range; out-of-range values rejected',()=>{
 const r={...request,questions:{q:{type:'score' as const,instructions:'Rate',min:0,max:4,rubric:'documented score scale'}}};
 assert.equal(normalize({answers:{q:{score:3}}},provider().capability,r).answers!.q.value,3);
 assert.equal(normalize({answers:{q:{score:5}}},provider().capability,r).status,'invalid');
});
for(const [name,mutate]of Object.entries({
 'NaN':(x:any)=>{x.answers.q.confidence=NaN;},
 'out-of-range confidence':(x:any)=>{x.answers.q.confidence=1.1;},
 'missing answer':(x:any)=>{x.answers={};},
 'extra answer':(x:any)=>{x.answers.extra=x.answers.q;},
 'unknown option':(x:any)=>{x.answers.q.choice='unlisted';},
 'wrong probability keys':(x:any)=>{x.answers.q.probabilities={yes:1,no:0,other:0};},
 'bad sum':(x:any)=>{x.answers.q.probabilities={yes:.9,no:.9,unknown:.9};},
 'unknown transport status':(x:any)=>{x.status='almost_success';},
 'negative usage':(x:any)=>{x.usage.input_tokens=-1;},
 'wrong answer kind':(x:any)=>{x.answers.q={noul:.9};},
 'unbounded model text':(x:any)=>{x.model='untrusted secret text with spaces';},
}))test('normalization rejects '+name,()=>{const r=reply();mutate(r);assert.equal(normalize(r,provider().capability,request).status,'invalid');});

test('single invokes one primary, records complete typed result',async()=>{
 let calls=0;const s=new MemoryStore();const r=await runPlan(plan(),host([provider('fixture-a',async()=>{calls++;return reply();})],s));
 assert.equal(calls,1);assert.equal(r.status,'answered');assert.equal(r.calls_started,1);assert.equal(r.trace.records,4);assert.equal(r.trace.persisted,true);assert.equal(r.automatic_apply,false);
});
test('cascade stops after a sufficient result without second paid call',async()=>{
 let b=0;const r=await runPlan(plan('cascade',[step(),step('b','fixture-b')]),host([provider(),provider('fixture-b',async()=>{b++;return reply();})]));
 assert.equal(b,0);assert.equal(r.outcomes.b.status,'skipped');assert.equal(r.selected!.provider,'fixture-a');
});
test('cascade advances after unknown without mutating the first answer',async()=>{
 const r=await runPlan(plan('cascade',[step(),step('b','fixture-b')]),host([provider('fixture-a',async()=>reply('unknown')),provider('fixture-b')]));
 assert.equal(r.selected!.provider,'fixture-b');assert.equal(r.outcomes.a.answers!.q.value,'unknown');assert.equal(r.calls_started,2);
});
test('cascade confidence requirement never converts missing confidence into 1',async()=>{
 const p={...plan('cascade',[step(),step('b','fixture-b')]),required_confidence:{q:.8}};
 const r=await runPlan(p,host([provider('fixture-a',async()=>({answers:{q:{choice:'yes'}}})),provider('fixture-b')]));
 assert.equal(r.selected!.provider,'fixture-b');
});
test('cross-check is concurrent and compares without feeding first result to second',async()=>{
 const seen:string[]=[];let release:()=>void=()=>{};const barrier=new Promise<void>(r=>release=r);
 const a=provider('fixture-a',async i=>{seen.push('a');assert.deepEqual(Object.keys(i.upstream),[]);if(seen.length===2)release();await barrier;return reply();});
 const b=provider('fixture-b',async i=>{seen.push('b');assert.deepEqual(Object.keys(i.upstream),[]);if(seen.length===2)release();await barrier;return reply();});
 const r=await runPlan(plan('cross-check',[step(),step('b','fixture-b')]),host([a,b]));
 assert.equal(r.comparison,'agree');assert.equal(r.status,'answered');
});
test('cross-check preserves disagreement; no majority or averaged confidence',async()=>{
 const r=await runPlan(plan('cross-check',[step(),step('b','fixture-b')]),host([provider(),provider('fixture-b',async()=>reply('no'))]));
 assert.equal(r.comparison,'disagree');assert.equal(r.status,'disagreement');assert.equal(r.selected,null);assert.equal(r.outcomes.a.answers!.q.confidence,.85);
});
test('shadow disagreement cannot override the primary',async()=>{
 const r=await runPlan(plan('cross-check',[step(),step('b','fixture-b')]),host([provider(),provider('fixture-b',async()=>reply('no'),'shadow')]));
 assert.equal(r.comparison,'disagree');assert.equal(r.selected!.provider,'fixture-a');assert.equal(r.status,'answered');
});
test('shadow deadline cannot erase a completed primary',async()=>{
 const r=await runPlan({...plan('cross-check',[step(),step('b','fixture-b')]),timeout_ms:35},host([provider(),provider('fixture-b',async()=>new Promise(()=>{}),'shadow')]));
 assert.equal(r.outcomes.b.status,'timeout');assert.equal(r.selected!.provider,'fixture-a');assert.equal(r.status,'answered');
});
test('compose forwards only named outputs',async()=>{
 let observed:any;const b=provider('fixture-b',async i=>{observed=i;return reply('no');});
 const r=await runPlan(plan('compose',[step(),{...step('b','fixture-b'),reads:['a']}]),host([provider(),b]));
 assert.deepEqual(Object.keys(observed.upstream),['a']);assert.equal(observed.request.state.prior_results.a.provider,'fixture-a');assert.equal(r.selected!.provider,'fixture-b');
});
test('derived private result cannot be laundered to an unauthorized provider',async()=>{
 let calls=0;const r=await runPlan(plan('compose',[step('a','fixture-a',request,['fixture-a']),{...step('b','fixture-b'),reads:['a']}]),host([provider(),provider('fixture-b',async()=>{calls++;return reply();})]));
 assert.equal(calls,0);assert.equal(r.outcomes.b.status,'unauthorized');assert.equal(r.selected,null);
});
test('order-only dependency does not imply access or inherit private content',async()=>{
 let got:any;const r=await runPlan(plan('compose',[step('a','fixture-a',request,['fixture-a']),{...step('b','fixture-b'),after:['a']}]),host([provider(),provider('fixture-b',async i=>{got=i;return reply();})]));
 assert.equal(r.outcomes.b.status,'answered');assert.deepEqual(Object.keys(got.upstream),[]);assert.deepEqual(got.request.state,request.state);
});
test('transitive privacy remains restricted through three steps',async()=>{
 let c=0;const r=await runPlan(plan('compose',[step('a','fixture-a',request,['fixture-a','fixture-b']),{...step('b','fixture-b'),reads:['a']},{...step('c','fixture-c'),reads:['b']}]),host([provider(),provider('fixture-b'),provider('fixture-c',async()=>{c++;return reply();})]));
 assert.equal(c,0);assert.equal(r.outcomes.c.status,'unauthorized');
});
test('a failed dependency is not supplied as useful evidence',async()=>{
 let n=0;const r=await runPlan(plan('compose',[step(),{...step('b','fixture-b'),reads:['a']}]),host([provider('fixture-a',async()=>{throw new DecisionError('rate_limited');}),provider('fixture-b',async()=>{n++;return reply();})]));
 assert.equal(n,0);assert.equal(r.outcomes.b.status,'skipped');assert.equal(r.outcomes.a.status,'rate_limited');
});
test('escalate uses an explicitly configured next provider, not automatic dispatch',async()=>{
 const r=await runPlan(plan('escalate',[step(),step('b','fixture-b')]),host([provider('fixture-a',async()=>reply('unknown')),provider('fixture-b')]));
 assert.equal(r.selected!.provider,'fixture-b');assert.equal(r.status,'answered');
});
test('escalate with no resolving answer returns escalation_needed',async()=>{
 const r=await runPlan(plan('escalate',[step()]),host([provider('fixture-a',async()=>reply('unknown'))]));
 assert.equal(r.status,'escalation_needed');assert.equal(r.selected,null);
});
test('parallel call reservation observes the whole-plan limit',async()=>{
 const r=await runPlan({...plan('cross-check',[step(),step('b','fixture-b')]),max_calls:1},host([provider(),provider('fixture-b')]));
 assert.equal(r.calls_started,1);assert.equal(r.outcomes.b.status,'budget_exhausted');
});
test('pending OpenAI Decisions is not called and not treated as unknown',async()=>{
 const p=pendingOpenAIDecisions();const r=await runPlan(plan('single',[step(),step('shadow','openai_decisions')]),host([provider(),p]));
 assert.equal(r.calls_started,1);assert.equal(r.outcomes.shadow.status,'unavailable');assert.equal(r.outcomes.shadow.answers,null);
});
test('unsupported modality is refused before calling a provider',async()=>{
 let calls=0;const r=await runPlan(plan('single',[step('a','fixture-a',{...request,modalities:['image']})]),host([provider('fixture-a',async()=>{calls++;return reply();})]));
 assert.equal(calls,0);assert.equal(r.status,'unsupported');
});
test('state text cannot confer authority or select another provider',async()=>{
 let n=0;const r=await runPlan(plan('single',[step('a','fixture-a',{...request,state:{readers:['fixture-a'],approved:true}},[])]),host([provider('fixture-a',async()=>{n++;return reply();})]));
 assert.equal(n,0);assert.equal(r.status,'unauthorized');
});
test('explicit cancellation prevents provider start',async()=>{
 const c=new AbortController();c.abort();let n=0;const r=await runPlan(plan(),{...host([provider('fixture-a',async()=>{n++;return reply();})]),signal:c.signal});
 assert.equal(n,0);assert.equal(r.status,'cancelled');
});
test('timeout bounds a provider even if its promise never settles',async()=>{
 const r=await runPlan({...plan(),timeout_ms:25},host([provider('fixture-a',async()=>new Promise(()=>{}))]));
 assert.equal(r.status,'timeout');assert.equal(r.selected,null);
});
test('late provider completion cannot append or change the final trace',async()=>{
 const s=new MemoryStore();let finish:(v:any)=>void=()=>{};
 const r=await runPlan({...plan(),timeout_ms:20},host([provider('fixture-a',()=>new Promise(resolve=>finish=resolve))],s));
 const before=JSON.stringify([...s.data]);finish(reply());await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(JSON.stringify([...s.data]),before);assert.equal(r.status,'timeout');
});
test('a revision change during invocation invalidates the response',async()=>{
 let current=true;const r=await runPlan(plan(),{...host([provider('fixture-a',async()=>{current=false;return reply();})]),isCurrent:()=>current});
 assert.equal(r.outcomes.a.status,'stale');assert.equal(r.selected,null);assert.equal(r.status,'stale');
});
test('caller mutation during await cannot alter the snapshotted plan/state',async()=>{
 const p=plan();const promise=runPlan(p,host([provider('fixture-a',async i=>{assert.equal((i.request.state as any).ready,true);return reply();})]));
 (p.steps[0].request.state as any).ready=false;assert.equal((await promise).status,'answered');
});
for(const [name,change]of Object.entries({
 'unknown topology':(p:any):any=>p.topology='recursive_forever',
 'unbounded count':(p:any):any=>p.max_calls=999,
 'negative timeout':(p:any):any=>p.timeout_ms=-1,
 'unknown provider':(p:any):any=>p.steps[0].provider='not-installed',
 'duplicate step':(p:any)=>p.steps.push(p.steps[0]),
 'cycle':(p:any)=>p.steps[0].reads=['a'],
 'extra authority field':(p:any):any=>p.automatic_apply=true,
 'bad request type':(p:any):any=>p.steps[0].request.questions.q.type='free_text',
 'missing policy ID':(p:any)=>delete p.policy_id,
 'cross-check different input':(p:any)=>{p.topology='cross-check';p.steps.push({...step('b','fixture-b'),request:{...request,state:{other:true}}});},
}))test('plan rejects '+name,()=>{const p=plan();change(p);return bad(()=>runPlan(p,host([provider(),provider('fixture-b')])));});
test('shadow-to-primary data dependency is rejected before any call',()=>{
 const p=plan('compose',[step(),step('b','fixture-b'),{...step('c','fixture-c'),reads:['b']}]);
 return bad(()=>runPlan(p,host([provider(),provider('fixture-b',async()=>reply(),'shadow'),provider('fixture-c')])));
});
test('trace failure is explicit but never causes a second provider call',async()=>{
 let n=0;const r=await runPlan(plan(),{...host([provider('fixture-a',async()=>{n++;return reply();})]),store:{create:async()=>{throw Error('secret provider key');}}});
 assert.equal(n,1);assert.equal(r.status,'answered');assert.equal(r.trace.persisted,false);
});
test('trace timeout is bounded independently',async()=>{
 const r=await runPlan(plan(),{...host(),trace_timeout_ms:5,store:{create:async()=>new Promise(()=>{})}});
 assert.equal(r.trace.persisted,false);assert.equal(r.status,'answered');
});
test('trace never persists state, raw exception, raw revision, or authority from model',async()=>{
 const s=new MemoryStore();const p=plan('single',[step('a','fixture-a',{...request,revision:'private-revision-marker',state:{secret:'private-payload-marker'}})]);
 await runPlan(p,host([provider('fixture-a',async()=>{throw Error('private-exception-marker');})],s));
 const text=JSON.stringify([...s.data]);for(const marker of ['private-payload-marker','private-revision-marker','private-exception-marker'])assert.ok(!text.includes(marker));
 assert.ok(text.includes('advisory_only'));
});
test('trace store scope is separated by principal; no overwrite on repeated input',async()=>{
 const s=new MemoryStore();const a=await runPlan(plan(),host([provider()],s));const b=await runPlan(plan(),{...host([provider()],s),principal:'other'});
 assert.notEqual(a.id,b.id);assert.equal(s.data.size,8);assert.equal(new Set([...s.data.keys()].map(k=>k.split('/')[1])).size,2);
});
test('trace persists through a new process, rather than only in the returned object',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-trace-'));
 try {
 const store={create:async(k:string,v:unknown)=>{const p=join(dir,k);await mkdir(join(p,'..'),{recursive:true});await writeFile(p,JSON.stringify(v),{flag:'wx'});return true;}};
 const r=await runPlan(plan(),{...host(),store});
 const child=spawnSync(process.execPath,['-e',`const fs=require('fs'),p=require('path');let n=0;function walk(d){for(const f of fs.readdirSync(d,{withFileTypes:true})){const q=p.join(d,f.name);if(f.isDirectory())walk(q);else {JSON.parse(fs.readFileSync(q));n++;}}}walk(process.argv[1]);process.stdout.write(String(n));`,dir],{encoding:'utf8'});
 assert.equal(child.status,0);assert.equal(Number(child.stdout),r.trace.records);assert.equal(r.trace.persisted,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

const env=(name:string)=>({JEV_PROVIDER_MODE:'typesafe-direct',TYPESAFE_API_KEY:'generated-test-key-not-real'} as Record<string,string>)[name];
function sourceSender(capture?:any[]):typeof fetch{return async(url,init)=>{
 if(capture)capture.push({url,body:JSON.parse(String(init?.body))});
 const {questions}=JSON.parse(String(init?.body));
 return Response.json({model:'jev-fixture',answers:Object.fromEntries(Object.entries(questions).map(([id,q]:[string,any])=>[id,q.type==='noul'?{noul:.75}:{choice:Object.keys(q.criteria)[0],probabilities:Object.fromEntries(Object.keys(q.criteria).map((x,i)=>[x,i===0?1:0])),confidence:.9}])),usage:{input_tokens:100,output_tokens:10}});
};}
test('legacy evaluator -> new bridge -> exact existing result and question hashes',async()=>{
 const input={question_set:'music-routing-v0',state:{scope:'generated-test-only'}};const capture:any[]=[];
 const a=await evaluate(input,env,sourceSender());const b=await evaluateWithTrace(input,env,new MemoryStore(),sourceSender(capture),'owner');
 assert.deepEqual({...b.value,latency_ms:0},{...a,latency_ms:0});assert.equal(capture.length,1);
 assert.equal(capture[0].url,'https://api.typesafe.ai/v1/systemone');assert.deepEqual(capture[0].body.state,input.state);
 assert.equal(b.headers['x-jev-shadow-status'],'unavailable');assert.equal(b.run.calls_started,1);
});
for(const name of Object.keys(QUESTION_SETS))test('existing '+name+' remains accepted without question edits',async()=>{
 const input={question_set:name,state:{fixture:true}};const r=await evaluateWithTrace(input,env,new MemoryStore(),sourceSender(),'owner');
 assert.equal(r.value.question_set_sha256,sha(QUESTION_SETS[name]));assert.equal(inspectLegacyReply(input,r.value).status,'answered');
});
test('known smoke/ops definition hashes are unchanged',()=>{
 assert.equal(sha(QUESTION_SETS['synthetic-smoke-v0']),'7c15c8b5a40299071520fda84aab8b582a0fc017f2ea1c8de9dee2633b9151ed');
 assert.equal(sha(QUESTION_SETS['ops-liveness-v0']),'68a9055c793398358f397e6c01acebe5839d05ad213ab8caca2ab932442a850f');
});
test('captured response must match state and definition hash',async()=>{
 const input={question_set:'synthetic-smoke-v0',state:{fixture:true}},r=await evaluate(input,env,sourceSender());
 assert.throws(()=>inspectLegacyReply(input,{...r,state_sha256:'0'.repeat(64)}));
 assert.throws(()=>inspectLegacyReply(input,{...r,question_set_sha256:'0'.repeat(64)}));
 assert.throws(()=>inspectLegacyReply(input,{...r,provider:'openai_decisions'}));
});
test('provider 429 stays 429 and is not automatically retried',async()=>{
 let n=0;await assert.rejects(()=>evaluateWithTrace({question_set:'synthetic-smoke-v0',state:{}},env,new MemoryStore(),async()=>{n++;return new Response('',{status:429});},'owner'),e=>e instanceof Fault&&e.status===429);
 assert.equal(n,1);
});
test('verified shadow still needs an explicit host grant',async()=>{
 let n=0;const shadow=provider('fixture-b',async()=>{n++;return reply();},'shadow');
 const r=await evaluateWithTrace({question_set:'synthetic-smoke-v0',state:{}},env,new MemoryStore(),sourceSender(),'owner',{shadow});
 assert.equal(n,0);assert.equal(r.run.outcomes.shadow.status,'unauthorized');
});
test('a malformed or failing shadow cannot change the legacy primary value',async()=>{
 const input={question_set:'synthetic-smoke-v0',state:{fixture:true}};
 const r=await evaluateWithTrace(input,env,new MemoryStore(),sourceSender(),'owner',{shadowAuthorized:true,shadow:provider('fixture-b',async()=>({answers:{bad:{choice:'yes'}}}),'shadow')});
 assert.equal(r.run.outcomes.shadow.status,'invalid');assert.equal(r.value.answers.should_continue.noul,.75);
});
test('legacy bridge surfaces trace write failure in a header, without retry',async()=>{
 let n=0;const r=await evaluateWithTrace({question_set:'synthetic-smoke-v0',state:{}},env,{create:async()=>false},async(...args)=>{n++;return sourceSender()(...args);},'owner');
 assert.equal(n,1);assert.equal(r.headers['x-jev-trace-status'],'incomplete');
});

const authConfig={key:'a'.repeat(64),owner_hash:'b'.repeat(64),probe_hash:'c'.repeat(64),owner_until:0,probe_until:0,enabled:true};
function appEnv(enabled=true){return (k:string)=>k==='JEV_AUTH_CONFIG'?JSON.stringify(authConfig):k==='JEV_FABRIC_ENABLED'?(enabled?'true':'false'):env(k);}
async function authorization(store:MemoryStore){
 const grant={gid:'G'.repeat(43),cid:'C'.repeat(43),sub:'owner',scope:SCOPE,revoked:false,seq:0,until:Date.now()+60000};await store.create('grant/'+grant.gid,grant);
 return 'Bearer '+sign('access',{sub:grant.sub,gid:grant.gid,cid:grant.cid,aud:RESOURCE,scope:grant.scope},authConfig,60);
}
async function applicationRequest(path:string,body:any,store:MemoryStore,token?:string){return new Request(ORIGIN+path,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(token?{authorization:token}:{})},body:JSON.stringify(body)});}
test('actual OAuth app REST entry consumes the fabric while preserving result shape',async()=>{
 const store=new MemoryStore(),token=await authorization(store),input={question_set:'synthetic-smoke-v0',state:{fixture:true}};
 const response=await app(await applicationRequest('/v1/decision',input,store,token),appEnv(),store,sourceSender());
 assert.equal(response.status,200);assert.equal(response.headers.get('x-jev-trace-status'),'stored');const value=await response.json();
 assert.equal(value.gateway_version,'0.3.0');assert.equal(value.answers.should_continue.noul,.75);assert.ok(!('run' in value));
});
test('actual MCP tools/call consumes fabric and returns unchanged native envelope',async()=>{
 const store=new MemoryStore(),token=await authorization(store);const input={question_set:'synthetic-smoke-v0',state:{fixture:true}};
 const response=await app(await applicationRequest('/mcp',{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'decision_evaluate',arguments:input}},store,token),appEnv(),store,sourceSender());
 assert.equal(response.status,200);assert.equal(response.headers.get('x-jev-shadow-status'),'not_requested');const b=await response.json();
 assert.equal(b.result.isError,false);assert.deepEqual(JSON.parse(b.result.content[0].text),b.result.structuredContent);assert.equal(b.result.structuredContent.gateway_version,'0.3.0');
});
test('feature disabled follows original path, emits no trace',async()=>{
 const store=new MemoryStore(),token=await authorization(store);
 const response=await app(await applicationRequest('/v1/decision',{question_set:'synthetic-smoke-v0',state:{}},store,token),appEnv(false),store,sourceSender());
 assert.equal(response.status,200);assert.equal(response.headers.get('x-jev-trace-id'),null);assert.equal([...store.data.keys()].filter(k=>k.startsWith('fabric/')).length,0);
});
test('unauthenticated callers cannot invoke or cause trace writes',async()=>{
 const store=new MemoryStore();let n=0;const r=await app(await applicationRequest('/v1/decision',{question_set:'synthetic-smoke-v0',state:{}},store),appEnv(),store,async()=>{n++;return Response.json({});});
 assert.equal(r.status,401);assert.equal(n,0);assert.equal(store.data.size,0);
});
test('revoked grant still refuses the new path',async()=>{
 const store=new MemoryStore(),token=await authorization(store);await store.cas('grant/'+'G'.repeat(43),v=>({...v,revoked:true}));
 const r=await app(await applicationRequest('/v1/decision',{question_set:'synthetic-smoke-v0',state:{}},store,token),appEnv(),store,sourceSender());assert.equal(r.status,401);
});
test('public input cannot inject topology, provider or shadow authorization',async()=>{
 const store=new MemoryStore(),token=await authorization(store);let n=0;
 const r=await app(await applicationRequest('/v1/decision',{question_set:'synthetic-smoke-v0',state:{},shadowAuthorized:true,topology:'compose'},store,token),appEnv(),store,async()=>{n++;return Response.json({});});
 assert.equal(r.status,422);assert.equal(n,0);
});
test('existing inference quota executes before fabric/provider calls',async()=>{
 const store=new MemoryStore(),token=await authorization(store);const bucket=Math.floor(Date.now()/60000);
 store.data.set('rate/'+hash('inference-minute-owner')+'/'+bucket,{n:120});let n=0;
 const r=await app(await applicationRequest('/v1/decision',{question_set:'synthetic-smoke-v0',state:{}},store,token),appEnv(),store,async()=>{n++;return Response.json({});});assert.equal(r.status,429);assert.equal(n,0);
});

test('cancellation during start journal does not count a reserved slot as a started provider call',async()=>{
 const cancel=new AbortController(),base=new MemoryStore();let calls=0;
 const store={create:async(k:string,v:any)=>{if(v.event==='step_start')cancel.abort();return base.create(k,v);}};
 const r=await runPlan(plan(),{...host([provider('fixture-a',async()=>{calls++;return reply();})]),store,signal:cancel.signal});
 assert.equal(calls,0);assert.equal(r.calls_started,0);assert.equal(r.status,'cancelled');
});
test('source becoming stale during start journal is rejected before external send',async()=>{
 let current=true,calls=0;const base=new MemoryStore();
 const store={create:async(k:string,v:any)=>{if(v.event==='step_start')current=false;return base.create(k,v);}};
 const r=await runPlan(plan(),{...host([provider('fixture-a',async()=>{calls++;return reply();})]),store,isCurrent:()=>current});
 assert.equal(calls,0);assert.equal(r.calls_started,0);assert.equal(r.status,'stale');
});
