import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractMemoryParts } from '../dist/memory-extraction.js';

const classifier = items => async () => Response.json({message:{content:JSON.stringify({items})}});
const rejectModel = async () => { throw Error('model should not run'); };

test('mixed messages retain complete original clauses; the server domain owns account applicability', async () => {
  const discussion = '我建议退款超过七天进入人工审核。';
  const style = '这个项目我习惯用中文写 Git 提交说明。';
  assert.deepEqual(await extractMemoryParts(discussion+style,classifier([{id:1,label:'preference'},{id:0,label:'discussion'}])),[
    {kind:'discussion',text:discussion},{kind:'preference',text:style},
  ]);
  const account = '在所有项目中我习惯先读摘要。';
  assert.deepEqual(await extractMemoryParts(account,classifier([{id:0,label:'preference'}])),
    [{kind:'preference',text:account}]);
});

test('only an entire explicit user adoption bypasses classification', async () => {
  assert.deepEqual(await extractMemoryParts('就按这个方案做。',rejectModel), [{kind:'adopt',text:'就按这个方案做。'}]);
  assert.deepEqual(await extractMemoryParts('确认采纳：退款转人工审核。',rejectModel), [{kind:'adopt',text:'确认采纳：退款转人工审核。'}]);
  for (const text of ['他说“就按这个方案做”。','我建议退款转人工审核。先不要公开。','我建议退款转人工审核。当我没说。']) {
    await assert.rejects(extractMemoryParts(text,rejectModel),{code:'memory_needs_clarification'});
  }
  await assert.rejects(extractMemoryParts('就按这个方案做？',classifier([{id:0,label:'discussion'}])),{code:'memory_needs_clarification'});
});

test('model labels cannot publish a personal or one-time action, or invent source evidence',async () => {
  for (const text of ['我建议退款检查我的私人邮箱。','我建议这次修复后直接推送。','我建议把我的住址加入议题。',
    '我建议退款超过七天进入人工审核并用本人的银行卡号6222020000000000作为测试。','我建议退款超过七天进入人工审核并用测试口令TRIAL672验证。']) {
    await assert.rejects(extractMemoryParts(text,classifier([{id:0,label:'discussion'}])),{code:'memory_needs_clarification'});
  }
  await assert.rejects(extractMemoryParts('本次修复后推送。',classifier([{id:0,label:'transient'}])),{code:'memory_no_material'});
  await assert.rejects(extractMemoryParts('我建议修改退款。这个项目我习惯先讨论。',
    classifier([{id:0,label:'discussion'},{id:0,label:'preference'}])),{code:'memory_needs_clarification'});
  await assert.rejects(extractMemoryParts('我建议修改退款。',async()=>Response.json({}, {status:503})),{code:'memory_model_unavailable'});
});

test('OpenAI-compatible extraction uses server configuration and retains strict source validation', async t => {
  const keys = ['TSP_MEMORY_PROVIDER','TSP_MEMORY_BASE_URL','TSP_MEMORY_MODEL','TSP_MEMORY_API_KEY'];
  const old = Object.fromEntries(keys.map(key => [key,process.env[key]]));
  t.after(() => { for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  Object.assign(process.env,{ TSP_MEMORY_PROVIDER:'openai', TSP_MEMORY_BASE_URL:'http://127.0.0.1:23456/v1',
    TSP_MEMORY_MODEL:'workbuddy/deepseek-v4.1-flash', TSP_MEMORY_API_KEY:'LOCAL_TEST_ONLY' });
  const text = '我习惯先读项目摘要。';
  const calls = [];
  const fetchImpl = async (url,init) => {
    calls.push({url,body:JSON.parse(init.body),headers:init.headers});
    return Response.json({choices:[{message:{content:JSON.stringify({items:[{id:0,label:'preference'}]})}}]});
  };
  assert.deepEqual(await extractMemoryParts(text,fetchImpl),[{kind:'preference',text}]);
  assert.equal(calls[0].url,'http://127.0.0.1:23456/v1/chat/completions');
  assert.equal(calls[0].body.model,'workbuddy/deepseek-v4.1-flash');
  assert.equal(calls[0].body.response_format.type,'json_object');
  assert.equal(calls[0].headers.authorization,'Bearer LOCAL_TEST_ONLY');
  assert.ok(!JSON.stringify(calls[0].body).includes('LOCAL_TEST_ONLY'));
  process.env.TSP_MEMORY_BASE_URL='http://user:password@localhost/v1';
  await assert.rejects(extractMemoryParts(text,fetchImpl),{code:'memory_model_unavailable'});
  assert.equal(calls.length,1);
});
