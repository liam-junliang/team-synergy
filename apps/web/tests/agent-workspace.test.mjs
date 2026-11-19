import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite, api, routing, switching, helpers, workbench, agent, dialogs, i18n, guide, mcpConnections, mcpConsent;
before(async () => {
  vite = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false } });
  [api, routing, switching, helpers, workbench, agent, dialogs, i18n, guide, mcpConnections, mcpConsent] = await Promise.all(['api.ts', 'workspaceRouting.ts', 'projectSwitching.ts', 'skills.ts', 'SkillsWorkbench.tsx', 'AgentWorkspace.tsx', 'SkillDialogs.tsx', 'i18n.ts', 'AgentUsageGuide.tsx', 'mcpConnectionsApi.ts', 'McpConsentWorkspace.tsx'].map(file => vite.ssrLoadModule(`/src/${file}`)));
});
after(async () => vite?.close());
afterEach(() => i18n.setLocale('zh-CN', false));
function render(Component, props, entries = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  entries.forEach(([key, value]) => client.setQueryData(key, value));
  try { return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Component, props))); } finally { client.clear(); }
}
const project = { code: 'P', name: 'Product', team_code: 'T', status: 'active', role: 'admin', capabilities: { read: true, write: true, manage: true } };
const skill = { code: 'S', name: 'review', description: 'Review changes', scope_type: 'team', scope_code: 'T', current_revision: 2, published_revision: 1, can_edit: true, can_manage: true, archived: false, available_revisions: [1], owner_user_code: 'U', updated_at: '2026-10-18T00:00:00Z', shares: [] };
const file = (path, content) => ({ path, content_base64: Buffer.from(content).toString('base64'), sha256: 'a'.repeat(64), size_bytes: Buffer.byteLength(content) });
const revision = (n, content, published = null) => ({ revision: n, name: 'review', description: 'Review changes', files: [file('SKILL.md', content), file('scripts/test.js', '<script>alert("test")</script>')], package_sha256: 'b'.repeat(64), size_bytes: 128, change_summary: `Revision ${n}`, created_at: '2026-10-18T00:00:00Z', created_by_user_code: 'U', published_at: published });
const detail = { ...skill, revisions: [revision(2, '# Current draft\n\n**New**'), revision(1, '# Published content\n\n**Old**', '2026-10-18T00:00:00Z')] };
const installations = { project_code: 'P', generation: 3, can_manage: true, installations: [] };

test('Agent routes survive direct loading, login and project switching without leaking prior details', () => {
  const path = routing.agentWorkspacePath('skills', { projectCode: 'P', teamCode: 'T', agentReturnPath: '/projects/P/documents?document=D' });
  assert.deepEqual(routing.parseWorkspacePath(path), { view: 'agent', agentTab: 'skills', projectCode: 'P', teamCode: 'T', agentReturnPath: '/projects/P/documents?document=D' });
  assert.ok(routing.isWorkspacePath('/agent/connect')); assert.ok(routing.isWorkspacePath('/agent/skills'));
  assert.equal(routing.isWorkspacePath('/agent/private-route'), false);
  assert.equal(routing.workspacePathAfterLogin(`http://localhost${path}`, false), path);
  const switched = routing.parseWorkspacePath(switching.projectSwitchPath(routing.parseWorkspacePath(path), 'Q'));
  assert.deepEqual(switched, { view: 'agent', agentTab: 'skills', projectCode: 'Q' });
  for (const unsafe of ['//example.com', '/\\example.com', 'https://example.com', '/api/skills', '/agent/connect?return=/agent/skills', '/projects/Q/documents']) assert.equal(routing.safeAgentReturnPath(unsafe, 'P'), '/projects/P/overview');
});

