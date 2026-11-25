import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useMutation } from '@tanstack/react-query';
import { DEFECT_EVIDENCE_MAX_FILE_BYTES, DEFECT_EVIDENCE_MAX_ITEMS, type DefectEvidence } from '../../../packages/contracts/src/schemas';
import { getDefectEvidenceFile, type CreateDefectInput, type DefectSummary, type Feature, type Requirement } from './api';
import { t } from './i18n';
import { readTestFile, safeTestUrl } from './testing';
import { WorkspaceDialog } from './WorkspaceDialog';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="ui-field-label block min-w-0">{label}<span className="mt-1 block">{children}</span></label>;
}

type EvidenceDraft = { text: string; urls: string[]; files: File[] };

function evidenceError({ text, urls, files }: EvidenceDraft): string | undefined {
  const count = Number(Boolean(text.trim())) + urls.length + files.length;
  if (!count) return t('请提供至少一项日志、报错、链接或附件。');
  if (count > DEFECT_EVIDENCE_MAX_ITEMS) return t('每份报告最多可附 {count} 项证据。', { count: DEFECT_EVIDENCE_MAX_ITEMS });
  if (urls.some(url => !safeTestUrl(url) || url.length > 4096)) return t('请每行填写一个有效的 HTTP(S) 链接。');
  if (files.some(file => !file.size)) return t('请选择有内容的文件。');
  if (files.reduce((total, file) => total + file.size, 0) > DEFECT_EVIDENCE_MAX_FILE_BYTES) return t('附件总大小不能超过 6 MiB。');
}

export async function prepareDefectEvidence(draft: EvidenceDraft): Promise<CreateDefectInput['evidence']> {
  const error = evidenceError(draft);
  if (error) throw new Error(error);
  const evidence: CreateDefectInput['evidence'] = [];
  if (draft.text.trim()) evidence.push({ kind: 'text', text: draft.text });
  for (const url of draft.urls) evidence.push({ kind: 'link', url });
  for (const file of draft.files) {
    const { file_name, mime_type, content_base64 } = await readTestFile(file);
    evidence.push({ kind: 'file', file_name, mime_type, content_base64 });
  }
  return evidence;
}

