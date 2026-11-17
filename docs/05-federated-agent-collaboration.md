# 不同人的 Agent 如何协作

## 联邦式协作

每个人可以继续使用自己的 Codex、Claude Code、OpenCode、Prompt、模型和个人知识库。平台只统一：

- 如何加入项目。
- 如何获取项目正式状态。
- 如何领取和提交任务。
- 如何发布提案、决策、产物和证据。

平台不控制 Agent 如何思考，也不要求所有 Agent 具有相同观点。

## 人—Agent 责任关系

```text
Human Principal
→ Agent Profile
→ Agent Run
→ Task
→ Artifact / Evidence
```

审计表达应能够回答：谁授权了哪个 Agent，以什么角色，在什么任务和工作区中，提交了什么结果。

## 双记忆模型

### 个人记忆

- 个人经验和方法。
- 私有知识库和提示词。
- 尚未公开的想法和临时分析。

### 项目记忆

- 已确认需求和术语。
- 已生效决策和契约。
- 任务、代码、测试和发布状态。
- 风险、阻塞和事故记录。

优先级：

```text
已生效项目决策
> 正式契约
> 当前任务要求
> 个人经验与偏好
```

个人 Agent 可以质疑正式决策，但必须通过 Proposal，而不能静默覆盖共同状态。

## 信息差异的处理

| 差异来源 | 解决机制 |
|---|---|
| 版本不同 | Snapshot 版本与变更摘要 |
| 术语不同 | 项目术语表和状态机 |
| 上下文不同 | 公共 Feature Context Pack 与来源引用 |
| 观点不同 | Proposal → Review → Decision |

## 结构化协作结论

不需要同步全部思考过程，只同步会影响协作的结论：

```yaml
type: PROPOSAL
feature_id: FEATURE-12
base_snapshot: 18
author:
  principal: user-liam
  agent_profile: builder
summary: 登录限流应以账号和设备组合判断
facts:
  - 仅按 IP 限流会影响共享网络用户
assumptions:
  - 设备标识可稳定获得
impact:
  backend: 需要增加限流键规则
  testing: 需要增加共享 IP 场景
evidence:
  - INCIDENT-7
```

## 决策治理

平台识别分歧，但不通过 Agent 无限辩论或简单投票强行消除分歧。

```text
Proposal
→ 提取共同事实、不同假设和缺失证据
→ 相关角色 Review
→ 明确的 Decision Owner 决定
→ 形成版本化 Decision
→ 通知受影响 Task/Run
```

决策权应来自项目角色和人，而不是 Agent 的表达长度或模型能力。

## 单人身兼多职

早期推荐三个 Profile：`planner`、`builder`、`verifier`。Profile 定义职责和权限，设备只是运行节点。

多 Agent 审核可以增加技术视角，但不等同于多人责任隔离。生产、安全、资金等高风险变更仍应争取第二个人复核。