test('Agent integration entry is visibly named and original navigation retains Testing before Defects', () => {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.match(source, /aria-label=\{t\('Agent 集成'\)\}/);
  assert.match(source, /aria-current=\{view === 'agent' \? 'page' : undefined\}/);
  assert.ok(source.indexOf("aria-label={t('Agent 集成')}") < source.indexOf('<ProjectSwitcher route='));
  assert.doesNotMatch(source, />← \{t\(session\.is_system_admin/);
  assert.equal(routing.PROJECT_SECTIONS.at(-3), 'testing'); assert.equal(routing.PROJECT_SECTIONS.at(-2), 'defects'); assert.equal(routing.PROJECT_SECTIONS.at(-1), 'handovers');
});

test('Connector consent resumes after login with a single opaque request identifier', () => {
  const request = 'a'.repeat(64);
  const consentPath = routing.MCP_CONSENT_PATH;
  const validPath = `${consentPath}?request=${request}`;
  assert.equal(routing.isWorkspacePath(validPath), true);
  assert.deepEqual(routing.parseWorkspacePath(validPath), { view: 'agent', agentTab: 'mcp-consent', mcpConsentRequest: request });
  for (const isAdmin of [false, true]) {
    assert.equal(routing.workspacePathAfterLogin(`https://app.example${validPath}&return=https%3A%2F%2Fother.example#extra`, isAdmin), validPath);
    assert.equal(routing.workspacePathAfterLogin(`https://app.example${validPath}&request=${request}`, isAdmin), consentPath);
  }
  assert.equal(routing.parseWorkspacePath(`${consentPath}?request=invalid`).mcpConsentRequest, undefined);
  assert.equal(switching.projectSwitchPath(routing.parseWorkspacePath(validPath), 'Q'), '/agent/connect?project=Q');
});

test('Connector authorization accepts only absolute HTTPS or loopback HTTP callback URLs', () => {
  assert.equal(mcpConsent.safeMcpCallback('https://agent.example/callback?code=fixture'), 'https://agent.example/callback?code=fixture');
  assert.equal(mcpConsent.safeMcpCallback('http://[::1]:54321/callback?error=access_denied'), 'http://[::1]:54321/callback?error=access_denied');
  for (const value of ['javascript:alert(1)', 'https://user:pass@agent.example/callback', 'http://notlocalhost.example/callback', 'https://agent.example/callback#fragment', '/callback', '//agent.example/callback']) assert.equal(mcpConsent.safeMcpCallback(value), null);
});

test('Connector consent authorizes the account with optional permissions and no project selection', () => {
  const user = { code: 'U', account: 'liam', display_name: 'Liam' };
  const request = 'a'.repeat(64);
  const route = { view: 'agent', agentTab: 'mcp-consent', mcpConsentRequest: request };
  const html = render(agent.AgentWorkspace, { route, user }, [
    [['mcp-authorization-request', 'U', request], { clientName: 'Personal Assistant', redirectOrigin: 'https://agent.example', requestedTaskWrite: true, requestedPersonalMemory: true }],
  ]);
  for (const label of ['Personal Assistant', 'liam', 'https://agent.example', 'Agent 在每次调用时指定项目', '客户端申请了任务协作和个人记忆读取', '记忆仅供读取']) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /<select|正在加载项目|--capture|Bearer/);
  assert.match(html, /<input type="checkbox"(?![^>]*checked=)/);
  assert.equal([...html.matchAll(/<input type="radio"[^>]*checked=""/g)].length, 1);
  assert.match(html, /checked=""[^>]*><span><strong[^>]*>仅查看/);
  assert.match(html, /<button type="submit"(?![^>]*disabled=)[^>]*>确认授权/);
});

test('Agent usage guide sits between setup and skills and preserves the current return path', () => {
  assert.deepEqual(routing.AGENT_WORKSPACE_TABS, ['connect', 'guide', 'skills']);
  const route = { view: 'agent', agentTab: 'guide', projectCode: 'P', teamCode: 'T', agentReturnPath: '/projects/P/understanding' };
  const path = routing.agentWorkspacePath('guide', route);
  assert.ok(routing.isWorkspacePath(path));
  assert.deepEqual(routing.parseWorkspacePath(path), route);
  assert.equal(routing.workspacePathAfterLogin(`http://localhost${path}`, false), path);
  assert.deepEqual(routing.parseWorkspacePath(switching.projectSwitchPath(route, 'Q')), { view: 'agent', agentTab: 'guide', projectCode: 'Q' });
});

test('Agent usage guide links and renders the corresponding Markdown manual independently of project context', () => {
  const user = { code: 'U', username: 'member', display_name: 'Member' };
  const route = { view: 'agent', agentTab: 'guide' };
  const noProject = render(agent.AgentWorkspace, { route, user });
  assert.match(noProject, /href="\/agent\/guide\.zh-CN\.md"[^>]*>读取 Markdown<\/a>/);
  assert.match(noProject, /正在读取使用指南/);
  assert.doesNotMatch(noProject, /候选项目|复制指令|授权本机设备/);

  const guideProject = { ...project, code: '19Q4K7PDARXQ9JHW6R6F' };
  const content = readFileSync(new URL('../public/agent/guide.en-US.md', import.meta.url), 'utf8');
  i18n.setLocale('en-US', false);
  const localized = render(agent.AgentWorkspace, { route: { ...route, projectCode: guideProject.code }, user, guideProject },
    [[['agent-usage-guide', 'en-US'], content]]);
  assert.match(localized, /<h1[^>]*>Team Synergy Agent operating manual<\/h1>/i);
  assert.match(localized, /aria-label="Contents"/);
  assert.match(localized, /href="\/agent\/guide\.en-US\.md"[^>]*>Read Markdown<\/a>/);
  assert.match(localized, /Candidate project from this page[^<]*<\/span><code[^>]*>19Q4K7PDARXQ9JHW6R6F<\/code>/);
  assert.match(localized, /Start with the HTTP Connector/);
  assert.match(localized, /Confirm it through the connection tools before use/);
  assert.match(localized, /<button[^>]*>Copy<\/button>/);
  for (const command of [
    'read_connector_skill', 'search_tools', 'tsp tools call get_connection_context', 'read_project_material', 'read_memory_sources', 'query_code_graph',
    'create_task_draft', 'record_test_execution', 'submit_task_evidence', 'artifact.uri', 'artifact.content_hash',
    'tsp.cmd task create', 'tsp task assign', 'tsp task claim TASK_CODE --profile builder',
    'tsp task submit', 'tsp task claim TASK_CODE --profile verifier', 'tsp task verify', 'tsp task close',
  ]) assert.ok(localized.includes(command), command);
  assert.doesNotMatch(localized, /Copy instructions|Loading the usage guide/);
  const shell = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.match(shell, /rel="help" href="\/agent\/guide\.zh-CN\.md"/);
  assert.match(shell, /rel="help" href="\/agent\/guide\.en-US\.md"/);
});

test('Agent manual source ignores session credentials and rejects missing or SPA-fallback responses', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => new Response('# Manual', { headers: { 'Content-Type': 'text/markdown; charset=utf-8' } }));
  assert.equal(await guide.readAgentGuide('en-US'), '# Manual');
  assert.equal(fetch.mock.calls[0].arguments[0], '/agent/guide.en-US.md');
  assert.equal(fetch.mock.calls[0].arguments[1].credentials, 'omit');
  fetch.mock.mockImplementation(async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }));
  await assert.rejects(guide.readAgentGuide('zh-CN'), /agent_guide_unavailable/);
  fetch.mock.mockImplementation(async () => new Response('missing', { status: 404 }));
  await assert.rejects(guide.readAgentGuide('en-US'), /agent_guide_unavailable/);
});

