import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluate} from '../netlify/lib/gateway.mts';
const input={question_set:'synthetic-smoke-v0',state:{next_work_ready:true}};
const env=(key:string)=>(name:string)=>name==='JEV_PROVIDER_MODE'?'typesafe-direct':name==='TYPESAFE_API_KEY'?key:undefined;
test('key is trimmed and control characters fail before network',async()=>{let calls=0;const send=(async(url:any,init:any)=>{calls++;assert.equal(init.headers.authorization,'Bearer TEST_FAKE');return Response.json({answers:{should_continue:{noul:.5}}})}) as typeof fetch;await evaluate(input,env(' TEST_FAKE\n'),send);await assert.rejects(()=>evaluate(input,env('TEST\nFAKE'),send),{code:'PROVIDER_KEY_FORMAT_INVALID'});assert.equal(calls,1);});
test('transport reports only allowlisted errors and blocks redirects',async()=>{for(const [cause,want]of [[{code:'ENOTFOUND'},'PROVIDER_NETWORK_ENOTFOUND'],[{code:'TEST_PRIVATE'},'PROVIDER_NETWORK_UNKNOWN'],[{message:'unexpected redirect'},'PROVIDER_NETWORK_REDIRECT_BLOCKED']]){const send=(async()=>{throw new Error('TEST_PRIVATE',{cause})}) as typeof fetch;await assert.rejects(()=>evaluate(input,env('TEST_FAKE'),send),{code:want});}});
