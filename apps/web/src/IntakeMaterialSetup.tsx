import { t } from './i18n';
import type { IntakeProfile } from './intakeApi';

export function intakeMaterialPreparationCommand(projectCode: string, profile: IntakeProfile): string {
  return `tsp intake prepare --project ${projectCode} --material team=work/materials --profile ${profile} --out outbox/material-spec\n\ntsp intake validate outbox/material-spec/intake.json\ntsp intake export outbox/material-spec/intake.json --out outbox/material-spec-export`;
}
export function IntakeMaterialSetup({ projectCode, profile }: { projectCode: string; profile: IntakeProfile }) {
  return <details className="mt-4 rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-semibold text-cyan-800">{t('从团队资料开始，或为代码补充资料')}</summary>
    <p className="mt-3 text-xs leading-6 text-slate-600">{t('将需求、流程说明或团队纪要放入本地 work/materials。支持 UTF-8 文本；Word、PDF 等需先转换为文本并保留原件及来源说明。纯资料项目可以直接准备，无需绑定代码仓库。')}</p>
    <p className="mt-2 text-xs leading-6 text-slate-600">{t('prepare 后让 Agent 按生成的 SKILL.md 盘点能力、编写规格并记录冲突，再执行校验和导出。代码项目也可在准备命令中追加 --material team=work/materials。')}</p>
    <pre className="mt-3 max-w-full overflow-x-auto rounded-lg bg-slate-950 p-3 text-xs leading-6 text-slate-100"><code>{intakeMaterialPreparationCommand(projectCode, profile)}</code></pre>
  </details>;
}
