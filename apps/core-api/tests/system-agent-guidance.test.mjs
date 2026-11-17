import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSystemAgentSkill } from '../scripts/bundle-system-agent-skill.mjs';
import { loadSystemAgentGuidance, SYSTEM_AGENT_GUIDANCE_MAX_CHARACTERS, SYSTEM_AGENT_GUIDANCE_MAX_SERIALIZED_BYTES } from '../dist/system-agent-guidance.js';
import { createSystemAgentRuntime } from '../dist/system-agent-runtime.js';

const skillRoot = new URL('../../../skills/spec-production/', import.meta.url);
const hash = value => createHash('sha256').update(value).digest('hex');

function fixture(t, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'team-synergy-skill-'));
  t.after(() => {
    const target = path.resolve(root), relative = path.relative(path.resolve(tmpdir()), target);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.basename(target).startsWith('team-synergy-skill-'));
    rmSync(target, { recursive: true, force: true });
  });
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

test('the distributed specification skill includes its code-rule analysis and review references', () => {
  const { guidance } = loadSystemAgentGuidance();
  for (const name of ['business-rules.md', 'inventory.md', 'evaluation.md', 'evaluation.schema.json', 'increments.md', 'method-sources.md']) {
    assert.ok(guidance.includes(`--- references/${name} ---`), `Missing readable Skill reference: ${name}`);
  }
});

