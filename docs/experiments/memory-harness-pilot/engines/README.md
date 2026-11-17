# 双引擎读取实测与适配边界

2026-11-10 在既有 `image-contract` 联调项目进行了两轮只读查询。使用 TeamSynergy 的 Bob 账号验证项目成员权限，用已封存的公开来源和属于 Bob 的经验作目标。Tencent 查询使用服务端 Wiki 凭据，OpenViking 查询使用独立成员凭据。操作前核对 Windows 监听进程、命令与地址的归属。导出的报告只含合成测试问法、计数、分数和公开版本。[本轮结果](live-results.json)

| 同一输入 | Tencent 项目 Wiki | OpenViking 本人经验，现有阈值 0.75 |
|---|---|---|
| `ASCII 6MiB 规范 Base64` | 4 条命中，找到目标共识 | 0 |
| `怎样验证Base64规范化和图片编码长度边界` | 4 条命中，找到目标共识 | 4 条命中，目标经验评分 0.80343 |
| `咖啡豆烘焙温度` | 0 | 0 |

第一轮使用关键词问法和无关对照。第二轮增加同一主题的自然语言问法，两轮保留同一账户、知识代次和阈值。Tencent 返回受控中文原文页和生成页的命中，由适配器映射回该代次的来源。4 条页面命中可以指向同一个来源。OpenViking 的 4 条中只有一个预先指定的目标。Alice 检索排除了目标经验，直接按 Bob 的 URI 读取返回 403。[探针](probe.mjs)

这组样本支持在检索响应中分别返回 `project` 与 `self` 的匹配来源和版本。Agent 可以请求一种或两种范围，对某个范围的空结果选择调整问法。按 TeamSynergy 的稳定来源与版本去重，保留命中的引擎位置。两端的分数和 ID 各有语义，跨引擎排序、准确率与模型泛化还需要单独评测。

## 底层契约

| 环节 | TencentDB Agent Memory | OpenViking | TeamSynergy 对接要求 |
|---|---|---|---|
| 会话进入 | 受管代理可从模型流量捕获，Core 的 `conversation/add` 接收显式消息，通过原生 L0 写入后调度提炼 | 宿主可向自己的 session 追加消息，再由 commit 归档并触发后台提炼 | 一个会话指定一个采集入口，识别用户、会话、项目及消息来源。先按内容拆分可共享项目片段与本人片段，分别向目标域传递允许处理的内容 |
| 私人与项目范围 | 服务、团队、成员、Agent、会话和 Wiki 资产分别有标识。实际 Wiki 适配器持有服务级凭据 | 此环境的个人经验是用户空间下由 Hub 写入的带 hash JSON。原生会话提炼使用用户／Peer 作用域和其内置模板 | 服务端根据实际会话和当前项目权限解析绑定。Peer／仓库路径可作平台绑定提示。原生提炼产物接入适配器时，须支持实际记忆类型与来源，现有 Hub 只接受其自定义 JSON schema |
| 可追溯标识 | 项目知识来源 ID、正文 hash、Wiki ID、来源文件名、Wiki 版本、生成页面是不同对象 | 经验 URI、记忆内容修订、会话 archive、提炼任务及 diff 各有用途 | 统一保存平台来源、修订／hash、引擎定位及受众。通过同一来源或经验证的关联桥接，不凭相似文本认定相同事实 |
| 变更与重放 | `conversation/add` 为每次输入生成消息 UUID。相同文件内容可复用 source hash，`rawWriteMany` 再次成功仍推进 Wiki version | append 和异步 commit 是不同阶段。此次验证服务 OpenAPI 声明了这两个路由。适配器已有的确定性经验 URI 适用于其自定义经验格式 | 用平台事件标识去重，每个目的地记录处理回执。远程结果不明时先核对原对象，恢复作业只处理尚缺的阶段。索引完成和业务记录生效分别记账 |
| 更新和撤回 | 文档原文、生成页、检索索引分层处理 | 会话提炼变更可审计，snapshot 支持路径树恢复，服务 OpenAPI 声明 restore | 撤回后立即过滤失效来源，并跟踪派生页／经验、索引的重新处理。当前请求和当前操作者决定推送等动作的授权 |

本轮在线实验执行 Wiki `get`、`raw/read` 及对照检索。已有中文 Markdown 共 460 字节，回读正文按 UTF-8 计算的 SHA-256 与冻结来源完全相同。候选方案可以让 Tencent raw 承载新试点文档的修订正文，TeamSynergy 记录版本清单、权限和当前修订指针。迁移前应以单独文件名保存每个不可变修订并验证冲突处理、清理与恢复。当前原生 raw 接口按名称写入，公共 HTTP 契约没有文档级 `expectedRevision`。部分格式的 `raw/read` 返回转换预览，迁移完整文件库还需验证原始二进制导出。待写中文原文应显式指定 `encoding: utf8`，传二进制时显式指定 `base64` 并核对原始字节哈希。[Wiki 路由](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2002196f2d7c22ea267cfcaf67c5a6fa861df681/MemoryKnowledge/src/routes/wiki.ts#L291) · [原文读写实现](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2002196f2d7c22ea267cfcaf67c5a6fa861df681/MemoryKnowledge/src/store/wiki-service.ts#L608)

本次 Windows 联调副本的 Tencent 基线为 `2002196f`，包含既有路径分隔符适配。本机 OpenViking `/health` 为 `0.5.3`，`/openapi.json` 声明会话创建、消息追加、提交、限定范围检索和快照恢复。实际调用覆盖个人经验读取及跨账号拒绝。会话自动提炼、恢复以及宿主插件表现仍需写入试验。上游阅读依据固定在 OpenViking `178a8cdf`，宿主插件版本和运行服务要分别核验。[会话](https://github.com/volcengine/OpenViking/blob/178a8cdfb41b51e7d24c4bf79a13cc54981e0ee8/docs/zh/api/05-sessions.md) · [快照与恢复](https://github.com/volcengine/OpenViking/blob/178a8cdfb41b51e7d24c4bf79a13cc54981e0ee8/docs/zh/api/11-snapshot.md) · [腾讯会话写入](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/2002196f2d7c22ea267cfcaf67c5a6fa861df681/MemoryCore/src/gateway/v2-router.ts#L665)

## 复现

在现有 Windows 联调主机的 TeamSynergy 根目录运行。脚本复用已安装的 Node、Hub 适配器、本机隔离 fixture 和成员身份，并以只读模式打开已有发布清单。阈值取运行配置。任一服务归属或发布映射改变都会影响复现，应核对现场配置与新结果。

```powershell
node docs/experiments/memory-harness-pilot/engines/probe.mjs
```

## 直接供宿主调用的项目级实验接口

`readProjectFixture({ mode, query })` 固定到隔离 fixture 的 Bob 与 `teamsynergy` 项目。`decisions` 在当前项目访问权限内读取已确认决定及其实际适用任务列表。`search` 将问题发往两端，按平台来源、版本和当前状态限定结果，并在远端调用后复核当前权限。允许返回的内容限于预选的图片契约决定和本人经验两条。结果含正文，供授权同账号的实验宿主使用。复验命令只输出聚合结果。[后端实现](project-reader.mjs) · [项目级复验](project-reader-results.json)

```powershell
node docs/experiments/memory-harness-pilot/engines/verify-project-reader.mjs
```
