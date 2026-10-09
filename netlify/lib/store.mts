import {getStore} from '@netlify/blobs';
import {Fault} from './gateway.mts';
import type {Store} from './auth.mts';
export function authStore(context:any):Store {
 // App rejects non-production hostnames before issuing or accepting credentials.
 const b=getStore({name:'jev-oauth-v1',consistency:'strong'});
 return {
  get:async k=>b.get(k,{type:'json'}),
  create:async(k,v)=>!!(await b.setJSON(k,v,{onlyIfNew:true})).modified,
  cas:async(k,change)=>{
   for(let i=0;i<8;i++){
    const old=await b.getWithMetadata(k,{type:'json'});
    const next=change(old?.data??null);
    if(next===null)return null;
    const r=await b.setJSON(k,next,old?{onlyIfMatch:old.etag}:{onlyIfNew:true});
    if(r.modified)return next;
   }
   throw new Fault('STATE_BUSY',503);
  }
 };
}
