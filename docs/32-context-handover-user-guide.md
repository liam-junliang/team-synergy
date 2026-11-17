# 共享上下文和跨人交接使用指南

首版支持同一项目的两位成员，在各自电脑和 Agent 登录下继续同一个 builder 任务。平台保留原 Run 的作者和证据，为接手者创建关联的新 Run；代码由 Git 远端传输，上下文由平台保存。原执行人发布成功后可以离线。

## 支持范围

- Task 为 running 或 self_tested，源 Run 为 active；目标是另一位有效项目成员。
- 项目登记了一个 Git 仓库，两人各自拥有该仓库的读取权限，源执行人拥有推送交接分支的权限。
- 使用固定版本上下文、人工审阅摘要、精确 Commit/Tree 和独立 Worktree。
- 第一版默认建立新 Agent 会话，不迁移他人的 Agent Home、登录或原生会话文件。
- 不支持 LFS、submodule、二进制改动和多仓库交接；必要文本报告可放在快照或摘要，其他必要材料必须可以独立获取。
- 原生对话自动采集、离线 bundle 和二进制对象存储属于后续能力。

## 准备环境

构建工作区后，以下示例使用 tsp 和 agentd 命令。若尚未安装命令别名，可分别使用仓库根目录下的 node apps/cli/dist/index.js 与 node apps/agentd/dist/index.js 代替。

~~~powershell
pnpm install --frozen-lockfile
pnpm -r build
pnpm dev
~~~

Core 启动时自动应用增量迁移。0024 增加快照、交接、租约和幂等记录；0025 为共享材料添加事务栅栏。0025 首版使用全局材料写锁，优先保证一致性；大量并发项目可再细化为项目锁。

A、B 分别在自己的电脑登录。必须使用设备 Bearer 凭据；新的交接和上下文读取接口不会接受只声明 X-Principal-Code 的身份。

~~~powershell
tsp auth login --api http://<平台主机>:8080 --account <自己的账号> --password <自己的密码> --name <自己的设备名>
tsp auth whoami
~~~

每台机器保留自己的配置和仓库路径。远端电脑无需 PostgreSQL 连接串，agentd 已改为访问 Core HTTP API。

## A 准备工作成果

先编写并审阅摘要 JSON。除 goal 外，其他列表可留空；不要包含 Token、个人偏好或不准备共享的私有讨论。

~~~json
{
  "goal": "继续完成登录接口及并发测试",
  "completed": ["已实现统一的认证失败响应"],
  "remaining": ["补充并发和锁定边界测试"],
  "decisions_applied": ["不返回账号是否存在"],
  "assumptions": [],
  "open_questions": ["锁定时长尚待确认"],
  "failed_attempts": ["定时器方案存在并发重置问题"],
  "next_actions": ["先阅读接口实现，再补并发测试"],
  "evidence_refs": []
}
~~~

确认外部 Agent 已停止时：

~~~powershell
tsp task handover prepare <任务编码> --target <B用户编码> --run <A的Run编码> --summary .\summary.json --repo D:\src\project --repository <项目仓库编码> --agent-stopped
~~~

若 Agent 由本机 agentd 托管，使用 --managed-agent 代替 --agent-stopped，由本机进程记录执行停止。该参数要求实际存在相应托管会话，不会伪造停止确认。

可以追加 --paths src/auth.ts tests/auth.test.ts 明确选择文件。快照采用选中路径的最终工作区内容，包括选中删除和未跟踪文件；原暂存区划分不迁移。临时 index 不改变 A 的 HEAD、原 index 或工作区。

进入 prepare 后源 Run 暂停、旧租约失效；任务不会被标成完成。Git 快照推送到专用 refs/heads/acp/handover/<交接编码>。命令返回交接编码、代码快照及排除文件清单。

准备失败时先用 show 查看状态和原因。源停止授权有期限；过期后可以取消交接、明确恢复源 Run，再重新准备，不能继续使用失效授权。不要删掉本机交接 journal 来解决重试问题。

## Owner 发布

