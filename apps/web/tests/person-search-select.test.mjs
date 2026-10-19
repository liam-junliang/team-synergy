import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite;

before(async () => {
  vite = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)),
    appType: 'custom',
    server: { middlewareMode: true },
  });
});

after(async () => {
  await vite?.close();
});

test('人员选择器可按姓名、账号和编码搜索', async () => {
  const { choosePersonMenuPlacement, filterPersonOptions } = await vite.ssrLoadModule('/src/PersonSearchSelect.tsx');
  const options = [
    { code: 'USER-LIAM', display_name: 'Liam', account: 'liam' },
    { code: 'USER-ADMIN', display_name: '系统管理员', account: 'admin' },
  ];

  assert.deepEqual(filterPersonOptions(options, '系统').map((option) => option.code), ['USER-ADMIN']);
  assert.deepEqual(filterPersonOptions(options, 'LIAM').map((option) => option.code), ['USER-LIAM']);
  assert.deepEqual(filterPersonOptions(options, 'user-admin').map((option) => option.code), ['USER-ADMIN']);
  assert.equal(choosePersonMenuPlacement(480, 24, 288), 'top');
  assert.equal(choosePersonMenuPlacement(80, 320, 288), 'bottom');
});

test('宽松尺寸人员选择器与弹窗操作控件保持 40px 高度', async () => {
  const { PersonSearchSelect } = await vite.ssrLoadModule('/src/PersonSearchSelect.tsx');
  const html = renderToStaticMarkup(createElement(PersonSearchSelect, {
    value: '',
    options: [{ code: 'USER-LIAM', display_name: 'Liam', account: 'liam' }],
    onChange() {},
    ariaLabel: '选择团队成员',
    placeholder: '搜索并选择用户',
    size: 'roomy',
    required: true,
  }));

  assert.match(html, /aria-label="选择团队成员"/);
  assert.match(html, /aria-required="true"/);
  assert.match(html, /h-10/);
  assert.match(html, /搜索并选择用户/);
  assert.doesNotMatch(html, /<select/);
});

test('团队弹窗与任务筛选复用同一人员选择器', async () => {
  const [teamsSource, appSource] = await Promise.all([
    readFile(new URL('../src/TeamsWorkspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(teamsSource, /<PersonSearchSelect/);
  assert.match(appSource, /<PersonSearchSelect/);
  assert.match(teamsSource, /ui-button ui-button-strong !h-10/);
  assert.match(teamsSource, /ui-button ui-button-primary !h-10/);
  assert.match(teamsSource, /canManageMember\(mayManageAdmins \? 'owner' : 'admin', member\)/);
  assert.doesNotMatch(teamsSource, /value="owner"/);
  assert.match(teamsSource, /removing \? t\("移出中…"\) : t\("移出"\)/);
  assert.match(appSource, /ariaLabel=\{t\("按负责人筛选"\)\}/);
});
