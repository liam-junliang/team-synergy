import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodeAnalysisRuntime, hostedGitEnvironment, validateHostedGitSource, validateHostedGitProxy } from '../dist/code-analysis-runtime.js';

test('hosted Git accepts only configured network hosts and a single valid branch', () => {
  assert.equal(validateHostedGitSource('https://github.com/team/repo.git', 'release/main', ['github.com']).hostname, 'github.com');
  for (const remote of ['F:/member/repo', '/tmp/repo', 'file:///repo', '\\\\member\\repo', 'ext::sh anything', 'git@github.com:team/repo.git', 'ssh://git@github.com/team/repo.git', 'https://user:secret@github.com/repo.git', 'https://unregistered.example/repo.git', 'http://github.com/team/repo.git', 'https://github.com/repo.git?token=secret', 'https://github.com/repo.git#ref']) {
    assert.throws(() => validateHostedGitSource(remote, 'main', ['github.com']), { code: 'code_analysis_source_invalid' }, remote);
  }
  for (const branch of [null, '', '--upload-pack=bad', '../main', 'a//b', '/main', 'main/', 'a..b', 'main.lock', '.hidden', 'a@{b}', 'main:other', 'feature\\main', 'main\nother', 'branch^{}']) {
    assert.throws(() => validateHostedGitSource('https://github.com/team/repo.git', branch, ['github.com']), { code: 'code_analysis_source_invalid' }, String(branch));
  }
  assert.throws(() => validateHostedGitSource('http://127.0.0.1/repo.git', 'main', ['127.0.0.1']), { code: 'code_analysis_source_invalid' });
  assert.equal(validateHostedGitSource('http://127.0.0.1/repo.git', 'main', ['127.0.0.1'], true).protocol, 'http:');
});

test('Git replacement environment excludes local and platform configuration and runtime stays disabled without explicit setup', async () => {
  const environment = hostedGitEnvironment({ PATH: 'test-path', TSP_DATABASE_URL: 'private-db', GITHUB_TOKEN: 'member-token', GIT_CONFIG_COUNT: '42', GIT_SSH_COMMAND: 'bad', NODE_OPTIONS: 'bad', HOME: 'member-home' }, 'runner-private-home');
  assert.equal(environment.HOME, 'runner-private-home');
  assert.equal(environment.GIT_CONFIG_NOSYSTEM, '1');
  for (const key of ['TSP_DATABASE_URL', 'GITHUB_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_SSH_COMMAND', 'NODE_OPTIONS']) assert.equal(environment[key], undefined);
  const runtime = createCodeAnalysisRuntime({ TSP_CODE_ANALYSIS_API_KEY: 'private-token' });
  assert.deepEqual(runtime.status(), { configured: false, plugins: [], model: '', message: '服务端托管分析未配置' });
  await assert.rejects(runtime.execute({}), { code: 'code_analysis_not_configured' });
});

test('Git proxy is accepted only from explicit server configuration and never inherited', () => {
  const parent = { HTTP_PROXY: 'http://member-proxy.invalid', HTTPS_PROXY: 'http://member-proxy.invalid', http_proxy: 'http://member-proxy.invalid', https_proxy: 'http://member-proxy.invalid', ALL_PROXY: 'socks5://member.invalid', NO_PROXY: '*' };
  const without = hostedGitEnvironment(parent, 'runner-home');
  for (const key of Object.keys(parent)) assert.equal(without[key], undefined);
  const configured = hostedGitEnvironment(parent, 'runner-home', 'http://127.0.0.1:7890');
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) assert.equal(configured[key], 'http://127.0.0.1:7890/');
  assert.equal(configured.ALL_PROXY, undefined); assert.equal(configured.NO_PROXY, undefined);
  assert.equal(validateHostedGitProxy('https://proxy.example:8443'), 'https://proxy.example:8443/');
  for (const value of ['relative-proxy', 'file:///proxy', 'socks5://127.0.0.1:1080', 'http://user:password@127.0.0.1:7890', 'http://127.0.0.1:7890?secret=value', 'http://127.0.0.1:7890#fragment', 'http://127.0.0.1:7890\n']) assert.throws(() => validateHostedGitProxy(value), { code: 'code_analysis_not_configured' });
});

