import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { hashPassword, hashToken } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';
import { isPublicRoute } from '../dist/auth.js';
import { closeTestDb, insertUser, openTestDb } from './test-db.mjs';
const fixtures=[];
const identity=(client_type='web')=>({installation_id:randomUUID(),installation_secret:randomBytes(32).toString('base64url'),client_type,platform:'win32'});
async function setup(){
 const db=await openTestDb(),app=await buildServer({db,logger:false});fixtures.push({db,app});
 const password_hash=await hashPassword('Password123!');
 const user=await insertUser(db,{account:'member',display_name:'Member',password_hash,created_at:new Date().toISOString()});
 const other=await insertUser(db,{account:'outsider',display_name:'Outsider',password_hash,created_at:new Date().toISOString()});
 async function login(account='member',id=identity()){
  const response=await app.inject({method:'POST',url:'/auth/password-login',payload:{account,password:'Password123!',device_name:'Desktop',device_identity:id}});
  assert.equal(response.statusCode,200,response.body);return {...response.json().data,headers:{authorization:`Bearer ${response.json().data.device_token}`}};
 }
 return {db,app,user,other,login};
}
afterEach(async()=>{for(const f of fixtures.splice(0)){await f.app.close();await closeTestDb(f.db);}});

test('device sessions are independently revoked, only owners can manage them, and secrets never appear in device responses',async()=>{
 const {db,app,user,login}=await setup();const id=identity();const first=await login('member',id),second=await login('member',id),outsider=await login('outsider');
 assert.equal(first.device_code,second.device_code);
 const listed=await app.inject({method:'GET',url:`/devices?user_code=${user.code}`,headers:first.headers});
 assert.equal(listed.json().data.length,1);assert.equal(listed.json().data[0].session_count,2);assert.equal(listed.json().data[0].current,true);
 assert.equal(listed.body.includes('secret'),false);assert.equal(listed.body.includes('hash'),false);assert.equal(listed.body.includes(id.installation_id),false);
 const sessions=await app.inject({method:'GET',url:`/devices/${first.device_code}/sessions`,headers:first.headers});
 assert.equal(sessions.json().data.length,2);assert.equal(sessions.json().data.find(s=>s.code===first.session_code).current,true);
 for(const operation of [
  {method:'GET',url:`/devices/${first.device_code}/sessions`},
  {method:'PATCH',url:`/devices/${first.device_code}`,payload:{device_name:'intruder'}},
  {method:'POST',url:`/sessions/${first.session_code}/revoke`},
  {method:'POST',url:`/devices/${first.device_code}/revoke`},
 ]) {const denied=await app.inject({...operation,headers:outsider.headers});assert.equal(denied.statusCode,403,denied.body);}
 const renamed=await app.inject({method:'PATCH',url:`/devices/${first.device_code}`,headers:first.headers,payload:{device_name:'My workstation'}});assert.equal(renamed.statusCode,200,renamed.body);
 const lastLogin=(await db.select().from(schema.devices).where(eq(schema.devices.code,first.device_code)))[0].last_login_at;
 const revoke=await app.inject({method:'POST',url:`/sessions/${first.session_code}/revoke`,headers:second.headers});assert.equal(revoke.statusCode,200,revoke.body);
 assert.equal((await app.inject({method:'GET',url:'/auth/whoami',headers:first.headers})).statusCode,401);
 assert.equal((await app.inject({method:'GET',url:'/auth/whoami',headers:second.headers})).statusCode,200);
 assert.equal((await db.select().from(schema.devices).where(eq(schema.devices.code,first.device_code)))[0].last_login_at,lastLogin);
 const revokeDevice=await app.inject({method:'POST',url:`/devices/${second.device_code}/revoke`,headers:second.headers});assert.equal(revokeDevice.statusCode,200,revokeDevice.body);
 assert.equal((await app.inject({method:'GET',url:'/auth/whoami',headers:second.headers})).statusCode,401);
});

