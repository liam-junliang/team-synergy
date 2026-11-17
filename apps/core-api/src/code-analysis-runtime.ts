import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DomainError } from '@team-synergy/domain';
import { PublicCodeSchema, validateCodeArtifact, type CodeArtifact, type CodePlugin, type CodeSnapshot } from '@team-synergy/contracts';
import { assertIntakeRegularPath, buildCodeArtifact, captureCodeSnapshot, getCodePlugins, prepareCodePlugins, registerCodePlugin, verifyCodeSnapshot, materializeCodeSemanticAnalysis } from '@team-synergy/integrations';

import { generateHostedUaGraph, SEMANTIC_PROMPT_VERSION, type SemanticProgress } from './code-analysis-semantic.js';
import { semanticDigest } from './code-analysis-semantic-source.js';
import { validateSemanticCacheOriginModels } from './code-analysis-semantic-model.js';
export { generateHostedUaGraph } from './code-analysis-semantic.js';

const exec = promisify(execFile);
const PREFIX = 'TSP_CODE_ANALYSIS_';

export interface HostedAnalysisInput {
  jobCode: string; projectCode: string;
  repository: { code: string; name: string; remote_url: string; default_branch: string | null };
}
export interface HostedAnalysisResult {
  snapshot: CodeSnapshot; artifact: CodeArtifact; plugins: CodePlugin[];
  execution_metadata: Record<string, unknown>;
}
export interface HostedAnalysisOptions { signal?: AbortSignal; onSnapshot?: (snapshot: CodeSnapshot) => Promise<void> | void; onProgress?: (progress: SemanticProgress) => Promise<void> | void }
type Configuration = { root: string; uaRoot: string; cgRoot: string; modelUrl: string; model: string; cacheOriginModels: string[]; apiKey: string; gitToken: string; gitProxy: string; hosts: string[]; repositories: string[]; allowHttp: boolean; concurrency: number };
const fail = (code: string, message: string): never => { throw new DomainError(code, message); };
const stopped = (signal?: AbortSignal) => { if (signal?.aborted) fail('code_analysis_cancelled', '服务端分析已中止'); };
function secret(env: NodeJS.ProcessEnv, name: string): string {
  const file = env[PREFIX + name + '_FILE'];
  const value = (file ? readFileSync(file, 'utf8') : env[PREFIX + name] ?? '').trim();
  if (value.length > 8192 || /[\r\n\0]/.test(value)) fail('code_analysis_not_configured', '服务端分析凭证配置无效');
  return value;
}
function configuration(env: NodeJS.ProcessEnv): Configuration {
  const value = (name: string) => env[PREFIX + name]?.trim() ?? '';
  const root = value('ROOT'), uaRoot = value('UA_ROOT'), cgRoot = value('CODEGRAPH_ROOT');
  if (value('ENABLED') !== '1' || ![root, uaRoot, cgRoot].every(p => p && path.isAbsolute(p))) fail('code_analysis_not_configured', '服务端分析未启用或引擎配置不完整');
  for (const directory of [root, uaRoot, cgRoot]) assertIntakeRegularPath(directory);
  const endpoint = new URL(value('MODEL_URL'));
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !(endpoint.protocol === 'https:' || endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))) fail('code_analysis_not_configured', '模型地址必须是 HTTPS 或服务端回环地址');
  const model = value('MODEL');
  if (!model || model.length > 200 || /[\r\n\0]/.test(model)) fail('code_analysis_not_configured', '未配置服务端分析模型');
  const cacheOriginModels = validateSemanticCacheOriginModels(value('CACHE_ORIGIN_MODELS').split(',').map(model => model.trim()).filter(Boolean), model);
  const hosts = value('GIT_ALLOWED_HOSTS').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  if (!hosts.length || hosts.some(host => !/^[a-z0-9.-]+$/.test(host))) fail('code_analysis_not_configured', '须显式配置允许拉取的 Git 主机');
  const gitToken = secret(env, 'GIT_TOKEN'), allowHttp = value('ALLOW_HTTP') === '1';
  const repositories = value('GIT_ALLOWED_REPOSITORIES').split(',').map(s => s.trim()).filter(Boolean).map(remote => validateHostedGitSource(remote, 'main', hosts, allowHttp).href);
  if (gitToken && !repositories.length) fail('code_analysis_not_configured', '使用服务端仓库凭证时须明确允许的仓库地址');
  const gitProxy = validateHostedGitProxy(value('GIT_PROXY'));
  const concurrency = Number(value('CONCURRENCY') || '3');
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 4) fail('code_analysis_not_configured', '语义并发数必须为1至4');
  return { root: path.resolve(root), uaRoot, cgRoot, modelUrl: endpoint.href.replace(/\/+$/, ''), model, cacheOriginModels, apiKey: secret(env, 'API_KEY'), gitToken, gitProxy, hosts, repositories, allowHttp, concurrency };
}

