import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize,runPlan,DecisionError,verifyTraceFinish} from '../netlify/lib/decision-fabric.mts';
import type {RequestData,Provider,Step,Plan,CompletionRule,Invocation} from '../netlify/lib/decision-fabric.mts';
import {evaluateWithTrace} from '../netlify/lib/fabric-gateway.mts';
import {compilePublicPlan,publicPlanDefinition,runPublicPlan,PUBLIC_TOOL_NAME} from '../netlify/lib/public-plan.mts';
import {app} from '../netlify/lib/app.mts';
import {ORIGIN,RESOURCE,SCOPE,sign,hash} from '../netlify/lib/auth.mts';
import {QUESTION_SETS} from '../netlify/lib/questions.mts';
import {Fault} from '../netlify/lib/gateway.mts';

class Store {
 data=new Map<string,any>();
 async get(k:string){return structuredClone(this.data.get(k)??null);}
 async create(k:string,v:any){if(this.data.has(k))return false;this.data.set(k,structuredClone(v));return true;}
 async cas(k:string,f:(v:any)=>any){const v=f(await this.get(k));if(v!==null)this.data.set(k,v);return v;}
}
const request:RequestData={question_set:'fixture-v1',questions:{q:{type:'noul',instructions:'Supplied evidence only'}},state:{fixture:true},modalities:['text'],revision:'r1'};
function provider(id='a',fn:(v:Invocation)=>Promise<any>=async()=>({model:'fixture',answers:{q:{noul:.5}}}),mode:'primary'|'shadow'='primary'):Provider{
 return {capability:{id,mode,verified:true,kinds:['choice','noul','score'],modalities:['text'],evidence:'generated-fixture'},invoke:fn};
}
function step(id='a',r=request,rule?:CompletionRule):Step{return {id,provider:id,request:structuredClone(r),scope:{readers:['a','b']},...(rule?{completion:{q:rule}}:{})};}
function plan(topology:Plan['topology'],steps:Step[]):Plan{return {topology,steps,primary:steps[0].id,policy_id:'generated-policy',max_calls:2,timeout_ms:1000};}
const host=(providers:Provider[])=>({providers,store:new Store(),principal:'test'});
const ordinal:RequestData={...request,questions:{q:{type:'score',instructions:'Urgency',criteria:['Can wait','Today','Immediately']}}};
const ordinalReply=()=>({model:'clef-fixture',answers:{q:{type:'score',score:1.3,confidence:.5,legend:{'0':'Can wait','1':'Today','2':'Immediately'},probabilities:{'0':.2,'1':.3,'2':.5}}}});

