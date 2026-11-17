# TeamSynergy：功能需求规格

> 性质：全项目当前实现的逆向规格草稿。代码事实、文档目标、分析推断与未验证项分开；不是业务批准或已执行验收。
> 日期：2026-11-10。Run NSG3TKRB16Y9F6Y203WB；显式工作区草稿；base commit 92728fbec04cfa34fee4421cb0a9319d1b755164。
> Snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；Skill 2.2.0。输入为675份固定源码/产品资料及1份知识投影。
> 图谱负责导航，最终规则回查原始源码；历史实验稿不作为本轮功能事实权威。14业务章节与已有平台模块身份的映射可多对一。
> 分析产物SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8；代码manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9；候选输入manifest c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e。
> 插件版本：ua 2.9.8, codegraph 1.6.2；适配器及runtime摘要保存在已捕获的code-knowledge.json。

## 需求范围

范围是本次草稿中已发现、被证据支持的公开业务能力。能力清单逐项记录included/excluded/unknown和原因；全局汇总文档不替代模块细则与每条结构化需求。现有绑定身份及原父模块保持，业务章节只是读者导航。

## 功能需求

下表列出本轮全部结构化需求，模块规则稿提供对应BR、正文/状态/数据/例外和逐AC验证步骤。观察到的缺陷或兼容分支被忠实记录，同时保留目标政策待决。

