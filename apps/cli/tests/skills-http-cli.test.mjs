import { test } from 'node:test';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { schema } from '@team-synergy/persistence';
import { eq } from 'drizzle-orm';
import { ensurePlatformSkillRelease } from '@team-synergy/application';
import { createHttpTestContext, insertMember, insertProject, insertTeam, insertUser, testCode } from './http-test-helpers.mjs';

test('a clean member workspace discovers and syncs the complete released platform skill without a source checkout', async t => {
  const context = await createHttpTestContext(import.meta.url);
  t.after(() => context.cleanup());
  const release = JSON.parse(readFileSync(new URL('../../core-api/dist/platform-skill-release.json', import.meta.url), 'utf8'));
  const published = await ensurePlatformSkillRelease(context.db, release);
  const owner = await insertUser(context.db, { account: 'released.owner', displayName: 'Owner' });
  const member = await insertUser(context.db, { account: 'released.member', displayName: 'Member' });
  const team = await insertTeam(context.db, { name: 'Release test' });
  const project = await insertProject(context.db, { name: 'Release project', teamId: team.id });
  await context.db.update(schema.projects).set({ owner_principal_id: owner.id, member_policy: 'private' }).where(eq(schema.projects.id, project.id));
  for (const [user,role] of [[owner,'owner'],[member,'viewer']]) {
    await insertMember(context.db, { principalId: user.id, projectId: project.id, role, displayName: user.display_name });
    await context.db.insert(schema.devices).values({ principal_id: user.id, device_name: 'Platform test', credential_hash: createHash('sha256').update(user.code).digest('hex'), created_at: '2026-11-12T00:00:00Z' });
  }
  const workspace = path.join(context.tmp, 'clean-member-workspace');
  mkdirSync(workspace);
  async function cli(user, args) {
    const r = await context.runCli(args, { ACP_DEVICE_TOKEN: user.code, ACP_PRINCIPAL_CODE: '', ACP_PRINCIPAL_ID: '' }, { cwd:workspace });
    return JSON.parse(r.out);
  }
  const globalCatalog = await cli(member, ['skill', 'catalog', '--platform']);
  assert.equal(globalCatalog.data[0].code, published.skill_code);
  const globalDetail = await cli(member, ['skill', 'show', published.skill_code, '--platform', '--revision', '1']);
  assert.equal(globalDetail.data.revisions[0].package_sha256, release.package_sha256);
  const destination = path.join(context.tmp, 'exported-builtin');
  const exported = await cli(member, ['skill', 'export', published.skill_code, '--revision', '1', '--directory', destination]);
  assert.equal(exported.ok, true, JSON.stringify(exported));
  for (const file of release.files) assert.equal(createHash('sha256').update(readFileSync(path.join(destination, file.path))).digest('hex'), file.sha256);
  assert.equal((await cli(member, ['skill', 'export', published.skill_code, '--revision', '1', '--directory', destination])).error.code, 'skill_export_conflict');
  assert.equal(existsSync(path.join(workspace, '.tsp')), false);
  mkdirSync(context.authHome, { recursive: true });
  writeFileSync(path.join(context.authHome, 'auth.json'), JSON.stringify({ api_url: context.apiUrl, device_token: member.code, user_code: member.code, device_name: 'Platform reader test' }));
  const selected = { skill: published.skill_code, revision: 1 };
  const tool = await cli(member, ['tools', 'call', 'read_platform_skill', '--input', JSON.stringify(selected)]);
  assert.equal(tool.ok, true, JSON.stringify(tool));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url)), 'mcp'], {
    cwd: workspace, windowsHide: true, env: context.env(), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '', error = '';
  child.stdout.on('data', value => output += value); child.stderr.on('data', value => error += value);
  const closed = new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
  child.stdin.end([{ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } },
    { id: 2, method: 'tools/call', params: { name: 'read_platform_skill', arguments: selected } }]
    .map(frame => JSON.stringify({ jsonrpc: '2.0', ...frame })).join('\n') + '\n');
  assert.equal(await closed, 0, error);
  const frames = output.trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(JSON.parse(frames[1].result.content[0].text), JSON.parse(tool.data.content[0].text));
  assert.equal(existsSync(path.join(workspace, '.agent')), false);
  const catalog = await cli(owner, ['skill','search',release.name,'--project',project.code]);
  assert.equal(catalog.data[0].scope_type,'platform');
  assert.equal(catalog.data[0].can_edit,false);
  assert.equal(catalog.data[0].release_version,published.release_version);
  assert.equal((await cli(member,['skill','enable',published.skill_code,'--project',project.code,'--revision','1'])).ok,false);
  assert.equal((await cli(owner,['skill','enable',published.skill_code,'--project',project.code,'--revision','1'])).ok,true);
  const synced = await cli(member,['skill','sync','--project',project.code]);
  assert.equal(synced.ok,true);
  for (const file of release.files) {
    const bytes = readFileSync(path.join(synced.data.skills_directory,release.name,file.path));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256);
  }
  for(const required of ['SKILL.md','scripts/check_dossier.py','references/team-synergy.md','agents/openai.yaml']) assert(release.files.some(file=>file.path===required), required);
  const edited = path.join(synced.data.skills_directory,release.name,'SKILL.md');
  writeFileSync(edited,'Member made a local change');
  const conflict = await cli(member,['skill','sync','--project',project.code]);
  assert.equal(conflict.error.code,'skill_local_modified');
  assert.equal(readFileSync(edited,'utf8'),'Member made a local change');
});