test('ordinal native score preserves distribution, legend, expectation and provenance',()=>{
 const r=normalize(ordinalReply(),provider().capability,ordinal);
 assert.equal(r.status,'answered');assert.equal(r.model,'clef-fixture');assert.equal(r.answers!.q.value,1.3);
 assert.deepEqual(r.answers!.q.legend,ordinalReply().answers.q.legend);assert.deepEqual(r.answers!.q.probabilities,ordinalReply().answers.q.probabilities);
});
test('ordinal missing confidence is not invented',()=>{
 const raw:any=ordinalReply();delete raw.answers.q.confidence;
 assert.equal(normalize(raw,provider().capability,ordinal).answers!.q.confidence,undefined);
});
for(const [name,mutate] of Object.entries({
 'wrong legend':(a:any):void=>{a.legend['0']='Immediately';},
 'reordered scale':(a:any):void=>{a.legend={'0':'Immediately','1':'Today','2':'Can wait'};},
 'wrong expectation':(a:any):void=>{a.score=.7;},
 'bad distribution mass':(a:any):void=>{a.probabilities['0']=.4;},
 'missing ordinal probability':(a:any):void=>{delete a.probabilities['1'];},
 'NaN':(a:any):void=>{a.probabilities['2']=NaN;},
 'kind mismatch':(a:any):void=>{a.type='choice';},
 'extra payload':(a:any):void=>{a.reason='unbounded text';},
}))test('ordinal rejects '+name,()=>{const raw=ordinalReply();mutate(raw.answers.q);assert.equal(normalize(raw,provider().capability,ordinal).status,'invalid');});
test('ordinal accepts declared four-decimal independent rounding without rewriting it',()=>{
 const raw:any=ordinalReply();raw.answers.q.probabilities={'0':.3333,'1':.3333,'2':.3333};raw.answers.q.score=1;
 const r=normalize(raw,provider().capability,ordinal);assert.equal(r.status,'answered');assert.equal(r.answers!.q.probabilities!['0'],.3333);
});
test('legacy ranged score is kept separate from ordinal score',()=>{
 const scalar:RequestData={...request,questions:{q:{type:'score',instructions:'Rate',min:-1,max:1,rubric:'explicit native range'}}};
 assert.equal(normalize({answers:{q:{score:.1}}},provider().capability,scalar).status,'answered');
 assert.equal(normalize(ordinalReply(),provider().capability,scalar).status,'invalid');
});
test('native type tags are accepted only when their question kind matches',()=>{
 assert.equal(normalize({answers:{q:{type:'noul',noul:.5}}},provider().capability,request).status,'answered');
 assert.equal(normalize({answers:{q:{type:'score',noul:.5}}},provider().capability,request).status,'invalid');
});
const strictRule=(otherwise:'continue'|'need_evidence'|'hold'|'reframe'):CompletionRule=>({kind:'noul',accept:[[0,.1],[.9,1]],otherwise});
test('legacy Noul value policy still accepts 0.5 as data',async()=>{
 const r=await runPlan(plan('cascade',[step(),step('b')]),host([provider(),provider('b')]));
 assert.equal(r.calls_started,1);assert.equal(r.status,'answered');assert.equal(r.outcomes.b.status,'skipped');
});
test('explicit Noul continue policy actually reaches the next evaluation',async()=>{
 const r=await runPlan(plan('cascade',[step('a',request,strictRule('continue')),step('b',request,strictRule('continue'))]),
 host([provider(),provider('b',async()=>({answers:{q:{noul:.95}}}))]));
 assert.equal(r.calls_started,2);assert.equal(r.selected!.provider,'b');assert.equal(r.outcomes.a.answers!.q.value,.5);
});
for(const action of ['need_evidence','hold','reframe'] as const)test('explicit '+action+' preserves value and prevents useless cascade',async()=>{
 const r=await runPlan(plan('cascade',[step('a',request,strictRule(action)),step('b')]),host([provider(),provider('b')]));
 assert.equal(r.calls_started,1);assert.equal(r.status,'unresolved');assert.equal(r.next_action,action);assert.equal(r.outcomes.b.status,'skipped');assert.equal(r.outcomes.a.answers!.q.value,.5);
});
test('cross-check reports a primary request for evidence without using shadow policy',async()=>{
 const r=await runPlan(plan('cross-check',[step('a',request,strictRule('need_evidence')),step('b',request,strictRule('need_evidence'))]),host([provider(),provider('b')]));
 assert.equal(r.next_action,'need_evidence');assert.equal(r.status,'unresolved');assert.equal(r.comparison,'agree');
});
test('explicit unknown acceptance differs from treating unknown as a resolved fact',async()=>{
 const q:RequestData={...request,questions:{q:{type:'choice',instructions:'Label',criteria:{yes:'yes',unknown:'insufficient'}}}};
 const r=await runPlan(plan('single',[step('a',q,{kind:'choice',accept:['unknown'],otherwise:'hold'})]),host([provider('a',async()=>({answers:{q:{choice:'unknown',confidence:.99}}}))]));
 assert.equal(r.status,'answered');assert.equal(r.selected!.answers!.q.value,'unknown');
});
test('completion policy cannot refer to an absent question or impossible score range',async()=>{
 const s:any=step();s.completion={absent:strictRule('hold')};await assert.rejects(()=>runPlan(plan('single',[s]),host([provider()])),DecisionError);
 const t:any=step('a',request,strictRule('hold'));t.completion.q.accept=[[0,2]];await assert.rejects(()=>runPlan(plan('single',[t]),host([provider()])),DecisionError);
});