| 章节 | 需求键 | 需求标题 | AC |
| --- | --- | --- | --- |
| M01 | REQ-GOV-ACCOUNT-PROVISION | 管理员开通账号、目录与凭证签发 | AC-GOV-ACCOUNT-PROVISION-CREATE, AC-GOV-ACCOUNT-PROVISION-INVALID, AC-GOV-ACCOUNT-PROVISION-ISSUE |
| M01 | REQ-GOV-ACCOUNT-SUSPEND | 账号禁用与安全恢复 | AC-GOV-ACCOUNT-SUSPEND-DISABLE, AC-GOV-ACCOUNT-SUSPEND-PROTECT, AC-GOV-ACCOUNT-SUSPEND-ENABLE |
| M01 | REQ-GOV-PASSWORD-LOGIN | 口令登录、初始密码门禁与锁定恢复 | AC-GOV-PASSWORD-LOGIN-SUCCESS, AC-GOV-PASSWORD-LOGIN-LOCK, AC-GOV-PASSWORD-LOGIN-EXPIRED, AC-GOV-PASSWORD-LOGIN-EXPIRED-SESSION, AC-GOV-PASSWORD-LOGIN-QUOTA, AC-GOV-PASSWORD-LOGIN-QUOTA-HOUR, AC-GOV-PASSWORD-LOGIN-QUOTA-SCOPE, AC-GOV-PASSWORD-LOGIN-QUOTA-RETENTION |
| M01 | REQ-GOV-PASSWORD-CHANGE | 验证当前口令后修改并收缩凭证 | AC-GOV-PASSWORD-CHANGE-KEEP, AC-GOV-PASSWORD-CHANGE-DENIED |
| M01 | REQ-GOV-INSTALLATION-SESSIONS | 同安装重登保留设备身份并生成独立会话 | AC-GOV-INSTALLATION-SESSIONS-RELOGIN, AC-GOV-INSTALLATION-SESSIONS-LIMIT, AC-GOV-INSTALLATION-SESSIONS-LEGACY |
| M01 | REQ-GOV-BIND-TOKEN | 一次性绑定令牌兑换 | AC-GOV-BIND-TOKEN-ONCE, AC-GOV-BIND-TOKEN-EXPIRED |
| M01 | REQ-GOV-DEVICE-AUTHORIZATION | 浏览器确认后向CLI一次性交换会话 | AC-GOV-DEVICE-AUTHORIZATION-APPROVE, AC-GOV-DEVICE-AUTHORIZATION-PENDING, AC-GOV-DEVICE-AUTHORIZATION-DENY |
| M01 | REQ-GOV-DEVICE-MANAGEMENT | 设备列表、更名及会话或安装吊销 | AC-GOV-DEVICE-MANAGEMENT-OWN, AC-GOV-DEVICE-MANAGEMENT-INSTALL, AC-GOV-DEVICE-MANAGEMENT-DENIED |
| M01 | REQ-GOV-WEB-AUTH-BOUNDARY | 浏览器会话、来源与CSRF边界 | AC-GOV-WEB-AUTH-BOUNDARY-WEB, AC-GOV-WEB-AUTH-BOUNDARY-CSRF, AC-GOV-WEB-AUTH-BOUNDARY-ACTOR |
| M01 | REQ-GOV-ACCOUNT-CLOSURE | 注销前责任交接与保留历史 | AC-GOV-ACCOUNT-CLOSURE-BLOCK, AC-GOV-ACCOUNT-CLOSURE-COMPLETE, AC-GOV-ACCOUNT-CLOSURE-CANCEL |
| M02 | REQ-GOV-TEAM-DIRECTORY | 团队建立、查看、重命名与个人排序 | AC-GOV-TEAM-DIRECTORY-CREATE, AC-GOV-TEAM-DIRECTORY-NAME, AC-GOV-TEAM-DIRECTORY-ORDER |
| M02 | REQ-GOV-TEAM-MEMBERS | 团队角色管理、移除预览和项目访问撤销 | AC-GOV-TEAM-MEMBERS-ROLE, AC-GOV-TEAM-MEMBERS-REMOVE, AC-GOV-TEAM-MEMBERS-BLOCK, AC-GOV-TEAM-MEMBERS-GOVERNANCE |
| M02 | REQ-GOV-PROJECT-CREATE-DIRECTORY | 创建项目并按有效访问展示与个人排序 | AC-GOV-PROJECT-CREATE-DIRECTORY-CREATE, AC-GOV-PROJECT-CREATE-DIRECTORY-VISIBLE, AC-GOV-PROJECT-CREATE-DIRECTORY-ORDER |
| M02 | REQ-GOV-PROJECT-EDIT-ARCHIVE | 项目资料修订、归档与恢复 | AC-GOV-PROJECT-EDIT-ARCHIVE-EDIT, AC-GOV-PROJECT-EDIT-ARCHIVE-ARCHIVE |
| M02 | REQ-GOV-PROJECT-EFFECTIVE-MEMBERS | 有效权限优先级与单独项目授权 | AC-GOV-PROJECT-EFFECTIVE-MEMBERS-PRECEDENCE, AC-GOV-PROJECT-EFFECTIVE-MEMBERS-ROLE, AC-GOV-PROJECT-EFFECTIVE-MEMBERS-HANDOFF, AC-GOV-PROJECT-EFFECTIVE-MEMBERS-ROSTER |
| M02 | REQ-GOV-PROJECT-POLICY | 项目访问策略预览及安全降权 | AC-GOV-PROJECT-POLICY-PREVIEW, AC-GOV-PROJECT-POLICY-DOWNGRADE |
| M02 | REQ-GOV-OWNERSHIP-TRANSFER | 有时限的所有权转移与接收 | AC-GOV-OWNERSHIP-TRANSFER-ACCEPT, AC-GOV-OWNERSHIP-TRANSFER-RECIPIENT, AC-GOV-OWNERSHIP-TRANSFER-CANCEL-EXPIRE |
| M02 | REQ-GOV-OWNERSHIP-RECOVERY | 失效负责人恢复与历史多Owner归一 | AC-GOV-OWNERSHIP-RECOVERY-RECOVERY, AC-GOV-OWNERSHIP-RECOVERY-DENIED, AC-GOV-OWNERSHIP-RECOVERY-LEGACY |
| M03 | REQ-GOV-MODULE-CATALOG | 功能模块目录、归档门槛与排序 | AC-GOV-MODULE-CATALOG-CATALOG, AC-GOV-MODULE-CATALOG-ARCHIVE, AC-GOV-MODULE-CATALOG-ORDER |
| M03 | REQ-GOV-FEATURE-ORGANIZATION | Feature归属、交付标记与完整排序 | AC-GOV-FEATURE-ORGANIZATION-CREATE, AC-GOV-FEATURE-ORGANIZATION-UPDATE, AC-GOV-FEATURE-ORGANIZATION-ORDER |
| M03 | REQ-GOV-FEATURE-SCHEDULE | Feature排期必须完整落在里程碑窗口 | AC-GOV-FEATURE-SCHEDULE-IN, AC-GOV-FEATURE-SCHEDULE-DENIED |
| M03 | REQ-GOV-PHASE-SCHEDULE | 阶段创建、日期与维护 | AC-GOV-PHASE-SCHEDULE-CREATE-EDIT, AC-GOV-PHASE-SCHEDULE-DATE |
| M03 | REQ-GOV-MILESTONE-DELIVERY | 里程碑负责人、交付门槛、窗口与汇总 | AC-GOV-MILESTONE-DELIVERY-CREATE, AC-GOV-MILESTONE-DELIVERY-COMPLETE, AC-GOV-MILESTONE-DELIVERY-WINDOW, AC-GOV-MILESTONE-DELIVERY-COUNTS, AC-GOV-MILESTONE-DELIVERY-LOOKUP |
| M03 | tsp-req-home-binding | 首页说明/参与指引与规范汇总 | AC-GOV-PROJECT-HOME-BIND, AC-GOV-PROJECT-HOME-DENIED |
| M04 | REQ-GOV-IDEA-COLLECTION | 想法录入、检索与作者管理 | AC-GOV-IDEA-COLLECTION-COLLECT, AC-GOV-IDEA-COLLECTION-MANAGE |
| M04 | REQ-GOV-TOPIC-AGGREGATION | 议题聚合、关系与维护权限 | AC-GOV-TOPIC-AGGREGATION-CREATE-LINK, AC-GOV-TOPIC-AGGREGATION-MISMATCH, AC-GOV-TOPIC-AGGREGATION-STATE-AUTH |
| M04 | REQ-GOV-TOPIC-DECISIONS | 讨论记录、反馈重开、决策替代与图片边界 | AC-GOV-TOPIC-DECISIONS-CYCLE, AC-GOV-TOPIC-DECISIONS-PERMISSION, AC-GOV-TOPIC-DECISIONS-IMAGES, AC-GOV-TOPIC-DECISIONS-IMAGES-HTTP, AC-GOV-TOPIC-DECISIONS-SUPERSEDES |
| M04 | REQ-GOV-TOPIC-WITHDRAWAL | 非决策记录软撤回与议题状态重算 | AC-GOV-TOPIC-WITHDRAWAL-RECALCULATE, AC-GOV-TOPIC-WITHDRAWAL-DENIED |
| M04 | REQ-GOV-DOCUMENT-REVIEW | 文档固定Revision评审、意见更新及人工结论 | AC-GOV-DOCUMENT-REVIEW-FIXED, AC-GOV-DOCUMENT-REVIEW-VOTE, AC-GOV-DOCUMENT-REVIEW-CONCLUSION |
| M05 | REQ-GOV-REQUIREMENT-DOCUMENT-CREATE-READ | 按模块发布可协作查阅的需求文档 | AC-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-CREATE, AC-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-COMPAT, AC-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-READ |
| M05 | REQ-GOV-REQUIREMENT-DOCUMENT-REVISION | 需求文档负责人修订并保留历史 | AC-GOV-REQUIREMENT-DOCUMENT-REVISION-REVISE, AC-GOV-REQUIREMENT-DOCUMENT-REVISION-DENIED |
| M05 | REQ-GOV-REQUIREMENT-CREATE-READ | 模块、来源文档或Feature中的结构化需求录入与检索 | AC-GOV-REQUIREMENT-CREATE-READ-CREATE, AC-GOV-REQUIREMENT-CREATE-READ-SCOPE, AC-GOV-REQUIREMENT-CREATE-READ-READ |
| M05 | REQ-GOV-REQUIREMENT-REVISION-BINDING | 需求内容版本与关系重绑分开处理 | AC-GOV-REQUIREMENT-REVISION-BINDING-CONTENT, AC-GOV-REQUIREMENT-REVISION-BINDING-LOCK, AC-GOV-REQUIREMENT-REVISION-BINDING-BIND |
| M05 | REQ-GOV-REQUIREMENT-LIFECYCLE | 需求确认、实施、交付与变更提议守卫 | AC-GOV-REQUIREMENT-LIFECYCLE-CONFIRM, AC-GOV-REQUIREMENT-LIFECYCLE-DELIVERY, AC-GOV-REQUIREMENT-LIFECYCLE-EDGES |
| M05 | REQ-GOV-BASELINE-FREEZE | 显式版本选择形成不可变需求基线 | AC-GOV-BASELINE-FREEZE-FREEZE, AC-GOV-BASELINE-FREEZE-PARENT, AC-GOV-BASELINE-FREEZE-INVALID, AC-GOV-BASELINE-FREEZE-SELECTION-DUPLICATE, AC-GOV-BASELINE-FREEZE-UNKNOWN-REQUIREMENT, AC-GOV-BASELINE-FREEZE-UNKNOWN-REVISION, AC-GOV-BASELINE-FREEZE-CROSS-PROJECT, AC-GOV-BASELINE-FREEZE-STATE-DRAFT, AC-GOV-BASELINE-FREEZE-ROLE-MEMBER, AC-GOV-BASELINE-FREEZE-PROJECT-ARCHIVED, AC-GOV-BASELINE-FREEZE-UNKNOWN-FIELD, AC-GOV-BASELINE-FREEZE-FIELD-SIZE, AC-GOV-BASELINE-FREEZE-SELECTION-SIZE, AC-GOV-BASELINE-FREEZE-METADATA-EMPTY, AC-GOV-BASELINE-FREEZE-IMMUTABLE |
| M05 | REQ-GOV-BASELINE-READ-COMPARE | 基线历史、完整性、差异与任务交接绑定 | AC-GOV-BASELINE-READ-COMPARE-HISTORY, AC-GOV-BASELINE-READ-COMPARE-DIFF, AC-GOV-BASELINE-READ-COMPARE-INTEGRITY, AC-GOV-BASELINE-READ-COMPARE-BINDINGS |
| M01 | REQ-GOV-CLI-AUTH-LOCAL | CLI认证本机状态、浏览器等待与退出恢复 | AC-GOV-CLI-AUTH-LOCAL-LOCAL, AC-GOV-CLI-AUTH-LOCAL-PARTIAL, AC-GOV-CLI-AUTH-LOCAL-BROWSER, AC-GOV-CLI-AUTH-LOCAL-INVALID |
| M06 | REQ-DEL-M06-01 | 任务看板、详情与依赖审计查询 | AC-M06-01-01, AC-M06-01-02 |
| M06 | REQ-DEL-M06-02 | 创建带来源及依赖的任务合同 | AC-M06-02-01, AC-M06-02-02 |
| M06 | REQ-DEL-M06-03 | 按当前状态修改合同或取消、首次绑定需求基线 | AC-M06-03-01, AC-M06-03-02, AC-M06-03-03 |
| M06 | REQ-DEL-M06-04 | 分派与失败任务返工重入 | AC-M06-04-01, AC-M06-04-02 |
| M06 | REQ-DEL-M06-05 | 领取任务与独立验证Run | AC-M06-05-01, AC-M06-05-02, AC-M06-05-03 |
| M06 | REQ-DEL-M06-06 | 自测证据与产物提交 | AC-M06-06-01, AC-M06-06-02 |
| M06 | tsp-req-task-verification | 验证、失败退回与管理关闭 | AC-M06-07-01, AC-M06-07-02, AC-M06-07-03 |
| M06 | REQ-DEL-M06-08 | 本机领取、外部工作区附着与上下文失败恢复 | AC-M06-08-01, AC-M06-08-02 |
| M06 | REQ-DEL-M06-09 | 设备租约、会话启动幂等与状态写入 | AC-M06-09-01, AC-M06-09-02, AC-M06-09-03 |
| M06 | REQ-DEL-M06-10 | 本机Agent托管、停止、同步与租约丢失保护 | AC-M06-10-01, AC-M06-10-02 |
| M07 | REQ-DEL-M07-01 | 项目工作空间初始化、绑定与识别 | AC-M07-01-01, AC-M07-01-02 |
| M07 | REQ-DEL-M07-02 | 项目仓库附着、克隆与本机状态诊断 | AC-M07-02-01, AC-M07-02-02, AC-M07-02-03 |
| M07 | REQ-DEL-M07-03 | 独立Run工作区创建、识别与可恢复清理 | AC-M07-03-01, AC-M07-03-02 |
| M07 | REQ-DEL-M07-04 | 准备交接、源停止确认与冻结草稿 | AC-M07-04-01, AC-M07-04-02 |
| M07 | REQ-DEL-M07-05 | 交接发布、固定上下文读取与差异检查 | AC-M07-05-01, AC-M07-05-02 |
| M07 | REQ-DEL-M07-06 | 目标接收、恢复尝试与客户端就绪回执 | AC-M07-06-01, AC-M07-06-02 |
| M07 | REQ-DEL-M07-07 | 交接激活与原请求重试 | AC-M07-07-01, AC-M07-07-02 |
| M07 | REQ-DEL-M07-08 | 取消、到期、漂移批准与显式源恢复 | AC-M07-08-01, AC-M07-08-02, AC-M07-08-03 |
| M07 | REQ-DEL-M07-09 | 安全Git交接快照、本机恢复及续接材料 | AC-M07-09-01, AC-M07-09-02, AC-M07-09-03 |
| M07 | REQ-DEL-M07-10 | 本机规范指引生成、范围差异与过期检查 | AC-M07-10-01, AC-M07-10-02 |
| M09 | REQ-DEL-M09-01 | 测试用例版本、检索与修订权限 | AC-M09-01-01, AC-M09-01-02 |
| M09 | REQ-DEL-M09-02 | 多来源测试资料与安全版本下载 | AC-M09-02-01, AC-M09-02-02 |
| M09 | REQ-DEL-M09-03 | 固定版本测试执行记录、结果汇总与过期提示 | AC-M09-03-01, AC-M09-03-02 |
| M09 | REQ-DEL-M09-04 | 失败测试结果关联或派生缺陷 | AC-M09-04-01, AC-M09-04-02, AC-M09-04-03 |
| M09 | REQ-DEL-M09-05 | 缺陷上报、修复任务与回归关闭 | AC-M09-05-01, AC-M09-05-02 |
| M10 | REQ-DEL-M10-01 | 规范技能包校验与草稿创建 | AC-M10-01-01, AC-M10-01-02 |
| M10 | REQ-DEL-M10-02 | 技能目录、版本可见性与授权读取 | AC-M10-02-01, AC-M10-02-02, AC-M10-02-03 |
| M10 | REQ-DEL-M10-03 | 技能修订、明确发布与归档恢复 | AC-M10-03-01, AC-M10-03-02 |
| M10 | REQ-DEL-M10-04 | 精确版本共享、项目交付资格与撤销 | AC-M10-04-01, AC-M10-04-02 |
| M10 | REQ-DEL-M10-05 | 项目技能安装、升级、别名及受限停用 | AC-M10-05-01, AC-M10-05-02 |
| M10 | REQ-DEL-M10-06 | 项目与Run固定技能清单、继承及当前授权重检 | AC-M10-06-01, AC-M10-06-02 |
| M10 | REQ-DEL-M10-07 | 本机技能清单检查、受管同步与失败恢复 | AC-M10-07-01, AC-M10-07-02 |
| M08 | REQ-INT-M08-01 | 按原始权限统一查询项目文档库 | REQ-INT-M08-01-AC01, REQ-INT-M08-01-AC02 |
| M08 | REQ-INT-M08-02 | 保护固定目录并管理普通目录树 | REQ-INT-M08-02-AC01, REQ-INT-M08-02-AC02 |
| M08 | REQ-INT-M08-03 | 创建、批量上传与修订原生文档并保留历史 | REQ-INT-M08-03-AC01, REQ-INT-M08-03-AC02, REQ-INT-M08-03-AC03, REQ-INT-M08-03-AC04, REQ-INT-M08-03-AC05 |
| M08 | REQ-INT-M08-04 | 对可读取资料的明确版本生成质量报告 | REQ-INT-M08-04-AC01, REQ-INT-M08-04-AC02 |
| M08 | REQ-INT-M08-05 | 保存多格式架构图并强制版本冲突检查 | REQ-INT-M08-05-AC01, REQ-INT-M08-05-AC02, REQ-INT-M08-05-AC03, REQ-INT-M08-05-AC04 |
| M08 | REQ-INT-M08-06 | 创建与查看多形式设计原型 | REQ-INT-M08-06-AC01, REQ-INT-M08-06-AC02 |
| M08 | REQ-INT-M08-07 | 修订原型、替换关联并保留版本 | REQ-INT-M08-07-AC01, REQ-INT-M08-07-AC02 |
| M08 | REQ-INT-M08-08 | 按权限下载明确版本的原型附件 | REQ-INT-M08-08-AC01, REQ-INT-M08-08-AC02 |
| M11 | REQ-INT-M11-01 | 准备安全的仓库与文本资料采集包 | REQ-INT-M11-01-AC01, REQ-INT-M11-01-AC02 |
| M11 | REQ-INT-M11-02 | 从已发布代码分析桥接原始固定快照 | REQ-INT-M11-02-AC01, REQ-INT-M11-02-AC02 |
| M11 | REQ-INT-M11-03 | 形成可追溯模块、规则、验收与验证计划 | REQ-INT-M11-03-AC01, REQ-INT-M11-03-AC02 |
| M11 | REQ-INT-M11-04 | 幂等提交并保护已发布项的来源 | REQ-INT-M11-04-AC01, REQ-INT-M11-04-AC02 |
| M11 | REQ-INT-M11-05 | 逐项审阅并固定批次发布依据 | REQ-INT-M11-05-AC01, REQ-INT-M11-05-AC02 |
| M11 | REQ-INT-M11-06 | 按固定依赖顺序逐项发布并保存局部结果 | REQ-INT-M11-06-AC01, REQ-INT-M11-06-AC02, REQ-INT-M11-06-AC03, REQ-INT-M11-06-AC04 |
| M11 | REQ-INT-M11-07 | 区分运行中恢复与新尝试续传 | REQ-INT-M11-07-AC01, REQ-INT-M11-07-AC02 |
| M11 | REQ-INT-M11-08 | 停止后续发布并保留来源映射与结果 | REQ-INT-M11-08-AC01, REQ-INT-M11-08-AC02 |
| M12 | REQ-INT-M12-01 | 按固定文档版本幂等创建修改稿任务 | REQ-INT-M12-01-AC01, REQ-INT-M12-01-AC02 |
| M12 | REQ-INT-M12-02 | 以有界候选和执行租约领取任务 | REQ-INT-M12-02-AC01, REQ-INT-M12-02-AC02 |
| M12 | REQ-INT-M12-03 | 以固定受限模型配置执行无工具草稿生成 | REQ-INT-M12-03-AC01, REQ-INT-M12-03-AC02 |
| M12 | REQ-INT-M12-04 | 保存完整修改稿、质量与提案摘要 | REQ-INT-M12-04-AC01, REQ-INT-M12-04-AC02 |
| M12 | REQ-INT-M12-05 | 请求者读取、取消和拒绝自己的修改稿 | REQ-INT-M12-05-AC01, REQ-INT-M12-05-AC02 |
| M12 | REQ-INT-M12-06 | 仅在明确哈希和当前授权下采用修改稿 | REQ-INT-M12-06-AC01, REQ-INT-M12-06-AC02 |
| M13 | REQ-INT-M13-01 | 分页检索全局团队与项目元数据 | REQ-INT-M13-01-AC01, REQ-INT-M13-01-AC02 |
| M13 | REQ-INT-M13-02 | 附原因修改治理元数据并阻止活动项目被归档 | REQ-INT-M13-02-AC01, REQ-INT-M13-02-AC02 |
| M13 | REQ-INT-M13-03 | 创建账号并签发受限初始凭据 | REQ-INT-M13-03-AC01, REQ-INT-M13-03-AC02 |
| M13 | REQ-INT-M13-04 | 禁用与恢复普通账号但不复活旧设备 | REQ-INT-M13-04-AC01, REQ-INT-M13-04-AC02 |
| M13 | REQ-INT-M13-05 | 以服务器本机命令恢复管理员初始口令 | REQ-INT-M13-05-AC01, REQ-INT-M13-05-AC02 |
| M13 | REQ-INT-M13-06 | 以CAS管理安全公开地址并向客户端投影 | REQ-INT-M13-06-AC01, REQ-INT-M13-06-AC02 |
| M13 | REQ-INT-M13-07 | 分页导出固定上界的脱敏全局审计 | REQ-INT-M13-07-AC01, REQ-INT-M13-07-AC02 |
| M13 | REQ-INT-M13-08 | 提供有权限的汇总指标和最小健康信息 | REQ-INT-M13-08-AC01, REQ-INT-M13-08-AC02 |
| M13 | REQ-INT-M13-09 | 在服务器本机运行有界只读完整性检查 | REQ-INT-M13-09-AC01, REQ-INT-M13-09-AC02, REQ-INT-M13-09-AC03 |
| M13 | REQ-INT-M13-10 | 输出待确认客户映射盘点而不回填归属 | REQ-INT-M13-10-AC01, REQ-INT-M13-10-AC02 |
| M13 | REQ-INT-M13-11 | 以精确公共路径分发CLI清单、脚本和包 | REQ-INT-M13-11-AC01, REQ-INT-M13-11-AC02 |
| M13 | REQ-INT-M13-12 | 在本机校验CLI包并按托管版本安装 | REQ-INT-M13-12-AC01, REQ-INT-M13-12-AC02, REQ-INT-M13-12-AC03 |
| M13 | REQ-INT-M13-13 | 按隐私哈希有界聚合登录安全事件 | REQ-INT-M13-13-AC01, REQ-INT-M13-13-AC02 |
| M14 | REQ-INT-M14-01 | 注册旁路插件并锁定兼容版本和摘要 | REQ-INT-M14-01-AC01, REQ-INT-M14-01-AC02 |
| M14 | REQ-INT-M14-02 | 捕获提交快照与显式草稿快照 | REQ-INT-M14-02-AC01, REQ-INT-M14-02-AC02 |
| M14 | REQ-INT-M14-03 | 以创建者和版本控制分析生命周期及检查点 | REQ-INT-M14-03-AC01, REQ-INT-M14-03-AC02, REQ-INT-M14-03-AC03 |
| M14 | REQ-INT-M14-04 | 发布经结构与证据预算验证的图产物 | REQ-INT-M14-04-AC01, REQ-INT-M14-04-AC02, REQ-INT-M14-04-AC03, REQ-INT-M14-04-AC04, REQ-INT-M14-04-AC05 |
| M14 | REQ-INT-M14-05 | 组合多仓库不可变视图并分离草稿与提交指针 | REQ-INT-M14-05-AC01, REQ-INT-M14-05-AC02 |
| M14 | REQ-INT-M14-06 | 统一CLI查询整体关系与原生代码符号 | REQ-INT-M14-06-AC01, REQ-INT-M14-06-AC02 |
| M14 | REQ-INT-M14-07 | 以原生UA阅读整体关系并定位codegraph证据 | REQ-INT-M14-07-AC01, REQ-INT-M14-07-AC02, REQ-INT-M14-07-AC03 |
| M14 | REQ-INT-M14-08 | 保留文档导出与原始源码桥接的可信度边界 | REQ-INT-M14-08-AC01, REQ-INT-M14-08-AC02 |