test('the real Skill keeps inventory and bounded-module methods available without changing its source or version', () => {
  const bundle = buildSystemAgentSkill();
  assert.deepEqual(loadSystemAgentGuidance(), bundle);
  for (const name of ['SKILL.md', 'references/inventory.md', 'references/business-rules.md', 'references/scope.md']) {
    const text = readFileSync(new URL(name, skillRoot), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(bundle.guidance.includes(`--- ${name} ---\n${text}`), `Reference is incomplete: ${name}`);
  }
  assert.match(bundle.guidance, /analyze each module in turn/);
  assert.match(bundle.guidance, /Choose a bounded module or scenario/);
  assert.match(bundle.guidance, /Navigate with UA, locate with codegraph, confirm in source/);
  assert.match(bundle.guidance, /implementation defects are not automatically desired requirements/);
  assert.match(bundle.guidance, /Planned checks are not executed tests/);
  assert.match(bundle.guidance, /do not submit, approve or apply project changes/);
  const legacy = ['SKILL.md', 'references/scope.md', 'references/specification.md'].map(name => `--- ${name} ---\n${readFileSync(new URL(name, skillRoot), 'utf8').replace(/\r\n/g, '\n')}`).join('\n\n');
  assert.ok(bundle.guidance.length > legacy.length, 'New reference content must actually be distributed');
  assert.ok(bundle.guidance.length <= SYSTEM_AGENT_GUIDANCE_MAX_CHARACTERS);
  assert.ok(Buffer.byteLength(JSON.stringify(bundle.guidance)) <= SYSTEM_AGENT_GUIDANCE_MAX_SERIALIZED_BYTES);
});

test('reference traversal resolves nested relative links and anchors, deduplicates cycles and ignores unrelated files', t => {
  const root = fixture(t, {
    'SKILL.md': '---\nmetadata:\n  version: fixture\n---\n[A](references/a.md#heading)\n[Website](https://example.com/reference.md)',
    'references/a.md': '[Root](../SKILL.md)\n[B](b.md#heading)',
    'references/b.md': '[A](a.md)\nUnique fixture rules.',
    'references/unrelated.md': 'Do not distribute unreferenced fixture text.',
  });
  const bundle = buildSystemAgentSkill(root);
  assert.equal(bundle.version, 'fixture');
  assert.equal(bundle.sha256, hash(bundle.guidance));
  assert.deepEqual([...bundle.guidance.matchAll(/^--- (.+) ---$/gm)].map(match => match[1]), ['SKILL.md', 'references/a.md', 'references/b.md']);
  assert.match(bundle.guidance, /Unique fixture rules/);
  assert.doesNotMatch(bundle.guidance, /Do not distribute/);
});

test('missing, escaping and unsupported references fail the build instead of silently omitting instructions', t => {
  for (const target of ['references/missing.md', '../outside.md', '/references/a.md', 'references/../../outside.md', 'file:///outside.md', 'references/a\\b.md']) {
    const root = fixture(t, { 'SKILL.md': `---\n  version: fixture\n---\n[Required](${target})` });
    assert.throws(() => buildSystemAgentSkill(root), /ENOENT|Unsupported Skill reference/);
  }
});

test('a linked reference directory cannot substitute a different local source tree', t => {
  const root = fixture(t, {
    'SKILL.md': '---\n  version: fixture\n---\n[Required](references/rules.md)',
    'actual/rules.md': 'Linked fixture rules.',
  });
  symlinkSync(path.join(root, 'actual'), path.join(root, 'references'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => buildSystemAgentSkill(root), /must not use links/);
});

test('both build and loader reject character or serialized-byte overflow and the loader rejects tampering', t => {
  const root = fixture(t, { 'SKILL.md': '---\n  version: fixture\n---\n' });
  const file = path.join(root, 'bundle.json');
  const initial = buildSystemAgentSkill(root);
  writeFileSync(file, JSON.stringify(initial));
  assert.deepEqual(loadSystemAgentGuidance(pathToFileURL(file)), initial);
  writeFileSync(file, JSON.stringify({ ...initial, guidance: initial.guidance + 'tampered' }));
  assert.throws(() => loadSystemAgentGuidance(pathToFileURL(file)), /Skill 包无效/);
  for (const text of ['x'.repeat(SYSTEM_AGENT_GUIDANCE_MAX_CHARACTERS + 1), '中'.repeat(Math.floor(SYSTEM_AGENT_GUIDANCE_MAX_SERIALIZED_BYTES / 3) + 1)]) {
    writeFileSync(path.join(root, 'SKILL.md'), `---\n  version: fixture\n---\n${text}`);
    assert.throws(() => buildSystemAgentSkill(root), /bounded context limit/);
    writeFileSync(file, JSON.stringify({ version: 'fixture', guidance: text, sha256: hash(text) }));
    assert.throws(() => loadSystemAgentGuidance(pathToFileURL(file)), /Skill 包无效/);
  }
});

test('the full reference package reaches the restricted drafting runtime using only a local protocol fixture', async t => {
  const bundle = buildSystemAgentSkill();
  const proposal = { title: 'Fixture draft', summary: 'Fixture', content: '# Fixture', rationale: 'Protocol only', evidence: ['document:DOC1@1'], warnings: ['No model or semantic analysis was run.'] };
  const root = fixture(t, {
    'install/package.json': JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-rc.2' }),
    'install/lib/bin.js': `const rl=require('node:readline').createInterface({input:process.stdin});
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
rl.on('line',line=>{const r=JSON.parse(line);if(r.method==='shutdown'){rl.close();return;}
if(r.method==='initialize'){send({jsonrpc:'2.0',id:r.id,result:{serverInfo:{name:'deepseek-harness-sdk-runtime'}}});return;}
if(r.method!=='session/prompt')return;
const p=JSON.parse(r.params.contentBlocks[0].text);if(${JSON.stringify(bundle.sha256)}!==require('node:crypto').createHash('sha256').update(p.platform_skill_guidance).digest('hex'))process.exit(10);
send({jsonrpc:'2.0',id:r.id,result:{messageId:'m1'}});const sessionId=r.params.sessionId;
for(const [type,data] of [['agent/inbox/spliced',{inserted:[{id:'m1'}]}],['assistant/message',{message:{content:[{type:'text',text:${JSON.stringify(JSON.stringify(proposal))}}]}}],['turn/end',{reason:{kind:'completed'}}]])send({jsonrpc:'2.0',method:'session.event',params:{sessionId,event:{type,data}}});
send({jsonrpc:'2.0',method:'session.status',params:{sessionId,status:'idle'}});});`,
  });
  const runtime = createSystemAgentRuntime({ TSP_SYSTEM_AGENT_ENABLED: 'true', TSP_SYSTEM_AGENT_DSH_BIN: path.join(root, 'install/lib/bin.js'), TSP_SYSTEM_AGENT_WORKSPACE_ROOT: path.join(root, 'work'), TSP_SYSTEM_AGENT_API_KEY: 'test-only-key', TSP_SYSTEM_AGENT_TIMEOUT_MS: '3000' });
  const actual = await runtime.generate({ jobCode: 'JOB1', document: { code: 'DOC1', revision: 1, title: 'Fixture', content: '# Original' }, instruction: 'Produce a draft.', guidance: bundle.guidance });
  assert.deepEqual(actual, proposal);
});
