import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,cp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runOffline} from '../examples/offline.mts';
import {compilePublicPlan} from '../netlify/lib/public-plan.mts';
import {validateInput} from '../netlify/lib/gateway.mts';

test('published examples finish through the real adapter with no external request',async()=>{
 const original=globalThis.fetch;let requests=0;
 globalThis.fetch=async()=>{requests++;throw new Error('External requests forbidden');};
 try{
  for(const name of ['music-routing-v0','roi-delta-v0','ops-liveness-v0','decision_run_v1.single']){
   const sample=JSON.parse(await readFile(new URL('../examples/'+name+'.json',import.meta.url),'utf8'));
   const input=sample.version?sample:{version:1,topology:'single',max_calls:1,timeout_ms:18000,
    steps:[{id:'example',...validateInput(sample),completion:'return_values'}]};
   const out=await runOffline(input);
   assert.equal(out.result.status,'answered');
   assert.equal(out.result.calls_started,1);
   assert.equal(out.result.automatic_apply,false);
   assert.equal(out.private_fixture_trace_readback,true);
   assert.equal(out.fixture_calls,1);
   assert.equal(out.paid_provider_calls,0);
   assert.equal(out.evidence_mode,'injected_transport');
   assert.equal(out.result.selected?.model,'offline-generated-fixture');
  }
  assert.equal(requests,0);
 }finally{globalThis.fetch=original;}
});

test('examples do not advertise provider injection or arbitrary questions',async()=>{
 const sample=JSON.parse(await readFile(new URL('../examples/decision_run_v1.single.json',import.meta.url),'utf8'));
 for(const extra of [{provider:'another-model'},{endpoint:'https://example.invalid/'},{questions:{custom:'free question'}}]){
  const altered=structuredClone(sample);Object.assign(altered.steps[0],extra);
  assert.throws(()=>compilePublicPlan(altered));
 }
 const unknown=structuredClone(sample);unknown.steps[0].question_set='free-question';
 assert.throws(()=>compilePublicPlan(unknown));
});

test('self-host origin configuration preserves the fixed issuer and allowed-origin contract',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jev-origin-'));
 try{
  await mkdir(join(dir,'netlify/lib'),{recursive:true});await mkdir(join(dir,'scripts'));
  for(const name of ['auth.mts','mcp_origin.mts'])await cp(new URL('../netlify/lib/'+name,import.meta.url),join(dir,'netlify/lib',name));
  await cp(new URL('../scripts/configure-origin.mjs',import.meta.url),join(dir,'scripts/configure-origin.mjs'));
  const script=join(dir,'scripts/configure-origin.mjs');
  for(const bad of ['http://host.invalid','https://host.invalid/','https://host.invalid/path','https://user:secret@host.invalid']){
   assert.notEqual(spawnSync(process.execPath,[script,bad]).status,0);
  }
  const origin='https://selfhost.example.invalid';
  const configured=spawnSync(process.execPath,[script,origin],{encoding:'utf8'});
  assert.equal(configured.status,0,configured.stderr);
  for(const name of ['auth.mts','mcp_origin.mts']){
   const source=await readFile(join(dir,'netlify/lib',name),'utf8');
   assert.ok(source.includes(origin));assert.ok(!source.includes('https://jev-decision-fabric.example'));
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
