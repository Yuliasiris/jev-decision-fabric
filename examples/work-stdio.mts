import {createInterface} from 'node:readline';
import {openReferenceHost} from './work-host.mts';
import {createWorkMcpHandler} from '../adaptive/mcp/work.mts';
const i=process.argv.indexOf('--state');if(i<0||!process.argv[i+1])throw Error('Use --state PRIVATE_DIRECTORY');
const host=openReferenceHost(process.argv[i+1],{pauseAfterRead:process.argv.includes('--pause-after-read')});
const handler=createWorkMcpHandler(host.service,{principal:'local-reference-owner',signal:new AbortController().signal});
const lines=createInterface({input:process.stdin,crlfDelay:Infinity});
try{for await(const line of lines){if(Buffer.byteLength(line)>512*1024)throw Error('MCP request too large');let message:unknown;
  try{message=JSON.parse(line);}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:null,error:{code:-32700,message:'Parse error'}})+'\n');continue;}
  const response=await handler(message);if(response)process.stdout.write(JSON.stringify(response)+'\n');
}}finally{host.close();}
