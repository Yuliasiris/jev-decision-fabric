import test from 'node:test';
import assert from 'node:assert/strict';
import {CONTRACT_VERSION} from '../contract/c0.mts';
import type {DecisionPort} from '../contract/c0.mts';
import {createTypeSafeDecision,prepareDecisionRequest,prepareWire,typesafeOnce} from '../providers/index.mts';
const input: Parameters<DecisionPort>[0] = {
  request: {contract_version:CONTRACT_VERSION,run_id:'provider-package',objective:'Check two supplied excerpts',input_revision:'r1',requested_output:'bounded comparison',sources:[],capabilities:[],
    budget:{max_operations:3,max_decisions:1,max_plan_versions:2,max_parallel:1,timeout_ms:1000}},
  plan_version:1,candidates:[{id:'read-other',purpose:'Read the missing excerpt',reason:'Need source coverage',evidence:[],patch:{upsert:[],remove:[]}}],observations:[],timeout_ms:1000,
};
test('published TypeSafe factory construction has no credential, transport or grant effects',()=>{
  let called=0;createTypeSafeDecision({model:'jev-latest',authorize:()=>{called++;return true;},getCredential:()=>{called++;return 'unused';},record:async()=>{called++;},send:async()=>{called++;throw Error();}},
    {signal:new AbortController().signal,deadline_ms:Date.now()+1000},'injected',{create:async()=>true});assert.equal(called,0);
});
test('public SDK custom selector retains exact wire and is separate from fixed tool requests',()=>{
  const request=prepareDecisionRequest(input),wire=prepareWire({request,upstream:{},signal:new AbortController().signal},'jev-latest');
  assert.equal(request.question_set,'next-task-preview-v1');assert.deepEqual(Object.keys(JSON.parse(wire.body_utf8)),['model','state','questions']);
  assert.equal(wire.destination,'https://api.typesafe.ai/v1/systemone');assert.equal(wire.redirect,'error');assert.equal(wire.timeout_ms,15000);
});
test('missing trusted grant reaches no credential or physical request',async()=>{
  let read=0,sent=0;const choose=createTypeSafeDecision({model:'jev-latest',authorize:()=>false,getCredential:()=>{read++;return 'injected-placeholder';},record:async()=>{},send:async()=>{sent++;throw Error();}},
    {signal:new AbortController().signal,deadline_ms:Date.now()+1000},'injected',{create:async()=>true});
  assert.equal((await choose(input)).status,'failed');assert.equal(read,0);assert.equal(sent,0);
});
test('relocated one-call transport sends once with synthetic response and never retries',async()=>{
  let sent=0;const events:unknown[]=[];const signal=new AbortController().signal;
  const invocation={request:prepareDecisionRequest(input),upstream:{},signal};
  const provider=typesafeOnce({model:'jev-latest',authorize:()=>true,getCredential:()=> 'injected-placeholder-not-issued',record:async event=>{events.push(event);},send:async()=>{
    sent++;return Response.json({model:'injected-fixture',answers:{next:{choice:'read-other',confidence:1,probabilities:{'read-other':1,hold:0}}}});
  }});
  await provider.invoke(invocation);await assert.rejects(provider.invoke(invocation));assert.equal(sent,1);
  assert.equal(JSON.stringify(events).includes('injected-placeholder-not-issued'),false);
});
test('unknown transport outcome retains one-call reservation and zero automatic retry',async()=>{
  let sent=0;const provider=typesafeOnce({model:'jev-latest',authorize:()=>true,getCredential:()=> 'injected-placeholder',record:async()=>{},send:async()=>{sent++;throw Error('unknown outcome');}});
  const invocation={request:prepareDecisionRequest(input),upstream:{},signal:new AbortController().signal};
  await assert.rejects(provider.invoke(invocation));await assert.rejects(provider.invoke(invocation));assert.equal(sent,1);
});
