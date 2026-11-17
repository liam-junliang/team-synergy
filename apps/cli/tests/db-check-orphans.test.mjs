import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
async function run(env){
 const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/index.js',import.meta.url)),'db:check-orphans'],{env:{...process.env,...env,NODE_USE_ENV_PROXY:'0'},stdio:['ignore','pipe','pipe'],windowsHide:true});
 let out='',err='';child.stdout.on('data',data=>out+=data);child.stderr.on('data',data=>err+=data);
 const code=await new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});return{code,out,err};
}
test('local integrity command requires explicit database URL and never exposes connection errors',async()=>{
 const missing=await run({TSP_DATABASE_URL:''});assert.equal(missing.code,1);assert.equal(JSON.parse(missing.out).error.code,'database_url_required');
 const failed=await run({TSP_DATABASE_URL:'postgres://fixture-user:fixture-private-password@127.0.0.1:1/no_database'});
 assert.equal(failed.code,1);assert.equal(JSON.parse(failed.out).error.code,'integrity_check_failed');
 assert.ok(!failed.out.includes('fixture-private-password'));assert.ok(!failed.err.includes('fixture-private-password'));assert.ok(!failed.out.includes('fixture-user'));
});
