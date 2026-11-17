# TeamSynergy 全项目规格与对照

> 全项目现状需求草稿；代码观察、文档目标、分析推断与未验证事项分开。未批准为目标需求。
> 日期：2026-11-10。14个业务章节；112条结构化需求；299组AC/验证计划；13类共享档案。
> Run NSG3TKRB16Y9F6Y203WB；显式工作区草稿；base commit 92728fbec04cfa34fee4421cb0a9319d1b755164。
> Snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；代码manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9。
> 分析产物SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8；候选输入manifest c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e；Skill 2.2.0。
> 675份原始固定输入＋1份知识文档；675文件定位覆盖不是全部语义或运行行为的验证。旧实验稿仅用于最终对照，不作为本轮功能事实权威。
> 原始源码位于该run本机固定副本，未提交内容没有GitHub提交永久链接。请用同run CLI和原始文件hash/range核对，不能把未来当前分支文件替代为历史证据。

## 先看效果

- [完整需求文档](TeamSynergy-完整需求文档.md)：14业务章节，包含每条结构化需求、条件/例外/规则、AC及验证步骤。
- [验收追溯总表](验收追溯总表.md)：REQ/AC与验证计划的对应，全部保留未执行状态。
- [与之前产物的对比](对比报告.md)：区分版本新增、同代码的表达差异及交付形式。
- [接口与命令导航](接口与命令导航.md)：静态入口清单，作为查漏和下钻线索。

## 模块细则

| 章节 | 范围 | 需求数 | 规则稿 |
| --- | --- | ---: | --- |
| M01 | 身份、会话与账号生命周期 | 11 | [规则](modules/m01-rules.md) |
| M02 | 团队、项目与权限治理 | 8 | [规则](modules/m02-rules.md) |
| M03 | 项目结构与首页 | 6 | [规则](modules/m03-rules.md) |
| M04 | 需求发现、决策与评审 | 5 | [规则](modules/m04-rules.md) |
| M05 | 需求文档、结构化需求与基线 | 7 | [规则](modules/m05-rules.md) |
| M06 | 任务执行与 Run | 10 | [规则](modules/m06-rules.md) |
| M07 | 交接恢复与本机工作空间 | 10 | [规则](modules/m07-rules.md) |
| M08 | 项目资料与设计资产 | 8 | [规则](modules/m08-rules.md) |
| M09 | 测试与缺陷 | 5 | [规则](modules/m09-rules.md) |
| M10 | 技能版本与交付 | 7 | [规则](modules/m10-rules.md) |
| M11 | 代码与资料接入、规则化需求生产 | 8 | [规则](modules/m11-rules.md) |
| M12 | 系统文档 Agent 修改稿 | 6 | [规则](modules/m12-rules.md) |
| M13 | 平台治理与运维 | 13 | [规则](modules/m13-rules.md) |
| M14 | 项目代码理解与插件知识 | 8 | [规则](modules/m14-rules.md) |

## 共享档案

| 类型 | 内容 |
| --- | --- |
| charter | [项目章程与业务背景](dossier/charter.md) |
| context | [系统上下文与角色](dossier/context.md) |
| domain | [领域模型与术语](dossier/domain.md) |
| requirements | [功能需求规格](dossier/requirements.md) |
| nfr | [非功能需求规格](dossier/nfr.md) |
| architecture | [架构说明](dossier/architecture.md) |
| api_data | [API 与数据契约](dossier/api_data.md) |
| test_strategy | [测试策略与追溯](dossier/test_strategy.md) |
| security | [安全与权限设计](dossier/security.md) |
| runbook | [运维与发布手册](dossier/runbook.md) |
| adr | [架构决策记录](dossier/adr.md) |
| onboarding | [开发与接入指南](dossier/onboarding.md) |
| risk | [风险与缺口登记](dossier/risk.md) |

## 验证和状态

- 候选共212项；112条需求；295个不同BR；299组AC/计划。
- 业务章节覆盖、来源/规则/验收结构、机器校验和语义复核分别记账；不以模板齐全或行号有效代替业务正确。
- 本轮语义复核：已完成分组初审和定向复核；限定范围内的问题已修正，运行验证及政策批准另记。初稿、初始发现、修订和定向复核保存在user-space工作目录；细节见对照报告。
- 业务目标批准、真实浏览器/并发/模型/生产恢复测试与未定位规划能力仍有明确边界。
- 原始可复验材料及原生查询在user-space的work/full-spec-20261110，代码副本由该run的本机来源映射定位。
- [平台候选](http://127.0.0.1:5173/projects/19Q4K7PDARXQ9JHW6R6F/overview?tab=intake)：`9XWPVRZXJ75FDD092B94`，状态`draft`；未自动审阅或apply。
- [当前草稿理解图](http://127.0.0.1:5173/projects/19Q4K7PDARXQ9JHW6R6F/understanding?repository=P1KRPDABN4RD0YXMX64E&run=NSG3TKRB16Y9F6Y203WB)：本轮没有切换原有默认项目视图。
