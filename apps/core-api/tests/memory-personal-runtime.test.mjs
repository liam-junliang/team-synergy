import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { ensurePersonalMemoryResource } from '../dist/memory-personal-runtime.js';

test('personal provisioning is deterministic across server instances, scoped, and never rotates existing keys', async t => {
  const users = new Map(), calls = [];
  const server = createServer(async (req,res) => {
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;
    calls.push([req.method,req.url]);
    res.setHeader('content-type','application/json');
    if(req.url==='/health'){
      const key=req.headers['x-api-key'];const user=[...users].find(([,value])=>value===key)?.[0];
      res.statusCode=user?200:401;res.end(JSON.stringify(user?{account_id:'fixture',user_id:user}:{error:'invalid'}));return;
    }
    if(req.method==='GET'){
      const user=req.url.split('/').at(-1);res.statusCode=users.has(user)?200:404;
      res.end(JSON.stringify({status:'ok',result:{user_id:user,role:'USER'}}));return;
    }
    assert.equal(req.method,'POST');assert.equal(body.role,'user');assert.ok(!req.url.endsWith('/key'));
    const secret=createHash('sha256').update(body.user_id+'\0'+body.seed).digest('hex');
    const key=['fixture',body.user_id,secret].map(x=>Buffer.from(x).toString('base64url')).join('.');
    if(users.has(body.user_id)){res.statusCode=409;res.end('{}');return;}
    users.set(body.user_id,key);res.end(JSON.stringify({status:'ok',result:{user_key:key}}));
  });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  t.after(()=>new Promise(done=>server.close(done)));
  const config=()=>({openviking:{baseUrl:'http://127.0.0.1:'+server.address().port},accounts:{},
    personalProvisioning:{accountId:'fixture',adminApiKey:'ADMIN_TEST_ONLY',keySeed:'TEST_ONLY_SEED_'.repeat(3)}});
  const a=config(), principal='0123456789ABCDEFGHJK';
  const [first,parallel]=await Promise.all([ensurePersonalMemoryResource(a,principal),ensurePersonalMemoryResource(a,principal)]);
  assert.deepEqual(parallel,first);
  assert.deepEqual(await ensurePersonalMemoryResource(config(),principal),first);
  const second=await ensurePersonalMemoryResource(a,'1123456789ABCDEFGHJK');
  assert.notEqual(second.userId,first.userId);assert.notEqual(second.apiKey,first.apiKey);
  assert.equal(calls.filter(([method])=>method==='POST').length,2);
  users.set(first.userId,'externally-rotated');
  await assert.rejects(ensurePersonalMemoryResource(config(),principal),/credential not verified/u);
  assert.equal(calls.filter(([method])=>method==='POST').length,2);
  assert.ok(!calls.some(([,url])=>url.endsWith('/key')));
});