test('browser authorizes a CLI without sharing its own token and only the polling secret exchanges once',async()=>{
 const {db,app,login}=await setup();const browser=await login();const id=identity('cli');
 const started=await app.inject({method:'POST',url:'/auth/device/start',payload:{device_name:'Liam CLI',device_identity:id}});assert.equal(started.statusCode,200,started.body);const req=started.json().data;
 const unauthenticated=await app.inject({method:'GET',url:`/auth/device/request?user_code=${req.user_code}`});assert.equal(unauthenticated.statusCode,401);
 const details=await app.inject({method:'GET',url:`/auth/device/request?user_code=${req.user_code}`,headers:browser.headers});assert.equal(details.statusCode,200,details.body);assert.equal(details.json().data.device_name,'Liam CLI');assert.equal(details.body.includes(id.installation_secret),false);
 const approve=await app.inject({method:'POST',url:'/auth/device/approve',headers:browser.headers,payload:{user_code:req.user_code,decision:'approve'}});assert.equal(approve.statusCode,200,approve.body);
 const badCode=await app.inject({method:'POST',url:'/auth/device/token',payload:{device_code:req.user_code}});assert.equal(badCode.json().error.code,'expired_token');
 const token=await app.inject({method:'POST',url:'/auth/device/token',payload:{device_code:req.device_code}});assert.equal(token.statusCode,200,token.body);assert.notEqual(token.json().data.device_token,browser.device_token);
 const reused=await app.inject({method:'POST',url:'/auth/device/token',payload:{device_code:req.device_code}});assert.equal(reused.json().error.code,'expired_token');
 const sessions=await db.select().from(schema.deviceSessions);assert.equal(sessions.length,2);
 assert.equal(sessions.some(s=>s.token_hash===hashToken(req.device_code)),false);
});

test('authorization gates reject forced-password sessions, legacy identity and excessive unauthenticated starts',async()=>{
 const {db,app,user,login}=await setup();const browser=await login();
 const req=(await app.inject({method:'POST',url:'/auth/device/start',payload:{device_name:'CLI',device_identity:identity('cli')}})).json().data;
 const legacy=await app.inject({method:'POST',url:'/auth/device/approve',headers:{'x-principal-code':user.code},payload:{user_code:req.user_code,decision:'approve'}});assert.equal(legacy.statusCode,401);
 await db.update(schema.users).set({must_change_password:true}).where(eq(schema.users.id,user.id));
 const forced=await app.inject({method:'POST',url:'/auth/device/approve',headers:browser.headers,payload:{user_code:req.user_code,decision:'approve'}});assert.equal(forced.statusCode,403);assert.equal(forced.json().error.code,'password_change_required');
 let response;for(let i=0;i<13;i++)response=await app.inject({method:'POST',url:'/auth/device/start',payload:{device_name:'CLI',device_identity:identity('cli')}});
 assert.equal(response.statusCode,429);assert.equal(response.json().error.code,'slow_down');
 assert.equal((await db.select().from(schema.deviceAuthorizationRequests)).length,12);
});

test('public route matching only permits the intended methods and safe release paths',()=>{
 for(const path of ['/health','/cli/manifest.json','/cli/install.ps1','/cli/install.sh','/cli/releases/tsp-win32-x64.zip'])assert.equal(isPublicRoute('GET',path),true);
 for(const path of ['/auth/device/start','/auth/device/token','/auth/login','/auth/password-login'])assert.equal(isPublicRoute('POST',path),true);
 for(const path of ['/auth/device/approve','/auth/device-identity','/cli/releases/../secrets','/cli/releases/a/b','/cli/private','/devices'])assert.equal(isPublicRoute('GET',path),false);
 assert.equal(isPublicRoute('POST','/cli/install.sh'),false);assert.equal(isPublicRoute('GET','/auth/device/start'),false);
});