test('skill reader uses selected immutable revision, safe Markdown and manager-gated controls', () => {
  const props = { skill: detail, busy: false, onEdit() {}, onAction() {}, onInstall() {} };
  const writable = render(workbench.SkillContentReader, props);
  for (const value of ['Current draft', '修订技能包', '发布此版本', '共享版本', '版本记录']) assert.ok(writable.includes(value));
  assert.doesNotMatch(writable, /<script|<iframe|srcdoc/);
  const readonly = render(workbench.SkillContentReader, { ...props, initialRevision: 1, skill: { ...detail, can_edit: false, can_manage: false }, projectSkills: { ...installations, can_manage: false } });
  assert.match(readonly, /Published content/); assert.doesNotMatch(readonly, /Current draft|修订技能包|发布此版本|共享版本|归档技能|采用到当前项目/);
  const installer = render(workbench.SkillContentReader, { ...props, skill: { ...detail, can_edit: false, can_manage: false }, projectSkills: installations });
  assert.match(installer, /采用到当前项目/); assert.doesNotMatch(installer, /修订技能包|共享版本/);
  const released = render(workbench.SkillContentReader, { ...props, projectSkills: installations, skill: {
    ...detail, scope_type: 'platform', scope_code: 'platform', can_edit: false, can_manage: false,
    revisions: [{ ...detail.revisions[1], release_version: '1.1.0' }],
  } });
  assert.match(released, /平台内置技能 · 1\.1\.0/);
  assert.match(released, /采用到当前项目/);
  assert.doesNotMatch(released, /修订技能包|发布此版本|共享版本|归档技能/);
  assert.match(writable, /shrink-0 space-y-3 border-b/); assert.match(writable, /min-h-0 min-w-0 overflow-y-auto overscroll-contain/);
});