## 验收场景

每个AC都具有独立或明确连续的起始状态、操作者/权限、动作和可观察结果。所有计划均未执行；已有测试代码只标为defined/not_run。不存在以文档检查替代业务验收的通过结论。完整AC与计划见各结构化需求及验收追溯总表。

### 跨模块示例1

对应需求键：REQ-GOV-ACCOUNT-PROVISION / AC-GOV-ACCOUNT-PROVISION-CREATE。条件与结果：有效平台管理员提交合法且未占用的账号时，创建active用户并返回15分钟初始密码与expires_at，普通用户创建被user_forbidden拒绝。

前置/数据/身份：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：准备平台管理员A和普通用户B，确认mixed.user不存在。

操作：A创建account=" Mixed.User "、display_name="新人"；读管理员列表及目录。；恢复初始状态后以B提交相同创建。；检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。

预期：创建active用户并返回15分钟初始密码与expires_at，普通用户创建被user_forbidden拒绝。。状态：未执行；引用该需求已有验证计划，不新增通过结论。

### 跨模块示例2

对应需求键：REQ-DEL-M06-01 / AC-M06-01-01。条件与结果：同时间任务分页保持确定ID次序，计数及依赖图只覆盖当前用户可见任务。

前置/数据/身份：独立场景，执行前重置数据；有效项目成员；播种同一创建时间的3个可见任务、1个不可见项目任务

