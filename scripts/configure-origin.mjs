/** Configure the same fixed HTTPS origin contract as the production source. */
import {readFile,writeFile} from 'node:fs/promises';
const value=process.argv[2];
let url;
try{url=new URL(value);}catch{throw new Error('Provide one HTTPS origin');}
if(url.protocol!=='https:'||url.username||url.password||url.origin!==value)throw new Error('Origin must be exact HTTPS, without path, query or credentials');
const placeholder='https://jev-decision-fabric.example';
const files=['../netlify/lib/auth.mts','../netlify/lib/mcp_origin.mts'];
const changes=[];
for(const file of files){
 const path=new URL(file,import.meta.url),source=await readFile(path,'utf8');
 if(source.split(placeholder).length!==2)throw new Error('Expected one untouched origin placeholder in each file');
 changes.push([path,source.replace(placeholder,value)]);
}
for(const [path,source] of changes)await writeFile(path,source);
console.log('Configured fixed origin in two source files. No deploy or external request performed.');
