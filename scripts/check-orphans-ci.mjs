import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withIntegrityFixture } from './orphan-fixture.mjs';
async function command(url) {
  const child=spawn(process.execPath,[fileURLToPath(new URL('../apps/cli/dist/index.js',import.meta.url)),'db:check-orphans'],
    {env:{...process.env,TSP_DATABASE_URL:url,NODE_USE_ENV_PROXY:'0'},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',data=>output+=data);child.stderr.resume();
  const code=await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(new Error('Fixture command deadline'));},15000);
    child.once('close',code=>{clearTimeout(timer);resolve(code);});child.once('error',error=>{clearTimeout(timer);reject(error);});
  });
  return {code,result:JSON.parse(output)};
}
try {
  await withIntegrityFixture(process.env.TSP_TEST_DATABASE_URL,'ci',async(db,url)=>{
    const records=await db.$client.query('SELECT (SELECT count(*) FROM projects)::int AS projects,(SELECT count(*) FROM tasks)::int AS tasks,(SELECT count(*) FROM runs)::int AS runs');
    if(records.rows[0].projects<2||records.rows[0].tasks<1||records.rows[0].runs<1)throw new Error('Fixture not populated');
    const valid=await command(url);
    if(valid.code!==0||!valid.result.ok||valid.result.data.total_orphans!==0)throw new Error('Populated fixture failed gate');
    await db.$client.query('UPDATE features SET module_id=9223372036854775807');
    const invalid=await command(url);
    if(invalid.code===0||invalid.result.ok||invalid.result.data.total_orphans<1)throw new Error('Deliberate orphan did not fail gate');
    console.log(JSON.stringify({gate:'populated_integrity_fixture',checks:valid.result.data.relations.length,duration_ms:valid.result.data.duration_ms,normal_passed:true,orphan_rejected:true}));
  });
}catch{
  process.stderr.write('Integrity fixture gate failed; inspect the isolated database configuration and checks.\n');process.exitCode=1;
}
