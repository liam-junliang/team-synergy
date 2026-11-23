import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { createAuthUseCases, hashPassword } from '@team-synergy/application';
import { schema } from '@team-synergy/persistence';
import { registerAgentWorkspaceActions } from '../dist/agent-workspace-actions.js';
import { registerAuthMiddleware } from '../dist/auth.js';
import { createRemoteMcpGrant } from '../dist/remote-mcp-authorization.js';
import { isPublicConnectorRoute, registerRemoteMcp } from '../dist/remote-mcp.js';
import { registerProjectRoutes } from '../dist/routes/projects.js';
import { registerProjectDocumentRoutes } from '../dist/routes/project-documents.js';
import { registerTeamRoutes } from '../dist/routes/teams.js';
import { closeTestDb, insertUser, openTestDb } from './test-db.mjs';

const resource = 'https://workspace.example.test/api/mcp';
const password = 'WorkspaceFixtureOnly123!';
const cli = fileURLToPath(new URL('../../cli/dist/index.js', import.meta.url));
const execute = promisify(execFile);

async function fixture(t) {
  const db = await openTestDb();
  const app = Fastify({ logger: false });
  t.after(async () => {
    await app.close();
    await closeTestDb(db);
  });
  registerAuthMiddleware(app, db, isPublicConnectorRoute);
  registerRemoteMcp(app, db, resource);
  registerTeamRoutes(app, db);
  registerProjectRoutes(app, db);
  registerProjectDocumentRoutes(app, db);
  registerAgentWorkspaceActions(app, db);

  const password_hash = await hashPassword(password);
  const created_at = new Date().toISOString();
  const users = {};
  for (const account of ['owner', 'viewer', 'outsider']) {
    users[account] = await insertUser(db, { account: `workspace.${account}`, display_name: account, password_hash, created_at });
  }

  async function connector(user, { allowWorkspaceWrite = true } = {}) {
    const { token } = await db.transaction(tx => createRemoteMcpGrant(tx, { principalId: user.id, projectId: null, projectCode: null,
      name: 'Workspace fixture', allowTaskWrite: true, allowWorkspaceWrite, allowPersonalMemory: false }));
    let id = 0;
    async function rpc(method, params = {}) {
      const response = await app.inject({ method: 'POST', url: '/mcp', headers: {
        host: new URL(resource).hostname, authorization: `Bearer ${token}`,
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
      }, payload: { jsonrpc: '2.0', id: ++id, method, params } });
      assert.equal(response.statusCode, 200, response.body);
      if (response.headers['content-type']?.startsWith('text/event-stream')) {
        const data = response.body.split(/\r?\n/).find(line => line.startsWith('data: '));
        assert.ok(data, 'The transport should emit a JSON-RPC event');
        return JSON.parse(data.slice(6));
      }
      return response.json();
    }
    const toolCall = (name, args) => rpc('tools/call', { name, arguments: args });
    return {
      rpc,
      toolCall,
      async call(name, args) {
        const response = await toolCall(name, args);
        assert.ifError(response.error);
        assert.equal(response.result.isError, false, JSON.stringify(response.result));
        return response.result.structuredContent;
      },
    };
  }

  async function cliClient(user) {
    const server = await app.listen({ host: '127.0.0.1', port: 0 });
    const device = await createAuthUseCases(db).loginWithPassword(user.account, password, 'CLI fixture');
    assert.equal(device.ok, true);
    const home = await mkdtemp(path.join(tmpdir(), 'tsp-workspace-action-'));
    t.after(async () => {
      assert.equal(path.dirname(home), path.resolve(tmpdir()));
      await rm(home, { recursive: true, force: true });
    });
    await writeFile(path.join(home, 'auth.json'), JSON.stringify({ ...device.data, api_url: server }));
    const run = async (...args) => {
      const { stdout } = await execute(process.execPath, [cli, ...args], {
        cwd: home, env: { ...process.env, AGENTCTL_HOME: home, ACP_API_URL: server }, timeout: 15000, windowsHide: true,
      });
      const answer = JSON.parse(stdout);
      assert.equal(answer.ok, true, stdout);
      return answer.data;
    };
    return {
      run,
      async call(name, args, projectCode) {
        const flags = projectCode ? ['--project', projectCode] : [];
        return run('tools', 'call', name, '--input', JSON.stringify(args), ...flags);
      },
      async writeMarkdown(markdown) {
        const file = path.join(home, 'workspace-guide.md');
        await writeFile(file, markdown, 'utf8');
        return file;
      },
    };
  }

  return { db, users, connector, cliClient };
}

