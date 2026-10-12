/** Host adapter candidate. Not a new MCP tool and not an authority issuer.
 * Uses the existing preview RequestData and frozen Fabric normalizer/runner.
 * No credentials are read from any remote service or included in audit events.
 */
import {createHash} from 'node:crypto';
import {DecisionError, canonical, digest} from '../../netlify/lib/decision-fabric.mts';
import type {Invocation, Provider} from '../../netlify/lib/decision-fabric.mts';
import {TEMPLATE_VERSION} from '../src/fabric-decision.mts';
import {boundedJSON, validateAnswers} from '../../netlify/lib/gateway.mts';

const DESTINATION = 'https://api.typesafe.ai/v1/systemone';
export const TRANSPORT_TIMEOUT_MS = 15000;
const bytesHash = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const freeze = <T,>(v: T): T => {if (v !== null && typeof v === 'object') {Object.values(v).forEach(freeze); Object.freeze(v);} return v;};
export type WireReview = Readonly<{
  recipient: 'TypeSafe'; destination: typeof DESTINATION; method: 'POST';
  content_type: 'application/json'; redirect: 'error'; credentials: 'omit';
  authentication: 'host-supplied Bearer; credential value excluded from review/log';
  question_template: string; model: string; body_utf8: string; body_bytes: number;
  timeout_ms: number; header_names: readonly string[];
  body_sha256: string; state_sha256: string; questions_sha256: string;
  logical_packet_sha256: string; upstream_keys: readonly string[];
}>;
export function prepareWire(invocation: Invocation, model: string): WireReview {
  if (!/^jev-[a-zA-Z0-9._-]{1,80}$/.test(model)) throw new DecisionError('invalid');
  const r = invocation.request;
  if (r.question_set !== TEMPLATE_VERSION || Object.keys(r.questions).join(',') !== 'next' ||
      r.questions.next.type !== 'choice' || r.modalities.join(',') !== 'text' ||
      Object.keys(invocation.upstream).length !== 0) throw new DecisionError('unsupported');
  if (digest(r.state) !== r.revision) throw new DecisionError('stale');
  // Clone/serialize once. The reviewed byte string is the string actually passed to fetch.
  canonical(r.state); canonical(r.questions);
  const body_utf8 = JSON.stringify({model, state: structuredClone(r.state), questions: structuredClone(r.questions)});
  if (Buffer.byteLength(body_utf8) > 160 * 1024) throw new DecisionError('invalid');
  return freeze({recipient: 'TypeSafe', destination: DESTINATION, method: 'POST',
    content_type: 'application/json', redirect: 'error', credentials: 'omit',
    authentication: 'host-supplied Bearer; credential value excluded from review/log',
    question_template: r.question_set, model, body_utf8, body_bytes: Buffer.byteLength(body_utf8),
    timeout_ms: TRANSPORT_TIMEOUT_MS, header_names: ['authorization', 'content-type'],
    body_sha256: bytesHash(body_utf8), state_sha256: digest(r.state), questions_sha256: digest(r.questions),
    logical_packet_sha256: digest({request: r, upstream: invocation.upstream}), upstream_keys: []});
}
/** Read back the actual nonsecret URL/init immediately before send. Never include credential values. */
export function bindActualSend(invocation: Invocation, prepared: WireReview, destination: string, init: RequestInit): WireReview {
  if (typeof init.body !== 'string') throw new DecisionError('invalid');
  let body: any;
  try {body = JSON.parse(init.body);} catch {throw new DecisionError('invalid');}
  const headers = new Headers(init.headers);
  const actual = {...prepared, destination, method: init.method, redirect: init.redirect, credentials: init.credentials,
    content_type: headers.get('content-type'), header_names: [...headers.keys()].sort(),
    model: body.model, body_utf8: init.body, body_bytes: Buffer.byteLength(init.body), body_sha256: bytesHash(init.body),
    state_sha256: digest(body.state), questions_sha256: digest(body.questions),
    logical_packet_sha256: digest({request: invocation.request, upstream: invocation.upstream})};
  if (canonical(actual) !== canonical(prepared)) throw new DecisionError('unauthorized');
  return freeze(actual) as WireReview;
}
export type HostOptions = {
  model: string;
  /** Trusted host verifies purpose/recipient/data and current authority. Never infer this from a candidate. */
  authorize: (wire: WireReview) => boolean | Promise<boolean>;
  /** Existing host credential only. This adapter does not discover, create or transport keys. */
  getCredential: () => string | undefined;
  /** Must resolve before send. The host owns durability/access control of this journal. */
  record: (event: Readonly<Record<string, unknown>>) => Promise<void>;
  send?: typeof fetch;
  /** Test clock seam; actual transport metadata remains 15s, parent deadline is also retained. */
  timeoutSignal?: (ms: number) => AbortSignal;
};
export function typesafeOnce(opts: HostOptions): Provider {
  let reserved = false;
  const send = opts.send ?? fetch;
  return {capability: {id: 'typesafe-direct-preview', mode: 'primary', verified: true,
    kinds: ['choice'], modalities: ['text'], evidence: 'protocol mapping only; host authority and credential required at invocation'},
    invoke: async (invocation) => {
      if (invocation.signal.aborted) throw new DecisionError('cancelled');
      if (reserved) throw new DecisionError('budget_exhausted');
      const wire = prepareWire(invocation, opts.model);
      if (!await opts.authorize(wire)) throw new DecisionError('unauthorized');
      if (invocation.signal.aborted) throw new DecisionError('cancelled');
      // Atomic in this process before any further await; no second physical attempt.
      if (reserved) throw new DecisionError('budget_exhausted');
      reserved = true;
      const key = opts.getCredential()?.trim();
      if (!key || /[^\x20-\x7e]/.test(key)) throw new DecisionError('unavailable');
      await opts.record({kind: 'wire_prepared', wire, transport: opts.send ? 'host_supplied_transport' : 'native_fetch',
        reservation: 1, credential_logged: false});
      if (invocation.signal.aborted) throw new DecisionError('cancelled');
      if (opts.model !== wire.model) throw new DecisionError('stale');
      const signal = AbortSignal.any([invocation.signal, (opts.timeoutSignal ?? AbortSignal.timeout)(TRANSPORT_TIMEOUT_MS)]);
      const init: RequestInit = {method: wire.method,
        headers: {'content-type': wire.content_type, authorization: `Bearer ${key}`},
        body: wire.body_utf8, signal, redirect: wire.redirect, credentials: wire.credentials};
      // Initial permission is not a final grant after journal waiting. Bind actual bytes and recheck authority here.
      const actual = bindActualSend(invocation, wire, wire.destination, init);
      if (!await opts.authorize(actual)) throw new DecisionError('unauthorized');
      bindActualSend(invocation, actual, actual.destination, init); // Also fence changes during async final authority lookup.
      if (opts.model !== actual.model) throw new DecisionError('stale');
      if (signal.aborted) throw new DecisionError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
      const began = performance.now();
      let raw: unknown;
      let onAbort = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new DecisionError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled'));
        signal.addEventListener('abort', onAbort, {once: true});
      });
      const receive = async () => {
        // No await, body rewrite or URL change between final binding and the one physical attempt.
        const response = await send(actual.destination, init);
        if (signal.aborted) {await response.body?.cancel(); throw new DecisionError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');}
        if (!response.ok) {
          await response.body?.cancel();
          await opts.record({kind: 'http_failure', status: response.status, body_sha256: wire.body_sha256, automatic_retry: false});
          throw new DecisionError(response.status === 429 ? 'rate_limited' : response.status === 401 || response.status === 403 ? 'unauthorized' : 'error');
        }
        let result: unknown;
        try {result = await boundedJSON(response, 512 * 1024); validateAnswers(result, invocation.request.questions);}
        catch {throw new DecisionError(signal.aborted ? signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' : 'invalid');}
        if (signal.aborted) throw new DecisionError(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled');
        return result;
      };
      try {
        raw = await Promise.race([receive(), aborted]);
      } catch (error) {
        if (error instanceof DecisionError) throw error;
        await opts.record({kind: 'transport_outcome_unknown', body_sha256: wire.body_sha256, automatic_retry: false});
        throw new DecisionError(signal.aborted ? signal.reason?.name === 'TimeoutError' ? 'timeout' : 'cancelled' : 'error');
      } finally {signal.removeEventListener('abort', onAbort);}
      await opts.record({kind: 'response_received', body_sha256: wire.body_sha256,
        response_canonical_sha256: digest(raw),
        transport_elapsed_ms: performance.now() - began, raw_response: raw,
        response_semantics_validated_by: 'pinned gateway typed checks then existing Fabric normalizer'});
      return raw;
    }};
}