test('real tsp/API cross-team skills preserve exact adopted bytes and enforce source, project and revoked-grant permissions', async t => {
  const context = await createHttpTestContext(import.meta.url);
  t.after(() => context.cleanup());
  const timestamp = '2026-10-18T00:00:00Z';
  const users = {};
  for (const [index, name] of ['source', 'target', 'admin', 'member'].entries()) {
    const user = await insertUser(context.db, { code: testCode(800 + index), account: `skills.e2e.${name}`, displayName: name, createdAt: timestamp });
    const token = `skills-e2e-device-${name}`;
    await context.db.insert(schema.devices).values({ principal_id: user.id, device_name: `Skills E2E ${name}`, credential_hash: createHash('sha256').update(token).digest('hex'), created_at: timestamp });
    users[name] = { ...user, token };
  }
  const sourceTeam = await insertTeam(context.db, { code: testCode(810), name: 'Source team', createdAt: timestamp });
  const targetTeam = await insertTeam(context.db, { code: testCode(811), name: 'Target team', createdAt: timestamp });
  await context.db.update(schema.teams).set({ owner_principal_id: users.source.id, created_by_principal_id: users.source.id }).where(eq(schema.teams.id, sourceTeam.id));
  await context.db.update(schema.teams).set({ owner_principal_id: users.target.id, created_by_principal_id: users.target.id }).where(eq(schema.teams.id, targetTeam.id));
  for (const [name, team, role] of [['source', sourceTeam, 'owner'], ['target', targetTeam, 'owner'], ['admin', targetTeam, 'admin'], ['member', targetTeam, 'member']]) {
    await context.db.insert(schema.teamMembers).values({ team_id: team.id, principal_id: users[name].id, role, display_name: name, created_at: timestamp });
  }
  const project = await insertProject(context.db, { code: testCode(812), teamId: targetTeam.id, name: 'Target project', createdAt: timestamp });
  await context.db.update(schema.projects).set({ owner_principal_id: users.target.id, created_by_principal_id: users.target.id, member_policy: 'private' }).where(eq(schema.projects.id, project.id));
  for (const [name, role] of [['target', 'owner'], ['admin', 'admin'], ['member', 'member']]) {
    await insertMember(context.db, { principalId: users[name].id, projectId: project.id, role, displayName: name, createdAt: timestamp });
  }

  const source = path.join(context.tmp, 'source-package');
  const workspace = path.join(context.tmp, 'target-workspace');
  mkdirSync(path.join(source, 'scripts'), { recursive: true });
  mkdirSync(path.join(source, 'references')); mkdirSync(workspace);
  const original = new Map([
    ['SKILL.md', Buffer.from('---\nname: cli-contract-review\ndescription: Review API contracts and authorization boundaries\n---\n# Review\nUse this exact revision one.\n')],
    ['scripts/check.js', Buffer.from('throw new Error("Import and sync must never execute this script");\n')],
    ['references/规则.md', Buffer.from('# 校验规则\n\n公开编码、版本和权限应保持一致。\n')],
    ['references/fixture.bin', Buffer.from([0, 255, 13, 10, 1, 42])],
  ]);
  for (const [name, bytes] of original) writeFileSync(path.join(source, ...name.split('/')), bytes);
  async function run(name, args, cwd = workspace) {
    const result = await context.runCli(args, { ACP_PRINCIPAL_CODE: '', ACP_PRINCIPAL_ID: '', ACP_TOKEN: '', ACP_DEVICE_TOKEN: users[name].token }, { cwd });
    let envelope;
    try { envelope = JSON.parse(result.out); } catch { assert.fail(`CLI returned invalid JSON: ${result.err || result.out}`); }
    return { ...result, ...envelope };
  }
  function success(result) { assert.equal(result.status, 0, result.err || result.out); assert.equal(result.ok, true, result.out); return result.data; }
  function denied(result, code) { assert.equal(result.status, 1, result.out); assert.equal(result.ok, false, result.out); assert.equal(result.error.code, code, result.out); }

  const created = success(await run('source', ['skill', 'create', '--team', sourceTeam.code, '--directory', source]));
  assert.equal(created.scope_type, 'team'); assert.equal(created.scope_code, sourceTeam.code); assert.equal(created.current_revision, 1);
  assert.equal(created.revisions[0].files.length, original.size);
  success(await run('source', ['skill', 'publish', created.code, '--revision', '1']));
  denied(await run('admin', ['skill', 'enable', created.code, '--project', project.code, '--revision', '1', '--alias', 'contract-review']), 'skill_delivery_blocked');
  const granted = success(await run('source', ['skill', 'share', created.code, '--project', project.code, '--revisions', '1']));
  const share = granted.shares.find(item => item.target_type === 'project' && item.target_code === project.code && !item.revoked_at);
  assert.ok(share); assert.equal(share.allow_external, false);
  const installed = success(await run('admin', ['skill', 'enable', created.code, '--project', project.code, '--revision', '1', '--alias', 'contract-review', '--base-generation', '0']));
  assert.equal(installed.generation, 1); assert.equal(installed.installations[0].revision, 1);
  denied(await run('member', ['skill', 'disable', created.code, '--project', project.code]), 'project_forbidden');
  success(await run('member', ['project', 'bind', project.code]));
  const synced = success(await run('member', ['skill', 'sync']));
  assert.equal(synced.project_code, project.code); assert.deepEqual(synced.added, ['contract-review']);
  for (const [name, bytes] of original) assert.deepEqual(readFileSync(path.join(synced.skills_directory, 'contract-review', ...name.split('/'))), bytes, name);
  const lockBefore = readFileSync(synced.lock_path, 'utf8'); const lock = JSON.parse(lockBefore);
  assert.equal(lock.skills[0].revision, 1); assert.equal(lock.skills[0].package_sha256, created.revisions[0].package_sha256);
  assert.equal(lock.skills[0].files.length, original.size); assert.equal(lockBefore.includes('content_base64'), false);
  for (const user of Object.values(users)) assert.equal(lockBefore.includes(user.token), false, 'Device credentials must never be stored in the package lock');
  assert.equal(/authorization|credential|device_token|bearer/i.test(lockBefore), false);

  writeFileSync(path.join(source, 'SKILL.md'), '---\nname: cli-contract-review\ndescription: New unpublished-to-target content\n---\n# Revision two\n');
  success(await run('source', ['skill', 'revise', created.code, '--directory', source, '--base-revision', '1', '--change', 'New source version']));
  success(await run('source', ['skill', 'publish', created.code, '--revision', '2']));
  denied(await run('admin', ['skill', 'revise', created.code, '--directory', source, '--base-revision', '2', '--change', 'Cannot change source']), 'skill_forbidden');
  denied(await run('member', ['skill', 'show', created.code, '--revision', '2']), 'skill_revision_not_found');
  assert.equal(success(await run('member', ['skill', 'sync'])).changed, false);
  assert.deepEqual(readFileSync(path.join(synced.skills_directory, 'contract-review', 'SKILL.md')), original.get('SKILL.md'));

  success(await run('source', ['skill', 'revoke', created.code, share.code]));
  denied(await run('member', ['skill', 'sync']), 'skill_delivery_blocked');
  assert.equal(readFileSync(synced.lock_path, 'utf8'), lockBefore);
  for (const [name, bytes] of original) assert.deepEqual(readFileSync(path.join(synced.skills_directory, 'contract-review', ...name.split('/'))), bytes, `Revocation must leave the existing local file unchanged: ${name}`);
  const fresh = path.join(context.tmp, 'fresh-workspace'); mkdirSync(fresh);
  denied(await run('member', ['skill', 'sync', '--project', project.code], fresh), 'skill_delivery_blocked');
  assert.equal(existsSync(path.join(fresh, '.tsp')), false, 'Revoked grants must not create local package files');
  assert.equal(success(await run('member', ['skill', 'list'])).installations[0].blocked, true);
});
