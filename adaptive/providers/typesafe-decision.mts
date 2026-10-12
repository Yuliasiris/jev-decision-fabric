/** Private host composition only. Reuses the existing serializer, reservation and runner. */
import {DecisionError} from '../../netlify/lib/decision-fabric.mts';
import type {TraceStore} from '../../netlify/lib/decision-fabric.mts';
import type {DecisionPort, EvidenceMode} from '../contract/c0.mts';
import {fabricDecision} from '../src/fabric-decision.mts';
import {typesafeOnce} from './typesafe-once.mts';
import type {HostOptions} from './typesafe-once.mts';

export const PRIVATE_HOST_DECISION_VERSION = 'jev-private-host-decision/0.1.0-preview' as const;
/** Host supplies its existing parent cancellation signal and original absolute deadline. */
export function privateHostDecision(options: HostOptions,
  parent: Readonly<{signal: AbortSignal; deadline_ms: number}>, mode: EvidenceMode, store: TraceStore): DecisionPort {
  const {signal, deadline_ms} = parent; // Capture once; later calls cannot extend the parent deadline.
  if (!Number.isSafeInteger(deadline_ms)) throw new DecisionError('invalid');
  const once = typesafeOnce(options); // One reservation for this admitted job, never recreated per choose.
  return fabricDecision({capability: once.capability, invoke: invocation => {
    if (signal.aborted) throw new DecisionError('cancelled');
    const remaining = deadline_ms - Date.now();
    if (remaining <= 0) throw new DecisionError('timeout');
    return once.invoke({...invocation, signal: AbortSignal.any([invocation.signal, signal,
      AbortSignal.timeout(Math.min(60000, remaining))])});
  }}, mode, store);
}
