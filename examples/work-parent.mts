/** Ordinary parent client for the existing optional work MCP service. No planner or grants. */
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {closeSync,existsSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {CONTRACT_VERSION} from '../adaptive/contract/c0.mts';
import type {Result} from '../adaptive/contract/c0.mts';
import {canonical,digest} from '../adaptive/src/controller.mts';
import {renderParentText,renderParentHelp,renderParentError} from './work-parent-view.mts';

type RPC = Readonly<{jsonrpc:'2.0';id?:number;method:string;params?:unknown}>;
/** Trusted caller code binds a transport. Tool arguments never configure authentication. */
export interface ParentTransport {
  request(message:RPC):Promise<string>;
  notify(message:RPC):Promise<void>;
  close():Promise<boolean>;
}
export type ParentOperation = 'start'|'continue'|'status';
type Entry = {operation:ParentOperation;tool:string;arguments:Record<string,string>;
  disposition:'prepared'|'sent'|'verified'|'response_unknown';raw_responses:string[];
  transport_closed:boolean|null;error:string|null};
export type ParentJournal = {
  schema:'jev.reference-parent-journal.v1';request:string;request_id:string;state_directory:string;
  run_id:string|null;last_result:Result|null;history:Entry[];digest:string;
};
export type ParentMessage = Readonly<{
  kind:'ordinary-parent-message';request_id:string;run_id:string|null;
  status:Result['status']|'response_unknown'|'not_started'|'readback_unconfirmed';text:string;
  next_operation:'continue'|'status'|'host_readback_or_reconciliation'|'none';
  result:Result|null;client_journal_sha256:string;
  result_is_cached:boolean;
  delivery:'transport_operation'|'saved_client_receipt';
  current_operation:Readonly<{operation:ParentOperation;disposition:Entry['disposition'];error:string|null;transport_closed:boolean|null}>|null;
  qualification:'client projection only; actual host origins and effects require their own evidence';
}>;
const ID=/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;
const MAX_REPLY=512*1024,MAX_JOURNAL=20*1024*1024,MAX_ENTRIES=32;
const object=(x:unknown):x is Record<string,any>=>!!x&&typeof x==='object'&&!Array.isArray(x);
const strings=(x:unknown)=>Array.isArray(x)&&x.every(s=>typeof s==='string');
export class ParentClientError extends Error {
  constructor(code:string){super(code);this.name='ParentClientError';}
}
function immutable<T>(value:T):T {
  const copy=structuredClone(value);
  const freeze=(x:any)=>{if(x&&typeof x==='object'){for(const item of Object.values(x))freeze(item);Object.freeze(x);}};
  freeze(copy);return copy;
}
function appendReply(entry:Entry,raw:string){
  if(typeof raw!=='string'||Buffer.byteLength(raw)>MAX_REPLY)throw new ParentClientError('PARENT_REPLY_TOO_LARGE');
  entry.raw_responses.push(raw);
}
function readJournal(path:string):ParentJournal {
  if(lstatSync(path).isSymbolicLink())throw new ParentClientError('PARENT_JOURNAL_INVALID');
  const raw=readFileSync(path,'utf8');if(Buffer.byteLength(raw)>MAX_JOURNAL)throw new ParentClientError('PARENT_JOURNAL_INVALID');
  const value=JSON.parse(raw),{digest:recorded,...body}=value;
  if(!object(value)||recorded!==digest(body)||value.schema!=='jev.reference-parent-journal.v1'||
    typeof value.request!=='string'||!value.request.trim()||value.request.length>16000||typeof value.request_id!=='string'||!ID.test(value.request_id)||
    typeof value.state_directory!=='string'||resolve(value.state_directory)!==value.state_directory||
    value.run_id!==null&&(typeof value.run_id!=='string'||!ID.test(value.run_id))||
    !Array.isArray(value.history)||value.history.length>MAX_ENTRIES)
    throw new ParentClientError('PARENT_JOURNAL_INVALID');
  for(const entry of value.history){
    if(!object(entry)||!['start','continue','status'].includes(entry.operation)||
      !['prepared','sent','verified','response_unknown'].includes(entry.disposition)||
      !strings(entry.raw_responses)||entry.raw_responses.some((raw:string)=>Buffer.byteLength(raw)>MAX_REPLY))
      throw new ParentClientError('PARENT_JOURNAL_INVALID');
  }
  if(value.last_result!==null)validateResult(value.last_result,value.run_id);
  return value as ParentJournal;
}
function saveJournal(path:string,journal:ParentJournal){
  const {digest:_old,...body}=journal;journal.digest=digest(body);
  const raw=JSON.stringify(journal,null,2)+'\n';if(Buffer.byteLength(raw)>MAX_JOURNAL)throw new ParentClientError('PARENT_JOURNAL_FULL');
  const tmp=path+'.'+randomUUID()+'.tmp',fd=openSync(tmp,'wx',0o600);
  try{writeFileSync(fd,raw);fsyncSync(fd);}finally{closeSync(fd);}
  renameSync(tmp,path);
  if(readJournal(path).digest!==journal.digest)throw new ParentClientError('PARENT_SAVE_UNCONFIRMED');
}
function uncertain(journal:ParentJournal){
  return journal.history.some(e=>e.operation!=='status'&&(e.disposition==='sent'||e.disposition==='response_unknown'));
}
function project(journal:ParentJournal,fromClientReceipt=false):ParentMessage {
  const result=journal.last_result,unknown=uncertain(journal),last=journal.history.at(-1),failed=!!last&&(last.error!==null||last.transport_closed===false);
  const status=unknown?'response_unknown':failed&&result?'readback_unconfirmed':result?.status??'not_started';
  const unconfirmedClose=journal.history.some(e=>e.transport_closed!==true&&e.disposition!=='prepared');
  const next=unknown||failed||unconfirmedClose||!result?'host_readback_or_reconciliation':result.status==='needs_host'?'continue':'none';
  const text=unknown?'The original operation has no verified response. Preserve its request_id and run_id; the host must read or reconcile the original effect. Do not resend it.':
    failed&&result?`The current ${last!.operation} operation or host close is unconfirmed. The previous result remains saved evidence; inspect actual host readback or reconciliation before another effect.`:
    result?.answer??(result?.status==='needs_host'?'The host returned saved unfinished work. An explicit continuation may be requested under the original limits.':
      result?`The host returned ${result.status}.`:'No work tool was invoked. Inspect the saved preflight error and original host configuration; no run_id is available.');
  return {kind:'ordinary-parent-message',request_id:journal.request_id,run_id:journal.run_id,status,text,
    next_operation:next,result:result===null?null:structuredClone(result),client_journal_sha256:journal.digest,
    result_is_cached:result!==null&&(fromClientReceipt||last?.disposition!=='verified'),
    delivery:fromClientReceipt?'saved_client_receipt':'transport_operation',
    current_operation:!fromClientReceipt&&last?{operation:last.operation,disposition:last.disposition,error:last.error,transport_closed:last.transport_closed}:null,
    qualification:'client projection only; actual host origins and effects require their own evidence'};
}
/** Read only the existing verified client record; never connect, save, lock, or append history. */
export function inspectParentReceipt(receiptPath:string):Readonly<{message:ParentMessage;journal:ParentJournal}> {
  const path=resolve(receiptPath);
  if(!existsSync(path))throw new ParentClientError('PARENT_RECEIPT_NOT_FOUND');
  try{const journal=immutable(readJournal(path));return immutable({message:project(journal,true),journal});}
  catch(error){if(error instanceof ParentClientError)throw error;throw new ParentClientError('PARENT_JOURNAL_INVALID');}
}
function validateResult(value:unknown,expectedRun:string|null):asserts value is Result {
  const count=(n:unknown)=>typeof n==='number'&&Number.isSafeInteger(n)&&n>=0;
  const nullable=(n:unknown,integer:boolean)=>n===null||typeof n==='number'&&Number.isFinite(n)&&n>=0&&(!integer||Number.isSafeInteger(n));
  if(!object(value)||value.contract_version!==CONTRACT_VERSION||typeof value.run_id!=='string'||!ID.test(value.run_id)||
    expectedRun!==null&&value.run_id!==expectedRun||!['needs_host','complete','hold','cancelled','failed'].includes(value.status)||
    !(value.answer===null||typeof value.answer==='string')||!strings(value.unresolved)||!strings(value.provenance)||!strings(value.pending)||
    value.authority!=='advisory_only'||value.automatic_apply!==false||!object(value.usage)||
    !count(value.usage.operations_started)||!count(value.usage.decisions_started)||!object(value.usage.by_kind)||
    !['worker','tool','caller','decision'].every(k=>count(value.usage.by_kind[k]))||
    !nullable(value.usage.tokens,true)||!nullable(value.usage.cost,false)||
    value.status==='complete'&&(typeof value.answer!=='string'||value.pending.length!==0))
    throw new ParentClientError('PARENT_RESULT_INVALID');
}
function decode(raw:string,id:number):Record<string,any>{
  if(Buffer.byteLength(raw)>MAX_REPLY)throw new ParentClientError('PARENT_REPLY_TOO_LARGE');
  const reply=JSON.parse(raw);
  if(!object(reply)||reply.jsonrpc!=='2.0'||reply.id!==id||Object.hasOwn(reply,'error')||!object(reply.result))
    throw new ParentClientError('PARENT_RPC_INVALID');
  return reply.result;
}
function checkTool(list:Record<string,any>,tool:string,fields:string[]){
  if(!Array.isArray(list.tools))throw new ParentClientError('PARENT_TOOL_UNAVAILABLE');
  const matches=list.tools.filter((x:any)=>object(x)&&x.name===tool);
  const schema=matches.length===1?matches[0].inputSchema:null;
  if(!object(schema)||schema.type!=='object'||schema.additionalProperties!==false||!object(schema.properties)||
    canonical(Object.keys(schema.properties).sort())!==canonical([...fields].sort())||
    !strings(schema.required)||canonical([...schema.required].sort())!==canonical([...fields].sort()))
    throw new ParentClientError('PARENT_TOOL_UNAVAILABLE');
}

/** One explicit operation. The file is a client journal, never the host's controller state. */
export async function runParentOperation(options:Readonly<{
  receiptPath:string;operation:ParentOperation;request?:string;requestId?:string;stateDirectory?:string;
  connect:()=>Promise<ParentTransport>;
}>):Promise<ParentMessage>{
  const receiptPath=resolve(options.receiptPath),operation=options.operation,request=options.request,
    requestId=options.requestId,stateDirectory=options.stateDirectory===undefined?undefined:resolve(options.stateDirectory),connect=options.connect;
  if(!['start','continue','status'].includes(operation))throw new ParentClientError('PARENT_ARGUMENTS_INVALID');
  mkdirSync(dirname(receiptPath),{recursive:true,mode:0o700});
  const lock=receiptPath+'.lock',fd=openSync(lock,'wx',0o600),token=randomUUID();writeFileSync(fd,token);
  let transport:ParentTransport|undefined,journal:ParentJournal|undefined,entry:Entry|undefined;
  try{
    if(existsSync(receiptPath))journal=readJournal(receiptPath);
    if(operation==='start'){
      const originalState=stateDirectory??journal?.state_directory;
      if(typeof request!=='string'||!request.trim()||request.length>16000||!originalState||
        requestId!==undefined&&(typeof requestId!=='string'||!ID.test(requestId)))
        throw new ParentClientError('PARENT_ARGUMENTS_INVALID');
      const originalId=requestId??journal?.request_id??'parent-'+randomUUID();
      if(journal){
        if(journal.request!==request||journal.request_id!==originalId||journal.state_directory!==originalState)
          throw new ParentClientError('PARENT_REQUEST_CONFLICT');
        // An identical start is a local receipt read. It never calls start again.
        return project(journal,true);
      }
      journal={schema:'jev.reference-parent-journal.v1',request,request_id:originalId,state_directory:originalState,
        run_id:null,last_result:null,history:[],digest:''};saveJournal(receiptPath,journal);
    }else{
      if(!journal||!journal.run_id)throw new ParentClientError('PARENT_ORIGINAL_RUN_UNAVAILABLE');
      if(request!==undefined||requestId!==undefined||stateDirectory!==undefined&&stateDirectory!==journal.state_directory)
        throw new ParentClientError('PARENT_ARGUMENTS_INVALID');
      if(operation==='continue'&&uncertain(journal))throw new ParentClientError('PARENT_RECONCILIATION_REQUIRED');
      if(operation==='continue'&&journal.history.some(e=>e.transport_closed!==true&&e.disposition!=='prepared'))throw new ParentClientError('PARENT_HOST_CLOSE_UNCONFIRMED');
    }
    if(!journal||journal.history.length>=MAX_ENTRIES)throw new ParentClientError('PARENT_JOURNAL_FULL');
    const tool=operation==='start'?'work_start_v1':operation==='continue'?'work_continue_v1':'work_status_v1';
    const args:Record<string,string>=operation==='start'?{request:journal.request,request_id:journal.request_id}:{run_id:journal.run_id!};
    const active:Entry={operation,tool,arguments:args,disposition:'prepared',raw_responses:[],transport_closed:null,error:null};
    entry=active;journal.history.push(active);saveJournal(receiptPath,journal);
    transport=await connect();
    const initialized=await transport.request(immutable({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-11-25',
      capabilities:{},clientInfo:{name:'ordinary-parent-reference',version:'1'}}}));
    appendReply(active,initialized);saveJournal(receiptPath,journal);
    const init=decode(initialized,1);
    if(init.protocolVersion!=='2025-11-25'||!object(init.capabilities?.tools))throw new ParentClientError('PARENT_PROTOCOL_UNSUPPORTED');
    await transport.notify(immutable({jsonrpc:'2.0',method:'notifications/initialized'}));
    const listed=await transport.request(immutable({jsonrpc:'2.0',id:2,method:'tools/list',params:{}}));
    appendReply(active,listed);saveJournal(receiptPath,journal);
    checkTool(decode(listed,2),tool,Object.keys(args));
    // The exact operation is durable before its only physical send. Uncertain sends are not replayed.
    active.disposition='sent';saveJournal(receiptPath,journal);
    const raw=await transport.request(immutable({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:tool,arguments:args}}));
    appendReply(active,raw);saveJournal(receiptPath,journal);
    const reply=decode(raw,3);
    if(reply.isError!==false||!Array.isArray(reply.content)||reply.content.length!==1||reply.content[0]?.type!=='text'||
      typeof reply.content[0].text!=='string'||canonical(JSON.parse(reply.content[0].text))!==canonical(reply.structuredContent))
      throw new ParentClientError('PARENT_TOOL_RESPONSE_UNCONFIRMED');
    validateResult(reply.structuredContent,journal.run_id);
    journal.run_id=reply.structuredContent.run_id;journal.last_result=structuredClone(reply.structuredContent);
    active.disposition='verified';saveJournal(receiptPath,journal);
  }catch(error){
    if(!journal||!entry)throw error;
    if(entry.disposition==='sent')entry.disposition='response_unknown';
    entry.error=error instanceof ParentClientError?error.message:'PARENT_TRANSPORT_OR_SAVE_FAILURE';
    saveJournal(receiptPath,journal);
  }finally{
    try{
      if(transport&&journal&&entry){
        try{entry.transport_closed=await transport.close();}catch{entry.transport_closed=false;}
        saveJournal(receiptPath,journal);
      }
    }finally{closeSync(fd);if(existsSync(lock)&&readFileSync(lock,'utf8')===token)unlinkSync(lock);}
  }
  return project(journal!);
}