const configValue={key:'a'.repeat(64),owner_hash:'b'.repeat(64),probe_hash:'c'.repeat(64),owner_until:0,probe_until:0,enabled:true};
const env=(planFlag=true,fabricFlag=true,live=true)=>(k:string)=>({JEV_AUTH_CONFIG:JSON.stringify({...configValue,enabled:live}),JEV_PROVIDER_MODE:'typesafe-direct',TYPESAFE_API_KEY:'generated-test-key-not-real',JEV_FABRIC_ENABLED:String(fabricFlag),JEV_FABRIC_PLAN_ENABLED:String(planFlag)} as Record<string,string>)[k];
function sender(onCall?:(body:any)=>void){return async(_url:any,init:any)=>{
 const input=JSON.parse(String(init.body));onCall?.(input);const answers:Record<string,any>={};
 for(const [id,q]of Object.entries<any>(input.questions))answers[id]=q.type==='noul'?{noul:.5}:{choice:Object.keys(q.criteria)[0],confidence:.9,probabilities:Object.fromEntries(Object.keys(q.criteria).map((k,i)=>[k,i===0?1:0]))};
 return Response.json({model:'jev-fixture',answers,usage:{input_tokens:1,output_tokens:1}});
};}
async function token(store:Store){await store.create('grant/'+'G'.repeat(43),{gid:'G'.repeat(43),cid:'C'.repeat(43),sub:'owner',scope:SCOPE,revoked:false,seq:0,until:Date.now()+60000});return 'Bearer '+sign('access',{sub:'owner',gid:'G'.repeat(43),cid:'C'.repeat(43),aud:RESOURCE,scope:SCOPE},configValue,60);}
const input={question_set:'synthetic-smoke-v0',state:{fixture:true}};
const publicInput=(topology='single')=>({version:1,topology,steps:[{id:'a',...input,completion:'return_values'}]});
function rpc(method:string,params?:any){return {jsonrpc:'2.0',id:1,method,...(params?{params}:{})};}
function req(body:any,t?:string){return new Request(ORIGIN+'/mcp',{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream',...(t?{authorization:t}:{})},body:JSON.stringify(body)});}

test('normal primary-only bridge never starts configured shadow',async()=>{
 let shadowCalls=0;const shadow:Provider={...provider('b',async()=>{shadowCalls++;throw new Error('must not run');},'shadow')};
 const r=await evaluateWithTrace(input,env(),new Store(),sender(),'owner',{comparison_mode:'primary-only',shadow,shadowAuthorized:true});
 assert.equal(shadowCalls,0);assert.equal(r.run.calls_started,1);assert.equal(r.headers['x-jev-shadow-status'],'not_requested');assert.equal(r.value.answers.should_continue.noul,.5);
});
test('explicit synchronous comparison waits for its shadow and retains the primary',async()=>{
 let entered:()=>void=()=>{},release:()=>void=()=>{};const start=new Promise<void>(r=>entered=r),wait=new Promise<void>(r=>release=r);let completed=false;
 const shadow:Provider={capability:{id:'b',mode:'shadow',verified:true,kinds:['noul'],modalities:['text'],evidence:'fixture'},invoke:async()=>{entered();await wait;return {model:'fixture',answers:{should_continue:{noul:.1}}};}};
 const job=evaluateWithTrace(input,env(),new Store(),sender(),'owner',{comparison_mode:'synchronous',shadow,shadowAuthorized:true}).then(r=>{completed=true;return r;});
 await start;assert.equal(completed,false);release();const r=await job;assert.equal(r.value.answers.should_continue.noul,.5);assert.equal(r.run.comparison,'disagree');
});
test('public plan compiles fixed source questions and host-only provider scope',()=>{
 const p=compilePublicPlan(publicInput());assert.deepEqual(p.steps[0].request.questions,QUESTION_SETS['synthetic-smoke-v0']);assert.equal(p.steps[0].provider,'jev');assert.deepEqual(p.steps[0].scope.readers,['jev']);
});
for(const [name,mutate]of Object.entries({
 'provider':(x:any):void=>{x.steps[0].provider='clef';},
 'scope':(x:any):void=>{x.steps[0].scope={readers:['anyone']};},
 'URL':(x:any):void=>{x.endpoint='https://example.org/';},
 'custom questions':(x:any):void=>{x.steps[0].questions={q:{type:'noul'}};},
 'extra steps':(x:any):void=>{x.steps=Array.from({length:9},(_,i)=>({...x.steps[0],id:'s'+i}));},
 'infinite time':(x:any):void=>{x.timeout_ms=Infinity;},
 'forward read':(x:any)=>{x.topology='compose';x.steps[0].reads=['b'];x.steps.push({...x.steps[0],id:'b'});},
 'version':(x:any):void=>{x.version=2;},
 'different cross-check input':(x:any)=>{x.topology='cross-check';x.steps.push({...x.steps[0],id:'b',state:{different:true}});},
}))test('public plan rejects '+name,()=>{const x=publicInput();mutate(x);assert.throws(()=>compilePublicPlan(x));});
test('discovery preserves old tool and gates new tool behind two explicit flags',async()=>{
 const store=new Store(),t=await token(store);
 for(const [p,f,count]of [[false,true,1],[true,false,1],[true,true,2]] as const){
  const b=await (await app(req(rpc('tools/list'),t),env(p,f),store,sender())).json();assert.equal(b.result.tools.length,count);assert.equal(b.result.tools[0].name,'decision_evaluate');
  if(count===2){assert.equal(b.result.tools[1].name,PUBLIC_TOOL_NAME);assert.equal(b.result.tools[1].annotations.idempotentHint,false);}
 }
});
test('new MCP tool performs finite compose, preserves old caller and journals results',async()=>{
 const store=new Store(),t=await token(store),seen:any[]=[];const x:any=publicInput('compose');x.steps.push({...x.steps[0],id:'b',reads:['a']});
 const response=await app(req(rpc('tools/call',{name:PUBLIC_TOOL_NAME,arguments:x}),t),env(),store,sender(b=>seen.push(b)));
 const b=await response.json();assert.equal(b.result.isError,false);const r=b.result.structuredContent;assert.equal(r.calls_started,2);assert.equal(r.status,'answered');assert.equal(r.trace.persisted,true);
 assert.equal(seen[1].state.prior_results.a.provider,'jev');assert.deepEqual(JSON.parse(b.result.content[0].text),r);
 assert.ok(!JSON.stringify([...store.data.values()].filter(v=>v.schema==='jev.fabric.trace.v1')).includes('generated-test-key-not-real'));
});
test('new tool checks authorization and live enablement before any call',async()=>{
 const store=new Store(),t=await token(store);let n=0;const send=sender(()=>n++);
 assert.equal((await app(req(rpc('tools/call',{name:PUBLIC_TOOL_NAME,arguments:publicInput()})),env(),store,send)).status,401);
 const b=await (await app(req(rpc('tools/call',{name:PUBLIC_TOOL_NAME,arguments:publicInput()}),t),env(true,true,false),store,send)).json();assert.equal(b.result.isError,true);assert.equal(n,0);
});
test('new finite tool consumes quota per provider attempt, not per outer plan',async()=>{
 const store=new Store(),t=await token(store),bucket=Math.floor(Date.now()/60000);store.data.set('rate/'+hash('inference-minute-owner')+'/'+bucket,{n:119});
 const x:any=publicInput('compose');x.steps.push({...x.steps[0],id:'b',after:['a']});let n=0;
 const b=await (await app(req(rpc('tools/call',{name:PUBLIC_TOOL_NAME,arguments:x}),t),env(),store,sender(()=>n++))).json();
 assert.equal(n,1);assert.equal(b.result.structuredContent.outcomes.b.status,'rate_limited');assert.notEqual(b.result.structuredContent.status,'answered');
});
test('grant revoked by first response prevents the second network call',async()=>{
 const store=new Store(),t=await token(store);const x:any=publicInput('compose');x.steps.push({...x.steps[0],id:'b',after:['a']});let n=0;
 const send=sender(()=>{n++;store.data.get('grant/'+'G'.repeat(43)).revoked=true;});
 const b=await (await app(req(rpc('tools/call',{name:PUBLIC_TOOL_NAME,arguments:x}),t),env(),store,send)).json();
 assert.equal(n,1);assert.equal(b.result.structuredContent.outcomes.b.status,'unauthorized');
});
test('caller cancellation after quota await prevents a late provider send',async()=>{
 const cancel=new AbortController();let sends=0;
 const r=await runPublicPlan(publicInput(),env(),new Store(),sender(()=>sends++),'test',{signal:cancel.signal,beforeCall:async()=>cancel.abort()});
 assert.equal(sends,0);assert.equal(r.status,'cancelled');
});
test('tool description does not claim Clef, audio, auto-dispatch or independence',()=>{
 const d=publicPlanDefinition();assert.match(d.description,/Only TypeSafe Jev is connected/);assert.match(d.description,/not independent/);assert.equal(d.inputSchema.additionalProperties,false);
});
test('margin applies to the selected label, not an unrelated dominant option',async()=>{
 const r:RequestData={...request,questions:{q:{type:'choice',instructions:'Yes or no',criteria:{yes:'yes',no:'no'}}}};
 const s=step('a',r,{kind:'choice',accept:['yes'],margin_at_least:.5,otherwise:'hold'});
 const out=await runPlan(plan('single',[s]),host([provider('a',async()=>({answers:{q:{choice:'yes',confidence:.8,probabilities:{yes:.1,no:.9}}}}))]));
 assert.equal(out.status,'unresolved');assert.equal(out.next_action,'hold');
});

test('mixed question follow-ups are preserved without a universal severity order',async()=>{
 const mixed:RequestData={...request,questions:{
  evidence:{type:'noul',instructions:'Is the evidence sufficient?'},
  framing:{type:'noul',instructions:'Is the framing settled?'},
 }};
 const s:Step={id:'a',provider:'a',request:mixed,scope:{readers:['a','b']},completion:{
  evidence:strictRule('need_evidence'),framing:strictRule('reframe'),
 }};
 const r=await runPlan(plan('single',[s]),host([provider('a',async()=>({answers:{evidence:{noul:.5},framing:{noul:.5}}}))]));
 assert.equal(r.status,'unresolved');assert.equal(r.assessments.a.action,'mixed');
 assert.equal(r.assessments.a.by_question.evidence,'need_evidence');assert.equal(r.assessments.a.by_question.framing,'reframe');
 assert.equal(r.next_action,null);assert.deepEqual(r.next_actions,['need_evidence','reframe']);
});

test('a mixed blocking follow-up stops cascade while retaining continue separately',async()=>{
 const mixed:RequestData={...request,questions:{
  retry:{type:'noul',instructions:'Would another decision pass help?'},
  gate:{type:'noul',instructions:'Should this remain on hold?'},
 }};
 const first:Step={id:'a',provider:'a',request:mixed,scope:{readers:['a','b']},completion:{
  retry:strictRule('continue'),gate:strictRule('hold'),
 }};
 const second:Step={id:'b',provider:'b',request:mixed,scope:{readers:['a','b']}};
 const r=await runPlan(plan('cascade',[first,second]),host([
  provider('a',async()=>({answers:{retry:{noul:.5},gate:{noul:.5}}})),provider('b')
 ]));
 assert.equal(r.calls_started,1);assert.equal(r.outcomes.b.status,'skipped');assert.equal(r.assessments.a.action,'mixed');
 assert.deepEqual(r.next_actions,['continue','hold']);assert.equal(r.next_action,null);
});

test('private trace finish can be read back without exposing trace contents',async()=>{
 const store=new Store();const r=await runPlan(plan('single',[step()]),{providers:[provider()],store,principal:'owner'});
 assert.equal(r.trace.persisted,true);assert.equal(await verifyTraceFinish(store,'owner',r),true);
 const end=[...store.data.entries()].find(([,v])=>v?.event==='finish');assert.ok(end);
 end![1].status='tampered';assert.equal(await verifyTraceFinish(store,'owner',r),false);
});

test('fabric-enabled legacy MCP call verifies private trace readback',async()=>{
 const store=new Store(),t=await token(store);
 const response=await app(req(rpc('tools/call',{name:'decision_evaluate',arguments:input}),t),env(false,true),store,sender());
 assert.equal(response.status,200);assert.equal(response.headers.get('x-jev-trace-readback'),'verified');
 const b=await response.json();assert.equal(b.result.isError,false);assert.equal(b.result.structuredContent.gateway_version,'0.3.0');
});

test('finite plan MCP call verifies private trace readback',async()=>{
 const store=new Store(),t=await token(store);
 const response=await app(req(rpc('tools/call',{name:PUBLIC_TOOL_NAME,arguments:publicInput()}),t),env(true,true),store,sender());
 assert.equal(response.status,200);assert.equal(response.headers.get('x-jev-trace-readback'),'verified');
 const b=await response.json();assert.equal(b.result.isError,false);assert.equal(b.result.structuredContent.trace.persisted,true);
});
