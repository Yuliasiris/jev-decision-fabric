/** Optional work tools. The authenticated host owns admission, effects and storage. */
import {CONTRACT_VERSION} from '../contract/c0.mts';
import type {Result} from '../contract/c0.mts';
import {canonical} from '../src/controller.mts';

export type WorkCaller = Readonly<{principal: string; signal: AbortSignal}>;
export type WorkAction = 'start' | 'continue' | 'status' | 'cancel';
export type StartArguments = Readonly<{request: string; request_id: string}>;
export type RunArguments = Readonly<{run_id: string}>;
export type CancelArguments = RunArguments & Readonly<{reason: string}>;
/**
 * start must durably bind (principal, request_id, exact request) before any effect.
 * Identical repeated requests read the original result; uncertain effects are not resent.
 * continue restores the original run/checkpoint/deadline/budget, never a fresh grant.
 * Authorization is rechecked by the SDK host at its actual effect boundaries too.
 */
export interface HostWorkService {
  authorize(action: WorkAction, args: StartArguments | RunArguments | CancelArguments,
    caller: WorkCaller): Promise<boolean>;
  start(args: StartArguments, caller: WorkCaller): Promise<Result>;
  continue(args: RunArguments, caller: WorkCaller): Promise<Result>;
  status(args: RunArguments, caller: WorkCaller): Promise<Result>;
  cancel(args: CancelArguments, caller: WorkCaller): Promise<Result>;
}
export class WorkToolError extends Error {
  readonly code: 'WORK_ARGUMENTS_INVALID' | 'WORK_NOT_AUTHORIZED' | 'WORK_UNAVAILABLE' | 'WORK_FAILURE';
  constructor(code: WorkToolError['code']) {super(code);this.code = code;}
}
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const names = {work_start_v1: 'start', work_continue_v1: 'continue',
  work_status_v1: 'status', work_cancel_v1: 'cancel'} as const;
