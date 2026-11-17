# TeamSynergy 企业项目资料 · 逆向交付与验收记录

上一版五份资料适合新成员了解背景，但没有逐模块说明权限、状态和数据归属，也没有让设计和测试人员实际操作的原型。本版保留前版历史：先写[高阶设计背景](design-brief.md)，从入口按用户要完成的工作划分 13 个分析模块，再按功能验证实现，并交叉复核重要状态变化。分析模块是阅读和分工边界，没有改变平台已有的五个业务模块。

| 读者 | 阅读或操作入口 |
| --- | --- |
| 产品负责人、研发负责人 | [系统设计与数据所有权](architecture.md) · [接口与权限](contracts.md) · [部署、降级与恢复](operations.md) |
| 身份、项目与平台管理员 | [M01 账号与设备](modules/M01-identity.md) · [M02 项目权限与所有权](modules/M02-project-access.md) · [M03 规划与仓库](modules/M03-planning.md) · [M12 治理与审计](modules/M12-governance.md) |
| 产品、设计与知识库维护者 | [M04 议题与需求](modules/M04-requirements.md) · [M05 原型与架构设计](modules/M05-design.md) · [M06 资料库](modules/M06-documents.md) · [M10 代码理解与规格采纳](modules/M10-code-intake.md) |
| 执行、质量与 Agent 集成 | [M07 任务证据](modules/M07-task.md) · [M08 运行与交接](modules/M08-run-handover.md) · [M09 测试与缺陷](modules/M09-quality-defect.md) · [M11 系统 Agent 与技能](modules/M11-agent-skills.md) · [M13 项目与个人记忆](modules/M13-memory.md) |
| 设计师与业务评审者 | [交互走查指南](interaction-design.md) · [入项与权限](prototypes/access.html) · [决定到需求基线](prototypes/review.html) · [交付与缺陷](prototypes/delivery.html) · [知识与来源](prototypes/knowledge.html) |
| 测试与发布负责人 | [跨模块验收矩阵](acceptance.md) · [代码接入协议走查](intake-protocol.md) · [入口、功能及旅程映射](coverage.json) · [实际验收与出版回执](verification.json) |

**平台位置。** [文档库](http://127.0.0.1:5173/projects/19Q4K7PDARXQ9JHW6R6F/documents)中本次发布 20 份资料（首页说明沿用原编码升至修订 2，另新增 19 份）。原有其余四份仍可读。架构使用原生架构文档，模块规格使用需求文档，验收使用测试资料；未自动批准结构化需求。[设计工作台](http://127.0.0.1:5173/projects/19Q4K7PDARXQ9JHW6R6F/design)另有四份独立的 HTML 草稿及逐屏说明。原件与 TencentDB 记忆索引分别保存。HTTP、成员 CLI、MCP 均能列出 24 份当前资料；后两者对 M08 的带出处 grep、M13 指定修订的按行读取一致。实读 Tencent Wiki 和 Core 的 24 张资料卡，均为引用和摘要，没有正文字段。

**依据。** 使用固定源码运行 `6E2KCYTSQKBX9YGDJHKM`，基准提交 `92728fb`，冻结工作树快照 `256f8b15`。本次复核覆盖 677 个有指纹的文件，分配 83 个入口文件（全部 32 个 Core API 路由文件、18 个 Web 工作台、选定的 CLI/设备等入口）。UA、CodeGraph 负责定位；业务/模块规则取证方法辅助编写，结论回查指定源码。104 个功能有标识；7 条跨模块旅程另设验收，有界面用可操作原型，无界面的代码规格采纳用协议回执。672 处源码/测试行段已核对路径与范围，这是引用次数，不是 672 个独立行为测试。

**核验及实际修订。**

- 权限与状态的独立复核纠正了议题决定所需角色、未规划排期在失败后的表现、首次恢复如何绑定目标设备、资料与任务契约漂移的不同处置。验收矩阵使用可观察的状态和拒绝后的原数据。
- 隔离 PostgreSQL 上的七个代表性套件共 83 个测试通过。首次让会重置同一租约库的测试文件并发运行，观察到建表竞争和夹具串扰；用测试平台自己的独立库串行执行文件后通过。未据此推断生产并发性能。
- Chromium 在实际产品预览函数和沙箱策略下走查桌面与 390 像素窄屏。四个原型合计 144 次状态观察；修复了嵌入预览的片段跳转，以及窄屏单选圆点与文字错行。[浏览器结果](F:/workspace/team-synergy-runtime/doc-rebuild-v2-20261112/browser/browser-results.json) · [窄屏对照图](F:/workspace/team-synergy-runtime/doc-rebuild-v2-20261112/browser/contact-mobile-initial.png)。
- 独立新会话仅以可复用技能和另一个冻结样本为输入，从 Commander 14.0.3 的四个文件推导 3 个模块、7 个功能、6 条协议旅程。两条错误恢复路径经第二人执行抽查；未纳入样本的 argv 分派行为明确不推断。[异项目交付](F:/workspace/team-synergy-runtime/doc-rebuild-v2-20261112/transfer/book/README.md)。通过正常用例后再注入 7 种错误，验证源码漂移、漏入口、无效归属、错误行号、无效状态或验收号、新增未冻结入口均会阻止校验通过。

**复跑。** 使用 [reverse-project-docs](../../../skills/reverse-project-docs/SKILL.md)，输入指定版本源码、已知高阶背景、交付读者与重点旅程。复跑本次成品时，在仓库根目录执行：

```powershell
python skills/reverse-project-docs/scripts/check_dossier.py check --source F:/workspace/team-synergy-runtime/doc-rebuild-clean-20261112/source --manifest F:/workspace/team-synergy-runtime/doc-rebuild-clean-20261112/snapshot.json --book docs/rebuild-20261112/v2
```

独立设计稿和源码推导仍须由业务方按真实工作验收；性能目标、部署容灾、完整无障碍达标、所有终端行为及全量需求签认没有在本轮验证。下一次更新应保留功能编号，按变化的来源和下游旅程复查对应原型和验收。
