import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createServer } from 'vite';

let vite;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    server: { middlewareMode: true, hmr: false },
  });
});

after(async () => {
  await vite?.close();
});

test('缺陷工作台默认展示可按键打开的表格，旧记录和修复操作保留在详情中', async () => {
  const { DefectsWorkbench, DefectDetail } = await vite.ssrLoadModule('/src/DefectsWorkbench.tsx');
  const projectCode = 'PROJECT-A';
  const client = new QueryClient();
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'owner', status: 'active' });
  client.setQueryData(['defects', projectCode], [{
    code: 'DEFECT-1',
    feature_code: 'FEATURE-1',
    title: '登录后项目看板空白',
    severity: 'high',
    status: 'fixing',
    reported_by: 'USER-1',
    description: '复现步骤：登录后进入项目。\n实际结果：页面空白。\n预期结果：显示任务看板。',
    found_in: 'v0.3.1 · Chrome',
    related_requirement_code: 'REQ-1',
    reported_at: '2026-08-17T08:00:00.000Z',
    fix_tasks: [{ task_code: 'TASK-1', title: '修复项目看板初始化', status: 'verified', assignee_principal_code: 'USER-2', created_at: '2026-08-17T08:30:00.000Z' }],
  }]);
  client.setQueryData(['features', projectCode], [{ code: 'FEATURE-1', project_code: projectCode, title: '任务看板', goal: null, status: 'active', module_code: null, module_name: null, milestone_code: null, milestone_name: null, start_at: null, end_at: null }]);
  client.setQueryData(['requirements', projectCode], [{ code: 'REQ-1', feature_code: 'FEATURE-1', module_code: null, module_name: null, document_code: null, title: '登录后查看任务', current_revision: 1, owner_code: 'USER-1', status: 'confirmed', summary: '', body: '', acceptance_criteria: [], open_questions: [], keywords: [], task_count: 1 }]);
  client.setQueryData(['members', projectCode], [{ code: 'USER-1', role: 'owner', display_name: 'Liam' }, { code: 'USER-2', role: 'member', display_name: '王构建' }]);
  const [original] = client.getQueryData(['defects', projectCode]);
  client.setQueryData(['defects', projectCode], [original, {
    ...original, code: 'DEFECT-2', title: '紧急问题且有三项证据', severity: 'critical',
    evidence: [{ kind: 'text', text: 'error' }, { kind: 'link', url: 'https://example.test/log' }, { kind: 'file', file_name: 'trace.log' }],
  }, { ...original, code: 'DEFECT-CLOSED', title: '已关闭的旧问题', status: 'closed' }]);

  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(DefectsWorkbench, { projectCode })));

  assert.match(html, /<table[^>]*><caption[^>]*>缺陷列表/);
  assert.match(html, /<th scope="row"[^>]*><div[^>]*><button[^>]*aria-haspopup="dialog"/);
  assert.match(html, /证据 0/);
  assert.match(html, /证据 3/);
  assert.ok(html.indexOf('紧急问题且有三项证据') < html.indexOf('登录后项目看板空白'));
  assert.ok(!html.includes('已关闭的旧问题'));
  assert.match(html, /aria-sort="descending"/);
  assert.doesNotMatch(html, /role="dialog"|原始问题描述|进入回归验证/);
  assert.match(html, /搜索标题、描述或版本/);
  assert.match(html, /登录后项目看板空白/);
  const detail = renderToStaticMarkup(createElement(DefectDetail, {
    defect: client.getQueryData(['defects', projectCode])[0], projectCode, canWrite: true, canManage: true,
    memberMap: new Map([['USER-2', '王构建']]), requirementName: '登录后查看任务', reporterName: 'Liam',
  }));
  for (const value of ['复现步骤：登录后进入项目', '原始问题描述', '修复项目看板初始化', '王构建', '打开任务看板', '进入回归验证', '修复任务已完成验证']) assert.ok(detail.includes(value));
  client.setQueryData(['project', projectCode], { code: projectCode, role: 'viewer', status: 'active' });
  const viewer = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(DefectsWorkbench, { projectCode })));
  assert.doesNotMatch(viewer, />报告缺陷<|>进入回归验证<|>创建修复任务</);
  assert.match(viewer, /登录后项目看板空白/);
  client.clear();
});

