# 数据接口与权限契约

此文用于联调和权限评审。以下四条调用链覆盖读取历史、冻结版本、提交异步事件和并发编辑；完整模块操作与负向场景见 M01–M13。对错误分支，调用方要同时检查 HTTP 状态和返回体的业务结果。

| 操作与发起者 | 请求与结果 | 冲突、降级与复核方式 |
| --- | --- | --- |
| 成员 Agent 获取资料原文 | `POST /projects/{project}/materials/read`；选择一种定位方式：来源引用、虚拟路径或对象定位。来源引用已经固定修订，不能再给 revision。文本按行或 UTF-16 偏移读取；二进制成功返回元数据及 binary_content，body/range 为空。 | 验证会话和项目身份，拒绝客户端提供未声明字段；来源不在本项目返回找不到。读取指定历史版时保留版本标志。见 `apps/core-api/src/routes/project-materials.ts:11-42`、`packages/contracts/src/project-materials.ts:16-40` |
| 有权限的负责人冻结需求基线 | POST /projects/{project}/requirement-baselines，提供 name、scope、reason 与每项 requirement_code 和 revision；父基线可显式给定。 | scope 是文字说明。拒绝跨项目、重复、未找到的修订、非法当前业务状态或无权操作。正文、验收及开放问题取所选修订；标题、状态和归属取冻结时对象。见 `apps/core-api/src/routes/baselines.ts:23-40`、`packages/application/src/baseline-use-cases.ts:153-199` |
| 自带 Agent 采集会话 | `POST /projects/{project}/memory/capture-events` 接收会话/原生事件、文本和可选业务绑定；返回 202 与采集记录。GET captures/{code} 查状态。 | 同一身份、项目、会话和原生事件键重送时比对规范化输入指纹；原文相同但绑定或版本不同仍可能冲突。只有本人 failed 且 attempts < 5 可重试；需澄清时以新事件补充。提取和外部投影可晚于接收。见 `apps/core-api/src/routes/memory.ts:111-129`、`apps/core-api/src/memory-capture-queue.ts:41-98` |
| 本人修订或撤回偏好 | PATCH /memory/personal/{source}，或 POST /memory/personal/{source}/withdraw；提交当前期望修订，编辑另给正文。 | 非本人无法读取根记录；旧 expectedRevision 返回冲突。先重读再重试，观察最新管理修订和投影清理状态。见 `apps/core-api/src/routes/personal-memory.ts:29-45`、`packages/application/src/personal-memory-use-cases.ts:88-114` |

| 主体 | 能读什么 | 写或管理的额外条件 | 负向验收 |
| --- | --- | --- | --- |
| 只读成员 | 在适用项目权限内读资料 | 代码理解另有限制，业务写入要求可写角色 | 同一账号分别读资料和含源码的代码知识，检查后者被拒。见 `packages/application/src/code-understanding-use-cases.ts:31-39` |
| 普通可写成员 | 当前项目内容及本人私有记忆 | 作者、执行者、任务状态等对象级条件继续生效 | 换另一成员读取私有记忆；在归档项目尝试提交改动。见 `packages/application/src/personal-memory-use-cases.ts:17-31`、`packages/application/src/project-access.ts:65-74` |
| 项目管理员与所有者 | 项目业务视图和相应管理动作 | 专属所有权操作再验 owner，明确区分 manage 与 owner；私有经验仍按账号鉴权 | 以管理员和实际所有者分别调用所有权相关操作，验证权限来源。见 `packages/application/src/project-access.ts:41-74` |
| 执行设备 | 已绑定会话的执行上下文与指定交接包 | 激活时再查目标身份、设备、尝试、状态和上下文 | 在 ready 后修改资料，以原回执尝试激活，核查负责人和源/目标 Run 状态。见 `packages/application/src/handover-use-cases.ts:410-446` |

数据字典的版本单位分别是需求修订、原型或文档修订、代码快照、个人记忆修订和投影作业的代数。API 协作者应按各自的单位重读和重试。接口中的公开编码用于定位；授权仍由服务器按当前身份检查。性能目标、SLA 和组织级保留期限待业务方确认。
