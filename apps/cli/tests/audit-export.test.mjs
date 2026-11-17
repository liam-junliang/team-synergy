import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

test('audit:export emits only NDJSON records and traverses stable snapshot pages',async()=>{
 const calls=[];
 const server=createServer((req,res)=>{
  const u=new URL(req.url,'http://localhost');calls.push(u);
  const second=u.searchParams.has('cursor');res.setHeader('Content-Type','application/json');
  res.end(JSON.stringify({ok:true,data:{items:[{id:second?'2':'1',action:'user.login_failed'}],snapshot:'2',next_cursor:second?null:'1'}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const child=spawn(process.execPath,[path.resolve('dist/index.js'),'audit:export','--since','2026-10-23'],{env:{...process.env,ACP_API_URL:`http://127.0.0.1:${server.address().port}`,ACP_PRINCIPAL_CODE:'fixture',NODE_USE_ENV_PROXY:'0'},stdio:['ignore','pipe','pipe']});
  let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});
  assert.equal(code,0,err);assert.deepEqual(out.trim().split('\n').map(JSON.parse).map(r=>r.id),['1','2']);
  assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('snapshot'),'2');assert.equal(calls[1].searchParams.get('since'),'2026-10-23');
 }finally{await new Promise(r=>server.close(r));}
});
