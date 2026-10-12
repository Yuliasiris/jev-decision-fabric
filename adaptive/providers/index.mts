/** Host-local TypeSafe binding; no key discovery, allocation creation or public-tool bypass. */
export {privateHostDecision as createTypeSafeDecision} from './typesafe-decision.mts';
export {typesafeOnce, prepareWire, bindActualSend, TRANSPORT_TIMEOUT_MS} from './typesafe-once.mts';
export type {HostOptions, WireReview} from './typesafe-once.mts';
export {prepareDecisionRequest, TEMPLATE_VERSION} from '../src/fabric-decision.mts';
export type {TraceStore} from '../../netlify/lib/decision-fabric.mts';