/** An optional administrator-owned transport setting, never inherited from a member's environment. */
export function validateHostedGitProxy(value: string): string {
  if (!value) return '';
  let url: URL;
  try { url = new URL(value); } catch { return fail('code_analysis_not_configured', '服务端 Git 代理地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || /[\r\n\0]/.test(value)) fail('code_analysis_not_configured', '服务端 Git 代理须是无凭证、查询或片段的 HTTP/HTTPS 地址');
  return url.href;
}

/** This is a second, server-network boundary beyond the project's logical repository registration. */
export function validateHostedGitSource(remote: string, branch: string | null, hosts: string[], allowHttp = false): URL {
  let url: URL;
  try { url = new URL(remote); } catch { return fail('code_analysis_source_invalid', '托管分析需要已登记的 HTTPS Git 仓库'); }
  const loopbackHttp = allowHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!(url.protocol === 'https:' || loopbackHttp) || !hosts.includes(url.hostname.toLowerCase()) || url.username || url.password || url.search || url.hash || !url.pathname || url.pathname === '/' || /[\r\n\0]/.test(remote)) fail('code_analysis_source_invalid', '仓库地址不在服务端允许的 HTTPS Git 来源范围');
  if (!branch || branch.length > 250 || ['~', '^', ':', '?', '*', '[', '\\'].some(character => branch.includes(character)) || Array.from(branch).some(character => /\s/.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || branch.includes('..') || branch.includes('@{') || branch.includes('//') || branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.') || branch.split('/').some(s => s.startsWith('.') || s.endsWith('.lock'))) fail('code_analysis_source_invalid', '仓库需要一条有效的主分支');
  return url;
}

/** No developer home, Git configuration, DB/platform token, hooks or credential helpers. */
export function hostedGitEnvironment(parent: NodeJS.ProcessEnv, home: string, configuredProxy = ''): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'LANG']) if (parent[key]) env[key] = parent[key];
  const proxy = validateHostedGitProxy(configuredProxy);
  if (proxy) Object.assign(env, { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy });
  return { ...env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_CONFIG_HOME: home, TMP: home, TEMP: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1' };
}

async function git(args: string[], cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  stopped(signal);
  try {
    const output = await exec('git', ['--no-replace-objects', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'credential.helper=', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', `protocol.http.allow=${env.TSP_GIT_TEST_HTTP === '1' ? 'always' : 'never'}`, '-c', 'http.followRedirects=false', ...args], { cwd, env, signal, timeout: 180_000, maxBuffer: 1024 * 1024, windowsHide: true });
    return output.stdout.trim();
  } catch { stopped(signal); return fail('code_analysis_git_failed', '无法拉取已登记仓库的主分支，请检查服务端网络、分支与仓库凭证'); }
}

export function createCodeAnalysisRuntime(env: NodeJS.ProcessEnv = process.env) {
  let config: Configuration | null = null, plugins: CodePlugin[] = [], message = '服务端托管分析未配置';
  try {
    config = configuration(env);
    mkdirSync(config.root, { recursive: true });
    const registry = path.join(config.root, 'engines');
    plugins = [registerCodePlugin(registry, 'ua', config.uaRoot), registerCodePlugin(registry, 'codegraph', config.cgRoot)];
    message = '服务端 Git 主线分析可用';
  } catch { config = null; }
  return {
    status: () => ({ configured: config !== null, plugins, model: config?.model ?? '', message }),
    async execute(input: HostedAnalysisInput, options: HostedAnalysisOptions = {}): Promise<HostedAnalysisResult> {
      if (!config) return fail('code_analysis_not_configured', '服务端托管分析未配置');
      const settings = config;
      for (const value of [input.jobCode, input.projectCode, input.repository.code]) PublicCodeSchema.parse(value);
      const remote = validateHostedGitSource(input.repository.remote_url, input.repository.default_branch, settings.hosts, settings.allowHttp);
      if (settings.repositories.length && !settings.repositories.includes(remote.href)) fail('code_analysis_source_invalid', '仓库未获得服务端分析授权');
      const registry = path.join(settings.root, 'engines');
      const locked = getCodePlugins(registry);
      if (JSON.stringify(locked) !== JSON.stringify(plugins)) fail('code_plugin_changed', '服务端引擎版本发生变化，请重启分析 Worker');
      const parent = path.join(settings.root, 'projects', input.projectCode, input.repository.code);
      assertIntakeRegularPath(parent); mkdirSync(parent, { recursive: true });
      const runDirectory = mkdtempSync(path.join(parent, `${input.jobCode}-`));
      const home = path.join(runDirectory, 'git-home'), bare = path.join(runDirectory, 'repo.git'), sourceDirectory = path.join(runDirectory, 'source');
      mkdirSync(home); mkdirSync(bare);
      const gitEnv = hostedGitEnvironment(env, home, settings.gitProxy);
      if (settings.allowHttp) gitEnv.TSP_GIT_TEST_HTTP = '1';
      if (settings.gitToken) Object.assign(gitEnv, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${remote.origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${settings.gitToken}`).toString('base64')}` });
      await git(['init', '--bare', '--template=', '--initial-branch=mainline', '.'], bare, gitEnv, options.signal);
      await git(['fetch', '--depth=1', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', remote.href, `+refs/heads/${input.repository.default_branch}:refs/heads/mainline`], bare, gitEnv, options.signal);
      const commit = await git(['rev-parse', '--verify', 'refs/heads/mainline^{commit}'], bare, gitEnv, options.signal);
      if (!/^[a-f0-9]{40,64}$/.test(commit)) fail('code_analysis_git_failed', 'Git 主线未解析到有效提交');
      const snapshot = captureCodeSnapshot(bare, sourceDirectory, { repositoryCode: input.repository.code, kind: 'commit', ref: commit, gitEnvironment: gitEnv });
      writeFileSync(path.join(runDirectory, 'snapshot.json'), JSON.stringify(snapshot));
      await options.onSnapshot?.(snapshot); stopped(options.signal);
      const pluginInput = { workspace: registry, runDirectory, sourceDirectory, snapshot, signal: options.signal };
      const prepared = await prepareCodePlugins(pluginInput);
      if (JSON.stringify(prepared.plugins) !== JSON.stringify(locked)) fail('code_plugin_changed', '分析引擎锁与任务不一致');
      const semantic = await generateHostedUaGraph({ snapshot, sourceDirectory, runDirectory, repositoryName: input.repository.name, config: settings, signal: options.signal, engineIdentity: semanticDigest(locked), cacheDirectory: path.join(settings.root, 'semantic-cache', input.projectCode, input.repository.code), onProgress: options.onProgress });
      writeFileSync(path.join(runDirectory, 'ua-graph.json'), JSON.stringify(semantic.graph));
      verifyCodeSnapshot(sourceDirectory, snapshot); stopped(options.signal);
      const artifact = materializeCodeSemanticAnalysis(await buildCodeArtifact({ ...pluginInput, uaGraph: semantic.graph }), snapshot, semantic.quality, semantic.plan);
      artifact.semantic_author = { kind: 'agent', model: settings.model, prompt_version: SEMANTIC_PROMPT_VERSION, provenance: semantic.modelProvenance };
      artifact.coverage.find(item => item.provider === 'ua')?.limitations.push('All safe snapshot bytes were sent in verified segments; semantic interpretations and static dependencies still require independent evaluation.');
      artifact.coverage.find(item => item.provider === 'ua')?.limitations.push(...semantic.quality.overview_limitations);
      const issues = validateCodeArtifact(artifact, snapshot);
      if (issues.length) fail('code_analysis_artifact_invalid', '分析结果未通过来源与图契约校验');
      const execution_metadata = { runner: 'server_git', branch: input.repository.default_branch, commit, snapshot_id: snapshot.snapshot_id, semantic_prompt_version: SEMANTIC_PROMPT_VERSION, requested_model: settings.model, response_models: [...new Set(semantic.models)], model_provenance: semantic.modelProvenance, cache_origin_models: settings.cacheOriginModels, semantic_files: semantic.selectedFiles.length, semantic_segments: semantic.quality.total_segments, semantic_bytes: semantic.quality.covered_bytes, semantic_report_sha256: semanticDigest(semantic.quality), semantic_full_coverage: true, captured_files: snapshot.files.length, plugins: locked };
      writeFileSync(path.join(runDirectory, 'artifact.json'), JSON.stringify(artifact));
      writeFileSync(path.join(runDirectory, 'execution.json'), JSON.stringify(execution_metadata));
      return { snapshot, artifact, plugins: locked, execution_metadata };
    },
  };
}