/** Actual local subprocess transport for the already-shipped scripted reference host. */
export function openReferenceParentTransport(stateDirectory:string,options:Readonly<{pauseAfterRead?:boolean;replyTimeoutMs?:number}>={}):ParentTransport{
  const timeout=options.replyTimeoutMs??20000;
  if(!Number.isSafeInteger(timeout)||timeout<1||timeout>30000)throw new ParentClientError('PARENT_TIMEOUT_INVALID');
  const extension=import.meta.url.endsWith('.mts')?'.mts':'.mjs';
  const entry=fileURLToPath(new URL('./work-stdio'+extension,import.meta.url));
  const child=spawn(process.execPath,[...(extension==='.mts'?['--experimental-strip-types']:[]),entry,'--state',resolve(stateDirectory),
    ...(options.pauseAfterRead?['--pause-after-read']:[])],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH??'',LANG:'C.UTF-8'}});
  let buffer='',failed=false;
  const waits=new Map<number,{resolve:(raw:string)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  const fail=()=>{failed=true;for(const waiter of waits.values()){clearTimeout(waiter.timer);waiter.reject(new ParentClientError('PARENT_TRANSPORT_FAILED'));}waits.clear();};
  child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>{
    buffer+=chunk;
    if(Buffer.byteLength(buffer)>MAX_REPLY&&!buffer.includes('\n')){fail();return;}
    let newline:number;
    while((newline=buffer.indexOf('\n'))>=0){const raw=buffer.slice(0,newline);buffer=buffer.slice(newline+1);
      try{if(Buffer.byteLength(raw)>MAX_REPLY)throw Error();const reply=JSON.parse(raw),waiter=waits.get(reply.id);
        if(!waiter)throw Error();waits.delete(reply.id);clearTimeout(waiter.timer);waiter.resolve(raw);
      }catch{fail();return;}
    }
  });
  child.stderr.resume();child.on('error',fail);child.stdin.on('error',fail);
  const exited=new Promise<boolean>(done=>child.on('close',(code)=>{fail();done(code===0);}));
  return {
    request(message){
      if(failed||message.id===undefined||waits.has(message.id))return Promise.reject(new ParentClientError('PARENT_TRANSPORT_FAILED'));
      return new Promise((yes,no)=>{const key=message.id!;
        const timer=setTimeout(()=>{waits.delete(key);no(new ParentClientError('PARENT_REPLY_UNKNOWN'));},timeout);
        waits.set(key,{resolve:yes,reject:no,timer});child.stdin.write(JSON.stringify(message)+'\n',error=>{if(error)fail();});
      });
    },
    async notify(message){if(failed)throw new ParentClientError('PARENT_TRANSPORT_FAILED');
      await new Promise<void>((yes,no)=>child.stdin.write(JSON.stringify(message)+'\n',error=>{if(error){fail();no(new ParentClientError('PARENT_TRANSPORT_FAILED'));}else yes();}));},
    async close(){
      child.stdin.end();let timer:ReturnType<typeof setTimeout>|undefined;
      try{return await Promise.race([exited,new Promise<boolean>(done=>{timer=setTimeout(()=>{child.kill('SIGTERM');done(false);},timeout);})]);}
      finally{if(timer)clearTimeout(timer);}
    },
  };
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const extension=import.meta.url.endsWith('.mts')?['--experimental-strip-types']:[];
  const command=['node',...extension,fileURLToPath(import.meta.url)];
  let receipt:string|undefined;
  try{
    const values=new Map<string,string>(),flags=new Set<string>();
    const valued=['--receipt','--operation','--state','--request','--request-id','--format'];
    for(let i=2;i<process.argv.length;i++){
      const key=process.argv[i];if(values.has(key)||flags.has(key))throw new ParentClientError('PARENT_ARGUMENTS_INVALID');
      if(['--help','--pause-after-read'].includes(key)){flags.add(key);continue;}
      if(!valued.includes(key)||process.argv[i+1]===undefined||process.argv[i+1].startsWith('--'))throw new ParentClientError('PARENT_ARGUMENTS_INVALID');
      values.set(key,process.argv[++i]);
    }
    const format=values.get('--format')??'json';if(!['json','text'].includes(format))throw new ParentClientError('PARENT_FORMAT_INVALID');
    if(flags.has('--help'))process.stdout.write(renderParentHelp({command}));
    else{
      receipt=values.get('--receipt');const operation=values.get('--operation')??'start',state=values.get('--state');
      if(!receipt||!['start','continue','status','inspect'].includes(operation))throw new ParentClientError('PARENT_ARGUMENTS_INVALID');
      const saved=existsSync(receipt)?inspectParentReceipt(receipt):undefined;
      let message:ParentMessage;
      if(operation==='inspect'){
        if(state!==undefined||values.has('--request')||values.has('--request-id')||flags.has('--pause-after-read'))throw new ParentClientError('PARENT_ARGUMENTS_INVALID');
        message=(saved??inspectParentReceipt(receipt)).message;
      }else{
        const directory=state??saved?.journal.state_directory;if(!directory)throw new ParentClientError('PARENT_ARGUMENTS_INVALID');
        message=await runParentOperation({receiptPath:receipt,operation:operation as ParentOperation,stateDirectory:state,
          request:values.get('--request'),requestId:values.get('--request-id'),connect:async()=>openReferenceParentTransport(directory,{pauseAfterRead:flags.has('--pause-after-read')})});
      }
      if(format==='json')process.stdout.write(JSON.stringify(message)+'\n');
      else{
        const inspection=inspectParentReceipt(receipt);
        process.stdout.write(renderParentText(message,{receiptPath:resolve(receipt),command,journal:inspection.journal}));
      }
    }
  }catch(error){process.stderr.write(renderParentError(error,{receiptPath:receipt===undefined?undefined:resolve(receipt),command}));process.exitCode=1;}
}