操作：查询limit=2再以offset=2查询；读取total及依赖图

预期：两页顺序按ID降序无重复，total=3，图中无不可见任务或跨可见域边，数据库不变。状态：未执行；引用该需求已有验证计划，不新增通过结论。

### 跨模块示例3

对应需求键：REQ-INT-M08-01 / REQ-INT-M08-01-AC01。条件与结果：同项目需求文档更新后，库关联条目返回相同原始代码和当前版本且不可通用编辑。

前置/数据/身份：准备active项目与active账号Member A，A为非Viewer的当前有效项目成员并有当前write权限，持有效普通登录session；原始需求文档D未归档且owner_principal_id=A，所属有效module固定。另建原生DOC作对照。记录D代码、当前revision=r、原始正文及历史数。使用专门可丢弃测试库，从独立基线重建；夹具尚未创建，计划not_run。

操作：以A的有效普通session通过原始需求文档修订入口，提交非空title/summary/content/change_summary，保留有效module归属，成功得到revision=r+1并记录新正文。；以A同一有效读取身份查询handoff并按D来源代码读详情，核对source_kind、current_revision、正文及通用can_edit。；以A调用通用项目文档修订入口，目标为关联来源代码D，提供合法非空字段；随后重读原始需求文档D和历史。

预期：原始修订成功为r+1；库关联条目仍使用D原始代码并展示当前r+1及新正文，通用can_edit=false。通用修订精确返回project_document_source_read_only；原始D仍为r+1，正文和历史不会因查询或被拒通用修订再改变。。状态：未执行；引用该需求已有验证计划，不新增通过结论。

