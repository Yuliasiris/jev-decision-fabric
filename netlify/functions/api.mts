import type {Context,Config} from '@netlify/functions';
import {app} from '../lib/app.mts';
import {authStore} from '../lib/store.mts';
export default async (req:Request,ctx:Context)=>app(req,k=>Netlify.env.get(k),authStore(ctx),fetch,ctx.ip||'unknown');
export const config:Config={path:['/mcp','/v1/decision','/health','/connect','/connected','/oauth/*','/.well-known/*']};
