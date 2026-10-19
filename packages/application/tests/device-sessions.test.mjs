import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { schema } from '@team-synergy/persistence';
import { createAuthUseCases, createDeviceAuthorizationUseCases, hashPassword, hashToken, createPublicCode, createExecutionUseCases, createTaskService } from '../dist/index.js';
import { insertUser, seedWorkspaceProject, insertFeature, insertTask, useTestDb } from './test-db.mjs';
const fixture = useTestDb(import.meta.url);
const identity = () => ({ installation_id: randomUUID(), installation_secret: randomBytes(32).toString('base64url'), client_type: 'cli', platform: 'win32' });
const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.data; };
async function setup() {
 const db=fixture.db;
 const user=await insertUser(db,{account:'member',displayName:'Member',passwordHash:await hashPassword('Password123!')});
 return {db,user,auth:createAuthUseCases(db),flow:createDeviceAuthorizationUseCases(db)};
}
async function login(auth, id) { return success(await auth.loginWithPassword('member','Password123!','Workstation',id)); }

test('the same verified installation receives separate sessions, preserves identity and updates only successful login timestamps',async()=>{
 const {db,auth}=await setup();const id=identity();
 const first=await login(auth,id);
 const [initial]=await db.select().from(schema.devices);
 await db.update(schema.devices).set({last_login_at:'2000-01-01T00:00:00.000Z'});
 success(await auth.resolveToken(first.device_token));
 assert.equal((await db.select().from(schema.devices))[0].last_login_at,'2000-01-01T00:00:00.000Z');
 const wrong=await auth.loginWithPassword('member','Password123!','Spoof',{...id,installation_secret:randomBytes(32).toString('base64url')});
 assert.equal(wrong.error.code,'auth_device_identity_mismatch');
 assert.equal((await db.select().from(schema.deviceSessions)).length,1);
 const second=await login(auth,id);
 assert.equal(second.device_code,first.device_code);assert.notEqual(second.device_token,first.device_token);
 const [after]=await db.select().from(schema.devices);assert.equal(after.credential_hash,initial.credential_hash);assert.equal(after.id,initial.id);
 assert.notEqual(after.last_login_at,'2000-01-01T00:00:00.000Z');
 success(await auth.logout(first.device_token));assert.equal((await auth.resolveToken(first.device_token)).ok,false);
 assert.equal((await auth.resolveToken(second.device_token)).ok,true);
 success(await auth.revokeDevice(second.device_code));assert.equal((await auth.resolveToken(second.device_token)).ok,false);
 const third=await login(auth,id);assert.equal(third.device_code,first.device_code);assert.equal((await auth.resolveToken(first.device_token)).ok,false);
});

test('concurrent password logins cannot bypass the unique installation or ten-device ceiling',async()=>{
 const {db,auth}=await setup(); const id=identity();
 const logins=await Promise.all([login(auth,id),login(auth,id),login(auth,id)]);
 assert.equal(new Set(logins.map(l=>l.device_code)).size,1);
 for(let i=0;i<8;i++) await login(auth,identity());
 const last=await Promise.all([auth.loginWithPassword('member','Password123!','A',identity()),auth.loginWithPassword('member','Password123!','B',identity())]);
 assert.equal(last.filter(r=>r.ok).length,1);assert.equal(last.find(r=>!r.ok).error.code,'auth_device_limit_reached');
 assert.equal((await db.select().from(schema.devices)).length,10);
});

test('legacy credentials are enrolled once and binding cannot merge unrelated installations or resurrect sessions',async()=>{
 const {db,user,auth}=await setup(); const legacyToken='legacy-token';
 const [legacy]=await db.insert(schema.devices).values({principal_id:user.id,device_name:'Legacy',credential_hash:hashToken(legacyToken),created_at:'2026-01-01T00:00:00.000Z'}).returning();
 const id=identity();success(await auth.bindIdentity(legacyToken,id));
 const relogin=await login(auth,id);assert.equal(relogin.device_code,legacy.code);
 const [after]=await db.select().from(schema.devices).where(eq(schema.devices.id,legacy.id));assert.equal(after.credential_hash,legacy.credential_hash);
 success(await auth.logout(legacyToken));assert.equal((await auth.resolveToken(legacyToken)).ok,false);
 await db.delete(schema.deviceSessions).where(eq(schema.deviceSessions.token_hash,hashToken(legacyToken)));
 assert.equal((await auth.resolveToken(legacyToken)).ok,false,'initialized tombstone forbids legacy reenrollment');
 const another=await login(auth,identity());const merge=await auth.bindIdentity(another.device_token,id);assert.equal(merge.ok,false);
});

