# Agent 记忆接入实验

[设计与分期](../../63-agent-memory-harness.md)采用六组可复核证据。实验产物都位于本目录。新接口仍处于研究阶段。

| 问题 | 复核入口 |
| --- | --- |
| 宿主能否实际发现和调用工具，hook 重放能否去重 | [Codex、独立 SDK 和 CLI 进程实验](transport/README.md) |
| 模型是否自行查找、是否找到相关内容、答复是否采用来源 | [模型调用与真实成员检索](agent-use/README.md) |
| 两个运行实例对同一句话返回什么 | [引擎能力与隔离检查](engines/README.md) |
| 整理器会不会把个人偏好、临时许可、讨论或落实状态分错 | [冻结样本](extraction/cases.json)与[发布判断](extraction/review-public.json) |
| 采纳后写回遇到并发、撤权或超时怎样恢复 | [事务回放](writeback/README.md) |
| 腾讯能否保留原文字节并防止覆盖旧版本 | [独立 Wiki 读写结果](storage/result.json) |

## 自然语言提炼

在仓库根目录运行。本机模型为 Ollama 的 hub-qwen2.5:latest，探针仅向 127.0.0.1 发送合成会话。运行会覆盖对应实验报告。每条报告记录模型摘要和提示词哈希。

```powershell
node docs/experiments/memory-harness-pilot/extraction/probe.mjs baseline development
node docs/experiments/memory-harness-pilot/extraction/probe.mjs scoped development
node docs/experiments/memory-harness-pilot/extraction/probe.mjs bound development
node docs/experiments/memory-harness-pilot/extraction/probe.mjs bound holdout
node docs/experiments/memory-harness-pilot/extraction/review-public.mjs
```

初始划定 4 个开发场景和 4 个预留场景。模型仅收到消息和输出 schema。逐例核对预先标注的归属、状态、来源消息与摘录锚点，额外的非预期分类也计一次失败。第一轮未核实场景的额外猜测被标成讨论，失败原因是多保留了一条已澄清的内容。第二轮将正文作为来源 ID，四例均未通过。第三轮将可选 ID 与合法标签直接写入解码 schema，开发例为 3/4，预留例为 4/4。一次性推送许可仍被分成项目讨论。

附加的公共资格复核只评估最终模型给出的 7 条 project 候选。另一次提示从同一模型读取用途判断，再与原归属和消息角色核对。唯一错误候选被暂缓，6 条合格公共摘录中有 3 条也被暂缓。此测量体现了误发布与漏发布的取舍。来源可定位、语义准确、授权有效是三项不同检验。[开发组](extraction/bound-development.json) · [预留组](extraction/bound-holdout.json)

## 文档正文

受管 Windows 本地 fixture 存在并运行时，下列命令新建有唯一名称的临时 Wiki。在隔离资源写入并读回合成的中文 Markdown，模拟两个基于同一初稿的编辑者，最后复核 team、Wiki ID 与唯一名称并清理。命令不涉及业务文档或已有 Wiki 的编辑。结果只保存测量和临时资源回执。中断时可用该回执定位本次资源。

```powershell
node docs/experiments/memory-harness-pilot/storage/wiki-roundtrip.mjs --scratch-wiki
```

本轮测量覆盖 UTF-8 与 CRLF、同名文件的迟到写入、按修订命名后取回旧版。生产评估还需要断电恢复、并发 CAS、附件字节导出、按来源撤权与备份恢复。当前实测由 TeamSynergy 成员试验、两个已部署引擎、真实本地模型和合成事务共同构成，各环节的测试入口和范围见上表。
