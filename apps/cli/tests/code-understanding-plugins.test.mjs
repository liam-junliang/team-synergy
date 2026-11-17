import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureCodeSnapshot } from '../dist/code-understanding-snapshot.js';
import { validateCodeArtifact } from '../../../packages/contracts/dist/index.js';
import { registerCodePlugin, describeCodePlugins, getCodePlugins, prepareCodePlugins, buildCodeArtifact, queryCodePlugin, verifyCodeRunPlugins } from '../dist/code-understanding-plugins.js';

test('plugin registry reports missing engines and rejects untested versions without activation', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'tsp-plugins-'));
  assert.deepEqual(describeCodePlugins(root).map(p => p.installed), [false, false]);
  assert.throws(() => getCodePlugins(root), { code: 'code_plugin_missing' });
  mkdirSync(path.join(root, 'future', '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(root, 'future', '.claude-plugin', 'plugin.json'), JSON.stringify({ version: '99.0.0' }));
  assert.throws(() => registerCodePlugin(root, 'ua', path.join(root, 'future')), { code: 'code_plugin_incompatible' });
  assert.equal(describeCodePlugins(root)[0].installed, false);
});

test('real pinned engines scan, index, validate semantics, bridge and query without mutating index', { skip: !process.env.TSP_TEST_UA_ROOT || !process.env.TSP_TEST_CODEGRAPH_ROOT, timeout: 180000 }, async () => {
  const fixtures = path.resolve('tmp', 'native-code-understanding'); mkdirSync(fixtures, { recursive: true });
  const root = mkdtempSync(path.join(fixtures, 'fixture-'));
  const repo = path.join(root, 'repo'); mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, 'src', 'auth.ts'), 'export function greet(name: string) {\n  const greeting = "Hello " + name;\n  return greeting;\n}\n\nexport function login() {\n  return greet("world");\n}\n');
  writeFileSync(path.join(repo, 'README.md'), '# Fixture\n\nGreeting and login.\n');
  writeFileSync(path.join(repo, 'src', 'location.ts'), 'export const localDirectory = "/home/fixture/private";\n\nexport function location() {\n  return localDirectory;\n}\n');
  const git = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true, stdio: 'pipe' });
  git('init'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');
  const runDirectory = path.join(root, 'run'), sourceDirectory = path.join(runDirectory, 'source');
  mkdirSync(runDirectory);
  const snapshot = captureCodeSnapshot(repo, sourceDirectory, { repositoryCode: 'R'.repeat(20), kind: 'commit' });
  registerCodePlugin(root, 'ua', process.env.TSP_TEST_UA_ROOT);
  registerCodePlugin(root, 'codegraph', process.env.TSP_TEST_CODEGRAPH_ROOT);
  const input = { workspace: root, runDirectory, sourceDirectory, snapshot };
  const prepared = await prepareCodePlugins(input);
  assert.equal(prepared.plugins.length, 2);
  assert.ok(prepared.codegraphArtifact.nodes.some(node => node.label === 'greet'));
  assert.ok(readFileSync(prepared.materials.ua_instructions, 'utf8').includes(snapshot.snapshot_id));
  const uaGraph = { version: '1.0.0', project: { name: 'Fixture', description: 'Greeting', languages: ['TypeScript'], frameworks: [], analyzedAt: new Date().toISOString(), gitCommitHash: snapshot.commit },
    nodes: [{ id: 'auth', type: 'module', name: 'Authentication', summary: 'Example login delegates to greeting; not real authentication.', tags: ['greeting', 'fixture'], complexity: 'moderate', domainMeta: { entities: ['Greeting'], businessRules: ['The example login greets world.'], userPurposes: ['Understand the greeting entry point.'], unknowns: ['Runtime behavior has not been executed.'], entryType: 'manual' }, rawLocalOnly: 'never published' }, { id: 'file:auth', type: 'file', name: 'auth.ts', filePath: 'src/auth.ts', summary: 'Declares greeting and login wrapper.', tags: [], complexity: 'simple' }],
    edges: [{ source: 'auth', target: 'file:auth', type: 'contains', direction: 'forward', weight: 1 }], layers: [{ id: 'application', name: 'Application', description: 'Fixture layer', nodeIds: ['auth', 'file:auth'] }], tour: [{ order: 1, title: 'Greeting', description: 'Start at login and follow greet.', nodeIds: ['auth'] }] };
  const artifact = await buildCodeArtifact({ ...input, uaGraph });
  assert.ok(artifact.edges.some(edge => edge.provider === 'bridge'));
  assert.equal(artifact.coverage.length, 2);
  assert.ok(!JSON.stringify(artifact).includes(root));
  assert.ok(artifact.evidence.some(item => item.snippet));
  assert.ok(!artifact.evidence.some(item => item.snippet?.includes('/home/fixture/private')));
  assert.deepEqual(validateCodeArtifact(artifact, snapshot), []);
  assert.deepEqual(artifact.ua_graph.nodes[0].tags, ['greeting', 'fixture']);
  assert.equal(artifact.ua_graph.nodes[0].complexity, 'moderate');
  assert.equal('rawLocalOnly' in artifact.ua_graph.nodes[0], false);
  assert.deepEqual(artifact.ua_graph.nodes[0].domainMeta, uaGraph.nodes[0].domainMeta);
  assert.equal(artifact.ua_graph.layers[0].description, 'Fixture layer');
  assert.deepEqual(artifact.ua_graph.project, uaGraph.project);
  const source = readFileSync(path.join(sourceDirectory, 'README.md'), 'utf8').trim();
  for (const unsafeGraph of [
    { ...uaGraph, project: { ...uaGraph.project, description: source } },
    { ...uaGraph, nodes: [{ ...uaGraph.nodes[0], tags: [source] }, uaGraph.nodes[1]] },
    { ...uaGraph, nodes: [{ ...uaGraph.nodes[0], domainMeta: { businessRules: [source] } }, uaGraph.nodes[1]] },
    { ...uaGraph, nodes: [{ ...uaGraph.nodes[0], domainMeta: { userPurposes: [source] } }, uaGraph.nodes[1]] },
    { ...uaGraph, nodes: [{ ...uaGraph.nodes[0], domainMeta: { unknowns: [source] } }, uaGraph.nodes[1]] },
  ]) await assert.rejects(buildCodeArtifact({ ...input, uaGraph: unsafeGraph }), { code: 'code_source_in_prose' });
  await assert.rejects(buildCodeArtifact({ ...input, uaGraph: { ...uaGraph, nodes: [{ ...uaGraph.nodes[0], domainMeta: { crossDomainInteractions: ['F:/private/customer'] } }, uaGraph.nodes[1]] } }), { code: 'code_graph_sensitive' });
  const native = artifact.nodes.find(node => node.provider === 'codegraph' && node.label === 'greet');
  const before = readFileSync(path.join(sourceDirectory, '.codegraph', 'codegraph.db'));
  const query = await queryCodePlugin({ ...input, command: 'callers', nodeId: native.id });
  assert.equal(query.source, 'local_native');
  assert.ok(JSON.stringify(query.data).includes('login'));
  assert.deepEqual(readFileSync(path.join(sourceDirectory, '.codegraph', 'codegraph.db')), before);
  await assert.rejects(buildCodeArtifact({ ...input, uaGraph: { ...uaGraph, project: { ...uaGraph.project, gitCommitHash: 'a'.repeat(40) } } }), { code: 'code_snapshot_mismatch' });
  assert.equal(verifyCodeRunPlugins(input).length, 2);
  console.log(JSON.stringify({ native_fixture: root, ua_nodes: artifact.nodes.filter(n => n.provider === 'ua').length, cg_nodes: prepared.codegraphArtifact.nodes.length, bridges: artifact.edges.filter(e => e.provider === 'bridge').length }));
});