test('external project readers see installed skills without team membership or manager actions', () => {
  const readonly = { ...project, role: 'viewer', is_external: true, capabilities: { read: true, write: false, manage: false } };
  const pinned = { skill_code: 'S', revision: 1, alias: 'shared-review', enabled: true, name: 'review', description: 'Review changes', scope_type: 'team', scope_code: 'T', package_sha256: 'b'.repeat(64), available_revisions: [1], blocked: false, blocked_reason: null };
  const html = render(workbench.SkillsWorkbench, { project: readonly, initialTab: 'project' }, [
    [['skills', 'catalog', 'project', 'P', 'project'], []],
    [['skills', 'installed', 'P'], { ...installations, can_manage: false, installations: [pinned] }],
    [['skills', 'detail', 'project', 'P', 'S'], { ...detail, current_revision: 1, can_edit: false, can_manage: false, revisions: [detail.revisions[1]] }],
  ]);
  assert.match(html, /shared-review/); assert.match(html, /Published content/);
  assert.doesNotMatch(html, /新建技能包|修订技能包|共享版本|采用到当前项目|>停用</);
  assert.match(html, /团队与项目自建/);
});

test('revoked skill installation stays visible but never renders cached package content', () => {
  const blocked = { skill_code: 'S', revision: 1, alias: 'old-review', enabled: true, name: 'review', description: 'Old summary', scope_type: 'team', scope_code: 'T', package_sha256: 'b'.repeat(64), available_revisions: [], blocked: true, blocked_reason: 'revoked' };
  const html = render(workbench.SkillsWorkbench, { project, initialTab: 'project' }, [
    [['skills', 'catalog', 'project', 'P', 'project'], []], [['skills', 'installed', 'P'], { ...installations, installations: [blocked] }],
    [['skills', 'detail', 'project', 'P', 'S'], detail],
  ]);
  assert.match(html, /授权不可用/); assert.match(html, /old-review/); assert.match(html, />停用</);
  assert.doesNotMatch(html, /Current draft|Published content|共享版本/);
});

test('skill catalog defaults to usable entries while history remains explicitly discoverable', () => {
  const active = { ...skill, code: 'ACTIVE', name: 'Current package', description: 'Ready' };
  const archived = { ...skill, code: 'ARCHIVED', name: 'Obsolete package', archived: true };
  const disabled = { skill_code: 'DISABLED', revision: 1, alias: 'Stopped package', enabled: false, name: 'Stopped', description: 'Old summary', scope_type: 'project', scope_code: 'P', package_sha256: 'b'.repeat(64), available_revisions: [], blocked: true, blocked_reason: 'source unavailable' };
  const html = render(workbench.SkillsWorkbench, { project, initialTab: 'owned' }, [
    [['skills', 'catalog', 'project', 'P', 'owned'], [active, archived]],
    [['skills', 'installed', 'P'], { ...installations, installations: [disabled] }],
  ]);
  assert.match(html, /Current package/);
  assert.doesNotMatch(html, /Obsolete package|Stopped package/);
  assert.match(html, /type="checkbox"/);
  assert.match(html, /显示已停用\/归档/);
  const entries = [{ ...active, skill: active }, { ...archived, skill: archived }, { code: 'DISABLED', name: 'Stopped', description: '', scope_type: 'project', scope_code: 'P', installation: disabled }];
  assert.deepEqual(workbench.filterSkillEntries(entries, '', false).map(item => item.code), ['ACTIVE']);
  assert.deepEqual(workbench.filterSkillEntries(entries, '', true).map(item => item.code), ['ACTIVE', 'ARCHIVED', 'DISABLED']);
  assert.deepEqual(workbench.filterSkillEntries(entries, 'STOPPED', true).map(item => item.code), ['DISABLED']);
  assert.equal(workbench.skillEntryStatus({ ...entries[1], installation: { ...disabled, enabled: true } }), '已归档');
  assert.equal(workbench.skillEntryStatus(entries[2]), '已停用');
});

