# Governance exceptions-only recheck

**Verdict: needs_revision.** 五个REQ的19条新增exceptions已定向复核：18条在静态范围内匹配，1条含过强唯一性结论，见GOV-EXCEPTIONS-001。本轮不重开原五项发现。

## 固定输入

- 复核候选：`parts/governance.json` SHA-256 `6c1ea8237b15d9b783b1620707dfa6b73a156de54d486663de98c0199522cff7`。
- 前一语义通过版：`parts/governance.semantic-repaired.json` SHA-256 `28234b3e230c819e263bc3173886ddbfe7996074db1979c0bb7e41587a565596`。
- 固定run：`NSG3TKRB16Y9F6Y203WB`；Skill `2.2.0`。
- 企业混合输入manifest：`c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e`。
- 阅读修订映射与static check作为变更导航，逐项重读固定源码作语义判断；未把schema/hash通过当语义证明。

## 本轮发现

[GOV-EXCEPTIONS-001] 新增 specification.exceptions[3].handling（第4条；同步 requirement content_markdown、GOV-M02-RULES 与 modules/m02-governance.md）声称“过期pending只有在后续新发请求的事务中才被置cancelled”。该唯一性不符固定源码：changeTransfer 对 cancel 只检查请求仍pending及操作者为from/to/initiated_by，不检查expires_at，随后直接写cancelled；因此有效参与人也可直接取消过期pending，而不必先发新转移。账号最终注销亦会取消相关pending请求。接受过期请求报错且不改变状态、新发请求清理过期pending这两部分正确，但不能扩大为唯一取消路径。

Source proof:

- `packages/application/src/ownership-use-cases.ts` L127–136; SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。
- `packages/application/src/ownership-use-cases.ts` L143–175; SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。
- `packages/application/src/ownership-use-cases.ts` L281–284; SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。

建议：仅修正新增exception及其重复正文：删除“只有…才”，表述为“接受过期请求返回ownership_transfer_expired且不改变请求状态；后续新发请求会在事务内把旧过期pending置cancelled；有效参与人仍可显式取消pending”。保留未证实后台自动过期的限制；不用新增功能、修改既有126条AC/计划或重开原五项。

## 全部19条新增异常的复核范围

### REQ-GOV-INSTALLATION-SESSIONS — 4 条

匹配：秘密不匹配、新建/重激活时10设备上限、绑定身份冲突、legacy session不重复登记/复活。

- `packages/application/src/auth-device.ts` L30–80; SHA-256 `3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9`。
- `packages/application/src/auth-use-cases.ts` L148–168; SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`。
### REQ-GOV-ACCOUNT-CLOSURE — 3 条

匹配：未begin、未交接责任、最后active且未deleted管理员保护及事务拒绝时的状态保持。

- `packages/application/src/ownership-use-cases.ts` L226–240; SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。
- `packages/application/src/ownership-use-cases.ts` L249–286; SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。
### REQ-GOV-OWNERSHIP-TRANSFER — 4 条

前三条及第4条的accept错误/不改owner匹配；第4条新增“只有后续新发才cancelled”未通过，见GOV-EXCEPTIONS-001。

- `packages/application/src/ownership-use-cases.ts` L49–53; SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。
- `packages/application/src/ownership-use-cases.ts` L108–139; SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。
- `packages/application/src/ownership-use-cases.ts` L143–175; SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`。
### tsp-req-home-binding — 3 条

匹配：非法bindings/规范字段、普通成员/归档写入、错误项目/归档文档/系统目录及关联事务保持。

- `packages/application/src/project-home-use-cases.ts` L40–48; SHA-256 `115a7340fb479c30adf8714f8361c35e7ca21ca7d42329a85e727afdb6a41836`。
- `packages/application/src/project-home-use-cases.ts` L87–126; SHA-256 `115a7340fb479c30adf8714f8361c35e7ca21ca7d42329a85e727afdb6a41836`。
### REQ-GOV-BASELINE-READ-COMPARE — 5 条

匹配：access_denied、当前项目baseline_not_found、内容hash失败、未发布交接省略及失配manifest的null绑定；未混淆拒绝/省略/null。

- `packages/application/src/baseline-use-cases.ts` L36–64; SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`。
- `packages/application/src/baseline-use-cases.ts` L106–137; SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`。
- `packages/application/src/baseline-use-cases.ts` L142–165; SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`。
- `packages/application/src/baseline-use-cases.ts` L203–225; SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`。

## 同步与变更边界

- 与semantic-repaired版比较，仅五个REQ的specification.exceptions及content_markdown、四份规则文档正文发生变化；keys/source/父引用与126条AC/verification_plan保持。
- 对19组condition/handling逐项检查，它们都存在于对应REQ正文和章节正文；问题GOV-EXCEPTIONS-001也因此同步重复，须在同一范围修正。
- 各源文件实际SHA-256与pack source.files匹配，所有打开的行范围有效。
- 本报告JSON按canonical evaluation.schema.json通过校验。
- GOV-CONFLICT-OWNER-COPY仍open；本轮没有批准Owner/Admin政策或清除此冲突。

## 未执行与限度

- 本轮仅复核五个REQ新增19条specification.exceptions及同步正文/章节和原source资格；不重开GOV-INITIAL-001至005，也不重新审查其他原规格。
- 18条新增condition/handling在本次静态范围内与固定源码相符；第19条中的唯一取消路径表述由GOV-EXCEPTIONS-001指出。此计数是本轮检查范围，非产品准确率。
- 未执行任何API、真实业务测试、数据库写入、迁移或fixture；126条AC/验证计划相较semantic-repaired备份保持，矩阵not_run未改。
- Owner/Admin文案冲突GOV-CONFLICT-OWNER-COPY保持open，未制造或推导业务批准。
- 静态结构和source hash/range检查只证明证据资格及变更边界，不证明业务正确、并发安全或部署行为。

## 本轮输入与保留报告哈希

- `query-governance-exception-repair.md` SHA-256 `dbe1a52352778875c846659c0ba48ea32f32114e4957beb768b4d5d2bb36a3ee`。
- `query-governance-exception-check.json` SHA-256 `b00b0fd066c79d6a92d0801406ecbeddc83da9bec63ecec16d0982ddf1ca7236`。
- `review/governance-initial.json` SHA-256 `bd0a4142ac4aadc8642c285bc2cbcef72c0f5e08a5dbf5fb663da61740b4f031`。
- `review/governance-initial.md` SHA-256 `fe679c5351bd74d18e4fcac5301f14d8dac784131d2200e08ca73f135b2ecacd`。
- `review/governance-recheck.json` SHA-256 `cd9e32e0bd7c66b9097df5e9e7005489f784b10225b9544610274116ec6ddea9`。
- `review/governance-recheck.md` SHA-256 `6f913ec217b98b4d240606aa37658124b9eea87a9ac8615c2afdda067d3abe2b`。