## 权限边界

具体授权、当前状态、项目归属、历史epoch、Profile和当前会话要联合判断。管理错误文案可能写Owner而实现也允许Admin；资料查看权限与修改权限分开。每条需求的前提和拒绝结果才是对应场景的静态合同。

## 异常与边界

兼容路径、幂等重放、并发修订、部分成功、停止/恢复、宽松关联和异步完成按各模块实际条件写明。无法从源码或指定数据确认的业务意图保留在gaps/conflicts；不把异常行为自动批准为目标政策。

## 追溯

追溯链为业务章节→module/Feature→REQ→AC→verification_plan，外加稳定BR及原始文件SHA/行范围。graph节点用于导航，source.files中的原始证据用于代码事实。所有候选与原来源可提交前复验，历史证据不替换为当前工作目录。

## 来源索引

- README.md:7-25 (SHA-256 e184bee4116f2e9a8a39f3380746f563bcafbe73effc6b947e63b29dbe6ae900)
- apps/core-api/src/server.ts:58-79 (SHA-256 3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada)
- scripts/deploy-runtime.ps1:7-25 (SHA-256 08f61ec5fd1357d742b1cf324022b489a5e055884e30f6e0940aad61ab8b8a55)
- scripts/backup-database.ps1:13-25 (SHA-256 d075d59168bd29f39b9e073bd69bd78a2fbf51ae8cb9b80aa109f97ac316ffd8)
- packages/persistence/src/db.ts:39-56 (SHA-256 c75d60506a2a31687fb7484fab4dc3e7abc5db26aee0c8fcd72e0437b9d6915a)
- apps/core-api/src/metrics.ts:51-67 (SHA-256 71530541540cb0c55d057450e4a38c0999ec4ad294c3be04ef29b5c859c3a5be)
- apps/core-api/src/security-headers.ts:4-16 (SHA-256 e813b19fa0ef575830b8a47afccb830087f9942d4a8e0e8ad2bd3228f84542d4)
- apps/web/security-headers.mjs:2-14 (SHA-256 83cf612dc0a27a843b8aa4a9da92398c358224dcb4add564f78495b04c484a0a)
- apps/core-api/src/auth.ts:125-130 (SHA-256 2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8)
- apps/core-api/src/auth.ts:25-34 (SHA-256 2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8)
- docs/ops/runbook.md:3-18 (SHA-256 a5b05ba062ca88580fb620547d89b6d4ad0562399607cf04a784a3fc3f9475cf)
- docs/ops/runbook.md:44-53 (SHA-256 a5b05ba062ca88580fb620547d89b6d4ad0562399607cf04a784a3fc3f9475cf)
- apps/cli/src/db-plan-tenants.ts:4-23 (SHA-256 eddd756cfbbb85b73a3e686e5adfac09a10f478dab717b550995154d09dea6bb)
- packages/persistence/src/tenant-inventory-catalog.ts:2-10 (SHA-256 364db9ab615d42345226f2339b300bede6d42b717b0fbd324d9aa6fbb73c16c6)
- packages/domain/src/task-state-machine.ts:17-29 (SHA-256 2d9ff86b7e9eadc41545b53789cf74de0bdd620d26afb7e9c914ea060b88df26)
- packages/contracts/src/schemas.ts:81-83 (SHA-256 7b6e3612dd96c833a0cc802c582c400c81ec7fac6cd8ffc8b6ba0a77c76349f2)
- packages/application/src/user-use-cases.ts:80-119 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/user-use-cases.ts:125-154 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/user-use-cases.ts:231-259 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/auth-device.ts:75-80 (SHA-256 3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9)
- packages/application/src/team-use-cases.ts:48-64 (SHA-256 ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2)
- packages/application/src/team-use-cases.ts:35-38 (SHA-256 ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2)
- packages/application/src/team-use-cases.ts:148-187 (SHA-256 ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2)
- packages/application/src/project-structure-use-cases.ts:146-177 (SHA-256 040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13)
- packages/application/src/intake-entity-writers.ts:23-33 (SHA-256 bd7a3c4d153178187225424bb36431d1ecdfea83b39dd7574d8191719bfca696)
- packages/application/src/project-use-cases.ts:90-138 (SHA-256 e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6)
- packages/application/src/intake-entity-writers.ts:35-47 (SHA-256 bd7a3c4d153178187225424bb36431d1ecdfea83b39dd7574d8191719bfca696)
- packages/application/src/requirement-collaboration-use-cases.ts:164-200 (SHA-256 e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710)
- packages/application/src/requirement-collaboration-use-cases.ts:204-221 (SHA-256 e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710)
- packages/application/src/requirement-collaboration-use-cases.ts:240-263 (SHA-256 e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710)
- packages/application/src/requirement-collaboration-use-cases.ts:382-406 (SHA-256 e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710)
- packages/application/src/requirement-document-use-cases.ts:75-112 (SHA-256 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac)
- packages/application/src/requirement-document-use-cases.ts:206-245 (SHA-256 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac)
- packages/application/src/requirement-document-use-cases.ts:368-451 (SHA-256 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac)
- packages/application/src/requirement-document-use-cases.ts:384-413 (SHA-256 075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac)
- packages/application/src/task-service.ts:234-323 (SHA-256 54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f)
- packages/application/src/task-service.ts:570-591 (SHA-256 54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f)
- packages/application/src/project-use-cases.ts:359-527 (SHA-256 e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6)
- apps/core-api/src/routes/tasks.ts:122-149 (SHA-256 5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa)
- apps/cli/src/project-workspace.ts:23-85 (SHA-256 aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143)
- apps/cli/src/project-binding.ts:37-95 (SHA-256 355a4849a0840b43c797ba0466f462a4a67a14ff55a0c089d505fd1f5ae71871)
- apps/cli/src/project-workspace.ts:98-151 (SHA-256 aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143)
- apps/cli/src/project-workspace.ts:155-244 (SHA-256 aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143)
- packages/application/src/project-document-use-cases.ts:193-250 (SHA-256 bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317)
- packages/application/src/project-document-use-cases.ts:428-510 (SHA-256 bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317)
- packages/application/src/project-document-use-cases.ts:252-355 (SHA-256 bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317)
- packages/application/src/project-document-folders.ts:1-77 (SHA-256 c50e6f6a5c975a8ef69e9f9bbb981177d8ff038d46f3fc54a778b92c5be5974b)
- packages/application/src/testing-use-cases.ts:24-65 (SHA-256 370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858)
- packages/application/src/testing-use-cases.ts:67-169 (SHA-256 370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858)
- packages/application/src/testing-content.ts:22-51 (SHA-256 7f4c4782a7c2ba6588a39c7b1567e328ee2bb925dbb37589a3b6b35a3d5eabe7)
- packages/application/src/testing-content.ts:70-86 (SHA-256 7f4c4782a7c2ba6588a39c7b1567e328ee2bb925dbb37589a3b6b35a3d5eabe7)
- packages/application/src/skills-content.ts:5-95 (SHA-256 4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983)
- packages/application/src/skills-use-cases.ts:112-128 (SHA-256 3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6)
- packages/application/src/skills-use-cases.ts:37-110 (SHA-256 3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6)
- packages/application/src/skills-access.ts:54-74 (SHA-256 3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d)
- apps/cli/src/intake.ts:55-125 (SHA-256 5324d2f8c2e080c89dae5fbf66727b1dd66242339442a18162295890e968d61a)
- apps/cli/src/intake-materials.ts:1-145 (SHA-256 2a5cb2a29512cd9214fc0628b5de20a80c179a760527a96daf5ff9923e401f70)
- apps/cli/src/intake-code-knowledge.ts:14-68 (SHA-256 274697e231e69c7286ea79379446c6f1b7e166d0e6a9ad8e6c03a08a29db682a)
- apps/cli/src/intake-materials.ts:146-169 (SHA-256 2a5cb2a29512cd9214fc0628b5de20a80c179a760527a96daf5ff9923e401f70)
- packages/application/src/system-agent-use-cases.ts:139-174 (SHA-256 fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148)
- apps/core-api/src/routes/system-agent.ts:6-18 (SHA-256 629772266060f896c2be9803c00f7e15555071269067b51675106679ae6e2829)
- packages/application/src/system-agent-use-cases.ts:219-280 (SHA-256 fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148)
- packages/application/src/system-agent-use-cases.ts:312-322 (SHA-256 fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148)
- packages/application/src/admin-governance-use-cases.ts:12-102 (SHA-256 5b7a9594f324003455ed61fb8822256ab6fbff160cb2ae31923b7ebe4d40367a)
- apps/core-api/src/routes/admin-governance.ts:8-23 (SHA-256 81b1ab9520ef0311605f9dbafc6a2b60a0d106db6f19d4dee39a53638c78d1f3)
- packages/application/src/admin-governance-use-cases.ts:105-159 (SHA-256 5b7a9594f324003455ed61fb8822256ab6fbff160cb2ae31923b7ebe4d40367a)
- apps/core-api/src/routes/admin-governance.ts:24-48 (SHA-256 81b1ab9520ef0311605f9dbafc6a2b60a0d106db6f19d4dee39a53638c78d1f3)
- apps/cli/src/code-understanding-plugins.ts:90-154 (SHA-256 71605fed4bc11579fda464dbde8bd003c14dff7f0c9ddb16aa77e0325f42dcf1)
- apps/cli/src/code-understanding.ts:101-128 (SHA-256 d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4)
- apps/cli/src/code-understanding-snapshot.ts:26-112 (SHA-256 4699f4308d3e615009be35781c8b52029569dc2f73371d9c490ff639dc2980e9)
- apps/cli/src/code-understanding.ts:130-164 (SHA-256 d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4)
- packages/application/src/user-use-cases.ts:86-107 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/user-use-cases.ts:156-225 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/user-use-cases.ts:233-241 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/user-use-cases.ts:265-286 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/auth-device.ts:83-87 (SHA-256 3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9)
- packages/application/src/auth-use-cases.ts:44-85 (SHA-256 e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab)
- apps/core-api/src/auth.ts:76-95 (SHA-256 2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8)
- packages/application/src/auth-use-cases.ts:19-24 (SHA-256 e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab)
- packages/application/src/auth-use-cases.ts:58-85 (SHA-256 e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab)
- packages/application/src/auth-use-cases.ts:79-85 (SHA-256 e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab)
- apps/core-api/src/routes/auth.ts:98-112 (SHA-256 16c61a32fca5ef23060e494b18affc5996eb4f35a1783d22d72b4932da07c5f8)
- packages/application/src/user-use-cases.ts:189-225 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/auth-use-cases.ts:90-110 (SHA-256 e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab)
- packages/application/src/auth-rate-limit.ts:5-24 (SHA-256 5cb59034dd5df29f8e37fdc2de4ebfb960e82cdfdad67aa195cca9d36aebb634)
- packages/application/src/user-use-cases.ts:16-18 (SHA-256 98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45)
- packages/application/src/auth-rate-limit.ts:7-24 (SHA-256 5cb59034dd5df29f8e37fdc2de4ebfb960e82cdfdad67aa195cca9d36aebb634)
- apps/core-api/src/routes/auth.ts:84-112 (SHA-256 16c61a32fca5ef23060e494b18affc5996eb4f35a1783d22d72b4932da07c5f8)
- packages/application/src/auth-use-cases.ts:90-115 (SHA-256 e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab)
- packages/application/src/auth-use-cases.ts:92-110 (SHA-256 e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab)