test('project scope changes do not use a cached detail from another project', () => {
  const html = render(workbench.SkillsWorkbench, { project: { ...project, code: 'Q' }, initialTab: 'project' }, [
    [['skills', 'catalog', 'project', 'Q', 'project'], []], [['skills', 'installed', 'Q'], { ...installations, project_code: 'Q' }],
    [['skills', 'detail', 'project', 'P', 'S'], detail],
  ]);
  assert.doesNotMatch(html, /Current draft|Published content/);
});

test('package import preserves UTF-8 and binary bytes and rejects unsafe or oversized packages', async () => {
  const markdown = new File(['---\nname: hello\ndescription: 测试\n---\n# Hello'], 'SKILL.md');
  const binary = new File([new Uint8Array([0, 255, 1])], 'asset.bin');
  Object.defineProperty(markdown, 'webkitRelativePath', { value: 'package/SKILL.md' });
  Object.defineProperty(binary, 'webkitRelativePath', { value: 'package/assets/asset.bin' });
  const result = await helpers.readSkillFiles([markdown, binary]);
  assert.equal(result[0].path, 'SKILL.md'); assert.match(helpers.skillFileText(result[0]), /测试/);
  assert.equal(result[1].path, 'assets/asset.bin'); assert.deepEqual(Buffer.from(result[1].content_base64, 'base64'), Buffer.from([0, 255, 1]));
  assert.equal(helpers.skillFileText(result[1]), undefined);
  for (const path of ['../secret', '/absolute', 'C:/file', 'refs\\bad', '.git/config', 'refs/CON.txt', 'trailing.', 'a//b', 'a/../b']) assert.equal(helpers.validSkillPath(path), false, path);
  assert.equal(helpers.validSkillPath('references/指南.md'), true);
  await assert.rejects(() => helpers.readSkillFiles([new File(['bad'], 'readme.md')]), /SKILL.md/);
  await assert.rejects(() => helpers.readSkillFiles([markdown, new File([new Uint8Array(6 * 1024 * 1024)], 'big.bin')]), /6 MiB/);
  await assert.rejects(() => helpers.readSkillFiles([new File(['A'], 'SKILL.md'), new File(['B'], 'skill.md')]), /大小写/);
});

test('file changes distinguish additions, removals and exact byte changes', () => {
  const changes = helpers.skillFileChanges([file('SKILL.md', 'new'), file('new.bin', 'x')], [file('SKILL.md', 'old'), file('gone.md', 'g')]);
  assert.deepEqual(changes, [{ path: 'SKILL.md', kind: 'changed' }, { path: 'gone.md', kind: 'removed' }, { path: 'new.bin', kind: 'added' }]);
});

test('sharing and adoption forms disclose exact revisions, scope and external-member impact', () => {
  const html = render(dialogs.SkillShareEditor, { skill: detail, onClose() {}, async onSaved() {} });
  assert.match(html, /目标项目编码/); assert.match(html, /允许交付给含外部协作者的项目/); assert.match(html, /后续新版本不会自动共享/);
  assert.match(html, />r1</); assert.doesNotMatch(html, />r2</);
  const adopt = render(dialogs.SkillInstallEditor, { skill: detail, projectSkills: installations, onClose() {}, async onSaved() {} });
  assert.match(adopt, /r1 · Revision 1/); assert.doesNotMatch(adopt, /r2 · Revision 2/);
});

