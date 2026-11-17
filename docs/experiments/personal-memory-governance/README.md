# 真实个人记忆治理验证

入口：`apps/core-api/tests/native-memory-personal-governance.mjs`。本目录每次运行使用独立 run-id；已存在的结果目录拒绝覆盖。

离线检查（不访问服务、不调用模型）：

```powershell
node apps/core-api/tests/native-memory-personal-governance.mjs --check
```

真实运行需先由执行者确认隔离服务可运行；私有环境通过本机配置加载，不在命令行或报告中放密钥：

- `TSP_TEST_DATABASE_URL`：loopback PostgreSQL 的专用 test 命名库，允许创建隔离数据库。禁止传业务库、恢复库或演练库；即使某个 harness helper 自身会建隔离库，也要遵守导入链上的测试保护。
- `TSP_MEMORY_ENGINES_FILE`：绝对路径，初始 `projects={}`、`accounts={}`；配置腾讯项目自动分配和 OpenViking 个人用户自动分配。现有共享账号及已有用户不允许删除。
- `TSP_EVAL_GATEWAY_URL`：本地 Magpie 的 `/v1` 地址。
- `TSP_EVAL_GATEWAY_TOKEN`：仅本机环境中的认证值。
- `TSP_EVAL_MODEL=workbuddy/deepseek-v4.1-flash`、`TSP_EVAL_FAMILY=deepseek-v4.1-flash`。
- 可选 `TSP_PROBE_DSH_BIN`、`TSP_PROBE_OPENCODE`：已安装官方 harness 路径。

```powershell
node apps/core-api/tests/native-memory-personal-governance.mjs --run-id 20261111-governance-a --include-opencode
```

运行在全新 PostgreSQL、独立项目 Wiki 和两个新 fixture 用户上。实际 DSH 会话输入的选定用户发言，通过可信控制器以同一会话 ID 和稳定事件 ID 写入 CLI stdin；不将此桥接宣称为 DSH/OpenCode 原生自动采集。收件箱整理直接执行生产 worker，分类与 Agent 都用指定 Flash 模型。OpenCode 开关增加两个空白会话读取。

覆盖无任务采集、同会话修订、空白会话接手、撤回后不可检索、物理副本删除、本人历史、Bob 的公共讨论与个人隔离、跨项目适用范围及无目标采纳澄清。记录实际模型、harness 版本、空白会话标记、工具与来源轨迹。错误重试和并发晚写由单测负责，不混入 Agent 成功率。

执行清理前核验 Wiki 身份、Core 完整作用域和新个人用户初始不存在证据；只删本次创建的资源。报告保留失败和清理状态，任何必要检查未通过均不能标记 accepted。

正式 Agent 回答使用生产 guidance，不加 writer 专用测试提示。模型原文语义与机械事实校验分别记录：机械校验检查 discussed 来源、当前记录、隐私隔离及 readSources 回读；独立 Agent 阅读原文再判断回答有没有将讨论写成已实施，没有真人参与评分。独立审查完成前，不能将 mechanicalAccepted 等同于完整 accepted。

投影等待遵守生产 outbox 的真实 retry lease，最多 3 次、120 秒；每次失败、重试、最终精确读回均保留，不能靠强制改时间或手工标 synced 通关。失败轮次不覆盖。固定单条诊断不经过 Agent/分类器，单独记录，不能混作模型成功率。

本轮一次测试错误曾清空本地业务库，已从事前校验备份恢复至独立运行库，记录见 [recovery.json](recovery.json)；后续安全重跑见 [regression-verification.json](regression-verification.json)，120/120 且专用库精确清理。不得将旧的误用业务库回归当作安全通过证据。

最终生产 guidance 完整轮为 [20261111-governance-g](20261111-governance-g/acceptance.json)：9/9 事实检查、42/42 指定 Flash 响应、6 个 DSH 会话和 2 个 OpenCode 空白会话，资源清理完整。原 `result.json` 不回写，独立原文审查和最终验收另存。旧失败轮次的原因和范围见 [实现报告](../../75-personal-memory-governance.md)。
