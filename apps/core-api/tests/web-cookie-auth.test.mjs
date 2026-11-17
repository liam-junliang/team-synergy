import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword } from '@team-synergy/application';
import { buildServer } from '../dist/server.js';
import { openTestDb, closeTestDb, insertUser, publicCode } from './test-db.mjs';
let app,db;
const originalEnv={NODE_ENV:process.env.NODE_ENV,TSP_WEB_ORIGIN:process.env.TSP_WEB_ORIGIN};
const origin='http://localhost:8080';
afterEach(async()=>{await app?.close();if(db)await closeTestDb(db);app=db=undefined;for(const [key,value]of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
async function fixture(initial=false){db=await openTestDb();app=await buildServer({db,logger:false});return insertUser(db,{code:publicCode(99201),account:'web.user',display_name:'Web User',is_system_admin:true,password_hash:await hashPassword('WebPassword123!'),must_change_password:initial,password_expires_at:initial?new Date(Date.now()+60000).toISOString():null,created_at:new Date().toISOString()});}
const headers=(extra={})=>({host:'localhost:8080',origin,...extra});
async function login(extra={}){return app.inject({method:'POST',url:'/auth/web/login',headers:headers(extra),payload:{account:'web.user',password:'WebPassword123!',device_name:'browser'}});}
function cookies(response){return response.headers['set-cookie'].map(value=>value.split(';')[0]).join('; ');}

test('Web login exposes user/CSRF only and restores a verified HttpOnly cookie session',async()=>{
 await fixture();const response=await login();assert.equal(response.statusCode,200);
 assert.equal(response.json().data.user.account,'web.user');assert.equal(typeof response.json().data.csrf_token,'string');
 assert.equal(response.body.includes('device_token'),false);assert.equal(response.body.includes('token_hash'),false);
 const setCookies=response.headers['set-cookie'];assert.ok(setCookies.some(value=>value.startsWith('tsp_session=')&&value.includes('HttpOnly')&&value.includes('SameSite=Lax')));
 const restored=await app.inject({method:'GET',url:'/auth/web/session',headers:headers({cookie:cookies(response)})});assert.equal(restored.statusCode,200);assert.equal(restored.json().data.user.account,'web.user');assert.equal(restored.json().data.csrf_token,response.json().data.csrf_token);
});
test('cookie mutations reject missing, forged and cross-session CSRF including public endpoints and fake Bearer fallback',async()=>{
 await fixture();const first=await login(),second=await login();assert.equal(first.statusCode,200);assert.equal(second.statusCode,200);
 const cookie=cookies(first);
 for(const extra of [{},{'x-csrf-token':'forged'},{authorization:'Bearer forged'}]){
  const response=await app.inject({method:'POST',url:'/auth/device/start',headers:headers({cookie,...extra}),payload:{}});assert.equal(response.statusCode,403);
 }
 const cross=cookies(second).replace(/tsp_csrf=[^;]+/,`tsp_csrf=${first.json().data.csrf_token}`);
 const response=await app.inject({method:'POST',url:'/auth/web/logout',headers:headers({cookie:cross,'x-csrf-token':first.json().data.csrf_token})});assert.equal(response.statusCode,403);
});
test('trusted Origin is required for login and cookie changes; stale cookie does not prevent login',async()=>{
 await fixture();const response=await app.inject({method:'POST',url:'/auth/web/login',headers:headers({origin:'https://attacker.example'}),payload:{account:'web.user',password:'WebPassword123!',device_name:'browser'}});assert.equal(response.statusCode,403);
 const missing=await app.inject({method:'POST',url:'/auth/web/login',headers:{host:'localhost:8080'},payload:{account:'web.user',password:'WebPassword123!',device_name:'browser'}});assert.equal(missing.statusCode,403);
 const logged=await login({cookie:'tsp_session=expired;tsp_csrf=old'});assert.equal(logged.statusCode,200);
 const denied=await app.inject({method:'POST',url:'/auth/web/logout',headers:headers({cookie:cookies(logged),origin:'https://attacker.example','x-csrf-token':logged.json().data.csrf_token})});assert.equal(denied.statusCode,403);
});
test('password change preserves the current cookie session and logout revokes it and clears cookies',async()=>{
 await fixture(true);const logged=await login();assert.equal(logged.statusCode,200);
 const secureHeaders=headers({cookie:cookies(logged),'x-csrf-token':logged.json().data.csrf_token});
 assert.equal((await app.inject({method:'GET',url:'/auth/web/session',headers:secureHeaders})).statusCode,200);
 const changed=await app.inject({method:'POST',url:'/auth/password-change',headers:secureHeaders,payload:{current_password:'WebPassword123!',new_password:'ChangedPassword123!'}});assert.equal(changed.statusCode,200);
 assert.equal((await app.inject({method:'GET',url:'/auth/web/session',headers:secureHeaders})).json().data.user.must_change_password,false);
 const logout=await app.inject({method:'POST',url:'/auth/web/logout',headers:secureHeaders});assert.equal(logout.statusCode,200);assert.ok(logout.headers['set-cookie'].every(value=>value.includes('Max-Age=0')));
 assert.equal((await app.inject({method:'GET',url:'/auth/web/session',headers:secureHeaders})).statusCode,401);
});
test('production cookies stay Secure and insecure non-loopback development transport is refused',async()=>{
 process.env.NODE_ENV='production';await fixture();const logged=await login();assert.equal(logged.statusCode,200);assert.ok(logged.headers['set-cookie'].every(value=>value.includes('; Secure')));
 delete process.env.NODE_ENV;
 const refused=await app.inject({method:'POST',url:'/auth/web/login',remoteAddress:'192.0.2.1',headers:{host:'example.test',origin:'http://example.test'},payload:{account:'web.user',password:'WebPassword123!',device_name:'browser'}});assert.equal(refused.statusCode,403);
});

test('browser installation proof is server-managed HttpOnly and remains stable across logout/relogin',async()=>{
 await fixture();
 const spoofedId='11111111-1111-4111-8111-111111111111',spoofedSecret='A'.repeat(43);
 const first=await app.inject({method:'POST',url:'/auth/web/login',headers:headers(),payload:{account:'web.user',password:'WebPassword123!',device_name:'browser',device_identity:{installation_id:spoofedId,installation_secret:spoofedSecret,client_type:'cli',platform:'test-platform'}}});
 assert.equal(first.statusCode,200);
 const browserCookie=first.headers['set-cookie'].find(value=>value.startsWith('tsp_browser='));
 assert.ok(browserCookie.includes('HttpOnly'));assert.ok(browserCookie.includes('SameSite=Lax'));
 const browserValue=browserCookie.split(';')[0].slice('tsp_browser='.length);
 const [stored]=await db.select().from((await import('@team-synergy/persistence')).schema.devices);
 assert.notEqual(stored.installation_id,spoofedId);assert.equal(stored.client_type,'web');assert.equal(stored.platform,'test-platform');
 const {createHash}=await import('node:crypto');
 assert.equal(stored.installation_secret_hash,createHash('sha256').update(browserValue.slice(37)).digest('hex'));
 assert.equal(first.body.includes(browserValue),false);assert.equal(first.body.includes(browserValue.slice(37)),false);
 const logout=await app.inject({method:'POST',url:'/auth/web/logout',headers:headers({cookie:cookies(first),'x-csrf-token':first.json().data.csrf_token})});assert.equal(logout.statusCode,200);
 assert.equal(logout.headers['set-cookie'].some(value=>value.startsWith('tsp_browser=')),false);
 const second=await login({cookie:browserCookie.split(';')[0]});assert.equal(second.statusCode,200);
 const devices=await db.select().from((await import('@team-synergy/persistence')).schema.devices);assert.equal(devices.length,1);assert.equal(devices[0].installation_secret_hash,stored.installation_secret_hash);
});
test('production Host cookies reject downgraded names and duplicate cookie identities',async()=>{
 process.env.NODE_ENV='production';await fixture();const logged=await login();assert.equal(logged.statusCode,200);
 assert.ok(logged.headers['set-cookie'].every(value=>value.startsWith('__Host-')&&value.includes('; Secure')&&value.includes('Path=/')&&!value.includes('Domain=')));
 const downgraded=await app.inject({method:'GET',url:'/auth/web/session',headers:headers({cookie:cookies(logged)+';tsp_session=downgraded'})});assert.equal(downgraded.statusCode,401);
 const duplicate=await app.inject({method:'GET',url:'/auth/web/session',headers:headers({cookie:cookies(logged)+';__Host-tsp_session=duplicate'})});assert.equal(duplicate.statusCode,401);
});
test('only explicit Web Origin or bounded loopback development proxy Origin is trusted',async()=>{
 await fixture();
 const proxy=await login({origin:'http://127.0.0.1:5173'});assert.equal(proxy.statusCode,200);
 const otherPort=await login({origin:'http://127.0.0.1:9999'});assert.equal(otherPort.statusCode,403);
 process.env.NODE_ENV='production';process.env.TSP_WEB_ORIGIN='https://app.example';
 const configured=await login({origin:'https://app.example'});assert.equal(configured.statusCode,200);
 const untrusted=await login({origin:'https://other.example'});assert.equal(untrusted.statusCode,403);
});

test('native CSP reports bypass session CSRF but authenticated browser routes retain their guards',async()=>{
 await fixture();
 const report=await app.inject({method:'POST',url:'/security/csp-report',headers:{host:'localhost:8080',cookie:'tsp_session=expired;tsp_csrf=bad','content-type':'application/csp-report'},payload:JSON.stringify({'csp-report':{'violated-directive':'script-src','document-uri':'https://example.invalid/private'}})});
 assert.equal(report.statusCode,204);
 const logged=await login();assert.equal(logged.statusCode,200);
 const userList=await app.inject({method:'GET',url:'/users',headers:headers({cookie:cookies(logged)})});assert.equal(userList.statusCode,200);
 const approval=await app.inject({method:'POST',url:'/auth/device/approve',headers:headers({cookie:cookies(logged),'x-csrf-token':logged.json().data.csrf_token}),payload:{user_code:'ABCD-EFGH',decision:'approve'}});assert.equal(approval.statusCode,400);assert.notEqual(approval.json().error.code,'unauthorized');
});
