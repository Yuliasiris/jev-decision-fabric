/** Local execution fixture. No HTTP, credentials, paid inference or model-quality evidence. */
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {runPublicPlan,compilePublicPlan} from '../netlify/lib/public-plan.mts';
import {QUESTION_SETS} from '../netlify/lib/questions.mts';
import {verifyTraceFinish} from '../netlify/lib/decision-fabric.mts';
import type {Sender} from '../netlify/lib/gateway.mts';

export async function runOffline(input:unknown){
 const plan=compilePublicPlan(input);
 const data=new Map<string,any>();
 const store={
  async create(key:string,value:unknown){if(data.has(key))return false;data.set(key,structuredClone(value));return true;},
  async get(key:string){return structuredClone(data.get(key)??null);}
 };
 let fixtureCalls=0,quotaChecks=0;
 const send:Sender=async(url,init)=>{
  if(url!=='https://api.typesafe.ai/v1/systemone')throw new Error('Unexpected fixture destination');
  fixtureCalls++;
  const body=JSON.parse(String(init?.body));
  const answers:Record<string,unknown>={};
  for(const [id,q] of Object.entries(body.questions) as [string,any][]){
   if(q.type==='noul')answers[id]={noul:0.5};
   else{
    const choices=Object.keys(q.criteria);
    const selected=choices.includes('unknown')?'unknown':choices[0];
    answers[id]={choice:selected,confidence:0,probabilities:Object.fromEntries(choices.map(k=>[k,k===selected?1:0]))};
   }
  }
  return Response.json({model:'offline-generated-fixture',answers,usage:{fixture:true}});
 };
 const env:Record<string,string>={JEV_FABRIC_ENABLED:'true',JEV_FABRIC_PLAN_ENABLED:'true',
  JEV_PROVIDER_MODE:'typesafe-direct',TYPESAFE_API_KEY:'OFFLINE_FAKE_KEY',TYPESAFE_BASE_URL:'https://api.typesafe.ai'};
 const principal='offline-example';
 const result=await runPublicPlan(input,k=>env[k],store,send,principal,{beforeCall:async()=>{quotaChecks++;}});
 const readback=await verifyTraceFinish(store,principal,result);
 if(result.calls_started!==fixtureCalls||quotaChecks!==fixtureCalls||!readback)throw new Error('Fixture execution did not finish');
 return {evidence_mode:'injected_transport',network_requests:0,paid_provider_calls:0,
  fixture_calls:fixtureCalls,quota_checks:quotaChecks,question_set:plan.steps[0].request.question_set,
  question_count:Object.keys(QUESTION_SETS[plan.steps[0].request.question_set]).length,
  private_fixture_trace_readback:readback,result};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const path=process.argv[2]?resolve(process.argv[2]):fileURLToPath(new URL('./decision_run_v1.single.json',import.meta.url));
 const input=JSON.parse(await readFile(path,'utf8'));
 globalThis.fetch=async()=>{throw new Error('Network disabled in offline example');};
 const output=await runOffline(input);
 console.log(JSON.stringify(output,null,2));
}
