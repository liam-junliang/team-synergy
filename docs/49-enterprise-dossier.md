# 企业级项目档案（Enterprise Dossier）

日期：2026-10-19。状态：Phase 1 已实现模板、协议字段和本地质量门禁；应用于 `tsp intake prepare/validate --profile enterprise`。

## 1. 目标

把存量代码接入从“代码摘要”提升为可评审的项目档案。企业级档案不是一篇更长的文档，而是一组有固定结构、证据、负责人和门禁的产物。

## 2. 必交产物

| artifact_type | 文档 | 必填章节 |
| --- | --- | --- |
| `charter` | 项目章程与业务背景 | 业务背景、问题与目标、范围与非目标、干系人、成功指标、约束与假设 |
| `context` | 系统上下文与角色 | 系统上下文、外部系统、用户角色、关键场景、运行约束 |
| `domain` | 领域模型与术语 | 术语表、领域实体、状态机、权限矩阵、业务规则 |
| `requirements` | 功能需求规格 | 需求范围、功能需求、验收场景、权限边界、异常与边界、追溯 |
| `nfr` | 非功能需求规格 | 性能、可用性、安全与隐私、可观测性、可维护性、容量与成本 |
| `architecture` | 架构说明 | 架构上下文、容器与组件、部署与运行、数据与集成、质量属性、风险与取舍 |
| `api_data` | API 与数据契约 | API 清单、鉴权与错误模型、数据实体与关系、数据保留与迁移、版本与兼容 |
| `test_strategy` | 测试策略与追溯 | 测试分层、测试环境、覆盖与追溯、证据与报告、未验证项 |
| `security` | 安全与权限设计 | 信任边界、威胁与缓解、身份与权限、数据分级、审计与密钥 |
| `runbook` | 运维与发布手册 | 部署、回滚、备份与恢复、告警与 SLO、故障处理 |
| `adr` | 架构决策记录 | 背景与问题、决策驱动、候选方案、决策、后果与确认 |
| `onboarding` | 开发与接入指南 | 前置条件、本地启动、开发流程、测试与发布、常见问题 |
| `risk` | 风险与缺口登记 | 风险登记、影响与概率、缓解措施、负责人、复查日期 |

前 11 项为必交；`onboarding` 和 `risk` 强烈建议提交。

## 3. 协议字段

`intake.json` 增加：

```json
{
  "profile": "enterprise",
  "items": [
    {
      "kind": "requirement_document",
      "artifact_type": "charter",
      "...": "其他候选字段"
    }
  ]
}
```

`artifact_type` 只允许出现在 `requirement_document` 和 `architecture` 候选上；`architecture` 必须使用 `kind=architecture` 且提供 Mermaid `diagram_source`。

## 4. 质量门禁

`tsp intake validate <file> --profile enterprise` 检查：

- 必交 artifact_type 齐全且不重复；
- 每个候选包含全部必填章节；
- 必交产物至少 2 条代码证据，且记录 gaps；
- 需求包含 `REQ-` 编号、验收场景、测试引用和可测试句式；
- NFR 包含可度量阈值（ms、%、RTO/RPO 等）；
- API/数据包含端点、错误模型和生命周期；
- 安全、运维、测试策略、ADR 包含对应关键内容；
- Markdown 代码围栏闭合、无空标题、TODO 带负责人；
- `source.complete=false` 或 `source.dirty=true` 产生警告，发布前必须人工确认。

门禁不通过时返回 `intake_quality_invalid`，details 中逐条列出问题；候选不会进入可发布状态。

## 5. 使用

```sh
tsp intake prepare --repository <code> --scope apps packages --profile enterprise --out outbox/intake-001
# 本机 Agent 按 SKILL.md、dossier-plan.md、templates/ 填写 intake.json
tsp intake validate outbox/intake-001/intake.json --profile enterprise
tsp intake submit outbox/intake-001/intake.json --idempotency-key intake-submit-001
```

## 6. 当前边界

- 企业级产物暂以 `requirement_document` / `architecture` 发布，尚未进入独立的「项目档案」系统目录；Phase 2 再增加专用 dossier 实体和目录。
- 质量门禁是本地结构/证据检查，不能替代业务、架构、安全和运维的人工评审。
- 未提交工作区和未执行运行验证会保留为 warning/gaps，不伪装成已验证事实。