test('Connector manages teams, projects, members and repositories through HTTP MCP and respects current scopes', async t => {
  const { db, users, connector } = await fixture(t);
  const owner = await connector(users.owner);
  const team = await owner.call('create_team', { name: 'Workspace connector team' });
  const teamCode = team.team_code;
  assert.equal(team.owner_code, users.owner.code);
  const projectInput = { team_code: teamCode, name: 'Workspace connector project', member_policy: 'private' };
  const project = await owner.call('create_project', projectInput);
  const projectCode = project.project_code;
  const other = await owner.call('create_project', { ...projectInput, name: 'Other connector project' });

  await owner.call('add_team_member', { team_code: teamCode, user_code: users.viewer.code, role: 'member' });
  await owner.call('add_project_member', { projectCode, user_code: users.viewer.code, role: 'viewer' });
  const repository = await owner.call('create_project_repository', {
    projectCode, name: 'Example repo', remote_url: 'https://git.example.test/team/workspace.git', default_branch: 'main',
  });
  const repository_code = repository.repository_code;
  assert.equal((await owner.call('list_project_repositories', { projectCode })).data[0].repository_code, repository_code);
  const wrongProject = await owner.toolCall('update_project_repository', { projectCode: other.project_code, repository_code, name: 'Wrong project' });
  assert.equal(wrongProject.result.structuredContent.error.code, 'agent_object_not_found');
  assert.equal((await owner.call('list_project_repositories', { projectCode })).data[0].name, 'Example repo');

  const viewer = await connector(users.viewer);
  const viewerForbidden = await viewer.toolCall('update_project', { projectCode, name: 'Viewer write' });
  assert.equal(viewerForbidden.result.structuredContent.error.code, 'project_forbidden');
  const catalog = await viewer.call('search_tools', { projectCode, module: 'repositories', limit: 20 });
  assert.deepEqual(catalog.tools.map(tool => tool.name), ['list_project_repositories']);

  const outsider = await connector(users.outsider);
  const outsiderForbidden = await outsider.toolCall('get_project', { projectCode });
  assert.equal(outsiderForbidden.result.structuredContent.error.code, 'project_forbidden');

  const legacy = await connector(users.owner, { allowWorkspaceWrite: false });
  const legacyTools = (await legacy.rpc('tools/list')).result.tools.map(tool => tool.name);
  assert.ok(legacyTools.includes('create_task_draft'));
  for (const [action, args] of [['create_team', { name: 'Denied Team' }], ['create_project', projectInput]]) {
    assert.ok(!legacyTools.includes(action));
    const denied = await legacy.toolCall(action, args);
    assert.ok(denied.error || denied.result?.isError === true);
  }
  assert.equal((await db.select().from(schema.teams)).length, 1);
  assert.equal((await db.select().from(schema.projects)).length, 2);
});

test('CLI uses the same named governance contracts with an authenticated device and no project binding', async t => {
  const { users, cliClient, connector } = await fixture(t);
  const { call, run, writeMarkdown } = await cliClient(users.owner);
  const team = await call('create_team', { name: 'Workspace CLI team' });
  const project = await call('create_project', { team_code: team.team_code, name: 'Workspace CLI project', member_policy: 'private' });
  const projectCode = project.project_code;
  await call('add_project_member', { user_code: users.viewer.code, role: 'viewer' }, projectCode);
  const repository = await call('create_project_repository', {
    name: 'CLI repo', remote_url: 'https://git.example.test/team/cli.git', default_branch: 'main',
  }, projectCode);
  const owner = await connector(users.owner);
  assert.equal((await owner.call('get_project', { projectCode })).name, 'Workspace CLI project');
  assert.equal((await owner.call('list_project_repositories', { projectCode })).data[0].repository_code, repository.repository_code);
  assert.ok((await owner.call('list_project_members', { projectCode })).data.some(person => person.user_code === users.viewer.code && person.role === 'viewer'));
  const file = await writeMarkdown('# Agent 工具动作\n\n这里保留了版本和权限约定。\n');
  const document = await run('docs', 'create', '--project', projectCode, '--title', 'Agent 工具动作', '--file', file);
  const read = await run('docs', 'show', document.document_code);
  assert.match(JSON.stringify(read), /这里保留了版本和权限约定/u);
  assert.match(JSON.stringify(await owner.call('list_project_document_library', { projectCode })), /Agent 工具动作/u);
});