test('Agent connection guide supplies real CLI and MCP setup without exposing device records', () => {
  i18n.setLocale('en-US', false);
  const html = render(agent.CliConnectionGuide, { user: { code: 'U', account: 'liam', display_name: 'Liam' }, project }, [
    [['platform-client-config'], { public_web_url: null, public_api_url: null }],
    [['devices', 'U'], [{ code: 'D', device_name: 'My laptop', created_at: '2026-10-18T00:00:00Z' }]],
    [['devices', 'OTHER'], [{ code: 'OTHER', device_name: 'Private device', created_at: '' }]],
  ]);
  assert.doesNotMatch(html, /tsp auth login-password|BIND_TOKEN|npm link|pnpm -r build/); assert.match(html, /tsp auth login --api/); assert.match(html, /tsp project bind P/); assert.match(html, /tsp skill sync --project P --check/);
  assert.doesNotMatch(html, /My laptop|Private device|Devices &amp; sessions|device_token|web-login|在线设备/);
  assert.match(html, /href="\/account"/);
  assert.match(html, /MCP/);
  const decode = value => value.replaceAll('&quot;', '"').replaceAll('&#x27;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const configurations = [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map(match => decode(match[1])).filter(text => text.startsWith('{')).map(text => JSON.parse(text));
  assert.deepEqual(configurations.map(config => config.mcpServers.team_synergy), [
    { command: 'cmd', args: ['/d', '/c', 'tsp', 'mcp', '--project', 'P'] },
    { command: 'tsp', args: ['mcp', '--project', 'P'] },
  ]);
  assert.match(html, /tsp tools call read_code_catalog --project P/);
  assert.match(html, /get_connection_context/);
  assert.match(html, /list_projects/);
  assert.doesNotMatch(html, /Set the working directory to the project bound/);
  assert.match(html, /list_project_materials/);
  assert.match(html, /read_code_catalog/);
});

test('Agent connection guide never offers an unbound placeholder as an executable bind command', () => {
  const html = render(agent.CliConnectionGuide, { user: { code: 'U', account: 'liam', display_name: 'Liam' } }, [
    [['platform-client-config'], { public_web_url: 'https://workspace.example.com', public_api_url: 'https://api.example.com' }],
  ]);
  assert.match(html, /tsp auth login --api https:\/\/api.example.com --web https:\/\/workspace.example.com/);
  assert.doesNotMatch(html, /tsp project bind (?:&lt;|<)PROJECT_CODE/);
  assert.match(html, /get_connection_context/);
  assert.match(html, /list_projects/);
  assert.match(html, /projectCode/);
  assert.match(html, /不设置工作目录或项目也能启动 MCP/);
  const jsonCommands = [...html.matchAll(/<code>([\s\S]*?)<\/code>/g)].map(match => match[1].replaceAll('&quot;', '"')).filter(text => text.startsWith('{')).map(text => JSON.parse(text));
  assert.deepEqual(jsonCommands.map(config => config.mcpServers.team_synergy.args), [
    ['/d', '/c', 'tsp', 'mcp'], ['mcp'],
  ]);
  assert.ok(jsonCommands.every(config => !('cwd' in config.mcpServers.team_synergy)));
});

test('Agent connection defaults to HTTP Connector and offers local setup when the endpoint is unavailable', () => {
  const user = { code: 'U', account: 'liam', display_name: 'Liam' };
  const base = { public_web_url: null, public_api_url: null };
  const loading = render(agent.AgentConnectionWorkspace, { user });
  assert.match(loading, /aria-pressed="true"[^>]*>HTTP Connector（推荐）<\/button>/);
  assert.match(loading, /正在读取平台接入配置/);
  assert.doesNotMatch(loading, /tsp auth login|复制服务地址/);
  const unconfigured = render(agent.AgentConnectionWorkspace, { user, project }, [[['platform-client-config'], base]]);
  assert.match(unconfigured, /aria-pressed="true"[^>]*>HTTP Connector（推荐）<\/button>/);
  assert.match(unconfigured, /此站点尚未启用 HTTP Connector/);
  assert.match(unconfigured, /打开本地接入/);
  assert.doesNotMatch(unconfigured, /复制服务地址|tsp auth login/);

  const local = render(agent.CliConnectionGuide, { user, project }, [[['platform-client-config'], base]]);
  assert.match(local, /tsp agent connect --harness codex --project P<\/code>/);
  assert.doesNotMatch(local, /--capture|复制授权头|Bearer/);
  for (const host of ['codex', 'dsh', 'opencode', 'claudecode']) assert.ok(local.includes(`value="${host}"`));

  const endpoint = 'https://workspace.example/agent/mcp';
  const entries = [[['platform-client-config'], { ...base, remote_mcp_url: endpoint }], [['remote-mcp-connections', 'U'], [
    { code: 'G', name: 'Personal office', projectCode: null, allowPersonalMemory: false, allowTaskWrite: false, expiresAt: '2099-01-01T00:00:00Z', revokedAt: null },
    { code: 'K', name: 'Old personal', projectCode: 'P', allowPersonalMemory: true, allowTaskWrite: true, expiresAt: '2099-01-01T00:00:00Z', revokedAt: '2026-01-01T00:00:00Z' },
  ]]];
  i18n.setLocale('en-US', false);
  const remote = render(agent.AgentConnectionWorkspace, { user, project, projects: [project] }, entries);
  assert.match(remote, /aria-pressed="true"[^>]*>HTTP Connector \(recommended\)<\/button>/);
  assert.match(remote, /https:\/\/workspace\.example\/agent\/mcp/);
  assert.match(remote, /Add TeamSynergy Connector/);
  assert.match(remote, /Sign in and authorize in the browser/);
  assert.match(remote, /straight to the consent page/);
  assert.match(remote, /browser returns the authorization result/);
  assert.match(remote, /<details[^>]*><summary[^>]*>Advanced: connect with an authorization header/);
  assert.match(remote, /Personal office/);
  assert.match(remote, /View only/);
  assert.match(remote, /Projects accessible to this account · View only/);
  assert.match(remote, /Project Product only · Allow collaboration/);
  assert.match(remote, /Session capture stays off after setup/);
  for (const text of ['Old personal', 'Revoked', 'Allow collaboration', 'Includes account preferences']) assert.ok(remote.includes(text));
  assert.match(remote, /Revoke connection Personal office/);
  assert.doesNotMatch(remote, /Revoke connection Old personal|Bearer|tsp auth login/);
  const noProject = render(agent.AgentConnectionWorkspace, { user, project: { ...project, status: 'archived' } }, entries);
  assert.match(noProject, /<button(?![^>]*disabled=)[^>]*>New connection<\/button>/);
  assert.match(noProject, /create a time-limited credential for this account/);
});

test('Connector consent loads and submits decisions to the private request route without caching', async (context) => {
  const fetch = context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, data: { redirectUrl: 'https://agent.example/callback' } }), { headers: { 'Content-Type': 'application/json' } }));
  const request = 'b'.repeat(64);
  await mcpConnections.getMcpAuthorizationRequest(request);
  const denial = { decision: 'deny' };
  const approval = { decision: 'allow', allowTaskWrite: true, allowPersonalMemory: false };
  await mcpConnections.decideMcpAuthorization(request, denial);
  await mcpConnections.decideMcpAuthorization(request, approval);
  const [read, deny, allow] = fetch.mock.calls.map(call => call.arguments);
  assert.ok([read, deny, allow].every(([path, init]) => path === `/api/mcp/oauth/requests/${request}` && init.cache === 'no-store' && init.credentials === 'same-origin'));
  assert.deepEqual(JSON.parse(deny[1].body), denial);
  assert.deepEqual(JSON.parse(allow[1].body), approval);
});

