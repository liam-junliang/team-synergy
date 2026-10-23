import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { runAdminResetPassword } from '../dist/admin-recovery.js';
function streamCapture(tty=false) { let text=''; const stream=new Writable({ write(chunk,encoding,done) { text+=chunk.toString(); done(); } }); stream.isTTY=tty; return {stream,text:()=>text}; }
function harness({ tty=false,input='TypedRecovery123!\n',resetOk=true }={}) {
 const terminal=streamCapture(tty); let command,closed=0,opened=0;
 const io={ input:Readable.from([input]),terminal:terminal.stream,env:{TSP_ALLOW_LOCAL_ADMIN_RESET:'1',TSP_DATABASE_URL:'postgres://local/test'},localOperator:'operator',localHostname:'host',load:async()=>({
  openDb:async()=>{opened++;return {};},closeDb:async()=>{closed++;},resetLocalAdminPassword:async(db,cmd)=>{ command=cmd;return resetOk?{ok:true,data:{account:'admin',user_code:'00000000000000000001',expires_at:'future',revoked_devices:1}}:{ok:false,error:{code:'internal_error',message:cmd.newPassword}};},
 })};
 return { io,terminal,command:()=>command,opened:()=>opened,closed:()=>closed };
}
test('stdin password goes only to reset helper and result contains no credential',async()=>{
 const h=harness();const result=await runAdminResetPassword({account:'admin',passwordStdin:true},h.io);
 assert.equal(h.command().newPassword,'TypedRecovery123!'); assert.equal(h.closed(),1);
 assert.equal(h.terminal.text(),''); assert.equal(JSON.stringify(result).includes('TypedRecovery'),false);
});
test('generated recovery secrets require terminal output and never enter JSON metadata',async()=>{
 const blocked=harness(); await assert.rejects(()=>runAdminResetPassword({account:'admin'},blocked.io),{code:'admin_recovery_terminal_required'}); assert.equal(blocked.opened(),0);
 const h=harness({tty:true}); const result=await runAdminResetPassword({account:'admin'},h.io);
 assert.ok(h.command().newPassword.length>=32); assert.ok(h.terminal.text().includes(h.command().newPassword));
 assert.equal(JSON.stringify(result).includes(h.command().newPassword),false);
});
test('explicit server authorization and database configuration are required before loading',async()=>{
 for (const field of ['TSP_ALLOW_LOCAL_ADMIN_RESET','TSP_DATABASE_URL']) { const h=harness();delete h.io.env[field]; await assert.rejects(()=>runAdminResetPassword({account:'admin',passwordStdin:true},h.io));assert.equal(h.opened(),0); }
});
test('stdin is bounded and multiline/TTY input is refused without DB writes',async()=>{
 for (const input of ['x'.repeat(2000),'first-line\nsecond-line\n']) {const h=harness({input});await assert.rejects(()=>runAdminResetPassword({account:'admin',passwordStdin:true},h.io));assert.equal(h.opened(),0);}
 const h=harness();h.io.input.isTTY=true;await assert.rejects(()=>runAdminResetPassword({account:'admin',passwordStdin:true},h.io));assert.equal(h.opened(),0);
});
test('reset failures close DB and redact helper error messages',async()=>{
 const h=harness({resetOk:false});let error;try{await runAdminResetPassword({account:'admin',passwordStdin:true},h.io);}catch(e){error=e;}
 assert.ok(error);assert.equal(error.message.includes('TypedRecovery'),false);assert.equal(h.closed(),1);assert.equal(h.terminal.text(),'');
});