export function ReportDefectDialog({ features, requirements, onClose, onSubmit }: {
  features: Feature[]; requirements: Requirement[]; onClose: () => void; onSubmit: (input: CreateDefectInput) => Promise<unknown>;
}) {
  const [title, setTitle] = useState('');
  const [steps, setSteps] = useState('');
  const [expected, setExpected] = useState('');
  const [actual, setActual] = useState('');
  const [log, setLog] = useState('');
  const [showLinks, setShowLinks] = useState(false);
  const [links, setLinks] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [featureCode, setFeatureCode] = useState(features[0]?.code ?? '');
  const [severity, setSeverity] = useState<CreateDefectInput['severity']>('medium');
  const [foundIn, setFoundIn] = useState('');
  const [requirementCode, setRequirementCode] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const urls = links.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
  const draft = { text: log, urls, files };
  const availableRequirements = requirements.filter(item => !item.feature_code || item.feature_code === featureCode);
  function addFiles(newFiles: File[]) {
    if (!newFiles.length) return;
    const combined = [...files, ...newFiles];
    const problem = evidenceError({ ...draft, files: combined });
    if (problem) { setError(problem); return; }
    setFiles(combined);
    setError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if (![title, steps, expected, actual].every(value => value.trim())) {
      setError(t('请填写标题、操作步骤、预期结果和实际结果。'));
      return;
    }
    setError('');
    setPending(true);
    try {
      await onSubmit({
        feature_code: featureCode, title: title.trim(), severity,
        action_steps: steps.trim(), expected_result: expected.trim(), actual_result: actual.trim(),
        evidence: await prepareDefectEvidence(draft), found_in: foundIn.trim() || undefined,
        related_requirement_code: requirementCode || undefined,
      });
    } catch (cause) {
      setError(cause instanceof Error ? t(cause.message) : t('缺陷提交失败'));
    } finally {
      setPending(false);
    }
  }
  return <WorkspaceDialog id="defect-report" size="wide" title={t('提交缺陷')} description={t('提交后由项目负责人或管理员确认。')} dismissDisabled={pending} onClose={onClose}
    footer={<>
      {error && <p role="alert" className="mb-3 break-words text-sm text-rose-700">{error}</p>}
      {!features.length && <p className="mb-3 text-sm text-amber-700">{t('请先在项目中创建 Feature。')}</p>}
      <div className="flex justify-end gap-2">
        <button type="button" disabled={pending} onClick={onClose} className="ui-button ui-button-secondary">{t('取消')}</button>
        <button type="submit" form="defect-report-form" disabled={pending || !featureCode} className="ui-button ui-button-primary">{t(pending ? '提交中…' : '提交缺陷')}</button>
      </div>
    </>}>
    <form id="defect-report-form" onSubmit={submit} onChangeCapture={() => setError('')}>
      <fieldset disabled={pending} className="min-w-0 space-y-4">
        <Field label={t('缺陷标题')}><input autoFocus required maxLength={512} value={title} onChange={event => setTitle(event.target.value)} placeholder={t('一句话描述可观察到的问题')} className="form-control" /></Field>
        <Field label={t('操作步骤')}><textarea required maxLength={65536} rows={2} value={steps} onChange={event => setSteps(event.target.value)} placeholder={t('从哪个页面开始，依次做了哪些操作？')} className="form-control resize-y" /></Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('预期结果')}><textarea required maxLength={65536} rows={2} value={expected} onChange={event => setExpected(event.target.value)} placeholder={t('应该看到什么？')} className="form-control resize-y" /></Field>
          <Field label={t('实际结果')}><textarea required maxLength={65536} rows={2} value={actual} onChange={event => setActual(event.target.value)} placeholder={t('实际发生了什么？')} className="form-control resize-y" /></Field>
        </div>
        <fieldset className="min-w-0">
          <legend className="ui-field-label">{t('证据')}<span className="ml-2 font-normal text-slate-500">{t('至少提供一项')}</span></legend>
          <textarea aria-label={t('日志或报错原文')} maxLength={65536} rows={2} value={log} onChange={event => setLog(event.target.value)} placeholder={t('粘贴日志或报错原文，也可添加链接或附件')} className="form-control mt-1 resize-y" />
          {showLinks && <div className="mt-2"><Field label={t('证据链接（每行一个）')}><textarea autoFocus rows={2} value={links} onChange={event => setLinks(event.target.value)} placeholder="https://…" className="form-control resize-y" /></Field></div>}
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            {!showLinks && <button type="button" onClick={() => setShowLinks(true)} className="ui-button ui-button-secondary">{t('添加链接')}</button>}
            <button type="button" onClick={() => fileInput.current?.click()} className="ui-button ui-button-secondary">{t('上传截图、录屏或文件')}</button>
            <input ref={fileInput} type="file" hidden multiple onChange={event => { addFiles(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ''; }} />
            <span className="text-xs text-slate-500">{t('附件合计最多 6 MiB')}</span>
          </div>
          {files.length > 0 && <ul aria-label={t('待上传附件')} className="mt-2 space-y-1">
            {files.map((file, index) => <li key={index} className="flex min-w-0 items-center gap-2 rounded-lg bg-slate-50 px-3 py-1 text-xs">
              <span className="min-w-0 flex-1 break-all">{file.name}</span>
              <button type="button" aria-label={t('移除附件 {name}', { name: file.name })} onClick={() => { setFiles(files.filter((_, i) => i !== index)); setError(''); }} className="ui-context-action ui-context-action-danger">{t('移除')}</button>
            </li>)}
          </ul>}
        </fieldset>
        <div className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2">
          <Field label={t('所属 Feature')}><select required value={featureCode} onChange={event => { setFeatureCode(event.target.value); setRequirementCode(''); }} className="form-control">
            <option value="">{t('选择 Feature')}</option>{features.map(feature => <option key={feature.code} value={feature.code}>{feature.title}</option>)}</select></Field>
          <Field label={t('严重度')}><select value={severity} onChange={event => setSeverity(event.target.value as typeof severity)} className="form-control">
            <option value="critical">{t('致命 · 核心流程不可用')}</option><option value="high">{t('高 · 主要能力受阻')}</option>
            <option value="medium">{t('中 · 有替代路径')}</option><option value="low">{t('低 · 轻微问题')}</option></select></Field>
        </div>
        <details><summary className="cursor-pointer text-xs font-semibold text-slate-600">{t('版本、环境与关联需求（选填）')}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label={t('发现版本 / 环境')}><input value={foundIn} onChange={event => setFoundIn(event.target.value)} placeholder={t('例如：v0.3.1 · Chrome 127')} className="form-control" /></Field>
            <Field label={t('关联需求')}><select value={requirementCode} onChange={event => setRequirementCode(event.target.value)} className="form-control">
              <option value="">{t('不关联需求')}</option>{availableRequirements.map(item => <option key={item.code} value={item.code}>{item.title}</option>)}</select></Field>
          </div>
        </details>
      </fieldset>
    </form>
  </WorkspaceDialog>;
}