test('remote MCP connection calls send the exact API contract without caching credentials', async (context) => {
  const data = { connection: { code: 'G', name: 'Browser agent', projectCode: null, allowPersonalMemory: false, allowTaskWrite: true, expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }, token: 'fixture-one-time-only' };
  const fetch = context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ ok: true, data }), { headers: { 'Content-Type': 'application/json' } }));
  await mcpConnections.listMcpConnections();
  assert.deepEqual(await mcpConnections.createMcpConnection({ name: 'Browser agent', allowPersonalMemory: false, allowTaskWrite: true }), data);
  await mcpConnections.revokeMcpConnection('G/1');
  const [list, create, revoke] = fetch.mock.calls.map(call => call.arguments);
  assert.equal(list[0], '/api/account/mcp-connections');
  assert.equal(create[0], '/api/account/mcp-connections');
  assert.equal(create[1].method, 'POST');
  assert.deepEqual(JSON.parse(create[1].body), { name: 'Browser agent', allowPersonalMemory: false, allowTaskWrite: true });
  assert.equal(revoke[0], '/api/account/mcp-connections/G%2F1');
  assert.equal(revoke[1].method, 'DELETE');
  assert.ok([list, create, revoke].every(([, init]) => init.cache === 'no-store' && init.credentials === 'same-origin'));
});

test('new UI messages have English translations and keep user-authored names unchanged', () => {
  for (const name of ['AgentWorkspace.tsx', 'RemoteMcpConnectionGuide.tsx', 'McpConsentWorkspace.tsx', 'McpPermissionFields.tsx', 'SkillsWorkbench.tsx', 'SkillDialogs.tsx', 'SkillShared.tsx', 'skills.ts']) {
    const source = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g)) assert.ok(i18n.englishMessages[match[1]], `missing ${match[1]}`);
  }
  i18n.setLocale('en-US', false);
  const html = render(workbench.SkillContentReader, { skill: { ...detail, name: '项目专属技能' }, busy: false, onEdit() {}, onAction() {}, onInstall() {} });
  assert.match(html, /Publish version|Version history/);
});

