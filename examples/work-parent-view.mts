/** Pure human views of the existing client receipt; never a host grant or state store. */
import type {ParentJournal, ParentMessage} from './work-parent.mts';

export type ParentViewContext = Readonly<{receiptPath?:string; command?:readonly string[]; journal?:ParentJournal}>;
const quoted=(value:string)=>/^[a-zA-Z0-9_./:@=-]+$/.test(value)?value:"'"+value.replace(/'/g,"'\\''")+"'";
const visible=(value:string,lines=false)=>value.replace(lines?/[\u0000-\u0008\u000b-\u001f\u007f]/g:/[\u0000-\u001f\u007f]/g,
  value=>'\\u'+value.charCodeAt(0).toString(16).padStart(4,'0'));
function command(context:ParentViewContext,operation:'inspect'|'status'|'continue') {
  if(!context.receiptPath)return null;
  return [...(context.command??['node','dist/examples/work-parent.mjs']),'--receipt',context.receiptPath,'--operation',operation,'--format','text'].map(quoted).join(' ');
}
export function renderParentText(message:ParentMessage,context:ParentViewContext={}):string {
  const journal=context.journal?.digest===message.client_journal_sha256?context.journal:undefined;
  const history=journal?.history??[],unknown=history.filter(entry=>entry.operation!=='status'&&['sent','response_unknown'].includes(entry.disposition));
  const unclosed=history.filter(entry=>entry.disposition!=='prepared'&&entry.transport_closed!==true);
  const current=message.current_operation,result=message.result;
  const fresh=!!result&&!message.result_is_cached&&current?.disposition==='verified'&&current.error===null;
  const lines:string[]=[];
  if(result?.answer!==null&&result?.answer!==undefined){
    lines.push(fresh?'Answer (fresh verified host result):':'Saved answer (cached; no new verified host readback):',visible(result.answer,true));
  }else lines.push(result?.status==='needs_host'?'Work saved: unfinished.':'No answer is available.',
    result?`Result: ${result.status}${fresh?' (fresh verified readback)':' (saved receipt)'}`:'No verified result; the original run may not be known.');
  lines.push('');
  lines.push(current?`Current operation: ${current.operation} — ${current.disposition}; host close ${current.transport_closed===true?'confirmed':'unconfirmed'}.`:
    'Saved receipt view only; no host was contacted.');
  if(current?.error)lines.push('Current error: '+visible(current.error));
  const last=history.at(-1);
  if(!current&&last){
    lines.push(`Last saved operation: ${last.operation} — ${last.disposition}; host close ${last.transport_closed===true?'confirmed':'unconfirmed'}.`);
    if(last.error)lines.push('Saved error: '+visible(last.error));
  }
  lines.push('Original run: '+(message.run_id??'not recovered; do not invent a run ID.'),'Request ID: '+visible(message.request_id));
  if(journal)lines.push('Request: '+visible(journal.request));
  if(context.receiptPath)lines.push('Receipt: '+visible(context.receiptPath));
  if(unknown.length)for(const entry of unknown)lines.push(`Earlier operation unresolved: ${entry.operation} (${entry.disposition}). Do not resend it.`);
  else if(message.status==='response_unknown')lines.push('An earlier mutating operation is unresolved. Do not resend it.');
  for(const entry of unclosed)lines.push(`Host close unconfirmed for ${entry.operation}; this receipt does not prove the old host exited.`);
  if(result?.pending.length)lines.push('Pending work: '+result.pending.map(value=>visible(value)).join(', '));
  if(result?.unresolved.length)lines.push('Unresolved: '+result.unresolved.map(value=>visible(value)).join('; '));
  if(result?.provenance.length)lines.push('Evidence: '+result.provenance.map(value=>visible(value)).join(', '));
  const inspect=command(context,'inspect'),status=command(context,'status'),continuation=command(context,'continue');
  const blocked=unknown.length>0||unclosed.length>0||message.status==='response_unknown'||message.status==='readback_unconfirmed'||
    !!current?.error||current?.transport_closed===false;
  lines.push('');
  if(!blocked&&journal&&result?.status==='needs_host'&&message.next_operation==='continue'&&continuation)
    lines.push('Next: explicitly continue this saved run; the host rechecks its original limits.',continuation);
  else if(blocked){
    lines.push('Next: inspect the saved receipt and use original host readback/reconciliation. Do not continue or resend an unknown operation.');
    if(inspect)lines.push(inspect);
    if(message.run_id){
      if(status)lines.push('Optional read-only status after checking the original connection and host permissions; it does not settle the earlier operation:',status);
      else lines.push('The original run is known. This view has no saved receipt path, so no executable command is supplied. Use the original receipt for read-only status after checking the connection and host permissions.');
    }else lines.push('A status call needs the actual original run ID. Ask the host to read the original request ID; do not start another run.');
  }else lines.push(result?.status==='complete'?'No further work is requested.':'The original host must check any remaining work and limits.');
  if(inspect&&!blocked)lines.push('Review the saved receipt without contacting the host:',inspect);
  lines.push('Original deadline and budget stay with the host; this view does not extend them.',message.qualification);
  return lines.join('\n')+'\n';
}
export function renderParentHelp(context:ParentViewContext={}):string {
  const program=(context.command??['node','dist/examples/work-parent.mjs']).map(quoted).join(' ');
  return `Use an ordinary request, then the same private receipt:\n\n${program} --state ./private/host --receipt ./private/parent.json --request "Calculate the total and mean" --pause-after-read --format text\n${program} --receipt ./private/parent.json --operation inspect --format text\n${program} --receipt ./private/parent.json --operation continue --format text\n${program} --receipt ./private/parent.json --operation status --format text\n\n--request-id ID     Optional: generated once and saved before the first connection.\n--format json|text  Default: json. Text separates fresh results from cached evidence.\n--operation start|continue|status|inspect  Default: start.\n--help             Show this help without reading or writing a receipt.\n\nInspect is read-only: no connection, effect, history append or lock removal.\nAn identical start reuses the saved request ID and receipt; it never resends.\nUnknown responses require original host readback/reconciliation, not another continue.\nThe reference host uses a scripted planner/final with actual local work; no Jev/native call.\n`;
}
export function renderParentError(error:unknown,context:ParentViewContext={}):string {
  const code=error instanceof Error&&/^PARENT_[A-Z_]+$/.test(error.message)?error.message:'PARENT_CLIENT_FAILURE';
  const reason:Record<string,string>={
    PARENT_RECONCILIATION_REQUIRED:'The original operation is still unknown. Continue was blocked before connecting.',
    PARENT_HOST_CLOSE_UNCONFIRMED:'An earlier host close is unconfirmed. Continue was blocked before connecting.',
    PARENT_ORIGINAL_RUN_UNAVAILABLE:'The original run ID is not available. Do not invent one or start again.',
    PARENT_REQUEST_CONFLICT:'This receipt belongs to a different original request, ID or state directory.',
    PARENT_RECEIPT_NOT_FOUND:'No saved client receipt was found.',
    PARENT_JOURNAL_INVALID:'The saved client receipt could not be verified. Do not overwrite it.',
    PARENT_ARGUMENTS_INVALID:'Check the command arguments and use --help.',
    PARENT_FORMAT_INVALID:'Use --format json or --format text.',
  };
  const lines=[reason[code]??'The client operation could not be confirmed. Preserve the original receipt.',`Error: ${code}`];
  const inspect=command(context,'inspect');if(inspect)lines.push('Read the saved receipt without contacting the host:',inspect);
  else lines.push('Use --help for the ordinary request and receipt commands.');
  lines.push('Do not resend unknown work or remove a host/client lock.');
  return lines.join('\n')+'\n';
}