~~~powershell
tsp task handover show <交接编码>
tsp task handover publish <交接编码>
~~~

沿用现有任务分派规则，发布需要项目 Owner。Web 项目导航中的“交接”独立汇总项目任务的交接记录，可按“待我处理”、状态或人员筛选，审阅摘要、固定材料和版本差异后发布或接收；任务详情仍保留入口。“文档”用于管理接口、部署等项目资料，与运行交接分开。

来源材料已变化时，平台会拒绝发布或激活。Owner 可在 Web 写明理由，批准继续该准确旧基线；批准只适用于当时审阅的来源版本，后续再次变化仍会阻断。批准不会更新原交接包，也不能豁免任务合同变化。缺失或归档的必需固定文档必须先处理，不能自动改用最新正文。

## B 恢复到自己的电脑

~~~powershell
tsp task handover accept <交接编码>
tsp task handover restore <交接编码> --repo E:\src\my-project --dir E:\work\continuation
tsp task handover activate <交接编码>
~~~

--repo 是 B 自己的主仓库，远端必须与项目登记一致；--dir 必须是新的独立工作区。CLI 获取并校验准确 Commit、Tree 和上下文哈希，写入本机恢复 journal、必读卡和来源原文。已存在的脏目录不会被覆盖。

restore 成功不代表已接管执行。activate 会在事务中再次检查权限、设备、来源版本和恢复 attempt，然后把源 Run 标为 transferred、目标 Run 标为 active，更新任务责任人并签发新租约。

不带 --agent-command 的 activate 只激活执行权，返回 run_code、workspace_path 和 brief_path，便于在自己的工具中继续。用默认 Codex 托管启动新会话：

~~~powershell
agentd start --run <返回的新Run编码> --workspace E:\work\continuation --prompt <返回的brief_path>
~~~

默认 Codex 通过 stdin 读取必读卡，上下文不会插入 shell 命令。使用其他 Agent 时可以给 activate 或 agentd start 传 --agent-command；这条命令由本人维护，进程可通过 ACP_BRIEF_PATH 读取必读卡路径，并通过 ACP_RUN_CODE、ACP_TASK_CODE 获取平台身份。自定义命令不会自动把共享材料拼接成可执行脚本。

CLI 的 submit/verify 会为受租约保护的 Run 使用本人的当前设备租约；手工调用 API 必须带 X-Run-Lease 和 X-Execution-Epoch。这些凭据不进入共享包或正常 CLI 输出。

## 取消和恢复

~~~powershell
tsp task handover cancel <交接编码>
agentd resume --run <A原来的Run编码>
~~~

取消或过期后，B 尚未激活的准备 Run 会终止，A 保持 suspended，不会在任何电脑自动重启。只有源本人可以通过显式 resume 重新领取租约。已 transferred 的 Run 不能重新激活；要交回原人，应从当前执行者发起新的交接。

网络中断或响应丢失时保留 journal 并重试原命令。restore/activate 持久化首次请求和幂等键，重试不会创建第二个目标 Run。托管进程收到租约撤销会停止；断网时最多执行到有效租约到期。平台不能物理阻止离线编辑，也不会撤销用户自己的 Git 登录。

## 查看固定上下文

~~~powershell
tsp context show <上下文快照编码>
tsp context diff <上下文快照编码>
~~~

发布后的正文固定不变。未发布草稿仅源本人和 Owner 可读；已发布材料向有效项目成员共享。接收、恢复和激活仍只有目标本人及绑定设备可执行。

历史证据保留作者和 Run 来源，接手不使旧测试自动适用于新 Commit 或新环境。每条验收引用按集合检查，重复同一条不能代替完整覆盖；客户端报告的恢复结果也不等同远程证明。

## 验证边界

自动化验证覆盖 PostgreSQL/HTTP、两个独立身份与设备凭据、两个 Git 检出目录、准确恢复、幂等重试、租约失效、成员撤销、上下文漂移和后续提交/验证。真实 Codex/Claude 模型会话与两台物理电脑的联调需要实际设备与各自授权；同机隔离测试不替代该项现场验收。