test('API mutations retain exact revision and optimistic installation generation', async () => {
  const previousFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, method: init?.method, body: init?.body && JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, data: detail }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
  try {
    await api.listSkills('project', 'P', 'shared'); await api.getSkill('S', 'P');
    await api.reviseSkill('S', { base_revision: 2, files: [file('SKILL.md', 'test')], change_summary: 'change' });
    await api.shareSkill('S', { target_type: 'team', target_code: 'OTHER', revisions: [1], allow_projects: true, allow_external: false });
    await api.installProjectSkill('P', 'S', { revision: 1, alias: 'review', enabled: true, base_generation: 3 });
    await api.revokeSkillShare('S', 'SHARE');
    assert.equal(calls[0].url, '/api/skills?project_code=P&view=shared'); assert.equal(calls[1].url, '/api/skills/S?project_code=P');
    assert.equal(calls[2].body.base_revision, 2); assert.deepEqual(calls[3].body.revisions, [1]); assert.equal(calls[3].body.allow_external, false);
    assert.deepEqual(calls[4].body, { revision: 1, alias: 'review', enabled: true, base_generation: 3 });
    assert.equal(calls[5].method, 'DELETE'); assert.equal(calls[5].url, '/api/skills/S/shares/SHARE');
  } finally { globalThis.fetch = previousFetch; }
});

test('platform library defaults to global published packages even with a blocked installation or unusable project target', () => {
  const builtin = { ...skill, scope_type: 'platform', scope_code: 'platform', can_edit: false, can_manage: false, release_version: '1.4.0' };
  const released = { ...builtin, revisions: [{ ...detail.revisions[1], name: 'reverse-project-docs', release_version: '1.4.0' }], shares: [] };
  const entries = [[['skills', 'catalog', 'platform'], [builtin]], [['skills', 'detail', 'platform', '', 'S'], released]];
  const html = render(workbench.SkillsWorkbench, {}, entries);
  for (const text of ['平台内置', '团队与项目自建', '共享给我', '项目采用', 'Published content', '下载技能包（JSON）']) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /新建技能包|修订技能包|发布此版本|共享版本|选择一个有权限的项目或团队后管理技能/);
  assert.doesNotMatch(html, /aria-label="团队范围"|aria-label="项目范围"/);
  const blocked = render(workbench.SkillsWorkbench, { project }, [...entries,
    [['skills', 'installed', 'P'], { ...installations, installations: [{ skill_code: 'S', enabled: false, blocked: true }] }],
  ]);
  assert.match(blocked, /Published content/);
  for (const projectCode of ['invalid!', 'Z'.repeat(20)]) {
    const page = render(agent.AgentWorkspace, { route: { view: 'agent', agentTab: 'skills', projectCode }, user: { code: 'U' } }, [
      ...entries, [['projects', 'agent', 'U'], []], [['teams'], []],
    ]);
    assert.match(page, /Published content/); assert.match(page, /无法访问所选项目/);
  }
});

test('global API calls carry no ambient project query', async () => {
  const previous = globalThis.fetch, calls = [];
  globalThis.fetch = async url => { calls.push(url); return new Response(JSON.stringify({ ok: true, data: [] })); };
  try { await api.listPlatformSkills(); await api.getPlatformSkill('S'); assert.deepEqual(calls, ['/api/skills/platform', '/api/skills/platform/S']); }
  finally { globalThis.fetch = previous; }
});

test('context selector links retain the chosen source or adoption view across the app route remount', () => {
  for (const view of ['owned', 'shared', 'project']) {
    const link = agent.skillLibraryContextPath({ view: 'agent', agentTab: 'skills', projectCode: 'Q', teamCode: 'T' }, view);
    const url = new URL(link, 'https://workspace.example');
    assert.equal(url.searchParams.get('skill_view'), view);
    assert.equal(routing.parseWorkspacePath(link).projectCode, 'Q');
    assert.equal(routing.parseWorkspacePath(link).teamCode, 'T');
  }
});