test('缺陷 API 将 defect_code 写入修复任务并按公开编码流转', async () => {
  const { createDefect, createTask, transitionDefect } = await vite.ssrLoadModule('/src/api.ts');
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    calls.push({ path: String(path), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const data = String(path) === '/api/defects'
      ? { defect_code: 'DEFECT-1', status: 'reported' }
      : String(path) === '/api/tasks'
        ? { task_code: 'TASK-1', status: 'draft', base_snapshot: 0 }
        : { defect_code: 'DEFECT-1', status: init.body && JSON.parse(init.body).to };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    const report = { feature_code: 'FEATURE-1', title: '空白页', severity: 'high', action_steps: '打开项目', expected_result: '看到看板', actual_result: '页面空白', evidence: [{ kind: 'text', text: '初始化超时' }] };
    await createDefect(report);
    await createTask({ feature_code: 'FEATURE-1', defect_code: 'DEFECT-1', title: '修复空白页', brief: '完整上下文', profile: 'builder', source: 'defect-fix', acceptance: [{ id: 'AC-1', text: '回归通过' }] });
    await transitionDefect('DEFECT-1', { to: 'fixing', fix_task_code: 'TASK-1' });

    assert.deepEqual(calls.map((call) => [call.method, call.path]), [['POST', '/api/defects'], ['POST', '/api/tasks'], ['POST', '/api/defects/DEFECT-1/transition']]);
    assert.deepEqual(calls[0].body, report);
    assert.equal(calls[1].body.defect_code, 'DEFECT-1');
    assert.equal(calls[1].body.source, 'defect-fix');
    assert.equal(calls[2].body.fix_task_code, 'TASK-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('缺陷证据保留日志、链接和实际文件字节，拒绝空、无效及超限输入', async () => {
  const { prepareDefectEvidence } = await vite.ssrLoadModule('/src/DefectReport.tsx');
  const bytes = new Uint8Array([0, 5, 255, 128, 42]);
  const file = new File([bytes], 'capture.webm', { type: 'video/webm' });
  const draft = { text: '  ERROR\n    at submit\n', urls: ['https://example.test/t/3'], files: [file] };
  assert.deepEqual(await prepareDefectEvidence(draft), [
    { kind: 'text', text: draft.text }, { kind: 'link', url: draft.urls[0] },
    { kind: 'file', file_name: file.name, mime_type: file.type, content_base64: Buffer.from(bytes).toString('base64') },
  ]);
  await assert.rejects(prepareDefectEvidence({ text: '  ', urls: [], files: [] }), /至少一项/);
  await assert.rejects(prepareDefectEvidence({ ...draft, urls: ['file:///tmp/log'] }), /HTTP\(S\)/);
  await assert.rejects(prepareDefectEvidence({ ...draft, files: [new File([], 'empty.txt')] }), /有内容/);
  await assert.rejects(prepareDefectEvidence({ ...draft, files: [new File([new Uint8Array(6 * 1024 * 1024)], 'full.bin'), file] }), /6 MiB/);
  await assert.rejects(prepareDefectEvidence({ ...draft, urls: Array(19).fill('https://example.test') }), /20 项/);
});

test('报告、分诊和状态提示准确展示中英文管理角色，Admin 可分诊且 Viewer 只读', async () => {
  const { DefectsWorkbench, DefectDetail } = await vite.ssrLoadModule('/src/DefectsWorkbench.tsx');
  const { canProject } = await vite.ssrLoadModule('/src/projectManagement.ts');
  const { ReportDefectDialog } = await vite.ssrLoadModule('/src/DefectReport.tsx');
  const { setLocale, t } = await vite.ssrLoadModule('/src/i18n.ts');
  const client = new QueryClient();
  const code = 'PROJECT-ROLES';
  const feature = { code: 'FEATURE-R', title: '导出' };
  client.setQueryData(['features', code], [feature]);
  client.setQueryData(['defects', code], [{ code: 'DEFECT-R', title: '导出异常', feature_code: feature.code, severity: 'medium', status: 'reported', fix_tasks: [], description: '旧报告' }]);
  client.setQueryData(['requirements', code], []);
  client.setQueryData(['members', code], []);
  const render = (child) => renderToStaticMarkup(createElement(QueryClientProvider, { client }, child));
  function workbench(role) {
    const project = { code, role, status: 'active' };
    client.setQueryData(['project', code], project);
    return render(createElement(DefectsWorkbench, { projectCode: code })) + render(createElement(DefectDetail, {
      defect: client.getQueryData(['defects', code])[0], projectCode: code, memberMap: new Map(), reporterName: 'QA',
      canWrite: canProject(project, 'write'), canManage: canProject(project, 'manage'),
    }));
  }
  try {
    for (const [locale, roles] of [['zh-CN', /项目负责人或管理员/], ['en-US', /project Owner or a project Admin/]]) {
      setLocale(locale, false);
      const dialog = render(createElement(ReportDefectDialog, { features: [feature], requirements: [], onClose() {}, onSubmit() {} }));
      assert.match(dialog, roles);
      const triage = t('确认问题并创建修复任务');
      const admin = workbench('admin');
      assert.ok(admin.includes(triage));
      assert.ok(admin.includes(t('标记为无需处理')));
      const viewer = workbench('viewer');
      assert.match(viewer, roles);
      assert.ok(viewer.includes('旧报告'));
      for (const action of [triage, t('标记为无需处理'), t('提交缺陷')]) assert.ok(!viewer.includes(action));
    }
  } finally {
    setLocale('zh-CN', false);
    client.clear();
  }
});

test('结构化报告在详情和修复任务中显示相同事实，附件按证据原序号下载', async (context) => {
  const { listDefects, getDefectEvidenceFile } = await vite.ssrLoadModule('/src/api.ts');
  const { DefectReportDetails, defectRepairContext } = await vite.ssrLoadModule('/src/DefectReport.tsx');
  const raw = {
    defect_code: 'D1', title: '导出异常', action_steps: '打开报表并导出', expected_result: '收到 CSV',
    actual_result: '下载中断', evidence: [{ kind: 'text', text: 'EPIPE at byte 42' },
      { kind: 'link', url: 'http:example.test/log' }, { kind: 'file', file_name: 'record.webm', mime_type: 'video/webm', size_bytes: 3, sha256: 'abcd' }],
  };
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (path, init) => {
    calls.push({ path, init });
    if (path.endsWith('/file')) return new Response(new Uint8Array([1, 9, 255]));
    return Response.json({ ok: true, data: [raw, { defect_code: 'OLD', description: '旧报告正文' }] });
  });
  const [defect, legacy] = await listDefects('', 'PROJECT-1');
  const client = new QueryClient();
  const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(DefectReportDetails, { defect })));
  assert.match(html, /href="http:\/\/example\.test\/log"[^>]*>http:example\.test\/log<\/a>/);
  for (const content of [raw.action_steps, raw.expected_result, raw.actual_result, raw.evidence[0].text, raw.evidence[1].url, raw.evidence[2].file_name]) {
    assert.ok(html.includes(content));
    assert.ok(defectRepairContext(defect).includes(content));
  }
  assert.match(defectRepairContext(defect), /GET \/defects\/D1\/evidence\/2\/file/);
  assert.deepEqual(legacy.evidence, []);
  assert.equal(legacy.action_steps, null);
  assert.equal(defectRepairContext(legacy), '旧报告正文');
  const partial = defectRepairContext({ ...legacy, evidence: raw.evidence });
  for (const content of ['旧报告正文', 'EPIPE at byte 42', 'http:example.test/log', 'record.webm', '/defects/OLD/evidence/2/file']) assert.ok(partial.includes(content));
  assert.deepEqual(new Uint8Array(await (await getDefectEvidenceFile('D1', 2)).arrayBuffer()), new Uint8Array([1, 9, 255]));
  assert.equal(calls.at(-1).path, '/api/defects/D1/evidence/2/file');
  assert.equal(calls.at(-1).init.credentials, 'same-origin');
  client.clear();
});
