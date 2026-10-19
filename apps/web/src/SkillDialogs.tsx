import { useRef, useState, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { createSkill, reviseSkill, shareSkill, installProjectSkill, type SkillDetail, type SkillFileInput, type SkillScope, type ProjectSkills, type ProjectSkillInstallation } from './api';
import { WorkspaceDialog } from './WorkspaceDialog';
import { SkillError } from './SkillShared';
import { readSkillFiles, skillFileText, skillTextFile, SKILL_STARTER, validSkillPath } from './skills';
import { t } from './i18n';

export function SkillField({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block text-xs font-semibold text-slate-700"><span className="mb-2 block">{label}</span>{children}</label>;
}

export function SkillEditor({ scope, scopeCode, initial, onClose, onSaved }: { scope: SkillScope; scopeCode: string; initial?: SkillDetail; onClose: () => void; onSaved: (skill: SkillDetail) => Promise<void> }) {
  const latest = initial?.revisions.find(revision => revision.revision === initial.current_revision);
  const [files, setFiles] = useState<SkillFileInput[]>(() => latest?.files.map(file => ({ path: file.path, content_base64: file.content_base64 })) ?? [skillTextFile('SKILL.md', SKILL_STARTER)]);
  const [selected, setSelected] = useState('SKILL.md');
  const [change, setChange] = useState('');
  const [newPath, setNewPath] = useState('');
  const [importError, setImportError] = useState('');
  const [importing, setImporting] = useState(false);
  const folderInput = useRef<HTMLInputElement>(null);
  const sequence = useRef(0);
  const file = files.find(item => item.path === selected);
  const text = file && skillFileText(file);
  const save = useMutation({ mutationFn: () => initial ? reviseSkill(initial.code, { base_revision: initial.current_revision, files, change_summary: change }) : createSkill({ scope_type: scope, scope_code: scopeCode, files, change_summary: change || undefined }), onSuccess: onSaved });
  async function importFolder(values: File[]) {
    if (!values.length) return;
    const id = ++sequence.current; setImporting(true); setImportError('');
    try { const imported = await readSkillFiles(values); if (sequence.current === id) { setFiles(imported); setSelected('SKILL.md'); } } catch (error) { if (sequence.current === id) setImportError(error instanceof Error ? error.message : String(error)); } finally { if (sequence.current === id) setImporting(false); }
  }
  function addFile() {
    const path = newPath.trim();
    if (!validSkillPath(path)) { setImportError('请输入有效的包内相对路径。'); return; }
    if (files.some(item => item.path.toLowerCase() === path.toLowerCase())) { setImportError('技能包存在重复或大小写冲突的路径。'); return; }
    setFiles(current => [...current, skillTextFile(path, '')]); setSelected(path); setNewPath(''); setImportError('');
  }
  return <WorkspaceDialog id="skill-editor" title={t(initial ? '修订技能包' : '新建技能包')} description={t('根目录 SKILL.md 的 name 和 description 定义名称与用途。保存产生新修订，发布后才能交付项目。')} size="wide" onClose={onClose} footer={<div className="flex justify-end gap-2"><button type="button" className="ui-button ui-button-secondary" onClick={onClose}>{t('取消')}</button><button form="skill-editor-form" type="submit" className="ui-button ui-button-primary" disabled={save.isPending || importing || Boolean(initial && !change.trim())}>{t(save.isPending ? '保存中…' : '保存草稿版本')}</button></div>}>
    <form id="skill-editor-form" className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
      <div className="rounded-xl border border-dashed border-cyan-300 bg-cyan-50/50 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-sm font-semibold">{t('导入完整技能目录')}</h3><p className="mt-1 text-xs leading-5 text-slate-500">{t('最多 200 个文件、总计 6 MiB。目录导入会替换当前草稿，脚本仅作为文件保存。')}</p></div><button type="button" className="ui-button ui-button-secondary" disabled={importing} onClick={() => folderInput.current?.click()}>{t(importing ? '正在读取…' : '选择目录')}</button></div><input ref={folderInput} type="file" multiple {...{ webkitdirectory: '', directory: '' }} aria-label={t('选择技能目录')} className="sr-only" onChange={event => { void importFolder(Array.from(event.target.files ?? [])); event.target.value = ''; }} /></div>
      <SkillField label={t('包内文件')}><select className="form-control w-full font-mono" value={selected} onChange={event => setSelected(event.target.value)}>{files.map(item => <option key={item.path}>{item.path}</option>)}</select></SkillField>
      {text !== undefined ? <SkillField label={selected}><textarea required={selected === 'SKILL.md'} spellCheck={false} className="form-control min-h-64 w-full font-mono text-xs leading-6" value={text} onChange={event => setFiles(current => current.map(item => item.path === selected ? skillTextFile(item.path, event.target.value) : item))} /></SkillField> : <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">{t('该文件为二进制或较大文件，保存时将保留原始字节。')}</p>}
      {selected !== 'SKILL.md' && <button type="button" className="ui-context-action !text-rose-700" onClick={() => { setFiles(current => current.filter(item => item.path !== selected)); setSelected('SKILL.md'); }}>{t('从草稿移除文件')}</button>}
      <div className="flex items-end gap-2"><div className="min-w-0 flex-1"><SkillField label={t('新增文本文件')}><input className="form-control w-full" value={newPath} onChange={event => setNewPath(event.target.value)} placeholder="references/guide.md" /></SkillField></div><button type="button" className="ui-button ui-button-secondary" onClick={addFile} disabled={!newPath.trim()}>{t('添加')}</button></div>
      <SkillField label={t('变更说明')}><input required={Boolean(initial)} className="form-control w-full" value={change} onChange={event => setChange(event.target.value)} /></SkillField>{initial && <p className="text-xs leading-5 text-slate-500">{t('基于 r{revision} 保存；冲突时请保留草稿并重新读取最新版本。', { revision: initial.current_revision })}</p>}<SkillError error={save.error || importError} />
    </form>
  </WorkspaceDialog>;
}

export function SkillShareEditor({ skill, onClose, onSaved }: { skill: SkillDetail; onClose: () => void; onSaved: () => Promise<void> }) {
  const [target, setTarget] = useState<SkillScope>('project');
  const [code, setCode] = useState('');
  const [revisions, setRevisions] = useState<number[]>([]);
  const [allowProjects, setAllowProjects] = useState(false);
  const [allowExternal, setAllowExternal] = useState(false);
  const save = useMutation({ mutationFn: () => shareSkill(skill.code, { target_type: target, target_code: code.trim(), revisions, allow_projects: target === 'team' && allowProjects, allow_external: allowExternal }), onSuccess: onSaved });
  return <WorkspaceDialog id="skill-share" title={t('共享技能版本')} description={t('共享仅授予读取和采用权，不授予来源编辑权。目标项目管理员仍需主动采用固定版本。')} onClose={onClose} footer={<div className="flex justify-end gap-2"><button type="button" className="ui-button ui-button-secondary" onClick={onClose}>{t('取消')}</button><button type="submit" form="skill-share-form" className="ui-button ui-button-primary" disabled={save.isPending || !code.trim() || !revisions.length}>{t('确认共享')}</button></div>}><form id="skill-share-form" className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}><SkillField label={t('目标范围')}><select className="form-control w-full" value={target} onChange={event => setTarget(event.target.value as SkillScope)}><option value="project">{t('项目')}</option><option value="team">{t('团队')}</option></select></SkillField><SkillField label={t(target === 'project' ? '目标项目编码' : '目标团队编码')}><input required className="form-control w-full font-mono" value={code} onChange={event => setCode(event.target.value)} /></SkillField><fieldset><legend className="mb-2 text-xs font-semibold">{t('授权版本')}</legend><div className="flex flex-wrap gap-3">{skill.revisions.filter(revision => revision.published_at).map(revision => <label key={revision.revision} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={revisions.includes(revision.revision)} onChange={event => setRevisions(current => event.target.checked ? [...current, revision.revision] : current.filter(item => item !== revision.revision))} />r{revision.revision}</label>)}</div></fieldset>{target === 'team' && <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={allowProjects} onChange={event => setAllowProjects(event.target.checked)} />{t('允许目标团队所属项目采用')}</label>}<label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={allowExternal} onChange={event => setAllowExternal(event.target.checked)} />{t('允许交付给含外部协作者的项目')}</label><div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-6 text-amber-900"><strong>{t('共享影响')}</strong><p>{t(target === 'project' ? '目标项目的读者将能读取被采用的版本；包含外部成员时必须明确允许外部协作者。' : '目标团队成员可读取所选版本。只有勾选项目采用后，其项目管理员才可将版本交付到项目。')}</p><p>{t('后续新版本不会自动共享。撤销可阻止新同步与新执行，已经下载的副本无法远程收回。')}</p></div><SkillError error={save.error} /></form></WorkspaceDialog>;
}

export function SkillInstallEditor({ skill, projectSkills, current, onClose, onSaved }: { skill: SkillDetail; projectSkills: ProjectSkills; current?: ProjectSkillInstallation; onClose: () => void; onSaved: () => Promise<void> }) {
  const revisions = skill.revisions.filter(revision => revision.published_at && skill.available_revisions.includes(revision.revision));
  const [revision, setRevision] = useState(current?.revision ?? revisions[0]?.revision ?? 0);
  const [alias, setAlias] = useState(current?.alias ?? skill.name);
  const save = useMutation({ mutationFn: () => installProjectSkill(projectSkills.project_code, skill.code, { revision, alias: alias.trim(), enabled: true, base_generation: projectSkills.generation }), onSuccess: onSaved });
  return <WorkspaceDialog id="skill-install" title={t(current ? '更新项目采用版本' : '采用到当前项目')} description={t('固定版本和别名；其他项目、旧版本及历史执行不受影响。授权由服务端再次校验。')} onClose={onClose}><form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}><SkillField label={t('固定版本')}><select required className="form-control w-full" value={revision} onChange={event => setRevision(Number(event.target.value))}><option value={0}>{t('选择版本')}</option>{revisions.map(item => <option key={item.revision} value={item.revision}>r{item.revision} · {item.change_summary || skill.name}</option>)}</select></SkillField><SkillField label={t('项目内别名')}><input required pattern="[a-z0-9]+(-[a-z0-9]+)*" className="form-control w-full font-mono" value={alias} onChange={event => setAlias(event.target.value)} /><p className="mt-2 text-xs font-normal text-slate-500">{t('使用小写英文、数字和连字符。同名技能需显式指定不同别名。')}</p></SkillField><p className="text-xs leading-5 text-slate-500">{t('采用不代表已同步到本机；保存后执行 tsp skill sync。')}</p><SkillError error={save.error} /><div className="flex justify-end gap-2"><button type="button" className="ui-button ui-button-secondary" onClick={onClose}>{t('取消')}</button><button type="submit" className="ui-button ui-button-primary" disabled={save.isPending || !revision || !alias.trim()}>{t('保存采用版本')}</button></div></form></WorkspaceDialog>;
}
