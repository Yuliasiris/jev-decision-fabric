import {openReferenceHost} from './work-host.mts';
const args=process.argv.slice(2),get=(name:string)=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
const state=get('--state');if(!state)throw Error('Use --state NEW_PRIVATE_DIRECTORY; --request TEXT or --resume RUN_ID or --status RUN_ID');
const host=openReferenceHost(state,{pauseAfterRead:args.includes('--pause-after-read')});
const caller={principal:'local-reference-owner',signal:new AbortController().signal};
try{
  const run=get('--resume')??get('--status'),request=get('--request');
  const result=get('--resume')?await host.service.continue({run_id:run!},caller):get('--status')?await host.service.status({run_id:run!},caller):
    request?await host.service.start({request,request_id:get('--request-id')??'reference-'+Date.now()},caller):null;
  if(!result)throw Error('Missing request/resume/status');
  console.log(JSON.stringify({result,qualification:host.scope},null,2));
}finally{host.close();}