type Name = keyof typeof names;
const idSchema = {type: 'string', minLength: 1, maxLength: 128, pattern: ID.source};
/** No binding means no advertisement; a schema does not create a running service. */
export function workToolDefinitions(service?: HostWorkService) {
  if (!service) return [];
  const schema = (properties: Record<string, unknown>, required: string[]) =>
    ({type: 'object', properties, required, additionalProperties: false});
  const common = {destructiveHint: false, idempotentHint: true, openWorldHint: true};
  return [
    {name: 'work_start_v1', description: 'Start an ordinary request using this host\'s authorized registered operations. The client retains request_id for readback after an uncertain response. No authority or model is accepted from arguments.',
      inputSchema: schema({request: {type: 'string', minLength: 1, maxLength: 16000}, request_id: idSchema}, ['request', 'request_id']),
      annotations: {...common, readOnlyHint: false}},
    {name: 'work_continue_v1', description: 'Continue the same saved run under its original deadline, budget and host authority. Unknown effects need reconciliation and are not automatically resent.',
      inputSchema: schema({run_id: idSchema}, ['run_id']), annotations: {...common, readOnlyHint: false, idempotentHint: false}},
    {name: 'work_status_v1', description: 'Read the authorized current result and unresolved work of the same run. This does not start, refresh or retry work.',
      inputSchema: schema({run_id: idSchema}, ['run_id']), annotations: {...common, readOnlyHint: true}},
    {name: 'work_cancel_v1', description: 'Request cancellation of this host\'s existing run. Saved evidence and uncertain effects remain available for reconciliation.',
      inputSchema: schema({run_id: idSchema, reason: {type: 'string', minLength: 1, maxLength: 2000}}, ['run_id', 'reason']),
      annotations: {...common, readOnlyHint: false}},
  ];
}
function record(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(x));
}
function parse(action: WorkAction, args: unknown): StartArguments | RunArguments | CancelArguments {
  if (!record(args)) throw new WorkToolError('WORK_ARGUMENTS_INVALID');
  const fields = action === 'start' ? ['request', 'request_id'] : action === 'cancel' ? ['run_id', 'reason'] : ['run_id'];
  if (Object.keys(args).length !== fields.length || !fields.every(k => Object.hasOwn(args, k)))
    throw new WorkToolError('WORK_ARGUMENTS_INVALID');
  const identity = action === 'start' ? args.request_id : args.run_id;
  if (typeof identity !== 'string' || !ID.test(identity)) throw new WorkToolError('WORK_ARGUMENTS_INVALID');
  const body = action === 'start' ? args.request : action === 'cancel' ? args.reason : undefined;
  if ((action === 'start' || action === 'cancel') && (typeof body !== 'string' || !body.trim() || body.length > (action === 'start' ? 16000 : 2000)))
    throw new WorkToolError('WORK_ARGUMENTS_INVALID');
  return Object.freeze(structuredClone(args)) as StartArguments | RunArguments | CancelArguments;
}
export async function callWorkTool(service: HostWorkService | undefined, name: string,
  args: unknown, caller: WorkCaller) {
  if (!service || !Object.hasOwn(names, name)) throw new WorkToolError('WORK_UNAVAILABLE');
  const action = names[name as Name], input = parse(action, args);
  if (!caller.principal || caller.signal.aborted) throw new WorkToolError('WORK_NOT_AUTHORIZED');
  try {
    if (await service.authorize(action, input, caller) !== true || caller.signal.aborted)
      throw new WorkToolError('WORK_NOT_AUTHORIZED');
    const returned = action === 'start' ? await service.start(input as StartArguments, caller) :
      action === 'cancel' ? await service.cancel(input as CancelArguments, caller) :
      await service[action](input as RunArguments, caller);
    const result = structuredClone(returned);
    const serialized = canonical(result); // Exact detached response before another asynchronous boundary.
    if (result.contract_version !== CONTRACT_VERSION || typeof result.run_id !== 'string' || !ID.test(result.run_id) ||
      result.authority !== 'advisory_only' || result.automatic_apply !== false ||
      (action !== 'start' && result.run_id !== (input as RunArguments).run_id))
      throw new WorkToolError('WORK_FAILURE');
    if (caller.signal.aborted || await service.authorize(action, input, caller) !== true || caller.signal.aborted)
      throw new WorkToolError('WORK_NOT_AUTHORIZED');
    if (Buffer.byteLength(serialized) > 512 * 1024) throw new WorkToolError('WORK_FAILURE');
    return {structuredContent: structuredClone(result), content: [{type: 'text' as const, text: serialized}], isError: false};
  } catch (error) {
    if (error instanceof WorkToolError) throw error;
    throw new WorkToolError('WORK_FAILURE');
  }
}
/** JSON-RPC dispatch only; a real transport supplies the trusted caller context. */
export function createWorkMcpHandler(service: HostWorkService | undefined, caller: WorkCaller) {
  return async (message: unknown) => {
    if (!record(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return {jsonrpc: '2.0', id: null, error: {code: -32600, message: 'Invalid Request'}};
    if (!Object.hasOwn(message, 'id')) return null;
    const id = message.id;
    if (typeof id !== 'string' && !Number.isSafeInteger(id))
      return {jsonrpc: '2.0', id: null, error: {code: -32600, message: 'Invalid Request'}};
    const ok = (result: unknown) => ({jsonrpc: '2.0', id, result});
    if (message.method === 'initialize') return ok({protocolVersion: record(message.params) &&
      ['2025-03-26','2025-06-18','2025-11-25'].includes(String(message.params.protocolVersion)) ? message.params.protocolVersion : '2025-11-25',
      capabilities: {tools: {listChanged: false}}, serverInfo: {name: 'jev-host-work', version: '0.1.0-preview'},
      instructions: 'Work tools exist only when this host binds its authorized SDK service. The legacy installed Jev plugin exposes separate fixed-question decision tools.'});
    if (message.method === 'ping') return ok({});
    if (message.method === 'tools/list') return ok({tools: workToolDefinitions(service)});
    if (message.method !== 'tools/call') return {jsonrpc: '2.0', id, error: {code: -32601, message: 'Method not found'}};
    if (!record(message.params) || typeof message.params.name !== 'string')
      return {jsonrpc: '2.0', id, error: {code: -32602, message: 'Invalid tool arguments'}};
    try {return ok(await callWorkTool(service, message.params.name, message.params.arguments, caller));}
    catch (error) {return ok({isError: true, content: [{type: 'text', text: error instanceof WorkToolError ? error.code : 'WORK_FAILURE'}]});}
  };
}