function FileEvidence({ file, defectCode, index }: { file: Extract<DefectEvidence, { kind: 'file' }>; defectCode: string; index: number }) {
  const download = useMutation({ mutationFn: async () => {
    const blob = await getDefectEvidenceFile(defectCode, index);
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = file.file_name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  } });
  return <><div className="flex flex-wrap items-center gap-2">
    <span className="min-w-0 break-all">{file.file_name}</span>
    <button type="button" disabled={download.isPending} aria-label={t('下载附件 {name}', { name: file.file_name })} onClick={() => download.mutate()} className="ui-button ui-button-secondary ui-button-compact">{t(download.isPending ? '下载中…' : '下载文件')}</button>
  </div>{download.error && <p role="alert" className="text-xs text-rose-700">{t(download.error.message)}</p>}</>;
}

export function DefectReportDetails({ defect }: { defect: DefectSummary }) {
  if (!defect.action_steps && !defect.expected_result && !defect.actual_result && !defect.evidence?.length) {
    return <section><h3 className="text-xs font-bold text-slate-500">{t('原始问题描述')}</h3>
      <p className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 text-sm leading-6">{defect.description || t('未填写问题描述。')}</p></section>;
  }
  return <dl className="space-y-4 text-sm leading-6 text-slate-700">
    {[[t('操作步骤'), defect.action_steps], [t('预期结果'), defect.expected_result], [t('实际结果'), defect.actual_result]].map(([label, content]) =>
      <div key={label}><dt className="text-xs font-bold text-slate-500">{label}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{content || t('未填写')}</dd></div>)}
    <div><dt className="text-xs font-bold text-slate-500">{t('证据')}</dt><dd className="mt-2">
      {defect.evidence?.length ? <ul className="space-y-2">{defect.evidence.map((item, index) => {
        const href = item.kind === 'link' ? safeTestUrl(item.url) : undefined;
        return <li key={index} className="min-w-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          {item.kind === 'text' && <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-5">{item.text}</pre>}
          {item.kind === 'link' && (href ? <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-cyan-700 underline">{item.url}</a> : <span className="break-all">{item.url}</span>)}
          {item.kind === 'file' && <FileEvidence file={item} defectCode={defect.code} index={index} />}
        </li>;
      })}</ul> : t('暂无证据')}
    </dd></div>
    {defect.description && <div><dt className="text-xs font-bold text-slate-500">{t('补充说明')}</dt><dd className="mt-1 whitespace-pre-wrap break-words">{defect.description}</dd></div>}
  </dl>;
}

export function defectRepairContext(defect: DefectSummary): string {
  if (!defect.action_steps && !defect.expected_result && !defect.actual_result && !defect.evidence?.length) return defect.description;
  const evidence = (defect.evidence ?? []).map((item, index) => {
    if (item.kind === 'text') return item.text;
    if (item.kind === 'link') return item.url;
    return `${item.file_name} · GET /defects/${encodeURIComponent(defect.code)}/evidence/${index}/file`;
  });
  return [
    [t('操作步骤'), defect.action_steps], [t('预期结果'), defect.expected_result],
    [t('实际结果'), defect.actual_result], [t('证据'), evidence.join('\n')],
    [t('补充说明'), defect.description],
  ].filter(([, content]) => content).map(([label, content]) => `${label}\n${content}`).join('\n\n');
}
