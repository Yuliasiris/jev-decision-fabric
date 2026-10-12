import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createWork, restoreWork, SDK_VERSION} from '../sdk/index.mts';
import type {CreateWorkOptions, WorkHost, PlannerPort, WorkSnapshot, InitialProposal, NextProposal,
  Registration, Observation, Task, TaskRequest} from '../sdk/index.mts';
import {CONTRACT_VERSION} from '../contract/c0.mts';
import {inspectFinal} from '../sdk/final.mts';
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const receipt = {mode: 'scripted' as const, origin: {fixture_only: true, caller_record: 'current'},
  usage: {tokens: null, cost: null}, latency_ms: null};
function task(id: string, cap: string, sources: string[], reads: string[] = []): Task {
  return {id, purpose: 'Carry out the ordinary supplied request', capability: cap,
    input_revision: 'current', input: {operation: cap === 'reporter' ? 'report' : 'read'},
    sources, reads, after: reads, output: cap === 'reporter' ? 'ordinary answer' : 'source observation'};
}
function observed(frame: TaskRequest, value: Observation['value']): Observation {
  return {contract_version: CONTRACT_VERSION, id: 'obs:' + frame.task_id, run_id: frame.run_id,
    task_id: frame.task_id, attempt_id: frame.attempt_id, input_revision: frame.input_revision,
    input_digest: frame.input_digest, status: 'completed', value, evidence: frame.sources.map(s => s.id),
    mode: 'scripted', usage: {tokens: null, cost: null}};
}
async function fixture(t: any, scenario: 'numeric' | 'missing' = 'numeric') {
  const dir = await mkdtemp(join(tmpdir(), 'jev-sdk-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const texts = scenario === 'numeric' ? {s1: '2,3,5', s2: 'unused'} : {s1: 'The limit is in configuration C.', s2: 'C says limit 4.'};
  for (const [id, value] of Object.entries(texts)) await writeFile(join(dir, id + '.txt'), value);
  const now = Date.now(), run_id = 'sdk-' + randomUUID(), abort = new AbortController();
  const catalog: Registration[] = [
    {capability: {id: 'reader', kind: 'tool', authorized: true, parallel: true, cancellable: true},
      description: 'Read an authorized current file and compute numeric sum when requested', input_description: 'operation=read'},
    {capability: {id: 'reporter', kind: 'caller', authorized: true, parallel: false, cancellable: true},
      description: 'Produce a fresh grounded ordinary answer', input_description: 'operation=report'}];
  const events: string[] = [], frames: TaskRequest[] = []; let saved!: WorkSnapshot;
  const calls = {initial: 0, next: 0, worker: 0, decision: 0, final: 0, archive: 0};
  const planner: PlannerPort = {
    initial: async context => {
      calls.initial++; events.push('planner_initial');
      assert.equal(context.request.objective, scenario === 'numeric' ? 'Add the numbers in my file and explain the result.' : 'Check the documented limit and read missing configuration if needed.');
      assert.equal(context.catalog[0].description, catalog[0].description);
      assert.equal(saved.pending_planner?.id, context.invocation.id);
      return {...receipt, tasks: [task('read', 'reader', ['s1']), task('report', 'reporter', [], ['read'])]};
    },
    next: async context => {
      calls.next++; events.push('planner_next');
      if (scenario === 'missing' && !context.observations.some(o => o.task_id === 'config')) return {...receipt,
        action: {kind: 'choose', candidates: [{id: 'read-config', purpose: 'Read the named missing configuration',
          reason: 'The actual first observation names C', evidence: ['obs:read'], patch: {remove: [],
            upsert: [task('config', 'reader', ['s2']), task('report', 'reporter', [], ['read','config'])]}}]}};
      return {...receipt, action: {kind: 'dispatch'}};
    }
  };
  const host: WorkHost = {
    signal: abort.signal, finalCapability: 'reporter',
    checks: {validateInput: (cap, input: any) => ['reader','reporter'].includes(cap) &&
      input?.operation === (cap === 'reporter' ? 'report' : 'read'),
      authorize: (_task, sources) => sources.every(s => texts[s.id as keyof typeof texts] === s.text),
      isCurrent: () => true,
      acceptNativeAdmission: admission => admission.run_id === run_id && admission.deadline_ms === now + 60000},
    authorizeEntry: () => true,
    save: async (snapshot, reason) => {events.push('save:' + reason); await writeFile(join(dir, 'checkpoint.json'), JSON.stringify(snapshot)); saved = snapshot;},
    readback: async snapshot => JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')).digest === snapshot.digest,
    acceptSnapshot: async snapshot => JSON.parse(await readFile(join(dir, 'checkpoint.json'), 'utf8')).digest === snapshot.digest,
    authorizeReconcile: () => true,
    verifyObservationOrigin: () => true,
    authorizePlanner: () => true,
    verifyPlannerOrigin: outcome => outcome.origin !== null && (outcome.origin as any).fixture_only === true,
    archiveObservation: async record => {await writeFile(join(dir,'observation-'+record.frame.task_id+'.json'),JSON.stringify(record.observation));},
    worker: async frame => {
      calls.worker++; events.push('worker:' + frame.task_id); frames.push(frame);
      assert.ok(saved.checkpoint.state.entries.some(e => e.request?.attempt_id === frame.attempt_id));
      const bytes = await readFile(join(dir, frame.sources[0].id + '.txt'));
      assert.equal(bytes.toString('utf8'), frame.sources[0].text);
      return observed(frame, scenario === 'numeric' ? {sum: bytes.toString('utf8').split(',').reduce((sum,n)=>sum+Number(n),0), excerpt: bytes.toString('utf8')} :
        {excerpt: bytes.toString('utf8'), needs_configuration: frame.task_id === 'read'});
    },
    decision: async (input, context) => {
      calls.decision++; events.push('decision');
      assert.ok(saved.checkpoint.state.pending_decision);
      assert.equal(context.boundary.parent_deadline_ms, now + 60000);
      return {candidate_id: input.candidates[0].id, status: 'selected', mode: 'injected', record: {fixture_only: true}};
    },
    final: async frame => {
      calls.final++; events.push('final');
      const provenance = Object.values(frame.reads).map(o => ({observation_id: o.id, claim: 'The current accepted observation supplies this result.'}));
      const answer = scenario === 'numeric' ? 'The sum is ' + (frame.reads.read.value as any).sum + '.' :
        'The document delegates its limit; configuration C reports 4.';
      const raw = Buffer.from(JSON.stringify({run_id: frame.run_id, task_id: frame.task_id, attempt_id: frame.attempt_id,
        input_digest: frame.input_digest, answer, provenance, unresolved: []}));
      return {...receipt, raw, new_native_call: false};
    },
    verifyFinalOrigin: reply => reply.origin !== null && (reply.origin as any).fixture_only === true,
    archiveFinal: async record => {calls.archive++; events.push('archive');
      await writeFile(join(dir, 'raw-final.json'), record.raw); assert.equal(hash(await readFile(join(dir, 'raw-final.json'))), record.raw_sha256);},
    evidenceText: o => typeof (o.value as any)?.excerpt === 'string' ? [(o.value as any).excerpt] : []
  };
  const options: CreateWorkOptions = {
    requestText: scenario === 'numeric' ? 'Add the numbers in my file and explain the result.' : 'Check the documented limit and read missing configuration if needed.',
    frame: {run_id, input_revision: 'current', requested_output: 'An ordinary grounded answer',
      sources: Object.entries(texts).map(([id,text])=>({id, revision:'current', text, origin:'fixture-authorized-file:'+id, range:'whole', omitted:false})),
      budget: {max_operations: 8, max_decisions: 2, max_plan_versions: 6, max_parallel: 2, timeout_ms: 60000}},
    catalog, admission: {run_id, profile_id:'fixture-current-parent', timeout_ms:60000, admitted_at_ms:now, deadline_ms:now+60000},
    planner, host, maxPlannerCalls:5
  };
  async function restore(snapshot: WorkSnapshot) {
    const expected = snapshot.checkpoint.digest;
    return restoreWork(snapshot, {catalog, admission: options.admission, planner, host,
      restoreChecks: {...host.checks, acceptCheckpoint: cp => cp.digest === expected,
        verifySettlement: (_effect, settlement) => settlement.evidence_ref === 'actual-fixture-readback'}});
  }
  return {dir, options, host, planner, catalog, calls, events, frames, abort, restore, saved:()=>saved};
}

test('ordinary prose uses caller planner and actual local file tool, final raw provenance and nullable usage', async t => {
  const f = await fixture(t), run = createWork(f.options), outcome = await run.run();
  assert.equal(outcome.sdk_status, 'COMPLETE'); assert.equal(outcome.result.answer, 'The sum is 10.');
  assert.equal(outcome.result.usage.by_kind.tool, 1); assert.equal(outcome.result.usage.by_kind.caller, 1);
  assert.deepEqual(outcome.result.provenance, ['obs:read']);
  assert.equal(outcome.snapshot.checkpoint.state.deadline_ms, f.options.admission.deadline_ms);
  assert.deepEqual(outcome.snapshot.checkpoint.state.request.budget, f.options.frame.budget);
  assert.equal(outcome.result.usage.cost, null); assert.equal(outcome.usage.planner.cost, null);
  assert.equal((outcome.final_receipt as any).claim_semantics_evaluated, false);
  assert.ok(f.events.indexOf('save:tasks_reserved') < f.events.indexOf('worker:read'));
  assert.ok(f.events.indexOf('archive') < f.events.indexOf('save:final_observed'));
  assert.equal(f.calls.archive, 1); assert.equal(outcome.sdk_version, SDK_VERSION);
});
test('actual observation drives candidate choice and changed information reads through unchanged Controller', async t => {
  const f = await fixture(t, 'missing'), run = createWork(f.options), outcome = await run.run();
  assert.equal(outcome.sdk_status, 'COMPLETE'); assert.equal(f.calls.decision, 1); assert.equal(f.calls.worker, 2);
  assert.deepEqual(outcome.result.provenance, ['obs:read','obs:config']);
  assert.equal(outcome.result.usage.operations_started, 4); assert.equal(outcome.result.usage.decisions_started, 1);
  assert.ok(f.events.indexOf('save:decision_reserved') < f.events.indexOf('decision'));
  assert.equal(outcome.snapshot.checkpoint.state.plans.length, 3);
});
test('failed initial durable save prevents caller planner and all effects', async t => {
  const f = await fixture(t); f.host.save = async () => {throw Error('disk-unavailable');};
  const run = createWork(f.options); await assert.rejects(run.run(), /disk-unavailable/);
  assert.deepEqual(f.calls, {initial:0,next:0,worker:0,decision:0,final:0,archive:0});
  await assert.rejects(run.run(), /parent_ended/);
});
test('false readback prevents caller planner before its physical effect', async t => {
  const f = await fixture(t); f.host.readback = async () => false;
  await assert.rejects(createWork(f.options).run(), /save_readback/); assert.equal(f.calls.initial, 0);
});
test('failed task reservation save prevents worker and final', async t => {
  const f = await fixture(t), save = f.host.save;
  f.host.save = async (snapshot, reason) => {if (reason === 'tasks_reserved') throw Error('reservation-disk-failed'); await save(snapshot,reason);};
  await assert.rejects(createWork(f.options).run(), /reservation-disk-failed/);
  assert.equal(f.calls.worker, 0); assert.equal(f.calls.final, 0); assert.equal(f.calls.initial, 1);
});
test('decision barrier failure does not call decision and cannot promote caller proposal', async t => {
  const f = await fixture(t, 'missing'), save = f.host.save;
  f.host.save = async (snapshot, reason) => {if (reason === 'decision_reserved') throw Error('decision-save-failed'); await save(snapshot,reason);};
  await assert.rejects(createWork(f.options).run(), /storage_failed|decision-save-failed/);
  assert.equal(f.calls.decision, 0); assert.equal(f.calls.final, 0);
});
test('unknown task survives restore; explicit actual readback permits only unstarted final, no worker resend', async t => {
  const f = await fixture(t); let physical!: TaskRequest;
  f.host.worker = async frame => {f.calls.worker++; physical=frame; throw Error('response-unknown');};
  const first = await createWork(f.options).run(); assert.equal(first.sdk_status, 'NEEDS_RECONCILIATION');
  const restored = await f.restore(f.saved());
  assert.equal((await restored.run()).sdk_status, 'NEEDS_RECONCILIATION'); assert.equal(f.calls.worker, 1);
  const snapshot = restored.snapshot(); assert.equal(snapshot.checkpoint.state.deadline_ms, f.options.admission.deadline_ms);
  await restored.reconcile({observation: observed(physical,{sum:10,excerpt:'2,3,5'})});
  const last = await restored.run(); assert.equal(last.sdk_status, 'COMPLETE'); assert.equal(f.calls.worker,1);
  assert.equal(last.result.usage.operations_started,2); assert.equal(last.result.provenance[0],'obs:read');
});
test('unknown settlement stays held and preserves original admitted operation count', async t => {
  const f=await fixture(t); f.host.worker=async()=>{f.calls.worker++;throw Error('unknown');};
  await createWork(f.options).run(); const restored=await f.restore(f.saved());
  const effect=restored.snapshot().checkpoint.state.entries.find(e=>e.request)!.request!;
  const result=await restored.reconcile({settlement:{effect_id:'task:'+effect.task_id+'/'+effect.attempt_id,
    outcome:'unknown',evidence_ref:'actual-fixture-readback',usage:{tokens:null,cost:null}}});
  assert.equal(result.sdk_status,'NEEDS_RECONCILIATION'); await restored.run(); assert.equal(f.calls.worker,1);
  assert.equal(result.result.usage.operations_started,1);
});
test('pending caller proposal is not replayed after restoration; verified original proposal can be reconciled once', async t => {
  const f=await fixture(t); let proposal!:InitialProposal;
  const initial=f.planner.initial;
  f.planner.initial=async context=>{proposal=await initial(context);throw Error('caller-ack-lost');};
  const first=await createWork(f.options).run(); assert.equal(first.sdk_status,'NEEDS_RECONCILIATION');
  const restored=await f.restore(f.saved()); await restored.run(); assert.equal(f.calls.initial,1);
  await restored.reconcile({planner:proposal}); const last=await restored.run(); assert.equal(last.sdk_status,'COMPLETE');
  assert.equal(f.calls.initial,1); assert.equal(last.usage.planner.calls_started,2);
  await assert.rejects(restored.reconcile({planner:proposal}),/no_pending_planner/);
});
test('disabled capability from caller proposal cannot self-grant worker access', async t => {
  const f=await fixture(t); f.options.catalog[0].capability.authorized=false;
  const result=await createWork(f.options).run(); assert.equal(result.sdk_status,'NEEDS_RECONCILIATION');
  assert.equal(result.snapshot.initialized,false); assert.equal(f.calls.worker,0);
});
test('restore requires latest durable wrapper and current catalog; rehashed model edits grant nothing', async t => {
  const f=await fixture(t); f.planner.initial=async()=>{throw Error('unknown');};
  await createWork(f.options).run(); const snapshot=f.saved();
  const fake=structuredClone(snapshot) as any; fake.planner_calls_started=0;
  await assert.rejects(f.restore(fake),/snapshot_binding/);
  f.host.acceptSnapshot=()=>false; await assert.rejects(f.restore(snapshot),/restore_authority/);
});
test('forged provenance is archived but cannot finish the run', async t => {
  const f=await fixture(t), final=f.host.final;
  f.host.final=async (frame,ctx)=>{const reply=await final(frame,ctx), v=JSON.parse(Buffer.from(reply.raw).toString());
    v.provenance[0].observation_id='unaccepted-worker'; return {...reply,raw:Buffer.from(JSON.stringify(v))};};
  const result=await createWork(f.options).run(); assert.equal(result.sdk_status,'NEEDS_RECONCILIATION');
  assert.equal(result.result.answer,null); assert.equal(f.calls.archive,1); assert.equal(result.snapshot.final_receipt,null);
});
test('denied final origin preserves bytes and prevents observation adoption', async t => {
  const f=await fixture(t); f.host.verifyFinalOrigin=()=>false;
  const result=await createWork(f.options).run(); assert.equal(result.result.answer,null); assert.equal(f.calls.archive,1);
  assert.equal(result.records.observations.filter(o=>o.adoption==='accepted').length,1);
});
test('deadline reached during caller verification cannot apply the initial plan or dispatch', async t => {
  const f=await fixture(t); let clock=f.options.admission.admitted_at_ms;
  f.host.checks.now=()=>clock; f.host.verifyPlannerOrigin=()=>{clock=f.options.admission.deadline_ms;return true;};
  const result=await createWork(f.options).run(); assert.equal(result.snapshot.initialized,false);
  assert.equal(f.calls.worker,0); assert.equal(f.calls.decision,0); assert.equal(f.calls.final,0);
});
test('original parent cancellation prevents the next physical worker', async t => {
  const f=await fixture(t), save=f.host.save;
  f.host.save=async (snapshot,reason)=>{await save(snapshot,reason); if(reason==='tasks_reserved')f.abort.abort();};
  const result=await createWork(f.options).run(); assert.equal(f.calls.worker,0); assert.equal(f.calls.final,0);
  assert.equal(result.result.status,'cancelled');
});
test('raw final rejects string substitute, duplicate JSON members, unaccepted reads and fabricated quotation', async t => {
  const f=await fixture(t), run=createWork(f.options); let frame!:TaskRequest, accepted!:Observation;
  f.host.final=async report=>{frame=report; accepted=Object.values(report.reads)[0]; throw Error('capture-only');};
  await run.run(); const base={run_id:frame.run_id,task_id:frame.task_id,attempt_id:frame.attempt_id,
    input_digest:frame.input_digest,answer:'Sum is 10.',provenance:[{observation_id:accepted.id,claim:'Read the numeric input.'}],unresolved:[]};
  const inspect=(v:any,obs=[accepted])=>inspectFinal(Buffer.from(JSON.stringify(v)),frame,obs,f.host.evidenceText);
  assert.throws(()=>inspectFinal('answer' as any,frame,[accepted],f.host.evidenceText),/size/);
  assert.throws(()=>inspect({...base,provenance:[{observation_id:'foreign',claim:'A result'}]}),/provenance/);
  assert.throws(()=>inspect(base,[]),/read_binding/);
  assert.throws(()=>inspect({...base,answer:'The value is "fabricated".'}),/fabricated_quotation/);
  const duplicate=JSON.stringify(base).replace('"answer":','"answer":"forged","answer":');
  assert.throws(()=>inspectFinal(Buffer.from(duplicate),frame,[accepted],f.host.evidenceText),/duplicate_member/);
});

test('worker return archived before post-read grant revocation; same original attempt is unadopted', async t => {
  const f=await fixture(t), worker=f.host.worker; let authorized=true;
  f.host.checks.isCurrent=()=>authorized;
  f.host.worker=async(frame,ctx)=>{const out=await worker(frame,ctx); authorized=false; return out;};
  const result=await createWork(f.options).run();
  assert.equal(result.sdk_status,'NEEDS_RECONCILIATION'); assert.equal(result.records.observations.length,0);
  assert.equal(f.calls.worker,1); assert.equal(f.calls.final,0);
  const raw=JSON.parse(await readFile(join(f.dir,'observation-read.json'),'utf8'));
  assert.equal(raw.status,'completed'); assert.equal(raw.task_id,'read');
  assert.equal(result.snapshot.checkpoint.state.entries.find(e=>e.task.id==='read')!.state,'running');
});
test('planner allowance is explicit, permission checked again after durable wait, and count is no grant', async t => {
  const f=await fixture(t), save=f.host.save; let allowed=true, checks=0;
  f.host.authorizePlanner=()=>{checks++; return allowed;};
  f.host.save=async(snapshot,reason)=>{await save(snapshot,reason);if(reason==='planner_reserved')allowed=false;};
  const result=await createWork(f.options).run(); assert.equal(checks,2); assert.equal(f.calls.initial,0);
  assert.equal(result.sdk_status,'NEEDS_RECONCILIATION'); assert.equal(result.usage.planner.calls_started,1);
  assert.throws(()=>createWork({...f.options,maxPlannerCalls:undefined as any}),/planner_budget/);
});
test('planner finite count cannot reset across restored snapshot', async t => {
  const f=await fixture(t); const run=createWork({...f.options,maxPlannerCalls:1});
  const result=await run.run(); assert.equal(result.sdk_status,'PAUSED'); assert.equal(result.snapshot.paused_reason,'planner_budget_exhausted');
  const restored=await f.restore(f.saved()); const again=await restored.run(); assert.equal(again.usage.planner.calls_started,1);
  assert.equal(f.calls.initial,1); assert.equal(f.calls.next,0); assert.equal(f.calls.final,0);
});

test('unverified model observation cannot reconcile a pending physical attempt', async t => {
  const f=await fixture(t); let frame!:TaskRequest;
  f.host.worker=async r=>{frame=r;throw Error('unknown');};
  await createWork(f.options).run(); const restored=await f.restore(f.saved());
  f.host.verifyObservationOrigin=()=>false;
  await assert.rejects(restored.reconcile({observation:observed(frame,{sum:99,excerpt:'forged'})}),/observation_origin/);
  assert.equal(restored.snapshot().checkpoint.state.accepted.length,0);
});
test('actual late readback retains late status and matching usage once after original deadline, no effects', async t => {
  const f=await fixture(t); let frame!:TaskRequest, clock=f.options.admission.admitted_at_ms;
  f.host.checks.now=()=>clock; f.host.worker=async r=>{f.calls.worker++;frame=r;throw Error('unknown');};
  const run=createWork(f.options); await run.run(); clock=f.options.admission.deadline_ms+1;
  const observation={...observed(frame,{sum:10,excerpt:'2,3,5'}),usage:{tokens:8,cost:0.02}};
  const late=await run.reconcile({observation});
  assert.equal(late.records.observations.at(-1)!.adoption,'late'); assert.equal(late.result.usage.tokens,8);
  const duplicate=await run.reconcile({observation}); assert.equal(duplicate.result.usage.tokens,8);
  assert.equal(f.calls.worker,1); assert.equal(f.calls.final,0); assert.equal(late.result.status,'hold');
});
test('reconciliation permission is independent and denial cannot mutate generic state', async t => {
  const f=await fixture(t); let frame!:TaskRequest;
  f.host.worker=async r=>{frame=r;throw Error('unknown');};
  const run=createWork(f.options); await run.run(); const before=run.snapshot().checkpoint.state;
  f.host.authorizeReconcile=()=>false;
  await assert.rejects(run.reconcile({observation:observed(frame,{sum:10,excerpt:'2,3,5'})}),/reconcile_authority/);
  assert.deepEqual(run.snapshot().checkpoint.state,before);
});

test('restore uses the digest-verified immutable snapshot across deferred host authorization', async t => {
  const f=await fixture(t); f.planner.initial=async()=>{throw Error('unknown');}; await createWork(f.options).run();
  const snapshot=structuredClone(f.saved()) as any;
  f.host.acceptSnapshot=async()=>{snapshot.planner_calls_started=0;snapshot.planner_max_calls=64;return true;};
  const restored=await f.restore(snapshot);
  assert.equal(restored.snapshot().planner_calls_started,1); assert.equal(restored.snapshot().planner_max_calls,5);
});
test('caller mutation during origin verification cannot replace the verified initial proposal', async t => {
  const f=await fixture(t), initial=f.planner.initial; let original:any;
  f.planner.initial=async input=>{original=await initial(input);return original;};
  f.host.verifyPlannerOrigin=async()=>{original.tasks=[task('foreign','reader',['s2'])];original.usage.cost=999;return true;};
  const result=await createWork(f.options).run(); assert.equal(result.sdk_status,'COMPLETE');
  assert.equal(result.records.plans[1].tasks[0].id,'read'); assert.equal(result.planner_receipts[0].usage.cost,null);
});
test('archiver cannot mutate private final bytes or usage used for validation and adoption', async t => {
  const f=await fixture(t), archive=f.host.archiveFinal;
  f.host.archiveFinal=async record=>{await archive(record);record.raw.fill(32);(record.origin as any).caller_record='changed';};
  const result=await createWork(f.options).run(); assert.equal(result.sdk_status,'COMPLETE'); assert.equal(result.result.answer,'The sum is 10.');
  assert.equal((result.final_receipt as any).origin.caller_record,'current');
  assert.equal((result.final_receipt as any).raw_sha256,hash(await readFile(join(f.dir,'raw-final.json'))));
});
test('writer revoked during final durable barrier cannot receive COMPLETE', async t => {
  const f=await fixture(t), save=f.host.save; let current=true;
  f.host.checks.isCurrent=()=>current;
  f.host.save=async(snapshot,reason)=>{await save(snapshot,reason);if(reason==='final_observed')current=false;};
  const result=await createWork(f.options).run(); assert.equal(result.sdk_status,'NEEDS_RECONCILIATION');
  assert.notEqual(result.result.status,'complete'); assert.equal(result.result.answer,null);
});
test('current grant revocation during reconciliation cannot adopt archived output', async t => {
  const f=await fixture(t); let frame!:TaskRequest;
  f.host.worker=async r=>{frame=r;throw Error('unknown');}; const run=createWork(f.options); await run.run();
  f.host.checks.authorize=()=>false;
  await assert.rejects(run.reconcile({observation:observed(frame,{sum:10,excerpt:'2,3,5'})}),/current_authority/);
  assert.equal(run.snapshot().checkpoint.state.accepted.length,0);
});
test('explicit cancellation persists original cancelled state and never resends pending worker', async t => {
  const f=await fixture(t); f.host.worker=async()=>{f.calls.worker++;throw Error('unknown');};
  const run=createWork(f.options); await run.run(); const cancelled=await run.cancel('Caller cancelled the original work');
  assert.equal(cancelled.result.status,'cancelled'); assert.equal(f.saved().checkpoint.state.status,'cancelled');
  const restored=await f.restore(f.saved()); await restored.run(); assert.equal(f.calls.worker,1);
});

test('raw final lost archival ACK resumes through same pending reporter without generating another answer', async t => {
  const f=await fixture(t), final=f.host.final, archive=f.host.archiveFinal; let reply:any; let lost=true;
  f.host.final=async(frame,ctx)=>{reply=await final(frame,ctx);return reply;};
  f.host.archiveFinal=async record=>{await archive(record);if(lost){lost=false;throw Error('archive-ack-lost');}};
  const first=await createWork(f.options).run(); assert.equal(first.sdk_status,'NEEDS_RECONCILIATION');
  const resumed=await f.restore(f.saved()); await resumed.run(); assert.equal(f.calls.final,1);
  const last=await resumed.reconcile({final:reply}); assert.equal(last.sdk_status,'COMPLETE');
  assert.equal(f.calls.final,1); assert.equal(f.calls.worker,1); assert.equal(last.result.answer,'The sum is 10.');
  assert.equal(last.snapshot.checkpoint.state.deadline_ms,f.options.admission.deadline_ms);
});
test('plain final Observation cannot bypass raw final origin and provenance boundary', async t => {
  const f=await fixture(t); let frame!:TaskRequest;
  f.host.final=async r=>{frame=r;throw Error('unknown-final');}; const run=createWork(f.options);await run.run();
  await assert.rejects(run.reconcile({observation:observed(frame,{answer:'forged',unresolved:[]})}),/raw_final_required/);
  assert.equal(run.snapshot().checkpoint.state.entries.find(e=>e.task.id==='report')!.state,'running');
});
test('foreign worker return remains an original uncertain attempt and does not become ordinary PAUSED', async t => {
  const f=await fixture(t), worker=f.host.worker;
  f.host.worker=async(frame,ctx)=>({...await worker(frame,ctx),run_id:'foreign-run'});
  const result=await createWork(f.options).run(); assert.equal(result.sdk_status,'NEEDS_RECONCILIATION');
  assert.equal(result.records.observations.at(-1)!.adoption,'invalid'); assert.equal(f.calls.final,0);
});
test('planner receives frozen reservation and data while native AbortSignal remains usable', async t => {
  const f=await fixture(t), initial=f.planner.initial;
  f.planner.initial=async context=>{
    assert.throws(()=>{(context.invocation as any).stage='next';},TypeError);
    assert.throws(()=>{(context.catalog[0].capability as any).authorized=false;},TypeError);
    context.signal.addEventListener('abort',()=>{}); return initial(context);
  };
  const result=await createWork(f.options).run(); assert.equal(result.sdk_status,'COMPLETE');
  assert.equal(result.planner_receipts[0].id,'planner:1');
});
test('reconciliation authorization and consumption use the same fixed observation despite caller mutation', async t => {
  const f=await fixture(t);let frame!:TaskRequest;
  f.host.worker=async r=>{frame=r;throw Error('unknown');}; const run=createWork(f.options);await run.run();
  const observation=observed(frame,{sum:10,excerpt:'2,3,5'});
  f.host.authorizeReconcile=async()=>{(observation as any).run_id='changed';(observation.value as any).sum=999;return true;};
  const result=await run.reconcile({observation});
  assert.equal(result.records.observations.at(-1)!.adoption,'accepted');
  assert.equal((result.records.observations.at(-1)!.observation.value as any).sum,10);
});
test('ordinary planner plus task reservations stay inside original total operation budget', async t => {
  const f=await fixture(t); const zero=createWork({...f.options,frame:{...f.options.frame,budget:{...f.options.frame.budget,max_operations:0}}});
  const outcome=await zero.run(); assert.equal(f.calls.initial,0); assert.equal(outcome.usage.parent_operations_started,0);
  const g=await fixture(t); const initial=g.planner.initial;
  g.planner.initial=async context=>({...await initial(context),tasks:[task('left','reader',['s1']),task('right','reader',['s1']),
    task('report','reporter',[],['left','right'])]});
  const limited=createWork({...g.options,frame:{...g.options.frame,budget:{...g.options.frame.budget,max_operations:2}}});
  const result=await limited.run(); assert.ok(result.usage.parent_operations_started<=2); assert.equal(g.calls.worker,1);
  assert.equal(g.calls.next,0); assert.equal(g.calls.final,0); assert.equal(result.result.status,'hold');
});
test('per-call cancellation during raw archive cannot cross final durable finish barrier', async t => {
  const f=await fixture(t), call=new AbortController(), archive=f.host.archiveFinal;
  f.host.archiveFinal=async record=>{await archive(record);call.abort();};
  const result=await createWork(f.options).run({signal:call.signal});assert.notEqual(result.result.status,'complete');
  assert.equal(result.result.answer,null);assert.equal(result.result.status,'cancelled');
});

test('actual late native final saves original bytes and matching usage once, never COMPLETE or new generation', async t => {
  const f=await fixture(t), final=f.host.final; let reply:any, clock=f.options.admission.admitted_at_ms;
  f.host.checks.now=()=>clock;
  f.host.final=async(frame,ctx)=>{reply={...await final(frame,ctx),usage:{tokens:12,cost:0.05}};throw Error('native-ack-lost');};
  const run=createWork(f.options);await run.run();clock=f.options.admission.deadline_ms+1;
  const result=await run.reconcile({final:reply});assert.notEqual(result.result.status,'complete');
  assert.equal(result.records.observations.at(-1)!.adoption,'late');
  assert.deepEqual(result.records.observations.at(-1)!.observation.usage,{tokens:12,cost:0.05});
  assert.equal((result.final_receipt as any).disposition,'SAVED_UNADOPTED_ORIGINAL_PARENT_ENDED');
  const again=await run.reconcile({final:reply});
  assert.equal(again.records.observations.at(-1)!.adoption,'duplicate'); assert.equal(f.calls.final,1);
  assert.equal(f.calls.worker,1);assert.equal(again.snapshot.checkpoint.state.usages.length,2);
});

test('matching late physical return becomes known STOPPED while pending native decision remains uncertain before restore', async t => {
  const f=await fixture(t);let frame!:TaskRequest,clock=f.options.admission.admitted_at_ms;
  f.host.checks.now=()=>clock; f.host.worker=async r=>{frame=r;throw Error('unknown');};
  const run=createWork(f.options);await run.run();clock=f.options.admission.deadline_ms+1;
  const late=await run.reconcile({observation:observed(frame,{sum:10,excerpt:'2,3,5'})});
  assert.equal(late.sdk_status,'STOPPED');assert.equal(late.result.status,'hold');assert.equal(late.result.answer,null);
  const g=await fixture(t,'missing'),admitted=g.options.admission.admitted_at_ms;
  const options={...g.options,admission:{...g.options.admission,timeout_ms:200,deadline_ms:admitted+200},
    frame:{...g.options.frame,budget:{...g.options.frame.budget,timeout_ms:200}}};
  g.host.checks.now=()=>admitted;g.host.checks.acceptNativeAdmission=a=>a.deadline_ms===admitted+200;
  g.host.decision=async()=>{g.calls.decision++;return new Promise(()=>{});};
  const pending=await createWork(options).run();assert.equal(pending.sdk_status,'NEEDS_RECONCILIATION');
  assert.ok(pending.snapshot.checkpoint.state.pending_decision);assert.equal(g.calls.decision,1);assert.equal(g.calls.final,0);
});