test('device authorization needs explicit approval, throttles polling and consumes the secret atomically once',async()=>{
 const {db,user,auth,flow}=await setup();const id=identity();
 const request=success(await flow.start({device_name:'CLI',device_identity:id}));
 assert.equal((await flow.token(request.device_code)).error.code,'authorization_pending');
 assert.equal((await flow.token(request.device_code)).error.code,'slow_down');
 const [stored]=await db.select().from(schema.deviceAuthorizationRequests);
 assert.equal(stored.device_code_hash,hashToken(request.device_code));assert.notEqual(stored.user_code_hash,request.user_code);
 assert.equal(JSON.stringify(stored,(_,v)=>typeof v==='bigint'?String(v):v).includes(id.installation_secret),false);
 success(await flow.approve(user.code,request.user_code,'approve'));
 const other=await insertUser(db,{account:'other',displayName:'Other'});
 assert.equal((await flow.approve(other.code,request.user_code,'approve')).error.code,'access_denied');
 await db.update(schema.deviceAuthorizationRequests).set({last_polled_at:null});
 const exchanged=await Promise.all([flow.token(request.device_code),flow.token(request.device_code)]);
 assert.equal(exchanged.filter(r=>r.ok).length,1);assert.equal(exchanged.find(r=>!r.ok).error.code,'expired_token');
 assert.equal((await db.select().from(schema.deviceSessions)).length,1);
 assert.equal((await auth.resolveToken(exchanged.find(r=>r.ok).data.device_token)).ok,true);
});

test('denied, expired and forced-password-change authorization never creates a session',async()=>{
 const {db,user,flow}=await setup();
 const denied=success(await flow.start({device_name:'Denied',device_identity:identity()}));success(await flow.approve(user.code,denied.user_code,'deny'));
 assert.equal((await flow.token(denied.device_code)).error.code,'access_denied');
 const stale=success(await flow.start({device_name:'Expired',device_identity:identity()}));await db.update(schema.deviceAuthorizationRequests).set({expires_at:'2000-01-01T00:00:00.000Z'});
 assert.equal((await flow.token(stale.device_code)).error.code,'expired_token');assert.equal((await flow.approve(user.code,stale.user_code,'approve')).error.code,'expired_token');
 const forced=success(await flow.start({device_name:'Forced',device_identity:identity()}));await db.update(schema.users).set({must_change_password:true}).where(eq(schema.users.id,user.id));
 assert.equal((await flow.approve(user.code,forced.user_code,'approve')).error.code,'password_change_required');
 assert.equal((await db.select().from(schema.deviceSessions)).length,0);
});

test('relogin on the same installation recovers an existing Run lease, different devices cannot, and device revocation invalidates it',async()=>{
 const db=fixture.db;const seeded=await seedWorkspaceProject(db,{users:[{key:'member',account:'member',displayName:'Member',teamRole:'owner',projectRole:'owner'}]});
 const user=seeded.users.member;await db.update(schema.users).set({password_hash:await hashPassword('Password123!')}).where(eq(schema.users.id,user.id));
 const auth=createAuthUseCases(db), id=identity(), first=await login(auth,id);
 const feature=await insertFeature(db,{projectId:seeded.project.id,title:'Lease'});
 const task=await insertTask(db,{featureId:feature.id,title:'Task',profile:'builder',acceptance:[{id:'AC1',text:'works'}]});const tasks=createTaskService(db);
 const assigned=success(await tasks.assignTask({taskCode:task.code,principalCode:user.code,assigneePrincipalCode:user.code,baseSnapshot:0}));
 const claimed=success(await tasks.claimTask({taskCode:task.code,principalCode:user.code,profile:'builder',baseSnapshot:assigned.base_snapshot,workspacePath:'/tmp/work',gitBase:'a'.repeat(40),runCode:createPublicCode(),workspaceCode:createPublicCode()}));
 const [device]=await db.select().from(schema.devices).where(eq(schema.devices.code,first.device_code));const execution=createExecutionUseCases(db), actor={principalId:user.id,deviceId:device.id};
 const lease=await execution.lease(claimed.run_code,actor);
 const second=await login(auth,id);success(await auth.logout(first.device_token));assert.equal(second.device_code,first.device_code);
 const recovered=await execution.lease(claimed.run_code,actor);assert.equal(recovered.lease_token,lease.lease_token);
 const other=await login(auth,identity());const [otherDevice]=await db.select().from(schema.devices).where(eq(schema.devices.code,other.device_code));
 await assert.rejects(()=>execution.lease(claimed.run_code,{principalId:user.id,deviceId:otherDevice.id}),e=>e.code==='execution_device_mismatch');
 success(await auth.revokeDevice(second.device_code));assert.ok((await db.select().from(schema.runLeases))[0].revoked_at);
 await assert.rejects(()=>execution.renew(claimed.run_code,actor,lease.lease_token,lease.execution_epoch),e=>e.code==='forbidden');
});
