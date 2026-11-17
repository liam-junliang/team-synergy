# Governance exception cancellation final recheck

**Verdict: reviewed_with_limits. GOV-EXCEPTIONS-001 = closed_static.** 本次仅核闭合该新增发现，不重开原五项或扩展新领域。

- 当前候选：`parts/governance.json` SHA-256 `6582835b66e00ef1b2caa9f03410f263e03653bbcbb2dee3c2837bb32fb1b723`。
- 留存异常补全阶段：`parts/governance.exceptions-stage.json` SHA-256 `6c1ea8237b15d9b783b1620707dfa6b73a156de54d486663de98c0199522cff7`。
- 固定源码run：`NSG3TKRB16Y9F6Y203WB`；Skill `2.2.0`。

## 关闭依据

复核字段为 `REQ-GOV-OWNERSHIP-TRANSFER.specification.exceptions[3].handling`，及其 requirement content_markdown、GOV-M02-RULES、modules/m02-governance.md 重复表达。新版删除了“只有后续新发才cancelled”，并准确区分：

- 接受已过期请求或owner已变时，返回相应错误，owner与请求状态不变。
- 后续新发请求在其事务内取消旧过期pending。
- 有效from/to/initiated_by参与人可显式取消仍pending的请求，包括过期请求。
- 账号完成注销会取消收件人或发起人为该账号的pending请求。
- 未宣称后台自动过期处理。

以上分支与重新读取的固定源码匹配：

- `packages/application/src/ownership-use-cases.ts` L127–136：新发请求处理过期pending。SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。
- `packages/application/src/ownership-use-cases.ts` L143–175：有效参与人cancel不检查expiry；accept检查expiry/owner；成功cancel写cancelled。SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。
- `packages/application/src/ownership-use-cases.ts` L281–284：账号关闭取消incoming/initiated pending。SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。

## 变更与验证范围

- 与留存阶段版比较，只有该exception handling及对应REQ/M02正文发生变化；条件、其余spec、evidence、gaps、IDs、126条AC/计划不变。
- 新handling在REQ正文、候选M02规则文档和modules/m02-governance.md中均存在，未发现旧唯一性表述残留于该同步片段。
- 源文件实际SHA-256与pack source.files匹配；JSON按canonical evaluation.schema.json验证通过。
- Owner/Admin冲突原样保持open；没有政策批准。
- 未运行业务/API、数据库、fixture或验收测试，计划仍not_run。静态关闭不代表运行成功。

## 旧报告保留

- `review/governance-initial.json` SHA-256 `bd0a4142ac4aadc8642c285bc2cbcef72c0f5e08a5dbf5fb663da61740b4f031`。
- `review/governance-initial.md` SHA-256 `fe679c5351bd74d18e4fcac5301f14d8dac784131d2200e08ca73f135b2ecacd`。
- `review/governance-recheck.json` SHA-256 `cd9e32e0bd7c66b9097df5e9e7005489f784b10225b9544610274116ec6ddea9`。
- `review/governance-recheck.md` SHA-256 `6f913ec217b98b4d240606aa37658124b9eea87a9ac8615c2afdda067d3abe2b`。
- `review/governance-exceptions-recheck.json` SHA-256 `a9fde53eba21474e88daf6b449e933c4b3728481bf0618cb13d2b656da872364`。
- `review/governance-exceptions-recheck.md` SHA-256 `994dd486bab4b130bc457f43835434ada27c231cbbcc2991b1778cf36bbc2116`。

- `query-governance-cancel-check.json` SHA-256 `0e9c23bb0af0d14ec034a27055cdab6d6c5090727ac559a2cbcc295c691f9c19`（仅作变更导航，未代替本次源码重读）。
