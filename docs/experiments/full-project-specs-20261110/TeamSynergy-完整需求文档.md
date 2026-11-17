# TeamSynergy 全项目现状需求规格

> 全项目现状需求草稿；代码观察、文档目标、分析推断与未验证事项分开。未批准为目标需求。
> 日期：2026-11-10。14个业务章节；112条结构化需求；299组AC/验证计划；13类共享档案。
> Run NSG3TKRB16Y9F6Y203WB；显式工作区草稿；base commit 92728fbec04cfa34fee4421cb0a9319d1b755164。
> Snapshot 06376ab6287ee2d55caa79fc34257896e53ad0577a2b678947888024834468fa；代码manifest 0725fd3bb7867a6d7bba008b6af001c70f66b3c1dbf296b59ad95172eec6bdb9。
> 分析产物SHA-256 691ab67f0c3a41a5bce1e59ca5ae83d99044ddfbfc5e026afb92183e681615c8；候选输入manifest c832ac2345121f95b5f5d83da6275c79610bc4023b829568ee1ceeb2fadf307e；Skill 2.2.0。
> 675份原始固定输入＋1份知识文档；675文件定位覆盖不是全部语义或运行行为的验证。旧实验稿仅用于最终对照，不作为本轮功能事实权威。
> 原始源码位于该run本机固定副本，未提交内容没有GitHub提交永久链接。请用同run CLI和原始文件hash/range核对，不能把未来当前分支文件替代为历史证据。

## 阅读方式

先按业务章节阅读角色、行为与例外，再看AC和计划。规则细表放在对应模块稿，13类共享资料提供上下文、架构、API/数据、安全、运维及风险。一个业务章节可以共享既有平台module身份；本轮不重新挂接已有绑定，也不将源码观察自动确认为政策。

| 章节 | 业务范围 | 需求数 | 规则文档 |
| --- | --- | ---: | --- |
| M01 | 身份、会话与账号生命周期 | 11 | [查看](modules/m01-rules.md) |
| M02 | 团队、项目与权限治理 | 8 | [查看](modules/m02-rules.md) |
| M03 | 项目结构与首页 | 6 | [查看](modules/m03-rules.md) |
| M04 | 需求发现、决策与评审 | 5 | [查看](modules/m04-rules.md) |
| M05 | 需求文档、结构化需求与基线 | 7 | [查看](modules/m05-rules.md) |
| M06 | 任务执行与 Run | 10 | [查看](modules/m06-rules.md) |
| M07 | 交接恢复与本机工作空间 | 10 | [查看](modules/m07-rules.md) |
| M08 | 项目资料与设计资产 | 8 | [查看](modules/m08-rules.md) |
| M09 | 测试与缺陷 | 5 | [查看](modules/m09-rules.md) |
| M10 | 技能版本与交付 | 7 | [查看](modules/m10-rules.md) |
| M11 | 代码与资料接入、规则化需求生产 | 8 | [查看](modules/m11-rules.md) |
| M12 | 系统文档 Agent 修改稿 | 6 | [查看](modules/m12-rules.md) |
| M13 | 平台治理与运维 | 13 | [查看](modules/m13-rules.md) |
| M14 | 项目代码理解与插件知识 | 8 | [查看](modules/m14-rules.md) |

## 结构化需求正文

## M01 · 身份、会话与账号生命周期

对应平台父模块：`GOV-M01`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-GOV-ACCOUNT-PROVISION · 管理员开通账号、目录与凭证签发

**观察类型：** `observed_in_code`

**摘要：** 管理员开通账号、目录与凭证签发的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 有效平台管理员；目录读取也允许有效普通账号

**触发：** 创建用户或签发初始密码、绑定令牌

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 从认证身份确定操作者，规范化账号并检查管理员权限。
- 创建有效账号并返回短时初始密码；管理员配置列表与普通用户目录返回不同字段。
- 按用户状态和管理员保护规则签发新凭证。

#### 业务规则

- BR-GOV-ACCOUNT-PROVISION-CREATE：条件：有效平台管理员提交合法且未占用的账号；判定/结果：创建active用户并返回15分钟初始密码与expires_at，普通用户创建被user_forbidden拒绝。
- BR-GOV-ACCOUNT-PROVISION-INVALID：条件：账号格式无效、重复或显示名空白；判定/结果：分别返回user_account_invalid/user_account_exists/user_display_name_required，不创建第二条账号。
- BR-GOV-ACCOUNT-PROVISION-ISSUE：条件：管理员对有效普通用户重新签发凭证；判定/结果：绑定令牌24小时到期且替换旧令牌；初始密码重置15分钟到期并吊销全部设备；不能重置其他平台管理员密码。

#### 状态变化/保留

- 创建user和user.created审计；签发绑定令牌替换旧hash/expiry。
- 重置初始密码设置must_change_password并吊销该用户设备；审计在重置事务之后单独写入，不宣称整条操作原子。

#### 数据契约

- account去首尾空白并转小写，匹配^[a-z0-9][a-z0-9._@-]{2,63}$；display_name非空。
- 新账号初始密码8字符、有效期15分钟，必须修改；绑定令牌有效期24小时，只保存哈希。
- 用户目录仅返回active用户的user_code/account/display_name；管理员列表额外含status/is_system_admin/must_change_password/pending_deletion/deleted_at。

#### 异常与边界

- 条件：有效平台管理员提交合法且未占用的账号；处理：创建active用户并返回15分钟初始密码与expires_at，普通用户创建被user_forbidden拒绝。
- 条件：账号格式无效、重复或显示名空白；处理：分别返回user_account_invalid/user_account_exists/user_display_name_required，不创建第二条账号。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-ACCOUNT-PROVISION-CREATE` | 有效平台管理员提交合法且未占用的账号时，创建active用户并返回15分钟初始密码与expires_at，普通用户创建被user_forbidden拒绝。 |
| `AC-GOV-ACCOUNT-PROVISION-INVALID` | 账号格式无效、重复或显示名空白时，分别返回user_account_invalid/user_account_exists/user_display_name_required，不创建第二条账号。 |
| `AC-GOV-ACCOUNT-PROVISION-ISSUE` | 管理员对有效普通用户重新签发凭证时，绑定令牌24小时到期且替换旧令牌；初始密码重置15分钟到期并吊销全部设备；不能重置其他平台管理员密码。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-ACCOUNT-PROVISION-CREATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：准备平台管理员A和普通用户B，确认mixed.user不存在。
- 操作：
  1. A创建account=" Mixed.User "、display_name="新人"；读管理员列表及目录。
  2. 恢复初始状态后以B提交相同创建。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：创建active用户并返回15分钟初始密码与expires_at，普通用户创建被user_forbidden拒绝。

**AC-GOV-ACCOUNT-PROVISION-INVALID** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：管理员A；已存在账号mixed.user。
- 操作：
  1. 分别创建ab、mixed.user和合法新账号但空白display_name；每次后读取列表。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别返回user_account_invalid/user_account_exists/user_display_name_required，不创建第二条账号。

**AC-GOV-ACCOUNT-PROVISION-ISSUE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：管理员A、普通用户U有设备D；另一管理员Z；U已有绑定令牌T。
- 操作：
  1. A为U签发新绑定令牌再尝试旧T登录。
  2. 独立重置U初始密码，检查D会话不可解析及must_change_password。
  3. 独立尝试重置Z密码。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：绑定令牌24小时到期且替换旧令牌；初始密码重置15分钟到期并吊销全部设备；不能重置其他平台管理员密码。

#### 来源与已有测试定义

- `packages/application/src/user-use-cases.ts:80-119`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `packages/application/src/user-use-cases.ts:125-154`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `packages/application/src/user-use-cases.ts:86-107`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `packages/application/src/user-use-cases.ts:156-225`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`

- `packages/application/tests/user-use-cases.test.mjs` · createUser：只有系统管理员可创建，user_id 自动编码并返回初始密码 · `defined`；仅检查固定源码中的测试定义，未执行；此条不证明运行成功。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 开通与凭证签发的审计部分在事务外；审计写入失败后的部分成功需运行验证，不能承诺整体回滚。
- 密码交付渠道、实际管理员任命及生产TTL配置未验证。

### REQ-GOV-ACCOUNT-SUSPEND · 账号禁用与安全恢复

**观察类型：** `observed_in_code`

**摘要：** 账号禁用与安全恢复的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 有效平台管理员

**触发：** 禁用或恢复普通账号

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 检查操作者平台管理员身份，保护本人及管理员目标。
- 禁用目标并清空绑定令牌；恢复时在事务中重新检查状态和注销标志。
- 恢复普通账号前吊销旧设备，避免旧会话和租约复活。

#### 业务规则

- BR-GOV-ACCOUNT-SUSPEND-DISABLE：条件：管理员禁用有效普通账号；判定/结果：status变disabled，绑定令牌清空，旧登录令牌立即不可用；重复禁用返回disabled。
- BR-GOV-ACCOUNT-SUSPEND-PROTECT：条件：操作者尝试禁用本人或平台管理员；判定/结果：本人返回user_self_disable，其他管理员返回user_system_admin_protected，账号状态保持active。
- BR-GOV-ACCOUNT-SUSPEND-ENABLE：条件：被禁用普通账号无注销标志；判定/结果：恢复active并吊销历史设备/会话/租约；已注销或pending_deletion账号拒绝user_deleted。

#### 状态变化/保留

- 禁用不在该方法逐个吊销设备，令牌解析因用户disabled立即拒绝。
- 恢复过程吊销设备及相应会话/租约，清除绑定令牌，保留业务历史。

#### 数据契约

- status为active/disabled；deleted_at或pending_deletion阻止恢复。
- 重复禁用已禁用用户或恢复已有效用户返回当前状态。

#### 异常与边界

- 条件：管理员禁用有效普通账号；处理：status变disabled，绑定令牌清空，旧登录令牌立即不可用；重复禁用返回disabled。
- 条件：被禁用普通账号无注销标志；处理：恢复active并吊销历史设备/会话/租约；已注销或pending_deletion账号拒绝user_deleted。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-ACCOUNT-SUSPEND-DISABLE` | 管理员禁用有效普通账号时，status变disabled，绑定令牌清空，旧登录令牌立即不可用；重复禁用返回disabled。 |
| `AC-GOV-ACCOUNT-SUSPEND-PROTECT` | 操作者尝试禁用本人或平台管理员时，本人返回user_self_disable，其他管理员返回user_system_admin_protected，账号状态保持active。 |
| `AC-GOV-ACCOUNT-SUSPEND-ENABLE` | 被禁用普通账号无注销标志时，恢复active并吊销历史设备/会话/租约；已注销或pending_deletion账号拒绝user_deleted。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-ACCOUNT-SUSPEND-DISABLE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：管理员A和用户U；U有有效登录令牌和绑定令牌。
- 操作：
  1. A禁用U，使用U旧会话whoami及绑定令牌登录；A再次禁用。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：status变disabled，绑定令牌清空，旧登录令牌立即不可用；重复禁用返回disabled。

**AC-GOV-ACCOUNT-SUSPEND-PROTECT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立管理员A、Z有效。
- 操作：
  1. A分别禁用A、Z；读取两者状态。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：本人返回user_self_disable，其他管理员返回user_system_admin_protected，账号状态保持active。

**AC-GOV-ACCOUNT-SUSPEND-ENABLE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：管理员A；禁用U仍保存历史设备/租约；另独立设置已注销或待注销目标。
- 操作：
  1. 恢复U，校验旧令牌不可用并重新登录可用。
  2. 分别恢复已注销或待注销目标并读取状态。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：恢复active并吊销历史设备/会话/租约；已注销或pending_deletion账号拒绝user_deleted。

#### 来源与已有测试定义

- `packages/application/src/user-use-cases.ts:231-259`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `packages/application/src/auth-device.ts:75-80`；SHA-256 `3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9`
- `packages/application/src/user-use-cases.ts:233-241`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `packages/application/src/user-use-cases.ts:265-286`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `packages/application/src/auth-device.ts:83-87`；SHA-256 `3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 恢复不是恢复已注销账号；普通账号启用后口令保留，实际交付新凭证方式需另行决定。

### REQ-GOV-PASSWORD-LOGIN · 口令登录、初始密码门禁与锁定恢复

**观察类型：** `observed_in_code`

**摘要：** 口令登录、初始密码门禁与锁定恢复的当前行为：覆盖8组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 账号持有人

**触发：** 提交密码登录请求

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 规范化账号，拒绝空账号/空密码/超过128字符口令。
- 校验密码并在用户行锁内重新核对hash和锁定状态；记录失败与锁定观察。
- 初始口令有效才建立新设备会话；成功清零失败计数。

#### 业务规则

- BR-GOV-PASSWORD-LOGIN-SUCCESS：条件：用户active、密码正确且初始密码未过期；判定/结果：登录返回user/device/session编码和独立会话凭证；初始密码会话访问业务接口被password_change_required拒绝。
- BR-GOV-PASSWORD-LOGIN-LOCK：条件：默认配置下同一已存在账号连续5次错误口令；判定/结果：第5次返回凭证错误并落锁，锁内正确口令也被slow_down拒绝；到期后正确登录清零计数。
- BR-GOV-PASSWORD-LOGIN-EXPIRED：条件：初始口令expiry不晚于当前时间，且本场景用户没有任何有效旧会话；判定/结果：应用新登录返回auth_initial_password_expired，HTTP统一401且无新增设备会话；管理员重新签发未过期初始密码是一条恢复路径，使用新密码可重新登录，不声明这是所有场景唯一恢复方式。
- BR-GOV-PASSWORD-LOGIN-EXPIRED-SESSION：条件：初始密码到期前已登录，原session仍有效且用户未禁用/设备未吊销、当前口令hash未变；判定/结果：到期后用旧初始密码发起新登录仍401；使用原有效session和正确当前初始密码可自行改密，清除must_change_password/password_expires_at；新密码随后可登录，原证明改密的session保留。
- BR-GOV-PASSWORD-LOGIN-QUOTA：条件：默认分钟配额：同password scope、IP及账号在同一分钟连续6次请求；判定/结果：前5次通过限流后因不存在账号而401 unauthorized；第6次429 slow_down且Retry-After=60；两个hash键的minute_count/hour_count均为6，说明拒绝也计数。t0+60秒的新请求通过分钟限流后401，计数为minute=1/hour=7。
- BR-GOV-PASSWORD-LOGIN-QUOTA-HOUR：条件：默认小时配额：每分钟恰5次、小时内累计20次后在新分钟第21次请求；判定/结果：前20次均通过限流后401；第21次在未超分钟配额时返回429 slow_down，Retry-After=3360秒，两hash键hour_count=21且当前minute_count=1；拒绝请求也递增小时计数。
- BR-GOV-PASSWORD-LOGIN-QUOTA-SCOPE：条件：同一IP及相同账号键文本，password配额已耗尽但bind scope尚未使用；判定/结果：password第6次429；bind首次请求仍通过自身限流后因无效bind token返回401，password两个键计数保持6而bind独立键各计1，证明scope隔离。
- BR-GOV-PASSWORD-LOGIN-QUOTA-RETENTION：条件：一次限流事务开始时表内存在严格早于一小时前和恰好一小时前的非当前scope键；判定/结果：严格旧行被删除；恰好一小时前及较新行保留；本次新password键正常创建且计数1。清理按整张限流表的时间条件执行，不限于本次请求键。

#### 状态变化/保留

- 失败计数和锁定审计随拒绝结果提交；锁定到期在下一次尝试解锁。
- 成功建立session并清零计数；初始口令过期不建立新session，但不会仅因此吊销到期前已有的有效session。

#### 数据契约

- 默认连续失败阈值5，锁定900秒；TSP_AUTH_FAILURE_LIMIT/TSP_AUTH_LOCK_SECONDS仅接受正安全整数。
- HTTP口令/绑定失败统一401 unauthorized；锁定/频率限制为429 slow_down并带Retry-After；应用层保留细分原因。
- Bearer初始密码会话仅允许whoami/password-change/logout；Cookie另允许web/session和web/logout。
- 初始口令expiry检查在新口令登录中；已有有效会话的改密入口不检查该expiry，不能推导到期后只有管理员能恢复。
- 接口限流按scope/IP及可选账号hash键检查分钟/小时计数，拒绝请求也递增；hour_started_at严格早于当前一小时前的行在限流事务起始删除。

#### 异常与边界

- 条件：用户active、密码正确且初始密码未过期；处理：登录返回user/device/session编码和独立会话凭证；初始密码会话访问业务接口被password_change_required拒绝。
- 条件：默认配置下同一已存在账号连续5次错误口令；处理：第5次返回凭证错误并落锁，锁内正确口令也被slow_down拒绝；到期后正确登录清零计数。
- 条件：初始口令expiry不晚于当前时间，且本场景用户没有任何有效旧会话；处理：应用新登录返回auth_initial_password_expired，HTTP统一401且无新增设备会话；管理员重新签发未过期初始密码是一条恢复路径，使用新密码可重新登录，不声明这是所有场景唯一恢复方式。
- 条件：默认分钟配额：同password scope、IP及账号在同一分钟连续6次请求；处理：前5次通过限流后因不存在账号而401 unauthorized；第6次429 slow_down且Retry-After=60；两个hash键的minute_count/hour_count均为6，说明拒绝也计数。t0+60秒的新请求通过分钟限流后401，计数为minute=1/hour=7。
- 条件：默认小时配额：每分钟恰5次、小时内累计20次后在新分钟第21次请求；处理：前20次均通过限流后401；第21次在未超分钟配额时返回429 slow_down，Retry-After=3360秒，两hash键hour_count=21且当前minute_count=1；拒绝请求也递增小时计数。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-PASSWORD-LOGIN-SUCCESS` | 用户active、密码正确且初始密码未过期时，登录返回user/device/session编码和独立会话凭证；初始密码会话访问业务接口被password_change_required拒绝。 |
| `AC-GOV-PASSWORD-LOGIN-LOCK` | 默认配置下同一已存在账号连续5次错误口令时，第5次返回凭证错误并落锁，锁内正确口令也被slow_down拒绝；到期后正确登录清零计数。 |
| `AC-GOV-PASSWORD-LOGIN-EXPIRED` | 初始口令expiry不晚于当前时间，且本场景用户没有任何有效旧会话时，应用新登录返回auth_initial_password_expired，HTTP统一401且无新增设备会话；管理员重新签发未过期初始密码是一条恢复路径，使用新密码可重新登录，不声明这是所有场景唯一恢复方式。 |
| `AC-GOV-PASSWORD-LOGIN-EXPIRED-SESSION` | 初始密码到期前已登录，原session仍有效且用户未禁用/设备未吊销、当前口令hash未变时，到期后用旧初始密码发起新登录仍401；使用原有效session和正确当前初始密码可自行改密，清除must_change_password/password_expires_at；新密码随后可登录，原证明改密的session保留。 |
| `AC-GOV-PASSWORD-LOGIN-QUOTA` | 默认分钟配额：同password scope、IP及账号在同一分钟连续6次请求时，前5次通过限流后因不存在账号而401 unauthorized；第6次429 slow_down且Retry-After=60；两个hash键的minute_count/hour_count均为6，说明拒绝也计数。t0+60秒的新请求通过分钟限流后401，计数为minute=1/hour=7。 |
| `AC-GOV-PASSWORD-LOGIN-QUOTA-HOUR` | 默认小时配额：每分钟恰5次、小时内累计20次后在新分钟第21次请求时，前20次均通过限流后401；第21次在未超分钟配额时返回429 slow_down，Retry-After=3360秒，两hash键hour_count=21且当前minute_count=1；拒绝请求也递增小时计数。 |
| `AC-GOV-PASSWORD-LOGIN-QUOTA-SCOPE` | 同一IP及相同账号键文本，password配额已耗尽但bind scope尚未使用时，password第6次429；bind首次请求仍通过自身限流后因无效bind token返回401，password两个键计数保持6而bind独立键各计1，证明scope隔离。 |
| `AC-GOV-PASSWORD-LOGIN-QUOTA-RETENTION` | 一次限流事务开始时表内存在严格早于一小时前和恰好一小时前的非当前scope键时，严格旧行被删除；恰好一小时前及较新行保留；本次新password键正常创建且计数1。清理按整张限流表的时间条件执行，不限于本次请求键。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-PASSWORD-LOGIN-SUCCESS** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在本需求明确声明的有效期、锁定或配额时间窗口场景使用待建设的受控时钟。所有步骤为待执行计划。 专用初态：有效初始密码用户U，锁定为空；独立客户端身份。
- 操作：
  1. POST /auth/password-login；保存返回令牌。
  2. 以令牌whoami再GET /projects。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：登录返回user/device/session编码和独立会话凭证；初始密码会话访问业务接口被password_change_required拒绝。

**AC-GOV-PASSWORD-LOGIN-LOCK** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在本需求明确声明的有效期、锁定或配额时间窗口场景使用待建设的受控时钟。所有步骤为待执行计划。 专用初态：新U无失败计数；受控应用时钟；HTTP测试需隔离配额或等其窗口恢复，避免与接口限流混淆。
- 操作：
  1. 直接调用应用用例提交5次错误口令，检查login_failure_count/locked_until。
  2. 锁内提交正确密码；推进超过900秒后再提交正确密码。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：第5次返回凭证错误并落锁，锁内正确口令也被slow_down拒绝；到期后正确登录清零计数。

**AC-GOV-PASSWORD-LOGIN-EXPIRED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在本需求明确声明的有效期、锁定或配额时间窗口场景使用待建设的受控时钟。所有步骤为待执行计划。 专用初态：隔离U must_change_password=true、口令已过期且无有效session；管理员A可重置；记录U设备/session基数。
- 操作：
  1. POST /auth/password-login提交正确但过期初始密码；核对401且设备/session数不增。
  2. A POST /users/U/initial-password；使用返回的新初始密码再次POST /auth/password-login，核对登录成功和新的expiry。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：应用新登录返回auth_initial_password_expired，HTTP统一401且无新增设备会话；管理员重新签发未过期初始密码是一条恢复路径，使用新密码可重新登录，不声明这是所有场景唯一恢复方式。

**AC-GOV-PASSWORD-LOGIN-EXPIRED-SESSION** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在本需求明确声明的有效期、锁定或配额时间窗口场景使用待建设的受控时钟。所有步骤为待执行计划。 专用初态：独立U初始口令P0在t0有效、expiry=t0+15分钟；先于expiry获得session S，S有效期在t0+16分钟之后；控制服务器Date/Date.now，限流干净且不触发失败锁。时钟夹具尚需建设，未提供或运行。
- 操作：
  1. 在t0 POST /auth/password-login使用P0取得S；记录device/session及expiry。
  2. 推进服务器时钟至t0+16分钟；重新用P0登录，核对401且无新增session。
  3. 用Bearer S POST /auth/password-change，current_password=P0,new_password=长度8至128的新P1；核对成功并GET /auth/whoami显示must_change_password=false。
  4. 读取隔离库确认password_expires_at=null；用P1新登录成功，再以S调用whoami确认S未被本次改密吊销。
  5. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：到期后用旧初始密码发起新登录仍401；使用原有效session和正确当前初始密码可自行改密，清除must_change_password/password_expires_at；新密码随后可登录，原证明改密的session保留。

**AC-GOV-PASSWORD-LOGIN-QUOTA** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在本需求明确声明的有效期、锁定或配额时间窗口场景使用待建设的受控时钟。所有步骤为待执行计划。 专用初态：建设前提（尚未提供/运行）：隔离HTTP夹具须运行固定Core API+一次性PostgreSQL，能控制服务器new Date/Date.now为t0=2026-11-10T00:00:00Z、固定request.ip=192.0.2.10、清空authRateLimits并只读查询其行；用捕获hashToken读取password:ip:192.0.2.10与password:account:quota-nobody的hash键。账号quota-nobody确认不存在，避免用户口令锁定混淆。
- 操作：
  1. 在固定t0连续6次POST /auth/password-login，body={account:"quota-nobody",password:"wrong",device_name:"quota-client"}；逐次记录状态与Retry-After。
  2. 只读查询两hash键，核对第6次虽拒绝仍把minute/hour计数写成6。
  3. 把服务器时钟推进到t0+60秒，发送同一请求；核对401而非429，并读取minute_count=1/hour_count=7。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：前5次通过限流后因不存在账号而401 unauthorized；第6次429 slow_down且Retry-After=60；两个hash键的minute_count/hour_count均为6，说明拒绝也计数。t0+60秒的新请求通过分钟限流后401，计数为minute=1/hour=7。

**AC-GOV-PASSWORD-LOGIN-QUOTA-HOUR** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在本需求明确声明的有效期、锁定或配额时间窗口场景使用待建设的受控时钟。所有步骤为待执行计划。 专用初态：建设前提（尚未提供/运行）：隔离HTTP/可控服务器时钟/可读限流表夹具；该用例独立清空限流表，t0=2026-11-10T00:00:00Z、IP=192.0.2.10、quota-nobody不存在，两个password hash键初始不存在。使用hashToken(password:ip:IP)及hashToken(password:account:quota-nobody)定位行。
- 操作：
  1. 分别固定服务器时钟在t0、t0+60秒、t0+120秒、t0+180秒，每个时刻发送5次POST /auth/password-login body={account:"quota-nobody",password:"wrong",device_name:"quota-client"}，共20次；记录第20次401。
  2. 推进至t0+240秒，发送第21次相同请求；读取429/Retry-After=3360。
  3. 只读两password键，核对hour_started_at=t0、hour_count=21、minute_started_at=t0+240秒、minute_count=1，确保拒绝来自小时门槛。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：前20次均通过限流后401；第21次在未超分钟配额时返回429 slow_down，Retry-After=3360秒，两hash键hour_count=21且当前minute_count=1；拒绝请求也递增小时计数。

**AC-GOV-PASSWORD-LOGIN-QUOTA-SCOPE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在本需求明确声明的有效期、锁定或配额时间窗口场景使用待建设的受控时钟。所有步骤为待执行计划。 专用初态：建设前提（尚未提供/运行）：隔离HTTP+数据库+可控服务器Date夹具及hash键只读查询；独立清空限流表，在固定t0=2026-11-10T00:00:00Z/IP=192.0.2.10使用不存在账号和无效绑定令牌文本quota-nobody；查询password/bind各自ip/account四个hash键。
- 操作：
  1. 同t0发送6次POST /auth/password-login body={account:"quota-nobody",password:"wrong",device_name:"quota-client"}，记录第6次429。
  2. 保持t0/IP不变，首次POST /auth/login body={bind_token:"quota-nobody",device_name:"quota-client"}；核对401而不是429。
  3. 按hashToken(scope+":ip:"+IP)及hashToken(scope+":account:quota-nobody")读取四键，核对password为6、bind为1。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：password第6次429；bind首次请求仍通过自身限流后因无效bind token返回401，password两个键计数保持6而bind独立键各计1，证明scope隔离。

**AC-GOV-PASSWORD-LOGIN-QUOTA-RETENTION** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在本需求明确声明的有效期、锁定或配额时间窗口场景使用待建设的受控时钟。所有步骤为待执行计划。 专用初态：建设前提（尚未提供/运行）：隔离可控new Date/Date.now与PostgreSQL夹具，能在用例开始前插入并在调用后只读查询authRateLimits；全表独立复位。t0=2026-11-10T00:00:00Z；以hashToken("fixture:old"/"fixture:boundary"/"fixture:new")作为三个无碰撞键，分别hour_started_at=t0-3600001毫秒、t0-3600000毫秒、t0-3599999毫秒，minute_started_at同各hour、计数均为1。当前password/IP/account键不存在；quota-nobody账号不存在。
- 操作：
  1. 固定服务器时钟t0，先读取确认三个fixture行和准确毫秒时间；POST一次/auth/password-login body={account:"quota-nobody",password:"wrong",device_name:"quota-client"}，IP=192.0.2.10。
  2. 捕获401响应；查询三个fixture键，核对仅old不存在、boundary/new仍在。
  3. 查询本次新password的ip/account键，核对minute_count/hour_count各1；本用例不把恰好一小时行保留解释为重置配额。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：严格旧行被删除；恰好一小时前及较新行保留；本次新password键正常创建且计数1。清理按整张限流表的时间条件执行，不限于本次请求键。

#### 来源与已有测试定义

- `packages/application/src/auth-use-cases.ts:44-85`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `apps/core-api/src/auth.ts:76-95`；SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`
- `packages/application/src/auth-use-cases.ts:19-24`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `packages/application/src/auth-use-cases.ts:58-85`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `packages/application/src/auth-use-cases.ts:79-85`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `apps/core-api/src/routes/auth.ts:98-112`；SHA-256 `16c61a32fca5ef23060e494b18affc5996eb4f35a1783d22d72b4932da07c5f8`
- `packages/application/src/user-use-cases.ts:189-225`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `packages/application/src/auth-use-cases.ts:90-110`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `packages/application/src/auth-rate-limit.ts:5-24`；SHA-256 `5cb59034dd5df29f8e37fdc2de4ebfb960e82cdfdad67aa195cca9d36aebb634`
- `packages/application/src/user-use-cases.ts:16-18`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `packages/application/src/auth-rate-limit.ts:7-24`；SHA-256 `5cb59034dd5df29f8e37fdc2de4ebfb960e82cdfdad67aa195cca9d36aebb634`
- `apps/core-api/src/routes/auth.ts:84-112`；SHA-256 `16c61a32fca5ef23060e494b18affc5996eb4f35a1783d22d72b4932da07c5f8`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 生产环境真实限流配置、代理IP可信性与时钟漂移未运行验证；安全事件聚合归管理模块。
- 限流/到期计划需要可控服务器Date/Date.now、隔离PostgreSQL与只读计数查询夹具；本次未提供该夹具，必须先建设后才能执行计划，不将计划设计当作测试可直接运行或已通过。

### REQ-GOV-PASSWORD-CHANGE · 验证当前口令后修改并收缩凭证

**观察类型：** `observed_in_code`

**摘要：** 验证当前口令后修改并收缩凭证的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 有效登录用户

**触发：** 请求修改密码

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 验证新口令长度8到128以及当前口令。
- 用户锁内重新核对旧hash和当前会话归属。
- 提交新hash、解除初始密码/锁定标志，吊销其他设备及当前安装的其他会话。

#### 业务规则

- BR-GOV-PASSWORD-CHANGE-KEEP：条件：当前口令与有效会话匹配；判定/结果：仅当前会话继续有效，同安装第二会话和另一设备全部会话失效；新口令可登录且旧口令失效。
- BR-GOV-PASSWORD-CHANGE-DENIED：条件：缺当前口令、口令错误、新密码长度7或129；判定/结果：分别auth_current_password_required/auth_credentials_invalid/auth_password_invalid；旧hash及设备会话不变。

#### 状态变化/保留

- 新hash、must_change_password=false、password_expires_at=null、失败计数/锁定清空。
- 事务内凭证收缩与user.password_changed审计一起提交。

#### 数据契约

- current_password必填且最多128字符；currentDeviceToken必须属于目标用户。
- 保留提交当前口令的那一会话，返回revoked_devices数量；同安装其他会话也吊销但不计入其他设备数。
- 改密入口不检查初始口令password_expires_at；在到期前取得且仍有效的session可于初始口令到期后证明当前密码并自行改密，见AC-GOV-PASSWORD-LOGIN-EXPIRED-SESSION。

#### 异常与边界

- 条件：缺当前口令、口令错误、新密码长度7或129；处理：分别auth_current_password_required/auth_credentials_invalid/auth_password_invalid；旧hash及设备会话不变。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-PASSWORD-CHANGE-KEEP` | 当前口令与有效会话匹配时，仅当前会话继续有效，同安装第二会话和另一设备全部会话失效；新口令可登录且旧口令失效。 |
| `AC-GOV-PASSWORD-CHANGE-DENIED` | 缺当前口令、口令错误、新密码长度7或129时，分别auth_current_password_required/auth_credentials_invalid/auth_password_invalid；旧hash及设备会话不变。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-PASSWORD-CHANGE-KEEP** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U拥有安装D1会话S1/S2和D2会话S3；旧口令已知；使用S1。
- 操作：
  1. POST /auth/password-change提交旧口令和新8字符以上口令。
  2. 以S1/S2/S3各whoami；独立尝试旧、新口令登录。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：仅当前会话继续有效，同安装第二会话和另一设备全部会话失效；新口令可登录且旧口令失效。

**AC-GOV-PASSWORD-CHANGE-DENIED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U有效且保存修改前hash/会话列表；每个变体恢复初始数据。
- 操作：
  1. 分别提交缺失、错误当前口令及长度边界新口令；读用户和会话记录。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别auth_current_password_required/auth_credentials_invalid/auth_password_invalid；旧hash及设备会话不变。

#### 来源与已有测试定义

- `packages/application/src/auth-use-cases.ts:90-115`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `packages/application/src/auth-device.ts:83-87`；SHA-256 `3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9`
- `packages/application/src/auth-use-cases.ts:92-110`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`

- `packages/application/tests/auth-use-cases.test.mjs` · proactive password change requires the current password and revokes other devices · `defined`；仅检查固定源码中的测试定义，未执行；此条不证明运行成功。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-INSTALLATION-SESSIONS · 同安装重登保留设备身份并生成独立会话

**观察类型：** `observed_in_code`

**摘要：** 同安装重登保留设备身份并生成独立会话的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 有效用户及其Web/CLI安装

**触发：** 登录、绑定安装身份或退出

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 按用户/client_type/installation_id定位设备，以安装秘密hash验证归属。
- 同安装重用设备并更新成功登录时间，每次新增90天会话；无安装身份的兼容调用创建新设备。
- 退出只吊销当前会话；整设备吊销另含全部会话和租约。

#### 业务规则

- BR-GOV-INSTALLATION-SESSIONS-RELOGIN：条件：相同用户、client_type、安装ID及秘密再次登录；判定/结果：两次device_code相同，session_code/token不同，稳定执行秘密不变；退出S1后S2仍可用。
- BR-GOV-INSTALLATION-SESSIONS-LIMIT：条件：已有10个未吊销安装或同ID提交错误秘密；判定/结果：新安装返回auth_device_limit_reached；错误秘密返回auth_device_identity_mismatch，设备和session数不增加。
- BR-GOV-INSTALLATION-SESSIONS-LEGACY：条件：未初始化的遗留凭证首次解析或绑定安装身份；判定/结果：一次登记保留旧执行秘密；不能把既有另一安装合并进本设备；退出后不能重新登记旧session。

#### 状态变化/保留

- 稳定device.id/code/credential_hash及原device_name在同安装重登时保留；只有last_login_at/platform/revoked_at按路径更新。
- 注销单session不删安装身份；旧已吊销session不会因重登复活。

#### 数据契约

- installation_id为UUID样式；installation_secret为43字符base64url；client_type web/cli；platform非空且不超过100字符；device_name去空白后1到200字符。
- 每用户未吊销设备上限10；恢复已吊销设备也检查上限。
- 遗留credential可一次性登记为session；legacy_session_initialized阻止重复登记。

#### 异常与边界

- 条件：相同用户/client_type/installation_id已存在，但提交的installation_secret哈希不匹配。；处理：返回auth_device_identity_mismatch，不新增设备或session，不覆盖稳定设备身份/执行秘密（BR-GOV-INSTALLATION-SESSIONS-LIMIT / AC-GOV-INSTALLATION-SESSIONS-LIMIT）。
- 条件：前序用户/安装秘密校验已通过，需要新建或重新激活设备，而用户已有10个未吊销设备。；处理：返回auth_device_limit_reached；不新增session，也不把被吊销设备恢复有效；同安装有效设备重登不按新设备占位处理（BR-GOV-INSTALLATION-SESSIONS-LIMIT / AC-GOV-INSTALLATION-SESSIONS-LIMIT）。
- 条件：绑定安装身份时，该身份已属于本人另一设备，或当前设备已有不同安装身份。；处理：分别返回auth_device_identity_conflict或auth_device_identity_mismatch；不合并设备身份、不覆盖原绑定（BR-GOV-INSTALLATION-SESSIONS-LEGACY / AC-GOV-INSTALLATION-SESSIONS-LEGACY）。
- 条件：旧凭证已经完成一次legacy登记，且其对应session已退出、吊销或不存在。；处理：resolveSessionToken不重新登记该旧凭证，不因同安装再次登录而复活原session；仍有效的另一session继续按自身状态解析（BR-GOV-INSTALLATION-SESSIONS-LEGACY / AC-GOV-INSTALLATION-SESSIONS-LEGACY、RELOGIN）。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-INSTALLATION-SESSIONS-RELOGIN` | 相同用户、client_type、安装ID及秘密再次登录时，两次device_code相同，session_code/token不同，稳定执行秘密不变；退出S1后S2仍可用。 |
| `AC-GOV-INSTALLATION-SESSIONS-LIMIT` | 已有10个未吊销安装或同ID提交错误秘密时，新安装返回auth_device_limit_reached；错误秘密返回auth_device_identity_mismatch，设备和session数不增加。 |
| `AC-GOV-INSTALLATION-SESSIONS-LEGACY` | 未初始化的遗留凭证首次解析或绑定安装身份时，一次登记保留旧执行秘密；不能把既有另一安装合并进本设备；退出后不能重新登记旧session。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-INSTALLATION-SESSIONS-RELOGIN** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U与单独合法CLI安装I；无既有设备。
- 操作：
  1. 用I登录两次获得S1/S2，比较设备标识与存储hash。
  2. 以S1退出，再分别解析S1/S2。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：两次device_code相同，session_code/token不同，稳定执行秘密不变；退出S1后S2仍可用。

**AC-GOV-INSTALLATION-SESSIONS-LIMIT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U已有10个有效安装；另独立准备1个设备对应I。
- 操作：
  1. 尝试第11个安装登录。
  2. 恢复独立单设备状态后，用相同I安装ID及不同秘密登录。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：新安装返回auth_device_limit_reached；错误秘密返回auth_device_identity_mismatch，设备和session数不增加。

**AC-GOV-INSTALLATION-SESSIONS-LEGACY** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：仅隔离升级测试库含未初始化遗留设备L，保存其token和hash；另有已绑定安装D。
- 操作：
  1. 解析L并POST /auth/device-identity绑定新I；检查device.id/hash。
  2. 尝试在D绑定I；退出L后再次解析L。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：一次登记保留旧执行秘密；不能把既有另一安装合并进本设备；退出后不能重新登记旧session。

#### 来源与已有测试定义

- `packages/application/src/auth-device.ts:30-58`；SHA-256 `3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9`
- `packages/application/src/auth-use-cases.ts:139-145`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `packages/application/src/auth-device.ts:35-42`；SHA-256 `3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9`
- `packages/application/src/auth-device.ts:61-80`；SHA-256 `3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9`
- `packages/application/src/auth-use-cases.ts:148-168`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`

- `packages/application/tests/device-sessions.test.mjs` · the same verified installation receives separate sessions, preserves identity and updates only successful login timestamps · `defined`；仅检查固定源码中的测试定义，未执行；此条不证明运行成功。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 安装身份丢失后的人工修复流程未定义；旧版无身份登录仍允许，不能声称所有会话都绑定安装。

### REQ-GOV-BIND-TOKEN · 一次性绑定令牌兑换

**观察类型：** `observed_in_code`

**摘要：** 一次性绑定令牌兑换的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 持有管理员签发令牌的客户端

**触发：** 提交/auth/login

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 检查令牌hash与有效期并锁住用户。
- 创建设备登录，在同事务清空绑定令牌。
- 重复兑换或过期令牌拒绝。

#### 业务规则

- BR-GOV-BIND-TOKEN-ONCE：条件：有效用户的未过期令牌第一次兑换；判定/结果：生成设备会话并消耗令牌；同一令牌第二次兑换失败且不新增设备。
- BR-GOV-BIND-TOKEN-EXPIRED：条件：令牌已过期或设备已达上限；判定/结果：过期返回应用auth_bind_token_expired；设备上限拒绝时事务回滚，T仍未消耗，吊销闲置设备后可用同T重试。

#### 状态变化/保留

- 成功后bind_token_hash/expiry为空并新增会话；创建失败事务不消耗令牌。

#### 数据契约

- 24小时是签发TTL；兑换按expires_at与当前时间比较。
- HTTP绑定失败统一401，应用层区分invalid/expired/device_limit等原因。

#### 异常与边界

- 条件：有效用户的未过期令牌第一次兑换；处理：生成设备会话并消耗令牌；同一令牌第二次兑换失败且不新增设备。
- 条件：令牌已过期或设备已达上限；处理：过期返回应用auth_bind_token_expired；设备上限拒绝时事务回滚，T仍未消耗，吊销闲置设备后可用同T重试。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-BIND-TOKEN-ONCE` | 有效用户的未过期令牌第一次兑换时，生成设备会话并消耗令牌；同一令牌第二次兑换失败且不新增设备。 |
| `AC-GOV-BIND-TOKEN-EXPIRED` | 令牌已过期或设备已达上限时，过期返回应用auth_bind_token_expired；设备上限拒绝时事务回滚，T仍未消耗，吊销闲置设备后可用同T重试。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-BIND-TOKEN-ONCE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U有效、T新签发；合法独立安装I，记录设备数。
- 操作：
  1. POST /auth/login提交T/device_name/device_identity；同T再次提交。
  2. 读取用户令牌hash和设备/session数量。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：生成设备会话并消耗令牌；同一令牌第二次兑换失败且不新增设备。

**AC-GOV-BIND-TOKEN-EXPIRED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：两个独立用例：已过期T；有效T但U有10有效设备。
- 操作：
  1. 兑换过期T并检查无设备增加。
  2. 在有效T用例先失败，再以U其他会话吊销一设备，使用同T重试。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：过期返回应用auth_bind_token_expired；设备上限拒绝时事务回滚，T仍未消耗，吊销闲置设备后可用同T重试。

#### 来源与已有测试定义

- `packages/application/src/auth-use-cases.ts:25-40`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `apps/core-api/src/routes/auth.ts:84-95`；SHA-256 `16c61a32fca5ef23060e494b18affc5996eb4f35a1783d22d72b4932da07c5f8`
- `packages/application/src/auth-use-cases.ts:31-38`；SHA-256 `e67b301854954e91957907bfa7959e8d138a9b8a7843502e2b1df99b074a06ab`
- `packages/application/src/auth-device.ts:39-57`；SHA-256 `3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-DEVICE-AUTHORIZATION · 浏览器确认后向CLI一次性交换会话

**观察类型：** `observed_in_code`

**摘要：** 浏览器确认后向CLI一次性交换会话的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** CLI安装、已登录浏览器用户

**触发：** 发起设备授权、批准/拒绝及轮询

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- CLI提交合法cli安装和名称，获得10分钟设备码与人读码，初始间隔5秒。
- 浏览器查询请求并由有效且已修改初始口令的用户决定approve/deny。
- CLI按服务端间隔轮询；批准后在事务内建立会话并置consumed。

#### 业务规则

- BR-GOV-DEVICE-AUTHORIZATION-APPROVE：条件：未过期pending请求经有资格用户批准；判定/结果：批准仅改变请求状态；等轮询间隔后首次兑换获得会话且置consumed，同device_code再次兑换expired_token。
- BR-GOV-DEVICE-AUTHORIZATION-PENDING：条件：pending请求未批准或过快轮询；判定/结果：首次authorization_pending且无会话；立即再轮询slow_down并增加间隔；等新间隔仍pending，不能声称登录完成。
- BR-GOV-DEVICE-AUTHORIZATION-DENY：条件：请求denied、过期或批准者仍必须改初始密码；判定/结果：分别access_denied/expired_token/password_change_required；无新增登录会话；已处理请求不能被第二人再次批准。

#### 状态变化/保留

- pending→approved或denied；approved→consumed；拒绝/过期/重复兑换不新增session。

#### 数据契约

- user_code去空白/连字符转大写后hash匹配；device_code最多256字符。
- 过快轮询interval每次增加5秒，上限60；返回retry_after，状态pending不等于登录完成。
- start每分钟12/小时120；token每分钟120/小时1200；request每分钟30/小时300，approve默认5/20。

#### 异常与边界

- 条件：未过期pending请求经有资格用户批准；处理：批准仅改变请求状态；等轮询间隔后首次兑换获得会话且置consumed，同device_code再次兑换expired_token。
- 条件：请求denied、过期或批准者仍必须改初始密码；处理：分别access_denied/expired_token/password_change_required；无新增登录会话；已处理请求不能被第二人再次批准。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-DEVICE-AUTHORIZATION-APPROVE` | 未过期pending请求经有资格用户批准时，批准仅改变请求状态；等轮询间隔后首次兑换获得会话且置consumed，同device_code再次兑换expired_token。 |
| `AC-GOV-DEVICE-AUTHORIZATION-PENDING` | pending请求未批准或过快轮询时，首次authorization_pending且无会话；立即再轮询slow_down并增加间隔；等新间隔仍pending，不能声称登录完成。 |
| `AC-GOV-DEVICE-AUTHORIZATION-DENY` | 请求denied、过期或批准者仍必须改初始密码时，分别access_denied/expired_token/password_change_required；无新增登录会话；已处理请求不能被第二人再次批准。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-DEVICE-AUTHORIZATION-APPROVE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U已改密码且有效浏览器会话，CLI合法I；干净授权记录和限流表。
- 操作：
  1. POST /auth/device/start，GET /auth/device/request?user_code=返回人读码。
  2. U POST /auth/device/approve decision=approve；等待返回轮询间隔后POST /auth/device/token。
  3. 同设备码再次兑换并查看session数量。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：批准仅改变请求状态；等轮询间隔后首次兑换获得会话且置consumed，同device_code再次兑换expired_token。

**AC-GOV-DEVICE-AUTHORIZATION-PENDING** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立未批准请求，有效期剩余足够；受控UTC时钟。
- 操作：
  1. 轮询一次后立即再轮询；按retry_after推进时钟，第三次轮询。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：首次authorization_pending且无会话；立即再轮询slow_down并增加间隔；等新间隔仍pending，不能声称登录完成。

**AC-GOV-DEVICE-AUTHORIZATION-DENY** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：分别新建三个独立请求；U普通，V初始密码未改；过期场景控制时钟超过10分钟。
- 操作：
  1. 批准deny请求后兑换；过期后查询/批准/兑换；V批准第三请求。
  2. 对已处理请求用另一有效用户再次approve。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别access_denied/expired_token/password_change_required；无新增登录会话；已处理请求不能被第二人再次批准。

#### 来源与已有测试定义

- `packages/application/src/device-authorization-use-cases.ts:10-49`；SHA-256 `977e98f37982a1114a01ffe2382c64ef67af047052e622d6c63a8ab0d7b6b5ba`
- `packages/application/src/device-authorization-use-cases.ts:54-72`；SHA-256 `977e98f37982a1114a01ffe2382c64ef67af047052e622d6c63a8ab0d7b6b5ba`
- `packages/application/src/device-authorization-use-cases.ts:54-71`；SHA-256 `977e98f37982a1114a01ffe2382c64ef67af047052e622d6c63a8ab0d7b6b5ba`
- `packages/application/src/device-authorization-use-cases.ts:29-49`；SHA-256 `977e98f37982a1114a01ffe2382c64ef67af047052e622d6c63a8ab0d7b6b5ba`
- `packages/application/src/device-authorization-use-cases.ts:58-71`；SHA-256 `977e98f37982a1114a01ffe2382c64ef67af047052e622d6c63a8ab0d7b6b5ba`

- `packages/application/tests/device-sessions.test.mjs` · device authorization needs explicit approval, throttles polling and consumes the secret atomically once · `defined`；仅检查固定源码中的测试定义，未执行；此条不证明运行成功。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- CLI打开浏览器与人工确认的环境交互未实际执行；不得把授权请求创建当作登录成功。

### REQ-GOV-DEVICE-MANAGEMENT · 设备列表、更名及会话或安装吊销

**观察类型：** `observed_in_code`

**摘要：** 设备列表、更名及会话或安装吊销的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 设备所属用户或有效平台管理员

**触发：** 查看客户端、session、改名或吊销

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 读取本人设备列表；平台管理员可指定其他用户。
- 按同一所有权边界查询会话/改名/吊销；列出当前标记及active/expired/revoked状态。
- 单会话撤销仅更新该session，整安装撤销同时处理sessions与执行租约并审计。

#### 业务规则

- BR-GOV-DEVICE-MANAGEMENT-OWN：条件：用户管理本人客户端；判定/结果：列表和会话显示current，合法更名持久化；撤销S1只使S1失效，其同设备S2保持有效。
- BR-GOV-DEVICE-MANAGEMENT-INSTALL：条件：本人或平台管理员吊销整设备；判定/结果：该设备全部会话与未吊销运行租约失效；其他设备不变。
- BR-GOV-DEVICE-MANAGEMENT-DENIED：条件：普通用户管理另一用户设备或名称空白/超过200；判定/结果：跨用户操作device_forbidden，非法名称validation_failed；两者不改变目标设备和会话。

#### 状态变化/保留

- 更名只改device_name并审计；session撤销写revoked_at；安装撤销写device/session/lease的revoked_at。

#### 数据契约

- device_name去空白后非空且输入长度最多200；session按created_at降序。
- 设备列表包含current及session_count；不向客户端返回执行秘密或session token。

#### 异常与边界

- 条件：普通用户管理另一用户设备或名称空白/超过200；处理：跨用户操作device_forbidden，非法名称validation_failed；两者不改变目标设备和会话。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-DEVICE-MANAGEMENT-OWN` | 用户管理本人客户端时，列表和会话显示current，合法更名持久化；撤销S1只使S1失效，其同设备S2保持有效。 |
| `AC-GOV-DEVICE-MANAGEMENT-INSTALL` | 本人或平台管理员吊销整设备时，该设备全部会话与未吊销运行租约失效；其他设备不变。 |
| `AC-GOV-DEVICE-MANAGEMENT-DENIED` | 普通用户管理另一用户设备或名称空白/超过200时，跨用户操作device_forbidden，非法名称validation_failed；两者不改变目标设备和会话。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-DEVICE-MANAGEMENT-OWN** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U有同安装两会话S1/S2；以S2操作，另用户V有自己的设备。
- 操作：
  1. GET /devices及/devices/D/sessions，PATCH D device_name="新名称"。
  2. POST /sessions/S1/revoke，分别测试S1/S2身份。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：列表和会话显示current，合法更名持久化；撤销S1只使S1失效，其同设备S2保持有效。

**AC-GOV-DEVICE-MANAGEMENT-INSTALL** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U有D1/D2；D1两会话和未吊销租约，D2有效；由D2或管理员操作。
- 操作：
  1. POST /devices/D1/revoke；解析D1/D2会话并查看D1租约revoked_at。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：该设备全部会话与未吊销运行租约失效；其他设备不变。

**AC-GOV-DEVICE-MANAGEMENT-DENIED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U与V独立设备；记录V初始状态。
- 操作：
  1. U尝试列V设备/列会话/改名/撤销。
  2. 以V提交空白或201字符名称。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：跨用户操作device_forbidden，非法名称validation_failed；两者不改变目标设备和会话。

#### 来源与已有测试定义

- `apps/core-api/src/routes/devices.ts:10-65`；SHA-256 `7475e026742ab1b096803acb5332b44aa809e28d0d03df977ecacf9d69a671c1`
- `packages/application/src/device-reads.ts:6-26`；SHA-256 `b3bcd58b35ae9851eedb3cf683ad0b3a22dd0a68a7b975fcbfc7158856ba0607`
- `apps/core-api/src/routes/devices.ts:68-78`；SHA-256 `7475e026742ab1b096803acb5332b44aa809e28d0d03df977ecacf9d69a671c1`
- `packages/application/src/auth-device.ts:83-87`；SHA-256 `3b97614bf8c9eebc06dc23e4e7b540e773a328cada4fcad95a78a221a36874c9`
- `apps/core-api/src/routes/devices.ts:10-16`；SHA-256 `7475e026742ab1b096803acb5332b44aa809e28d0d03df977ecacf9d69a671c1`
- `apps/core-api/src/routes/devices.ts:53-66`；SHA-256 `7475e026742ab1b096803acb5332b44aa809e28d0d03df977ecacf9d69a671c1`
- `packages/application/src/device-reads.ts:6-11`；SHA-256 `b3bcd58b35ae9851eedb3cf683ad0b3a22dd0a68a7b975fcbfc7158856ba0607`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-WEB-AUTH-BOUNDARY · 浏览器会话、来源与CSRF边界

**观察类型：** `observed_in_code`

**摘要：** 浏览器会话、来源与CSRF边界的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 浏览器用户和API客户端

**触发：** Web登录、读取会话与受保护请求

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- Web登录校验Origin并根据环境设置cookie安全属性；生成或重用HttpOnly安装证明。
- 会话读取仅接受cookie身份并返回用户及CSRF；无效CSRF值可刷新。
- 有Cookie时不回退Bearer/legacy；不安全方法必须Origin、CSRF cookie/header及签名同时成立。

#### 业务规则

- BR-GOV-WEB-AUTH-BOUNDARY-WEB：条件：可信Origin和有效口令的浏览器登录；判定/结果：响应含user/csrf_token及受控cookie属性，GET /auth/web/session no-store；注销后该session失效而browser cookie保留。
- BR-GOV-WEB-AUTH-BOUNDARY-CSRF：条件：Cookie认证写请求缺少正确来源/CSRF或同时提供Bearer；判定/结果：缺CSRF/错误Origin返回403 csrf_invalid；安全GET同时提供Cookie和Bearer返回401，不借Bearer绕过Cookie身份。
- BR-GOV-WEB-AUTH-BOUNDARY-ACTOR：条件：请求正文或查询声明另一个principal_code；判定/结果：操作者始终来自中间件身份，不能靠正文提升权限；仅在允许legacy环境无凭证时才有过渡身份路径。

#### 状态变化/保留

- Web登录返回user和csrf_token，原始session token只通过cookie。
- Web注销仅清session/csrf cookie且吊销当前session，browser安装cookie保留。

#### 数据契约

- 会话与browser cookie为HttpOnly，csrf cookie可读；Path=/，SameSite=Lax，90天Max-Age；生产使用__Host-前缀和Secure。
- 非生产loopback HTTP允许开发例外；正常源、配置TSP_WEB_ORIGIN源以及特定本地5173开发源按函数判定。
- 默认开发/测试可允许x-principal-code，生产默认禁止；hasAuthenticatedSession只认bearer/cookie，不能声称所有路由都关闭legacy。

#### 异常与边界

- 条件：Cookie认证写请求缺少正确来源/CSRF或同时提供Bearer；处理：缺CSRF/错误Origin返回403 csrf_invalid；安全GET同时提供Cookie和Bearer返回401，不借Bearer绕过Cookie身份。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-WEB-AUTH-BOUNDARY-WEB` | 可信Origin和有效口令的浏览器登录时，响应含user/csrf_token及受控cookie属性，GET /auth/web/session no-store；注销后该session失效而browser cookie保留。 |
| `AC-GOV-WEB-AUTH-BOUNDARY-CSRF` | Cookie认证写请求缺少正确来源/CSRF或同时提供Bearer时，缺CSRF/错误Origin返回403 csrf_invalid；安全GET同时提供Cookie和Bearer返回401，不借Bearer绕过Cookie身份。 |
| `AC-GOV-WEB-AUTH-BOUNDARY-ACTOR` | 请求正文或查询声明另一个principal_code时，操作者始终来自中间件身份，不能靠正文提升权限；仅在允许legacy环境无凭证时才有过渡身份路径。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-WEB-AUTH-BOUNDARY-WEB** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：新浏览器profile，可信HTTPS测试源；U有效；隔离cookie jar。
- 操作：
  1. POST /auth/web/login，检查Set-Cookie和响应JSON。
  2. 带cookie读session，再带正确Origin及CSRF header调用web/logout，检查cookie与旧会话。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：响应含user/csrf_token及受控cookie属性，GET /auth/web/session no-store；注销后该session失效而browser cookie保留。

**AC-GOV-WEB-AUTH-BOUNDARY-CSRF** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U已登录cookie C，另有合法Bearer B；记录项目名称。
- 操作：
  1. 带C但不带CSRF修改项目；错误Origin重试。
  2. GET /auth/whoami同时提供C和B。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：缺CSRF/错误Origin返回403 csrf_invalid；安全GET同时提供Cookie和Bearer返回401，不借Bearer绕过Cookie身份。

**AC-GOV-WEB-AUTH-BOUNDARY-ACTOR** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：Bearer普通成员U与owner O；生产环境legacy未显式启用。
- 操作：
  1. 以U令牌提交只有管理者可做的修改，正文填principal_code=O。
  2. 无Bearer仅用x-principal-code=O重试。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：操作者始终来自中间件身份，不能靠正文提升权限；仅在允许legacy环境无凭证时才有过渡身份路径。

#### 来源与已有测试定义

- `apps/core-api/src/routes/auth.ts:14-45`；SHA-256 `16c61a32fca5ef23060e494b18affc5996eb4f35a1783d22d72b4932da07c5f8`
- `apps/core-api/src/web-session.ts:74-87`；SHA-256 `6c7ab0c9d2b130a9b62a8359cfcdb92b9a7b4cbe2979ba56640ae6894a6d854e`
- `apps/core-api/src/auth.ts:46-73`；SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`
- `apps/core-api/src/web-session.ts:17-28`；SHA-256 `6c7ab0c9d2b130a9b62a8359cfcdb92b9a7b4cbe2979ba56640ae6894a6d854e`
- `apps/core-api/src/web-session.ts:65-72`；SHA-256 `6c7ab0c9d2b130a9b62a8359cfcdb92b9a7b4cbe2979ba56640ae6894a6d854e`
- `apps/core-api/src/auth.ts:98-115`；SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`
- `apps/core-api/src/auth.ts:125-139`；SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 真实TLS终止、代理协议、部署Origin配置及浏览器cookie策略未运行验证；开发legacy兼容是现状，不是生产政策批准。

### REQ-GOV-ACCOUNT-CLOSURE · 注销前责任交接与保留历史

**观察类型：** `observed_in_code`

**摘要：** 注销前责任交接与保留历史的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 有效账号本人

**触发：** 查看、开始、取消或完成账号注销

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 查询独占及未确认历史团队/项目所有权、未结束分派任务和活动运行。
- 开始注销设置pending_deletion；取消清除；待注销账号仍可对外发起所有权转移。
- 完成时串行检查全部交接和最后管理员保护，吊销凭证/租约、取消相关pending转移并软注销。

#### 业务规则

- BR-GOV-ACCOUNT-CLOSURE-BLOCK：条件：已开始注销但仍有团队/项目所有权或未结束任务/运行；判定/结果：完成返回account_closure_blocked及责任清单，pending_deletion仍true且账号凭证未被最终吊销。
- BR-GOV-ACCOUNT-CLOSURE-COMPLETE：条件：begin后全部责任交接完成且非最后有效管理员；判定/结果：完成软注销、取消本人发起或作为收件人的pending转移，设备会话和相关租约失效，历史保留。
- BR-GOV-ACCOUNT-CLOSURE-CANCEL：条件：用户取消注销或尚未begin即complete；判定/结果：cancel恢复pending_deletion=false；未begin完成返回account_closure_not_started；最后管理员完成返回last_system_admin_protected。

#### 状态变化/保留

- begin/cancel只改变pending_deletion并审计；complete设disabled、deleted_at、清password/bind token，pending_deletion=false。
- 保留用户和业务历史，不删除既有业务记录；最后有效平台管理员不能完成注销。

#### 数据契约

- open_tasks排除closed/failed/cancelled；active_runs含active/preparing/suspended。
- 归档项目和历史owner记录同样阻塞；待注销不能接收所有权或创建新团队/项目。

#### 异常与边界

- 条件：尚未begin，pending_deletion=false即请求complete。；处理：返回account_closure_not_started，账号状态、凭证、租约及历史保持；必须先开始注销流程（BR-GOV-ACCOUNT-CLOSURE-CANCEL / AC-GOV-ACCOUNT-CLOSURE-CANCEL）。
- 条件：已begin但仍有独占或历史未确认团队/项目所有权、非closed/failed/cancelled分派任务，或active/preparing/suspended运行。；处理：返回account_closure_blocked及责任清单，pending_deletion仍为true；不执行最终凭证/租约吊销或软注销；完成既有交接后可用新请求再次检查（BR-GOV-ACCOUNT-CLOSURE-BLOCK / AC-GOV-ACCOUNT-CLOSURE-BLOCK）。
- 条件：责任已清空，但当前用户是最后一个active且未deleted的平台管理员。；处理：返回last_system_admin_protected，账号保持active与待注销状态，不清密码或注销历史；配置其他有效管理员后再请求完成（BR-GOV-ACCOUNT-CLOSURE-CANCEL / AC-GOV-ACCOUNT-CLOSURE-CANCEL）。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-ACCOUNT-CLOSURE-BLOCK` | 已开始注销但仍有团队/项目所有权或未结束任务/运行时，完成返回account_closure_blocked及责任清单，pending_deletion仍true且账号凭证未被最终吊销。 |
| `AC-GOV-ACCOUNT-CLOSURE-COMPLETE` | begin后全部责任交接完成且非最后有效管理员时，完成软注销、取消本人发起或作为收件人的pending转移，设备会话和相关租约失效，历史保留。 |
| `AC-GOV-ACCOUNT-CLOSURE-CANCEL` | 用户取消注销或尚未begin即complete时，cancel恢复pending_deletion=false；未begin完成返回account_closure_not_started；最后管理员完成返回last_system_admin_protected。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-ACCOUNT-CLOSURE-BLOCK** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U有归档自有项目和一个open任务；无其他阻塞；保存状态。
- 操作：
  1. GET /account/closure并begin；POST complete；比对清单和账号记录。
  2. 按既有交接流程转移项目并结束/交接任务，重新查询清单。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：完成返回account_closure_blocked及责任清单，pending_deletion仍true且账号凭证未被最终吊销。

**AC-GOV-ACCOUNT-CLOSURE-COMPLETE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立普通U，已begin、无owned/legacy责任、无open_tasks/active_runs；保留历史已结束任务、设备和相关租约。
- 操作：
  1. POST complete；以旧会话请求whoami；检查user/device/session/lease/transfer和历史记录。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：完成软注销、取消本人发起或作为收件人的pending转移，设备会话和相关租约失效，历史保留。

**AC-GOV-ACCOUNT-CLOSURE-CANCEL** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支独立状态；普通U、唯一有效管理员A均无业务责任。
- 操作：
  1. U begin后cancel，查询状态。
  2. 独立U未begin调用complete。
  3. A begin后complete，检查仍active。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：cancel恢复pending_deletion=false；未begin完成返回account_closure_not_started；最后管理员完成返回last_system_admin_protected。

#### 来源与已有测试定义

- `packages/application/src/ownership-use-cases.ts:226-240`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:249-268`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:266-286`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:260-272`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 注销为软删除，数据保留期限与法律要求未提供；账号再次开通不等于恢复注销账号。

### REQ-GOV-CLI-AUTH-LOCAL · CLI认证本机状态、浏览器等待与退出恢复

**观察类型：** `observed_in_code`

**摘要：** CLI认证本机状态、浏览器等待与退出恢复的当前行为：覆盖4组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 使用CLI的账号持有人

**触发：** 执行auth login/login-password/passwd/logout/whoami

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 规范化API URL，按API地址加载或首次创建安装证明；现有身份损坏或链接路径拒绝覆盖。
- auth login可选择一次性token或浏览器授权，成功才保存auth配置；login-password先保存会话再可选改密。
- 浏览器授权显示地址/人读码并等待，pending继续，slow_down增加本地间隔；到截止时expired_token。
- logout在API返回结果后删除auth配置并保留安装证明；网络失败由客户端转为api_unreachable，仍删除本地配置，不代表服务器会话已吊销。

#### 业务规则

- BR-GOV-CLI-AUTH-LOCAL-LOCAL：条件：相同规范化API反复登录或注销再登录；判定/结果：重用安装身份；成功只输出设备/用户/名称而不输出device_token；退出删当前auth配置，安装身份保留。
- BR-GOV-CLI-AUTH-LOCAL-PARTIAL：条件：口令登录成功但--new-password改密被拒绝，或logout远端失败；判定/结果：改密失败退出码1但已保存会话可用于后续passwd；logout结构化失败或网络api_unreachable都删除本地配置，网络失败时远端会话是否吊销不能确定。
- BR-GOV-CLI-AUTH-LOCAL-BROWSER：条件：授权请求有效但浏览器打不开、用户尚未批准或最终过期；判定/结果：打开浏览器失败会提示人工地址并继续等待；pending继续轮询，slow_down本地间隔加5秒，截止时expired_token且不保存新auth配置。
- BR-GOV-CLI-AUTH-LOCAL-INVALID：条件：API URL含凭证/query或本机身份文件损坏/是链接；判定/结果：api_url_invalid或auth_identity_invalid，不覆盖身份文件、不开始新登录；保留原文件供排查。

#### 状态变化/保留

- 成功写当前API/user/device/session配置；安装证明跨logout保留。
- --new-password失败时登录配置已保存，仍可passwd恢复；不宣称登录和改密是一个原子步骤。

#### 数据契约

- API URL只允许无用户名/密码/query/fragment的HTTP(S)，规范化尾斜杠。
- 本机安装UUID v4、43字符秘密、cli类型；身份文件≤4096 bytes，逐级拒绝symlink/junction；实际Windows ACL效果未验证。
- browser grant expires_in须&gt;0且≤1800、interval 1至60；--no-browser只输出地址，--web指定前端源。
- auth.json读取兼容user_id字段；写模式0600请求权限不代表跨平台已验证；本地fingerprint仅journal匹配，不授予远程认证。

#### 异常与边界

- 条件：口令登录成功但--new-password改密被拒绝，或logout远端失败；处理：改密失败退出码1但已保存会话可用于后续passwd；logout结构化失败或网络api_unreachable都删除本地配置，网络失败时远端会话是否吊销不能确定。
- 条件：授权请求有效但浏览器打不开、用户尚未批准或最终过期；处理：打开浏览器失败会提示人工地址并继续等待；pending继续轮询，slow_down本地间隔加5秒，截止时expired_token且不保存新auth配置。
- 条件：API URL含凭证/query或本机身份文件损坏/是链接；处理：api_url_invalid或auth_identity_invalid，不覆盖身份文件、不开始新登录；保留原文件供排查。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-CLI-AUTH-LOCAL-LOCAL` | 相同规范化API反复登录或注销再登录时，重用安装身份；成功只输出设备/用户/名称而不输出device_token；退出删当前auth配置，安装身份保留。 |
| `AC-GOV-CLI-AUTH-LOCAL-PARTIAL` | 口令登录成功但--new-password改密被拒绝，或logout远端失败时，改密失败退出码1但已保存会话可用于后续passwd；logout结构化失败或网络api_unreachable都删除本地配置，网络失败时远端会话是否吊销不能确定。 |
| `AC-GOV-CLI-AUTH-LOCAL-BROWSER` | 授权请求有效但浏览器打不开、用户尚未批准或最终过期时，打开浏览器失败会提示人工地址并继续等待；pending继续轮询，slow_down本地间隔加5秒，截止时expired_token且不保存新auth配置。 |
| `AC-GOV-CLI-AUTH-LOCAL-INVALID` | API URL含凭证/query或本机身份文件损坏/是链接时，api_url_invalid或auth_identity_invalid，不覆盖身份文件、不开始新登录；保留原文件供排查。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-CLI-AUTH-LOCAL-LOCAL** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：隔离AGENTCTL_HOME临时目录和受控API服务器；U有效，已知本地安装文件列表；不用真实用户配置。
- 操作：
  1. 用auth login --api或login-password成功登录，记录输出与本地配置。
  2. auth logout后检查auth文件消失但devices文件保留；相同API再登录比较installation_id。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：重用安装身份；成功只输出设备/用户/名称而不输出device_token；退出删当前auth配置，安装身份保留。

**AC-GOV-CLI-AUTH-LOCAL-PARTIAL** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每分支独立临时AGENTCTL_HOME；受控API分别返回登录成功/改密拒绝、logout结构化错误或连接异常。
- 操作：
  1. 执行login-password --new-password为无效值；检查auth存在并用passwd修复。
  2. 独立模拟logout失败响应与网络异常，核对本地配置均已删除且安装证明保留；服务端会话状态另外读取。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：改密失败退出码1但已保存会话可用于后续passwd；logout结构化失败或网络api_unreachable都删除本地配置，网络失败时远端会话是否吊销不能确定。

**AC-GOV-CLI-AUTH-LOCAL-BROWSER** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立临时目录、受控API grant间隔/有效期；替代浏览器启动为失败；控制UTC时钟与响应序列。
- 操作：
  1. auth login --no-browser验证只输出地址；另模拟启动失败。
  2. 返回pending、slow_down后始终pending至deadline，记录请求间隔和最终退出。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：打开浏览器失败会提示人工地址并继续等待；pending继续轮询，slow_down本地间隔加5秒，截止时expired_token且不保存新auth配置。

**AC-GOV-CLI-AUTH-LOCAL-INVALID** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立临时AGENTCTL_HOME，包含损坏JSON/非v4 UUID/链接祖先的不同副本；API请求计数为0。
- 操作：
  1. 分别用含userinfo URL、查询URL登录；读取各损坏身份并尝试登录；比较原文件字节及远端计数。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：api_url_invalid或auth_identity_invalid，不覆盖身份文件、不开始新登录；保留原文件供排查。

#### 来源与已有测试定义

- `apps/cli/src/index.ts:190-243`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`
- `apps/cli/src/device-identity.ts:16-60`；SHA-256 `cb8113e79887d7590655adb2409f68e3392ff0a514a51d949d989476a780da9c`
- `apps/cli/src/auth-store.ts:50-54`；SHA-256 `08fbc4396ea9be53871252f69910fae686fa93dcc8daf3f23605c6728ecf571d`
- `apps/cli/src/auth-store.ts:99-101`；SHA-256 `08fbc4396ea9be53871252f69910fae686fa93dcc8daf3f23605c6728ecf571d`
- `apps/cli/src/index.ts:228-243`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`
- `apps/cli/src/index.ts:247-305`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`
- `apps/cli/src/api-client.ts:46-88`；SHA-256 `043e0796c15ca7150906d4fb38ad7e3e31d1ecf8e8070cc62a47345d62dceefc`
- `apps/cli/src/browser-auth.ts:10-58`；SHA-256 `ea184090be63d237cce9893f768746102cf380fb990f3b5a73af1aef06465171`
- `apps/cli/src/index.ts:202-220`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 登录结果未知时没有自动查询原exchange结果的恢复协议；再次授权可能产生新session；不能宣称网络重试幂等。
- CLI本地文件权限跨平台效果和交互浏览器行为未运行。

## M02 · 团队、项目与权限治理

对应平台父模块：`tsp-module-collaboration`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-GOV-TEAM-DIRECTORY · 团队建立、查看、重命名与个人排序

**观察类型：** `observed_in_code`

**摘要：** 团队建立、查看、重命名与个人排序的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 有效用户；重命名需团队Owner/Admin

**触发：** 创建团队、查看目录或改变名称/顺序

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 有效非待注销用户以非空名称创建团队并成为唯一Owner；底层普通成员行存admin。
- 仅列出本人正式成员团队，计算有效角色与可见项目数。
- Owner/Admin改名，个人排序须提交全部团队且不重复。

#### 业务规则

- BR-GOV-TEAM-DIRECTORY-CREATE：条件：有效非待注销账号提交非空团队名；判定/结果：创建team、admin成员行，返回role=owner且owner_code/created_by均为本人；空白名拒绝。
- BR-GOV-TEAM-DIRECTORY-NAME：条件：Owner或Admin重命名；普通Member尝试相同操作；判定/结果：管理者非空新名成功；Member team_forbidden；同名请求保留名称且不新增rename审计。
- BR-GOV-TEAM-DIRECTORY-ORDER：条件：用户对自己全部团队提交无重复完整编码集合；判定/结果：按指定个人顺序返回；遗漏/重复/不属于本人的编码team_order_invalid；其他成员顺序保持。

#### 状态变化/保留

- 创建team及成员行和审计同事务；created_by与owner分开保留。
- 排序/改名不改变其他人的排序或所有权。

#### 数据契约

- 列表按个人sort_order、created_at、team.code升序；一般成员projects_count仅计可访问项目，管理者计团队全部项目。
- 同名改名不写更新审计；排序只改变当前用户teamMembers.sort_order。

#### 异常与边界

- 条件：有效非待注销账号提交非空团队名；处理：创建team、admin成员行，返回role=owner且owner_code/created_by均为本人；空白名拒绝。
- 条件：Owner或Admin重命名；普通Member尝试相同操作；处理：管理者非空新名成功；Member team_forbidden；同名请求保留名称且不新增rename审计。
- 条件：用户对自己全部团队提交无重复完整编码集合；处理：按指定个人顺序返回；遗漏/重复/不属于本人的编码team_order_invalid；其他成员顺序保持。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-TEAM-DIRECTORY-CREATE` | 有效非待注销账号提交非空团队名时，创建team、admin成员行，返回role=owner且owner_code/created_by均为本人；空白名拒绝。 |
| `AC-GOV-TEAM-DIRECTORY-NAME` | Owner或Admin重命名；普通Member尝试相同操作时，管理者非空新名成功；Member team_forbidden；同名请求保留名称且不新增rename审计。 |
| `AC-GOV-TEAM-DIRECTORY-ORDER` | 用户对自己全部团队提交无重复完整编码集合时，按指定个人顺序返回；遗漏/重复/不属于本人的编码team_order_invalid；其他成员顺序保持。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-TEAM-DIRECTORY-CREATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U有效，无团队；另用独立pending_deletion U分支。
- 操作：
  1. U POST /teams name="研发"并GET /teams。
  2. 独立空白名、待注销用户分别创建。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：创建team、admin成员行，返回role=owner且owner_code/created_by均为本人；空白名拒绝。

**AC-GOV-TEAM-DIRECTORY-NAME** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：团队T中O owner、A admin、M member；保存审计数。
- 操作：
  1. A PATCH /teams/T为新名，再重复新名；M改名。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：管理者非空新名成功；Member team_forbidden；同名请求保留名称且不新增rename审计。

**AC-GOV-TEAM-DIRECTORY-ORDER** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U正式属于T1/T2；V同时属于这两团队；U另不可见T3。
- 操作：
  1. U PUT /teams/order [T2,T1]，读取U和V列表。
  2. 独立恢复后提交[T1]、[T1,T1]、[T1,T3]。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：按指定个人顺序返回；遗漏/重复/不属于本人的编码team_order_invalid；其他成员顺序保持。

#### 来源与已有测试定义

- `packages/application/src/team-use-cases.ts:48-64`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/team-use-cases.ts:35-38`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/team-use-cases.ts:70-87`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/team-use-cases.ts:93-130`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-TEAM-MEMBERS · 团队角色管理、移除预览和项目访问撤销

**观察类型：** `observed_in_code`

**摘要：** 团队角色管理、移除预览和项目访问撤销的当前行为：覆盖4组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 团队Owner/Admin

**触发：** 增删成员、改角色或查看移除影响/项目治理

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 查看团队正式成员及治理元数据；治理列表不自动授予私有项目内容访问。
- 仅授予Admin/Member，Owner独占管理员任免且本人Owner不可直接修改/删除。
- 移除前预览并检查其项目所有权/open工作，完成交接后同事务撤销团队内所有单独项目授权与团队成员行。

#### 业务规则

- BR-GOV-TEAM-MEMBERS-ROLE：条件：Owner为有效用户授予Admin或Member；Admin管理普通Member；判定/结果：合法变更成功；Owner自身受team_owner_protected保护，Admin任免Admin被team_forbidden拒绝；重复添加team_member_exists。
- BR-GOV-TEAM-MEMBERS-REMOVE：条件：待移除成员不再持有团队项目所有权且无未交接工作；判定/结果：移除该团队成员及团队内全部显式项目授权，继承访问一并消失；其他团队私有项目外部授权不变。
- BR-GOV-TEAM-MEMBERS-BLOCK：条件：目标仍拥有任一团队项目，或有非终态任务/active、preparing、suspended运行；判定/结果：分别project_owner_protected或team_member_has_open_tasks，清单标识阻塞项；全部授权和成员行不变。
- BR-GOV-TEAM-MEMBERS-GOVERNANCE：条件：团队管理者查看项目治理；判定/结果：看到全部团队项目的负责人/状态/ownership_pending/can_access；can_access=false的私有项目仍不可读取正文。

#### 状态变化/保留

- add/update写成员与审计；remove同时撤销所在团队全部项目explicit grants，不动其他团队授权。
- 所有权或未结束工作阻塞时事务保持团队/项目授权不变。

#### 数据契约

- 普通团队成员仅可查看成员；管理入口Owner/Admin；Admin不可管理现有Admin或授予Admin。
- 移除影响返回projects、blocked_owned_projects、open_tasks、active_runs；其他团队外部授权保留。
- 涉及团队项目的变更持有项目fence；并发项目集合变化重试，最多5次尝试。

#### 异常与边界

- 条件：Owner为有效用户授予Admin或Member；Admin管理普通Member；处理：合法变更成功；Owner自身受team_owner_protected保护，Admin任免Admin被team_forbidden拒绝；重复添加team_member_exists。
- 条件：目标仍拥有任一团队项目，或有非终态任务/active、preparing、suspended运行；处理：分别project_owner_protected或team_member_has_open_tasks，清单标识阻塞项；全部授权和成员行不变。
- 条件：团队管理者查看项目治理；处理：看到全部团队项目的负责人/状态/ownership_pending/can_access；can_access=false的私有项目仍不可读取正文。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-TEAM-MEMBERS-ROLE` | Owner为有效用户授予Admin或Member；Admin管理普通Member时，合法变更成功；Owner自身受team_owner_protected保护，Admin任免Admin被team_forbidden拒绝；重复添加team_member_exists。 |
| `AC-GOV-TEAM-MEMBERS-REMOVE` | 待移除成员不再持有团队项目所有权且无未交接工作时，移除该团队成员及团队内全部显式项目授权，继承访问一并消失；其他团队私有项目外部授权不变。 |
| `AC-GOV-TEAM-MEMBERS-BLOCK` | 目标仍拥有任一团队项目，或有非终态任务/active、preparing、suspended运行时，分别project_owner_protected或team_member_has_open_tasks，清单标识阻塞项；全部授权和成员行不变。 |
| `AC-GOV-TEAM-MEMBERS-GOVERNANCE` | 团队管理者查看项目治理时，看到全部团队项目的负责人/状态/ownership_pending/can_access；can_access=false的私有项目仍不可读取正文。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-TEAM-MEMBERS-ROLE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：T中O owner、A admin、M member、有效N尚未加入。
- 操作：
  1. O添加N member，A改N member；O改N admin。
  2. A尝试改/移除N admin；O尝试修改O；重复添加M。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：合法变更成功；Owner自身受team_owner_protected保护，Admin任免Admin被team_forbidden拒绝；重复添加team_member_exists。

**AC-GOV-TEAM-MEMBERS-REMOVE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：T1成员U在T1项目P1有explicit grant，在T2的P2有外部grant；无所有权/未结束工作。
- 操作：
  1. 管理者先GET removal-impact再DELETE团队成员。
  2. 用U分别访问P1/P2并读成员列表。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：移除该团队成员及团队内全部显式项目授权，继承访问一并消失；其他团队私有项目外部授权不变。

**AC-GOV-TEAM-MEMBERS-BLOCK** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每次独立T/U；分别准备owned P、分派未关闭任务、非分派但由U执行的活动run。
- 操作：
  1. 预览影响，尝试移除；读取teamMembers/members及阻塞清单。
  2. 完成已知交接后用新移除请求重试。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别project_owner_protected或team_member_has_open_tasks，清单标识阻塞项；全部授权和成员行不变。

**AC-GOV-TEAM-MEMBERS-GOVERNANCE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：T owner O但私有项目P未给O项目grant；另普通T成员M。
- 操作：
  1. O GET projects-governance；访问P内容，检查拒绝。
  2. M请求治理列表。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：看到全部团队项目的负责人/状态/ownership_pending/can_access；can_access=false的私有项目仍不可读取正文。

#### 来源与已有测试定义

- `packages/application/src/team-use-cases.ts:35-38`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/team-use-cases.ts:148-187`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/team-use-cases.ts:193-245`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/team-use-cases.ts:174-178`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/team-use-cases.ts:193-213`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/team-use-cases.ts:216-245`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/team-use-cases.ts:250-267`；SHA-256 `ea975641b905b8d6f5d47af4d46e635fec4f44e8f43d6295518b67c220d126f2`
- `packages/application/src/project-access.ts:41-55`；SHA-256 `4501fc66a37efa3cf06a22428ca1ec3cfbcd54a1a0e269bdaffdaa170ffdc43c`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 预览与删除之间状态可能改变，删除重新检查才是决定；重试耗尽为运行故障，未虚构自动补偿。

### REQ-GOV-PROJECT-CREATE-DIRECTORY · 创建项目并按有效访问展示与个人排序

**观察类型：** `observed_in_code`

**摘要：** 创建项目并按有效访问展示与个人排序的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 团队Owner/Admin或已有项目访问者

**触发：** 新建项目、列出/读取项目与排序

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 团队管理者新建项目，默认team_read，创建者成为唯一Owner并初始化系统目录。
- 按Owner→explicit→团队策略解析项目可见性，展示权限来源/外部协作标记。
- 用户只对该团队全部可访问项目保存个人顺序。

#### 业务规则

- BR-GOV-PROJECT-CREATE-DIRECTORY-CREATE：条件：有效团队Owner或Admin且非待注销创建项目；判定/结果：默认team_read并返回owner，建立唯一owner与created_by；普通团队成员被project_create_forbidden拒绝。
- BR-GOV-PROJECT-CREATE-DIRECTORY-VISIBLE：条件：用户对部分项目为团队继承/explicit/外部协作者；判定/结果：仅有效可见项目返回，附role/access_source/is_external/member_policy；私有未授权项目不返回。
- BR-GOV-PROJECT-CREATE-DIRECTORY-ORDER：条件：用户按团队提交全部可见项目完整集合；判定/结果：个人顺序持久化且不新增explicit grant；遗漏/重复/越权项目project_order_invalid。

#### 状态变化/保留

- 创建project/admin成员行/目录及审计同事务；保留created_by。
- 个人项目排序不改变members或继承关系。

#### 数据契约

- member_policy为private/team_read/team_write，默认team_read；name非空，description空值规范为null。
- 未自定义顺序时created_at和code升序；projectOrders只保存个人排序，不产生授权。

#### 异常与边界

- 条件：有效团队Owner或Admin且非待注销创建项目；处理：默认team_read并返回owner，建立唯一owner与created_by；普通团队成员被project_create_forbidden拒绝。
- 条件：用户按团队提交全部可见项目完整集合；处理：个人顺序持久化且不新增explicit grant；遗漏/重复/越权项目project_order_invalid。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-PROJECT-CREATE-DIRECTORY-CREATE` | 有效团队Owner或Admin且非待注销创建项目时，默认team_read并返回owner，建立唯一owner与created_by；普通团队成员被project_create_forbidden拒绝。 |
| `AC-GOV-PROJECT-CREATE-DIRECTORY-VISIBLE` | 用户对部分项目为团队继承/explicit/外部协作者时，仅有效可见项目返回，附role/access_source/is_external/member_policy；私有未授权项目不返回。 |
| `AC-GOV-PROJECT-CREATE-DIRECTORY-ORDER` | 用户按团队提交全部可见项目完整集合时，个人顺序持久化且不新增explicit grant；遗漏/重复/越权项目project_order_invalid。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-PROJECT-CREATE-DIRECTORY-CREATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：T中O owner、A admin、M member；三者有效。
- 操作：
  1. A POST /projects team_code=T,name="项目"；GET新项目并查看策略/角色/目录。
  2. 独立M尝试创建。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：默认team_read并返回owner，建立唯一owner与created_by；普通团队成员被project_create_forbidden拒绝。

**AC-GOV-PROJECT-CREATE-DIRECTORY-VISIBLE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U属于T1；T1含team_read P1、private P2无U授权；T2 private P3给U member。
- 操作：
  1. U GET /projects及按T1过滤；GET P2；比较P1/P3外部标记。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：仅有效可见项目返回，附role/access_source/is_external/member_policy；私有未授权项目不返回。

**AC-GOV-PROJECT-CREATE-DIRECTORY-ORDER** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：U通过团队继承可见P1/P2，未显式授权；另私有P3不可见。
- 操作：
  1. PUT /projects/order team_code=T,project_codes=[P2,P1]；GET并查看members未增加。
  2. 独立遗漏或夹带P3排序。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：个人顺序持久化且不新增explicit grant；遗漏/重复/越权项目project_order_invalid。

#### 来源与已有测试定义

- `packages/application/src/project-use-cases-project.ts:41-118`；SHA-256 `141196e18895a6d875d31579423b90310558577ea9d18a9ed871e68b22df0c44`
- `packages/application/src/project-access.ts:22-26`；SHA-256 `4501fc66a37efa3cf06a22428ca1ec3cfbcd54a1a0e269bdaffdaa170ffdc43c`
- `packages/application/src/project-use-cases-project.ts:125-158`；SHA-256 `141196e18895a6d875d31579423b90310558577ea9d18a9ed871e68b22df0c44`
- `packages/application/src/project-access.ts:41-55`；SHA-256 `4501fc66a37efa3cf06a22428ca1ec3cfbcd54a1a0e269bdaffdaa170ffdc43c`
- `packages/application/src/project-use-cases-project.ts:161-178`；SHA-256 `141196e18895a6d875d31579423b90310558577ea9d18a9ed871e68b22df0c44`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 一些错误文案写“只有Owner”，实际isProjectManager允许Admin；以实现条件为当前观察，文案冲突单列。

### REQ-GOV-PROJECT-EDIT-ARCHIVE · 项目资料修订、归档与恢复

**观察类型：** `observed_in_code`

**摘要：** 项目资料修订、归档与恢复的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目Owner/Admin修改资料；仅Owner归档恢复

**触发：** 编辑基本信息或设置active/archived

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 管理者更新非空项目名及可选说明，事务内重新检查权限。
- 内容相同直接返回原snapshot，不产生修改。
- 仅Owner改变归档状态；归档保留读取与历史并拒绝受manage/write检查的内容操作。

#### 业务规则

- BR-GOV-PROJECT-EDIT-ARCHIVE-EDIT：条件：项目Owner/Admin提交不同名称或说明；判定/结果：修改内容且current_snapshot加1；再次完全相同请求snapshot保持，普通成员拒绝。
- BR-GOV-PROJECT-EDIT-ARCHIVE-ARCHIVE：条件：Owner归档active项目再恢复；判定/结果：archived且snapshot加1，仍能读取历史；write/manage入口拒绝，恢复active再加1；Admin不能归档。

#### 状态变化/保留

- project.updated/archived/restored审计与项目变更同事务。
- archived不删除模块/任务/需求，restore恢复active。

#### 数据契约

- description未给出则保留，显式null或空白清空。
- 资料或状态真实改变current_snapshot加1；重复相同状态不加版本。

#### 异常与边界

- 条件：项目Owner/Admin提交不同名称或说明；处理：修改内容且current_snapshot加1；再次完全相同请求snapshot保持，普通成员拒绝。
- 条件：Owner归档active项目再恢复；处理：archived且snapshot加1，仍能读取历史；write/manage入口拒绝，恢复active再加1；Admin不能归档。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-PROJECT-EDIT-ARCHIVE-EDIT` | 项目Owner/Admin提交不同名称或说明时，修改内容且current_snapshot加1；再次完全相同请求snapshot保持，普通成员拒绝。 |
| `AC-GOV-PROJECT-EDIT-ARCHIVE-ARCHIVE` | Owner归档active项目再恢复时，archived且snapshot加1，仍能读取历史；write/manage入口拒绝，恢复active再加1；Admin不能归档。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-PROJECT-EDIT-ARCHIVE-EDIT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P，O owner、A admin、M member；记录snapshot N。
- 操作：
  1. A PATCH /projects/P新name，省略description检查保留；再次同请求。
  2. 独立恢复后M修改。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：修改内容且current_snapshot加1；再次完全相同请求snapshot保持，普通成员拒绝。

**AC-GOV-PROJECT-EDIT-ARCHIVE-ARCHIVE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P，Owner O、Admin A和已有需求R。
- 操作：
  1. A先请求归档；O归档，读取P/R并尝试更新R。
  2. O重复归档检查不加snapshot，再恢复。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：archived且snapshot加1，仍能读取历史；write/manage入口拒绝，恢复active再加1；Admin不能归档。

#### 来源与已有测试定义

- `packages/application/src/project-use-cases-project.ts:181-240`；SHA-256 `141196e18895a6d875d31579423b90310558577ea9d18a9ed871e68b22df0c44`
- `packages/application/src/project-use-cases-project.ts:248-303`；SHA-256 `141196e18895a6d875d31579423b90310558577ea9d18a9ed871e68b22df0c44`
- `packages/application/src/project-access.ts:65-73`；SHA-256 `4501fc66a37efa3cf06a22428ca1ec3cfbcd54a1a0e269bdaffdaa170ffdc43c`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 归档限制以各实际入口的检查为准，不能推导所有内部函数都统一具备状态机或事务。

### REQ-GOV-PROJECT-EFFECTIVE-MEMBERS · 有效权限优先级与单独项目授权

**观察类型：** `observed_in_code`

**摘要：** 有效权限优先级与单独项目授权的当前行为：覆盖4组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 有效项目成员；授权变更需Owner/Admin

**触发：** 解析成员能力、列名册或维护explicit grant

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 按唯一Owner、单独grant、team默认、无访问四层顺序解析。
- 名册展示继承及单独成员、权限来源、外部标记与能力。
- 移除单独授权可能恢复团队继承；失去写权限之前必须交接工作，Owner受保护。

#### 业务规则

- BR-GOV-PROJECT-EFFECTIVE-MEMBERS-PRECEDENCE：条件：team_write用户有显式viewer授权；判定/结果：有效角色viewer/source=explicit且write=false；移除grant后恢复member/source=team，若仍有工作但写权限不丢失可成功。
- BR-GOV-PROJECT-EFFECTIVE-MEMBERS-ROLE：条件：Owner维护admin/member/viewer授权，Admin只管理非Admin；判定/结果：成功返回effective_role/access_source；任免owner或Admin越界、重复add、移除无explicit grant分别拒绝且原授权不变。
- BR-GOV-PROJECT-EFFECTIVE-MEMBERS-HANDOFF：条件：变更导致目标无写权限且其仍有开放任务或活动运行；判定/结果：member_has_open_tasks携带task/run编码，授权不变；交接结束后新请求可成功。
- BR-GOV-PROJECT-EFFECTIVE-MEMBERS-ROSTER：条件：用户通过HTTP GET /projects/P/members读取名册，可为内部或外部协作者；判定/结果：有访问权者获得Owner、explicit及策略继承的有效成员名册，按display_name/code排序；外部explicit用户is_external=true。无项目访问权的有效用户在HTTP路由前置getProject检查返回ok=false/project_forbidden且不返回名册正文；内部listMembers无访问时返回[]不等于该HTTP响应。

#### 状态变化/保留

- 删除grant只删除members，不删除teamMembers；结果role按恢复的继承权限返回。
- 降至viewer/无访问时存在非closed/failed/cancelled分派任务或active/preparing/suspended run则拒绝。

#### 数据契约

- team_read→viewer，team_write→member，private不继承；显式viewer覆盖team_write。
- 可授admin/member/viewer；Admin不能任免Admin；归档项目不能改权限。
- Owner/Admin管理；read允许四角色；write排除viewer；manage_admins/manage_policy/transfer/archive只有Owner。

#### 异常与边界

- 条件：Owner维护admin/member/viewer授权，Admin只管理非Admin；处理：成功返回effective_role/access_source；任免owner或Admin越界、重复add、移除无explicit grant分别拒绝且原授权不变。
- 条件：用户通过HTTP GET /projects/P/members读取名册，可为内部或外部协作者；处理：有访问权者获得Owner、explicit及策略继承的有效成员名册，按display_name/code排序；外部explicit用户is_external=true。无项目访问权的有效用户在HTTP路由前置getProject检查返回ok=false/project_forbidden且不返回名册正文；内部listMembers无访问时返回[]不等于该HTTP响应。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-PROJECT-EFFECTIVE-MEMBERS-PRECEDENCE` | team_write用户有显式viewer授权时，有效角色viewer/source=explicit且write=false；移除grant后恢复member/source=team，若仍有工作但写权限不丢失可成功。 |
| `AC-GOV-PROJECT-EFFECTIVE-MEMBERS-ROLE` | Owner维护admin/member/viewer授权，Admin只管理非Admin时，成功返回effective_role/access_source；任免owner或Admin越界、重复add、移除无explicit grant分别拒绝且原授权不变。 |
| `AC-GOV-PROJECT-EFFECTIVE-MEMBERS-HANDOFF` | 变更导致目标无写权限且其仍有开放任务或活动运行时，member_has_open_tasks携带task/run编码，授权不变；交接结束后新请求可成功。 |
| `AC-GOV-PROJECT-EFFECTIVE-MEMBERS-ROSTER` | 用户通过HTTP GET /projects/P/members读取名册，可为内部或外部协作者时，有访问权者获得Owner、explicit及策略继承的有效成员名册，按display_name/code排序；外部explicit用户is_external=true。无项目访问权的有效用户在HTTP路由前置getProject检查返回ok=false/project_forbidden且不返回名册正文；内部listMembers无访问时返回[]不等于该HTTP响应。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-PROJECT-EFFECTIVE-MEMBERS-PRECEDENCE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：T成员U；active P为team_write，U显式viewer；O owner；独立恢复测试数据。
- 操作：
  1. GET名册和P能力，O DELETE U的项目grant；再查有效角色。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：有效角色viewer/source=explicit且write=false；移除grant后恢复member/source=team，若仍有工作但写权限不丢失可成功。

**AC-GOV-PROJECT-EFFECTIVE-MEMBERS-ROLE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P中O owner、A admin、M member，另有效N；各变体独立复位。
- 操作：
  1. O授N admin；A尝试改N和O，重复add M。
  2. 尝试移除只有继承访问且无explicit行的用户。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：成功返回effective_role/access_source；任免owner或Admin越界、重复add、移除无explicit grant分别拒绝且原授权不变。

**AC-GOV-PROJECT-EFFECTIVE-MEMBERS-HANDOFF** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：private P的explicit member U，任务未终结；另独立分支任务已终结但U仍有suspended run。
- 操作：
  1. Owner改U viewer或删除grant，观察失败和原grant。
  2. 按既有交接结束工作后再次发起变更。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：member_has_open_tasks携带task/run编码，授权不变；交接结束后新请求可成功。

**AC-GOV-PROJECT-EFFECTIVE-MEMBERS-ROSTER** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P为team_read，Owner O，团队成员U，非团队用户X有P的explicit member授权，Y有效且无P团队/explicit/owner访问。记录原成员行；使用U/Y各自有效Bearer会话；其他条件相同。
- 操作：
  1. 以U GET /projects/P/members，核对名册角色、access_source、外部X标记与display_name/code顺序。
  2. 以Y GET同一URL，核对ok=false、error.code=project_forbidden且无成员data；再读取隔离库确认成员行未变化。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：有访问权者获得Owner、explicit及策略继承的有效成员名册，按display_name/code排序；外部explicit用户is_external=true。无项目访问权的有效用户在HTTP路由前置getProject检查返回ok=false/project_forbidden且不返回名册正文；内部listMembers无访问时返回[]不等于该HTTP响应。

#### 来源与已有测试定义

- `packages/application/src/project-access.ts:22-26`；SHA-256 `4501fc66a37efa3cf06a22428ca1ec3cfbcd54a1a0e269bdaffdaa170ffdc43c`
- `packages/application/src/project-access.ts:41-55`；SHA-256 `4501fc66a37efa3cf06a22428ca1ec3cfbcd54a1a0e269bdaffdaa170ffdc43c`
- `packages/application/src/member-use-cases.ts:73-97`；SHA-256 `37757662125624c660c1bbad6bace32471f143dd6b9306912e1061dbe9bc6d28`
- `packages/application/src/member-use-cases.ts:14-25`；SHA-256 `37757662125624c660c1bbad6bace32471f143dd6b9306912e1061dbe9bc6d28`
- `packages/application/src/member-use-cases.ts:43-97`；SHA-256 `37757662125624c660c1bbad6bace32471f143dd6b9306912e1061dbe9bc6d28`
- `packages/application/src/member-use-cases.ts:28-39`；SHA-256 `37757662125624c660c1bbad6bace32471f143dd6b9306912e1061dbe9bc6d28`
- `apps/core-api/src/routes/projects.ts:167-171`；SHA-256 `4f016bc1bf57e3a429142799654121e533907397263aae7cf82bf47c857c75eb`
- `packages/application/src/project-use-cases-project.ts:310-315`；SHA-256 `141196e18895a6d875d31579423b90310558577ea9d18a9ed871e68b22df0c44`
- `packages/application/src/member-use-cases.ts:103-124`；SHA-256 `37757662125624c660c1bbad6bace32471f143dd6b9306912e1061dbe9bc6d28`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-PROJECT-POLICY · 项目访问策略预览及安全降权

**观察类型：** `observed_in_code`

**摘要：** 项目访问策略预览及安全降权的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 唯一项目Owner

**触发：** 预览或变更private/team_read/team_write

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- Owner选择策略，预览未被explicit覆盖的有效团队用户变化。
- 事务内重查Owner和active状态；team_write降为其他策略前检查继承写者的未交接任务/运行。
- 仅更改默认策略，保留explicit例外、Owner与业务历史。

#### 业务规则

- BR-GOV-PROJECT-POLICY-PREVIEW：条件：Owner预览team_read→team_write；判定/结果：仅继承viewer变member计gained_write；explicit viewer仍viewer；Admin预览被project_forbidden拒绝。
- BR-GOV-PROJECT-POLICY-DOWNGRADE：条件：team_write→team_read/private且继承member仍有开放工作；判定/结果：member_has_open_tasks拒绝并保持team_write；仅explicit写者有工作不阻止默认策略下降。

#### 状态变化/保留

- member_policy即时改变继承访问，project.access_policy_changed审计同事务；未交接阻塞时策略不变。

#### 数据契约

- 预览含gained_read/gained_write/lost_write/lost_access及explicit_exceptions，排除owner、deleted用户和explicit行。
- owner尚未确认时ownership_pending；归档不可更新策略。

#### 异常与边界

- 条件：Owner预览team_read→team_write；处理：仅继承viewer变member计gained_write；explicit viewer仍viewer；Admin预览被project_forbidden拒绝。
- 条件：team_write→team_read/private且继承member仍有开放工作；处理：member_has_open_tasks拒绝并保持team_write；仅explicit写者有工作不阻止默认策略下降。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-PROJECT-POLICY-PREVIEW` | Owner预览team_read→team_write时，仅继承viewer变member计gained_write；explicit viewer仍viewer；Admin预览被project_forbidden拒绝。 |
| `AC-GOV-PROJECT-POLICY-DOWNGRADE` | team_write→team_read/private且继承member仍有开放工作时，member_has_open_tasks拒绝并保持team_write；仅explicit写者有工作不阻止默认策略下降。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-PROJECT-POLICY-PREVIEW** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P team_read，O owner、A admin、U继承、V显式viewer。
- 操作：
  1. O GET access-policy?member_policy=team_write，核对逐人changes/count。
  2. A同请求；O PUT策略后核对U/V权限。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：仅继承viewer变member计gained_write；explicit viewer仍viewer；Admin预览被project_forbidden拒绝。

**AC-GOV-PROJECT-POLICY-DOWNGRADE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立P1有继承writer U开放任务/active run；独立P2只有explicit writer V开放任务。
- 操作：
  1. Owner分别PUT P1/P2目标策略，读取策略及用户权限。
  2. P1交接后重新提交。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：member_has_open_tasks拒绝并保持team_write；仅explicit写者有工作不阻止默认策略下降。

#### 来源与已有测试定义

- `packages/application/src/project-policy-use-cases.ts:12-41`；SHA-256 `dc59aa0d234804565b23b7dc104578377fb39e43a9ab9c5c12d59f32865a2fcf`
- `packages/application/src/project-policy-use-cases.ts:45-74`；SHA-256 `dc59aa0d234804565b23b7dc104578377fb39e43a9ab9c5c12d59f32865a2fcf`
- `packages/application/src/member-use-cases.ts:28-39`；SHA-256 `37757662125624c660c1bbad6bace32471f143dd6b9306912e1061dbe9bc6d28`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-OWNERSHIP-TRANSFER · 有时限的所有权转移与接收

**观察类型：** `observed_in_code`

**摘要：** 有时限的所有权转移与接收的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 当前Owner、目标正式团队成员及转移参与人

**触发：** 发起、列出、接收或取消团队/项目转移

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- Owner发起给有效且非待注销的正式团队成员，7天内一个scope仅一个有效pending请求。
- 请求不立即改owner；仅收件人接受，事务内再次检查owner和收件资格。
- 接受后设置新owner并将新旧负责人底层成员角色保存admin；参与人可取消pending请求。

#### 业务规则

- BR-GOV-OWNERSHIP-TRANSFER-ACCEPT：条件：O向正式团队成员N发起scope转移且N仍有效；判定/结果：创建时owner仍O；N接受后owner=N、旧O有效角色admin、created_by不变；第二次接受ownership_transfer_not_pending。
- BR-GOV-OWNERSHIP-TRANSFER-RECIPIENT：条件：目标不是正式团队成员、已待注销或接受前失去资格；判定/结果：分别ownership_recipient_not_team_member/account_pending_deletion/用户无效错误，owner不变；仅收件人可接受。
- BR-GOV-OWNERSHIP-TRANSFER-CANCEL-EXPIRE：条件：有效pending已存在、参与人取消或7天过期；判定/结果：有效pending阻止重复发起；参与人取消后可新发；过期请求不能接受，新发会取消旧pending并创建新7天请求。

#### 状态变化/保留

- pending→accepted/cancelled；接受改变owner_principal_id但created_by不变。
- 参与状态/owner改变或资格失效时拒绝，原所有权不变。

#### 数据契约

- scope team/project；已是owner拒绝；owner=null须先legacy resolve。
- 只有from/to/initiated_by可列到或取消请求；列表created_at降序无最终tie-break。
- 过期pending在新发起时改cancelled并记录expired审计；过期接受被拒绝，不宣称后台自动到期。

#### 异常与边界

- 条件：接收人不是所属团队正式成员，或处于pending_deletion；发起与接受阶段都检查资格。；处理：分别返回ownership_recipient_not_team_member或account_pending_deletion，原owner不变；接受失败不把pending请求标为accepted（BR-GOV-OWNERSHIP-TRANSFER-RECIPIENT / AC-GOV-OWNERSHIP-TRANSFER-RECIPIENT）。
- 条件：同scope已有未过期pending请求时再次发起转移。；处理：返回ownership_transfer_pending，不创建第二个有效pending，也不改变owner；参与人取消或旧请求到期后再发新请求（BR-GOV-OWNERSHIP-TRANSFER-CANCEL-EXPIRE / AC-GOV-OWNERSHIP-TRANSFER-CANCEL-EXPIRE）。
- 条件：对非pending请求再次接受，或不是收件人本人接受pending请求。；处理：分别返回ownership_transfer_not_pending或ownership_recipient_required，请求状态和owner保持（BR-GOV-OWNERSHIP-TRANSFER-ACCEPT / AC-GOV-OWNERSHIP-TRANSFER-ACCEPT、RECIPIENT）。
- 条件：接受时请求已过期或当前owner已不是请求记录中的from_principal_id。；处理：分别返回ownership_transfer_expired或ownership_changed，不改变owner或请求状态；后续新发请求会在其事务内把旧过期pending置cancelled；有效from/to/initiated_by参与人也可显式取消仍pending的请求，包括已过期请求。账号完成注销还会取消收件人或发起人为该账号的pending请求，见BR-GOV-ACCOUNT-CLOSURE-COMPLETE；不宣称存在后台自动过期处理（BR-GOV-OWNERSHIP-TRANSFER-CANCEL-EXPIRE / AC-GOV-OWNERSHIP-TRANSFER-CANCEL-EXPIRE）。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-OWNERSHIP-TRANSFER-ACCEPT` | O向正式团队成员N发起scope转移且N仍有效时，创建时owner仍O；N接受后owner=N、旧O有效角色admin、created_by不变；第二次接受ownership_transfer_not_pending。 |
| `AC-GOV-OWNERSHIP-TRANSFER-RECIPIENT` | 目标不是正式团队成员、已待注销或接受前失去资格时，分别ownership_recipient_not_team_member/account_pending_deletion/用户无效错误，owner不变；仅收件人可接受。 |
| `AC-GOV-OWNERSHIP-TRANSFER-CANCEL-EXPIRE` | 有效pending已存在、参与人取消或7天过期时，有效pending阻止重复发起；参与人取消后可新发；过期请求不能接受，新发会取消旧pending并创建新7天请求。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-OWNERSHIP-TRANSFER-ACCEPT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个scope独立：T和P Owner O，N是所属T正式成员且非pending_deletion。
- 操作：
  1. O POST ownership-transfers，检查scope owner未变；N POST返回code/accept。
  2. 查询新旧角色及created_by；重试同accept。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：创建时owner仍O；N接受后owner=N、旧O有效角色admin、created_by不变；第二次接受ownership_transfer_not_pending。

**AC-GOV-OWNERSHIP-TRANSFER-RECIPIENT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立T/P及O；X仅external项目grant，N正式团队成员；对接受前资格变化做独立数据快照。
- 操作：
  1. O向X发起；另向N发起后使N待注销，再由N接受。
  2. 其他用户尝试接受N请求。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别ownership_recipient_not_team_member/account_pending_deletion/用户无效错误，owner不变；仅收件人可接受。

**AC-GOV-OWNERSHIP-TRANSFER-CANCEL-EXPIRE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立O/N和scope，固定起始UTC时间t0；无其他pending。
- 操作：
  1. O发起后再发；N取消，O新发。
  2. 独立复位后发起并推进超过7天，N接受失败，O再发，核对旧/新状态。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：有效pending阻止重复发起；参与人取消后可新发；过期请求不能接受，新发会取消旧pending并创建新7天请求。

#### 来源与已有测试定义

- `packages/application/src/ownership-use-cases.ts:108-139`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:143-180`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:49-53`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:159-168`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:127-136`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:159-175`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`

- `packages/application/tests/permissions-ownership.test.mjs` · ownership changes only after recipient acceptance, retains creator and makes previous owner admin · `defined`；仅检查固定源码中的测试定义，未执行；此条不证明运行成功。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-OWNERSHIP-RECOVERY · 失效负责人恢复与历史多Owner归一

**观察类型：** `observed_in_code`

**摘要：** 失效负责人恢复与历史多Owner归一的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 平台管理员恢复团队；团队Owner恢复项目；历史Owner或平台管理员确认遗留责任

**触发：** 发起recover或resolve

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 当前负责人失效时有权者提供原因发起恢复，仍由收件人接受。
- 接受恢复时再次检查原Owner仍失效、发起者仍有恢复权。
- owner=null仅允许在已有legacy owner成员中选一个，其他历史owner改admin，不给新用户迁移授予权限。

#### 业务规则

- BR-GOV-OWNERSHIP-RECOVERY-RECOVERY：条件：原负责人disabled/已注销，正确恢复者提供原因且目标有资格；判定/结果：恢复请求创建但不即时改owner，目标接受后变更；原owner恢复有效或发起者失去恢复权后接受失败。
- BR-GOV-OWNERSHIP-RECOVERY-DENIED：条件：原owner仍有效、原因空白或actor不具恢复权；判定/结果：分别ownership_recovery_not_required/ownership_recovery_reason_required/ownership_recovery_forbidden；无新请求或owner变化。
- BR-GOV-OWNERSHIP-RECOVERY-LEGACY：条件：历史scope owner_principal_id=null且已有多个role=owner行；判定/结果：历史Owner或平台管理员仅可选择其中既有Owner；其他owner成员降admin，creator不变；陌生目标ownership_resolution_target_invalid。

#### 状态变化/保留

- 恢复请求pending→accepted后改变唯一owner；旧owner底层admin保留。
- legacy resolve仅从null设置owner并改历史owner成员角色；重复resolve拒绝。

#### 数据契约

- 团队恢复需有效平台管理员；项目恢复需该团队Owner；原owner有效则ownership_recovery_not_required。
- legacy resolve不补写creator；管理员可确认失效legacy owner以建立历史责任，再走恢复，不重新启用该账号。

#### 异常与边界

- 条件：原负责人disabled/已注销，正确恢复者提供原因且目标有资格；处理：恢复请求创建但不即时改owner，目标接受后变更；原owner恢复有效或发起者失去恢复权后接受失败。
- 条件：原owner仍有效、原因空白或actor不具恢复权；处理：分别ownership_recovery_not_required/ownership_recovery_reason_required/ownership_recovery_forbidden；无新请求或owner变化。
- 条件：历史scope owner_principal_id=null且已有多个role=owner行；处理：历史Owner或平台管理员仅可选择其中既有Owner；其他owner成员降admin，creator不变；陌生目标ownership_resolution_target_invalid。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-OWNERSHIP-RECOVERY-RECOVERY` | 原负责人disabled/已注销，正确恢复者提供原因且目标有资格时，恢复请求创建但不即时改owner，目标接受后变更；原owner恢复有效或发起者失去恢复权后接受失败。 |
| `AC-GOV-OWNERSHIP-RECOVERY-DENIED` | 原owner仍有效、原因空白或actor不具恢复权时，分别ownership_recovery_not_required/ownership_recovery_reason_required/ownership_recovery_forbidden；无新请求或owner变化。 |
| `AC-GOV-OWNERSHIP-RECOVERY-LEGACY` | 历史scope owner_principal_id=null且已有多个role=owner行时，历史Owner或平台管理员仅可选择其中既有Owner；其他owner成员降admin，creator不变；陌生目标ownership_resolution_target_invalid。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-OWNERSHIP-RECOVERY-RECOVERY** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立团队T owner O失效且有平台管理员A、正式成员N；项目P owner失效且T Owner TO有效。
- 操作：
  1. 分别由A恢复T、TO恢复P并N接受；比较owner。
  2. 独立复位后恢复请求发起，再启用旧Owner或移除恢复者资格，然后N接受。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：恢复请求创建但不即时改owner，目标接受后变更；原owner恢复有效或发起者失去恢复权后接受失败。

**AC-GOV-OWNERSHIP-RECOVERY-DENIED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个变体独立scope与有效目标N。
- 操作：
  1. 向recover提交各错误条件；查pending请求及owner。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别ownership_recovery_not_required/ownership_recovery_reason_required/ownership_recovery_forbidden；无新请求或owner变化。

**AC-GOV-OWNERSHIP-RECOVERY-LEGACY** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：仅隔离升级测试数据库：T或P有两个legacy owner行及原creator；N不在legacy owners。
- 操作：
  1. POST /ownership/resolve选择既有owner，读唯一owner/底层成员/creator。
  2. 独立复位后选择N，再重复已resolved场景。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：历史Owner或平台管理员仅可选择其中既有Owner；其他owner成员降admin，creator不变；陌生目标ownership_resolution_target_invalid。

#### 来源与已有测试定义

- `packages/application/src/ownership-use-cases.ts:56-60`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:108-136`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:163-178`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:113-126`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`
- `packages/application/src/ownership-use-cases.ts:186-220`；SHA-256 `e39597572af718f66c188655803e1721d4fade73444e2c2ab00f5745b3221393`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- legacy确认所需升级fixture不由普通新建流程产生；迁移归属不清仍需人工处理，未虚构fixture已经存在或已运行。

## M03 · 项目结构与首页

对应平台父模块：`tsp-module-collaboration`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-GOV-MODULE-CATALOG · 功能模块目录、归档门槛与排序

**观察类型：** `observed_in_code`

**摘要：** 功能模块目录、归档门槛与排序的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目成员可读；Owner/Admin管理

**触发：** 列出、新建、更新或重排模块

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 成员按sort_order/id升序读取模块。
- 管理者以非空名建立active/archived模块，未给sortOrder时追加到最大顺序之后。
- 管理者修改或归档模块；归档前排除未归档Feature；重排必须提交全部编码。

#### 业务规则

- BR-GOV-MODULE-CATALOG-CATALOG：条件：项目Owner/Admin创建或修改模块，成员读取；判定/结果：合法模块按sort_order/id出现，未提供顺序追加；普通Member/Viewer写入project_forbidden。
- BR-GOV-MODULE-CATALOG-ARCHIVE：条件：目标模块仍关联非archived Feature；判定/结果：module_has_active_features，模块保持原状态；所有关联Feature归档或移出后新请求可归档。
- BR-GOV-MODULE-CATALOG-ORDER：条件：管理者提交模块完整无重复集合；判定/结果：顺序持久化；重复/遗漏/外项目编码module_order_invalid，原顺序保持。

#### 状态变化/保留

- create写模块与审计同事务；update先更新再在事务外写审计，不能把所有变更描述为原子。
- 归档被active/delivered Feature阻塞时模块status不变。

#### 数据契约

- 模块code稳定；name非空，description空白/null归一null；status active/archived。
- 模块完整排序更新sort_order及updated_at；归档不删除模块或已归档Feature。

#### 异常与边界

- 条件：项目Owner/Admin创建或修改模块，成员读取；处理：合法模块按sort_order/id出现，未提供顺序追加；普通Member/Viewer写入project_forbidden。
- 条件：管理者提交模块完整无重复集合；处理：顺序持久化；重复/遗漏/外项目编码module_order_invalid，原顺序保持。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-MODULE-CATALOG-CATALOG` | 项目Owner/Admin创建或修改模块，成员读取时，合法模块按sort_order/id出现，未提供顺序追加；普通Member/Viewer写入project_forbidden。 |
| `AC-GOV-MODULE-CATALOG-ARCHIVE` | 目标模块仍关联非archived Feature时，module_has_active_features，模块保持原状态；所有关联Feature归档或移出后新请求可归档。 |
| `AC-GOV-MODULE-CATALOG-ORDER` | 管理者提交模块完整无重复集合时，顺序持久化；重复/遗漏/外项目编码module_order_invalid，原顺序保持。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-MODULE-CATALOG-CATALOG** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P含Owner O、Admin A、Member M、Viewer V和模块X sort_order=3。
- 操作：
  1. A POST modules name="新模块"；GET modules核对追加。
  2. M/V分别创建和更新模块；读取原记录。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：合法模块按sort_order/id出现，未提供顺序追加；普通Member/Viewer写入project_forbidden。

**AC-GOV-MODULE-CATALOG-ARCHIVE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P模块X含active F及archived F2；Owner O。
- 操作：
  1. O PATCH /modules/X status=archived；记录拒绝。
  2. O将F移出X或归档，再请求归档X并GET目录。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：module_has_active_features，模块保持原状态；所有关联Feature归档或移出后新请求可归档。

**AC-GOV-MODULE-CATALOG-ORDER** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P恰有X/Y；另一P2有Z；每个非法分支独立复位。
- 操作：
  1. PUT modules/order [Y,X]后GET。
  2. 分别提交[X]、[X,X]、[X,Z]后GET。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：顺序持久化；重复/遗漏/外项目编码module_order_invalid，原顺序保持。

#### 来源与已有测试定义

- `packages/application/src/project-structure-use-cases.ts:146-177`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`
- `packages/application/src/intake-entity-writers.ts:23-33`；SHA-256 `bd7a3c4d153178187225424bb36431d1ecdfea83b39dd7574d8191719bfca696`
- `packages/application/src/project-structure-use-cases.ts:214-255`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`
- `packages/application/src/project-structure-use-cases.ts:183-208`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 模块创建可直接给archived；检查归档Feature门槛在update路径，不推广为所有创建均受同门槛。

### REQ-GOV-FEATURE-ORGANIZATION · Feature归属、交付标记与完整排序

**观察类型：** `observed_in_code`

**摘要：** Feature归属、交付标记与完整排序的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目成员读取；Owner/Admin创建或更新

**触发：** 列出、读取、创建、更新及重排Feature

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 管理者创建非空标题Feature，可选同项目module/milestone，默认active。
- 成员读取编码、模块/里程碑名称与目标、排期、状态。
- 更新可用null解除module/milestone；重排提交项目全部Feature。

#### 业务规则

- BR-GOV-FEATURE-ORGANIZATION-CREATE：条件：管理者提交有效标题及同项目模块/里程碑；判定/结果：Feature以给定状态或默认active建立；Member不可创建；不存在或外项目关联分别module_not_found/milestone_not_found。
- BR-GOV-FEATURE-ORGANIZATION-UPDATE：条件：管理者更新或解除归属并标记delivered/archived；判定/结果：指定字段更新，未给字段保留；null解除归属；当前实现可直接标记delivered，不附加任务完成证明。
- BR-GOV-FEATURE-ORGANIZATION-ORDER：条件：项目全部Feature编码无重复重排；判定/结果：按指定顺序返回；遗漏/重复/外项目编码feature_order_invalid，拒绝时顺序保持。

#### 状态变化/保留

- Feature创建及审计同事务；update直接更新后审计，保留code。
- 完整排序事务更新sort_order；关系越项目拒绝不写入。

#### 数据契约

- name优先于title兼容字段；goal空白/null归一null；status active/delivered/archived。
- Feature创建默认追加sort_order；list按sort_order/id升序；没有在此函数检查delivered必须任务全关闭。

#### 异常与边界

- 条件：管理者提交有效标题及同项目模块/里程碑；处理：Feature以给定状态或默认active建立；Member不可创建；不存在或外项目关联分别module_not_found/milestone_not_found。
- 条件：项目全部Feature编码无重复重排；处理：按指定顺序返回；遗漏/重复/外项目编码feature_order_invalid，拒绝时顺序保持。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-FEATURE-ORGANIZATION-CREATE` | 管理者提交有效标题及同项目模块/里程碑时，Feature以给定状态或默认active建立；Member不可创建；不存在或外项目关联分别module_not_found/milestone_not_found。 |
| `AC-GOV-FEATURE-ORGANIZATION-UPDATE` | 管理者更新或解除归属并标记delivered/archived时，指定字段更新，未给字段保留；null解除归属；当前实现可直接标记delivered，不附加任务完成证明。 |
| `AC-GOV-FEATURE-ORGANIZATION-ORDER` | 项目全部Feature编码无重复重排时，按指定顺序返回；遗漏/重复/外项目编码feature_order_invalid，拒绝时顺序保持。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-FEATURE-ORGANIZATION-CREATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P有O/A/M及模块X、里程碑K；另一项目有X2/K2。
- 操作：
  1. A POST Feature使用name及title不同值，核对name优先。
  2. 独立M创建；O用X2或K2创建。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：Feature以给定状态或默认active建立；Member不可创建；不存在或外项目关联分别module_not_found/milestone_not_found。

**AC-GOV-FEATURE-ORGANIZATION-UPDATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P的F无排期，关联X/K且有未关闭任务；O管理者。
- 操作：
  1. O PATCH F module_code=null,milestone_code=null,status=delivered；GET F核对字段与关联任务。
  2. Member尝试同样修改。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：指定字段更新，未给字段保留；null解除归属；当前实现可直接标记delivered，不附加任务完成证明。

**AC-GOV-FEATURE-ORGANIZATION-ORDER** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P恰有F1/F2；P2有F3；O有效。
- 操作：
  1. PUT Feature排序[F2,F1]；GET。
  2. 逐一独立复位提交[F1]、[F1,F1]、[F1,F3]。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：按指定顺序返回；遗漏/重复/外项目编码feature_order_invalid，拒绝时顺序保持。

#### 来源与已有测试定义

- `packages/application/src/project-use-cases.ts:90-138`；SHA-256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`
- `packages/application/src/intake-entity-writers.ts:35-47`；SHA-256 `bd7a3c4d153178187225424bb36431d1ecdfea83b39dd7574d8191719bfca696`
- `packages/application/src/project-use-cases.ts:248-345`；SHA-256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`
- `packages/application/src/project-use-cases.ts:144-208`；SHA-256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- Feature delivered是人工状态标记，里程碑完成仅消费此状态；未证实代表实际交付完成。
- Feature HTTP入口与CLI别名在surface清单补充定位，核心规则以应用层检查为准。

### REQ-GOV-FEATURE-SCHEDULE · Feature排期必须完整落在里程碑窗口

**观察类型：** `observed_in_code`

**摘要：** Feature排期必须完整落在里程碑窗口的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目Owner/Admin

**触发：** 创建或更新带日期Feature

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 规范化YYYY-MM-DD日期并排除非法日历日期。
- 任一日期存在时必须start/end齐全、start≤end且绑定日期完整的里程碑。
- 检查Feature区间包含在里程碑[start,target]，失败保持原排期。

#### 业务规则

- BR-GOV-FEATURE-SCHEDULE-IN：条件：Feature完整起止日期位于完整里程碑窗口内；判定/结果：成功保存；等于窗口两端和同日范围允许。
- BR-GOV-FEATURE-SCHEDULE-DENIED：条件：日期非法/单边、无里程碑、里程碑窗口不全或越界；判定/结果：分别schedule_date_invalid/feature_schedule_incomplete/feature_schedule_requires_milestone/feature_milestone_schedule_required/feature_schedule_outside_milestone，原Feature不变。

#### 状态变化/保留

- 成功写start_date/end_date及milestone_id；失败不更新Feature。

#### 数据契约

- 无日期时允许不绑定milestone；有任一日期时不能只清空里程碑。
- 相同起止日与正好等于里程碑边界允许；日历日期按UTC校验，不推导时区时刻。

#### 异常与边界

- 条件：日期非法/单边、无里程碑、里程碑窗口不全或越界；处理：分别schedule_date_invalid/feature_schedule_incomplete/feature_schedule_requires_milestone/feature_milestone_schedule_required/feature_schedule_outside_milestone，原Feature不变。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-FEATURE-SCHEDULE-IN` | Feature完整起止日期位于完整里程碑窗口内时，成功保存；等于窗口两端和同日范围允许。 |
| `AC-GOV-FEATURE-SCHEDULE-DENIED` | 日期非法/单边、无里程碑、里程碑窗口不全或越界时，分别schedule_date_invalid/feature_schedule_incomplete/feature_schedule_requires_milestone/feature_milestone_schedule_required/feature_schedule_outside_milestone，原Feature不变。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-FEATURE-SCHEDULE-IN** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P/K start=2026-11-01,target=2026-11-30；O；F无排期。
- 操作：
  1. PATCH F milestone_code=K,start_date=2026-11-01,end_date=2026-11-30；GET确认。
  2. 独立复位测试start=end=2026-11-10。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：成功保存；等于窗口两端和同日范围允许。

**AC-GOV-FEATURE-SCHEDULE-DENIED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个变体独立恢复F初态；完整K、缺日期K2各属于P；O。
- 操作：
  1. 依次独立提交2026-02-30、仅start、带完整日期但无K、用K2、超出K target。
  2. 另测end早于start返回feature_date_range_invalid。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别schedule_date_invalid/feature_schedule_incomplete/feature_schedule_requires_milestone/feature_milestone_schedule_required/feature_schedule_outside_milestone，原Feature不变。

#### 来源与已有测试定义

- `packages/application/src/schedule.ts:5-53`；SHA-256 `d912cc968b02cf3e40836d0286cca858aba342d7cc266a74211237d945b7de8e`
- `packages/application/src/project-use-cases.ts:307-325`；SHA-256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`
- `packages/application/src/project-use-cases.ts:313-325`；SHA-256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-PHASE-SCHEDULE · 阶段创建、日期与维护

**观察类型：** `observed_in_code`

**摘要：** 阶段创建、日期与维护的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目成员读取；Owner/Admin维护

**触发：** 列出、新建或更新阶段

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 成员按sort_order/id读取阶段。
- 管理者创建非空阶段名及可选goal/start/end，默认planned和sort_order=0。
- 更新未给字段保留，给null日期清空；若双日期存在要求end≥start。

#### 业务规则

- BR-GOV-PHASE-SCHEDULE-CREATE-EDIT：条件：管理者维护合法阶段信息；判定/结果：阶段默认planned，可保存单边日期；成员读到持久化信息，普通Member不可修改。
- BR-GOV-PHASE-SCHEDULE-DATE：条件：非空非法日期或双日期逆序；判定/结果：schedule_date_invalid或phase_date_range_invalid，阶段原值不变；合法null清空允许。

#### 状态变化/保留

- 直接插入/更新阶段后单独写审计，不能承诺审计失败整体回滚。

#### 数据契约

- phase status planned/active/completed/archived按HTTP入口允许值；单边日期在阶段允许，不能套用Feature双日期门槛。
- 阶段goal空值归一null；阶段日期变化未检查其下里程碑是否仍在区间。

#### 异常与边界

- 条件：管理者维护合法阶段信息；处理：阶段默认planned，可保存单边日期；成员读到持久化信息，普通Member不可修改。
- 条件：非空非法日期或双日期逆序；处理：schedule_date_invalid或phase_date_range_invalid，阶段原值不变；合法null清空允许。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-PHASE-SCHEDULE-CREATE-EDIT` | 管理者维护合法阶段信息时，阶段默认planned，可保存单边日期；成员读到持久化信息，普通Member不可修改。 |
| `AC-GOV-PHASE-SCHEDULE-DATE` | 非空非法日期或双日期逆序时，schedule_date_invalid或phase_date_range_invalid，阶段原值不变；合法null清空允许。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-PHASE-SCHEDULE-CREATE-EDIT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P；O/A管理者、M member；无同名假设。
- 操作：
  1. A POST phases name="交付阶段",start_date=2026-11-01；GET。
  2. A PATCH阶段增加end_date=2026-11-30；M尝试修改。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：阶段默认planned，可保存单边日期；成员读到持久化信息，普通Member不可修改。

**AC-GOV-PHASE-SCHEDULE-DATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P阶段Q start=2026-11-01,end=2026-11-30；O；每个变体复位。
- 操作：
  1. PATCH Q end_date=2026-02-30；另测end_date=2026-10-01。
  2. 独立PATCH Q start_date=null并核对end保留。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：schedule_date_invalid或phase_date_range_invalid，阶段原值不变；合法null清空允许。

#### 来源与已有测试定义

- `packages/application/src/project-structure-use-cases.ts:262-365`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`
- `packages/application/src/schedule.ts:5-21`；SHA-256 `d912cc968b02cf3e40836d0286cca858aba342d7cc266a74211237d945b7de8e`
- `packages/application/src/project-structure-use-cases.ts:325-365`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 阶段与里程碑日期包含关系没有本模块实现检查；不声称全项目进度层级自动同步。

### REQ-GOV-MILESTONE-DELIVERY · 里程碑负责人、交付门槛、窗口与汇总

**观察类型：** `observed_in_code`

**摘要：** 里程碑负责人、交付门槛、窗口与汇总的当前行为：覆盖5组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目成员读取；Owner/Admin管理

**触发：** 创建、更新或读取里程碑

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 选择同项目阶段、非空名、可选可写项目成员负责人和合法窗口。
- 创建不能直接completed；更新进入completed要求至少一个非archived Feature且全部delivered。
- 调整窗口不能排除任何已排期Feature；读取统计Feature数/delivered数/任务总数/closed数。

#### 业务规则

- BR-GOV-MILESTONE-DELIVERY-CREATE：条件：管理者以同项目阶段创建非completed里程碑；判定/结果：保存planned默认与窗口；viewer负责人被milestone_owner_invalid拒绝；直接completed被milestone_completion_blocked拒绝。
- BR-GOV-MILESTONE-DELIVERY-COMPLETE：条件：从planned/active转completed；判定/结果：没有非archived Feature或存在active Feature时拒绝；至少一个非archived且全部delivered时成功，archived Feature不阻塞该门槛。
- BR-GOV-MILESTONE-DELIVERY-WINDOW：条件：缩窄或清空里程碑窗口会排除已排期Feature；判定/结果：milestone_feature_schedule_conflict并返回冲突Feature/窗口；里程碑未改变。
- BR-GOV-MILESTONE-DELIVERY-COUNTS：条件：读取里程碑含active/delivered/archived Feature及不同任务状态；判定/结果：feature_count含全部，delivered_feature_count仅delivered；task_total含全部任务，closed_task_count仅closed。
- BR-GOV-MILESTONE-DELIVERY-LOOKUP：条件：提交未知负责人或update未知阶段编码；判定/结果：create未知负责人变null；update未知负责人清空，未知阶段回退原阶段；与找到的跨项目阶段拒绝相区分。

#### 状态变化/保留

- update里程碑与审计同事务；create插入后审计在事务外。
- 完成门槛只在从非completed转completed检查，不保证后续Feature改动自动重开。

#### 数据契约

- status planned/active/at_risk/completed/cancelled；创建缺负责人/未知负责人编码目前落为null，已找到的viewer负责人拒绝。
- update中未知phaseCode会回退existingPhase；未知ownerCode会清空owner；这些是观察到的宽松分支，需要保留为缺口。
- 汇总feature_count计全部（包括archived），delivered_feature_count只status=delivered；任务closed只计closed。

#### 异常与边界

- 条件：管理者以同项目阶段创建非completed里程碑；处理：保存planned默认与窗口；viewer负责人被milestone_owner_invalid拒绝；直接completed被milestone_completion_blocked拒绝。
- 条件：从planned/active转completed；处理：没有非archived Feature或存在active Feature时拒绝；至少一个非archived且全部delivered时成功，archived Feature不阻塞该门槛。
- 条件：缩窄或清空里程碑窗口会排除已排期Feature；处理：milestone_feature_schedule_conflict并返回冲突Feature/窗口；里程碑未改变。
- 条件：提交未知负责人或update未知阶段编码；处理：create未知负责人变null；update未知负责人清空，未知阶段回退原阶段；与找到的跨项目阶段拒绝相区分。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-MILESTONE-DELIVERY-CREATE` | 管理者以同项目阶段创建非completed里程碑时，保存planned默认与窗口；viewer负责人被milestone_owner_invalid拒绝；直接completed被milestone_completion_blocked拒绝。 |
| `AC-GOV-MILESTONE-DELIVERY-COMPLETE` | 从planned/active转completed时，没有非archived Feature或存在active Feature时拒绝；至少一个非archived且全部delivered时成功，archived Feature不阻塞该门槛。 |
| `AC-GOV-MILESTONE-DELIVERY-WINDOW` | 缩窄或清空里程碑窗口会排除已排期Feature时，milestone_feature_schedule_conflict并返回冲突Feature/窗口；里程碑未改变。 |
| `AC-GOV-MILESTONE-DELIVERY-COUNTS` | 读取里程碑含active/delivered/archived Feature及不同任务状态时，feature_count含全部，delivered_feature_count仅delivered；task_total含全部任务，closed_task_count仅closed。 |
| `AC-GOV-MILESTONE-DELIVERY-LOOKUP` | 提交未知负责人或update未知阶段编码时，create未知负责人变null；update未知负责人清空，未知阶段回退原阶段；与找到的跨项目阶段拒绝相区分。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-MILESTONE-DELIVERY-CREATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P含Q阶段、writer U、viewer V；O。
- 操作：
  1. POST milestones phase_code=Q,name="版本",owner_principal_code=U；读取。
  2. 独立使用V或status=completed创建。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：保存planned默认与窗口；viewer负责人被milestone_owner_invalid拒绝；直接completed被milestone_completion_blocked拒绝。

**AC-GOV-MILESTONE-DELIVERY-COMPLETE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：三个独立K：空、含active F、含delivered F与archived F2；O。
- 操作：
  1. 分别PATCH各K status=completed；GET里程碑与Feature状态。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：没有非archived Feature或存在active Feature时拒绝；至少一个非archived且全部delivered时成功，archived Feature不阻塞该门槛。

**AC-GOV-MILESTONE-DELIVERY-WINDOW** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：K窗口11月1至30，F已安排11月10至20；O。
- 操作：
  1. 独立PATCH K target_date=2026-11-15；另测清start_date；每次GET验证原窗口。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：milestone_feature_schedule_conflict并返回冲突Feature/窗口；里程碑未改变。

**AC-GOV-MILESTONE-DELIVERY-COUNTS** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：隔离K有三类Feature各1，分别关联closed/failed/cancelled任务各1；项目成员M。
- 操作：
  1. GET milestones，核对feature_count=3、delivered_feature_count=1、task_total=3、closed_task_count=1。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：feature_count含全部，delivered_feature_count仅delivered；task_total含全部任务，closed_task_count仅closed。

**AC-GOV-MILESTONE-DELIVERY-LOOKUP** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：K已有phase Q与owner U；未知编码Z无对应记录；另项目Q2；O。
- 操作：
  1. 独立PATCH K phase_code=Z并读取阶段仍Q。
  2. 复位PATCH owner_principal_code=Z并读取owner=null；另用Q2验证拒绝。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：create未知负责人变null；update未知负责人清空，未知阶段回退原阶段；与找到的跨项目阶段拒绝相区分。

#### 来源与已有测试定义

- `packages/application/src/project-structure-use-cases.ts:426-501`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`
- `packages/application/src/project-structure-use-cases.ts:546-557`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`
- `packages/application/src/project-structure-use-cases.ts:543-576`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`
- `packages/application/src/project-structure-use-cases.ts:371-419`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`
- `packages/application/src/project-structure-use-cases.ts:444-478`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`
- `packages/application/src/project-structure-use-cases.ts:524-539`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`
- `packages/application/src/project-structure-use-cases.ts:588-590`；SHA-256 `040c7dd7545c9f17a8fabfb1dc7b0f7fd2faa843a1f38ff4496f3175f54ffd13`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 未知编码的宽松fallback可能是缺陷，本文记录当前实现，不视作已批准业务政策。
- 完成后的Feature再改active是否应自动重开里程碑无代码机制/决策；未提出为既定规则。

本条沿用既有父模块：`tsp-module-documents`；关联规则文档：`tsp-doc-documents`。

### tsp-req-home-binding · 首页说明/参与指引与规范汇总

**观察类型：** `observed_in_code`

**摘要：** 首页说明/参与指引与规范汇总的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目成员读取；Owner/Admin配置首页

**触发：** 读取或更新项目首页文档关联

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 读取时确保固定说明/规范目录，返回overview/guide及规范集合。
- 管理者只绑定当前项目active且位于overview系统目录的说明/指引文档。
- null解除一个角色关联，未给字段保持；规范从固定规范目录汇总，不接受单一standards_document_code绑定。

#### 业务规则

- BR-GOV-PROJECT-HOME-BIND：条件：管理者绑定同项目overview系统目录中的active文档；判定/结果：首页返回其完整content/revision；null解除overview但guide及文档记录保留。
- BR-GOV-PROJECT-HOME-DENIED：条件：非管理者、archived项目、外项目/archived/错误目录文档或standards_document_code；判定/结果：分别权限/归档/文档范围或目录错误/规范受管理错误；原home关联不变。

#### 状态变化/保留

- 首页更新关联与审计同事务；GET可能初始化缺失系统目录。
- 归档文档不出现在active首页文档查询中；解除关联不删除文档。

#### 数据契约

- bindings必须非空对象，仅overview_document_code/guide_document_code；值为20位public code或null。
- 首页can_edit仅active项目管理者；文档can_edit还允许非viewer创建人，按当前project文档规则。

#### 异常与边界

- 条件：bindings含standards_document_code，或为空对象、含未知字段、值不是有效public code/null。；处理：分别返回project_home_standards_managed或project_home_invalid，不写首页关联；规范仍由固定规范目录汇总（BR-GOV-PROJECT-HOME-DENIED / AC-GOV-PROJECT-HOME-DENIED及bindings数据合同）。
- 条件：有效项目普通成员配置首页，或Owner/Admin在archived项目配置首页。；处理：分别返回project_home_forbidden或project_archived，原overview/guide关联及文档保持（BR-GOV-PROJECT-HOME-DENIED / AC-GOV-PROJECT-HOME-DENIED）。
- 条件：所选文档不属于当前项目或不存在、文档已archived，或不在overview系统目录。；处理：分别返回project_home_document_invalid、project_home_document_archived或project_home_document_folder_invalid；整个关联事务回滚，保留原有首页绑定（BR-GOV-PROJECT-HOME-DENIED / AC-GOV-PROJECT-HOME-DENIED）。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-PROJECT-HOME-BIND` | 管理者绑定同项目overview系统目录中的active文档时，首页返回其完整content/revision；null解除overview但guide及文档记录保留。 |
| `AC-GOV-PROJECT-HOME-DENIED` | 非管理者、archived项目、外项目/archived/错误目录文档或standards_document_code时，分别权限/归档/文档范围或目录错误/规范受管理错误；原home关联不变。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-PROJECT-HOME-BIND** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P，O管理者、M成员；overview目录有active D/G。
- 操作：
  1. O PUT home overview_document_code=D,guide_document_code=G；M GET。
  2. O PUT overview_document_code=null，再GET及读取D。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：首页返回其完整content/revision；null解除overview但guide及文档记录保留。

**AC-GOV-PROJECT-HOME-DENIED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每次独立复位P home=D；准备外项目D2、归档D3、普通目录D4及M member。
- 操作：
  1. M更新home；O分别绑定D2/D3/D4或传standards_document_code；读取home仍D。
  2. 独立归档P后O更新。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别权限/归档/文档范围或目录错误/规范受管理错误；原home关联不变。

#### 来源与已有测试定义

- `packages/application/src/project-home-use-cases.ts:40-68`；SHA-256 `115a7340fb479c30adf8714f8361c35e7ca21ca7d42329a85e727afdb6a41836`
- `packages/application/src/project-home-use-cases.ts:87-126`；SHA-256 `115a7340fb479c30adf8714f8361c35e7ca21ca7d42329a85e727afdb6a41836`
- `packages/application/src/project-home-use-cases.ts:40-48`；SHA-256 `115a7340fb479c30adf8714f8361c35e7ca21ca7d42329a85e727afdb6a41836`
- `packages/application/src/project-home-use-cases.ts:93-124`；SHA-256 `115a7340fb479c30adf8714f8361c35e7ca21ca7d42329a85e727afdb6a41836`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 规范排序和目录递归细节由文档模块定义；这里只引用collectProjectStandardsDocuments，不重复承诺其规则。

## M04 · 需求发现、决策与评审

对应平台父模块：`tsp-module-collaboration`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-GOV-IDEA-COLLECTION · 想法录入、检索与作者管理

**观察类型：** `observed_in_code`

**摘要：** 想法录入、检索与作者管理的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 可写项目成员录入；作者或Owner/Admin修改；成员读取

**触发：** 列表、创建或更新想法

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 成员按标题/详情大小写不敏感搜索、可选status过滤，updated_at降序列出。
- 可写成员创建非空title想法，保存detail/source并默认active。
- 非viewer作者或管理者修改内容及active/archived状态。

#### 业务规则

- BR-GOV-IDEA-COLLECTION-COLLECT：条件：有效可写成员创建并检索想法；判定/结果：默认active、返回作者和topic_count；q匹配title/detail，status过滤；viewer可读不可创建。
- BR-GOV-IDEA-COLLECTION-MANAGE：条件：作者或管理者修改想法，其他普通成员尝试修改；判定/结果：授权者可改title/detail/source/status；非作者普通成员requirement_idea_forbidden；空title或非法status拒绝，原内容不变。

#### 状态变化/保留

- create写想法后单独审计；update更新内容与时间，不在该函数写审计。

#### 数据契约

- source空白/null归一null；title非空；detail可空；topic_count由关联表计数。
- 排序updated_at无最终tie-break；不推导唯一全序；归档想法仍可按筛选读取。

#### 异常与边界

- 条件：有效可写成员创建并检索想法；处理：默认active、返回作者和topic_count；q匹配title/detail，status过滤；viewer可读不可创建。
- 条件：作者或管理者修改想法，其他普通成员尝试修改；处理：授权者可改title/detail/source/status；非作者普通成员requirement_idea_forbidden；空title或非法status拒绝，原内容不变。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-IDEA-COLLECTION-COLLECT` | 有效可写成员创建并检索想法时，默认active、返回作者和topic_count；q匹配title/detail，status过滤；viewer可读不可创建。 |
| `AC-GOV-IDEA-COLLECTION-MANAGE` | 作者或管理者修改想法，其他普通成员尝试修改时，授权者可改title/detail/source/status；非作者普通成员requirement_idea_forbidden；空title或非法status拒绝，原内容不变。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-IDEA-COLLECTION-COLLECT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P中作者U、viewer V；创建两个标题/详情可区分的想法。
- 操作：
  1. U POST ideas title=" 搜索建议 ",detail="Index"；GET ideas?q=index&amp;status=active。
  2. V读取再尝试创建。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：默认active、返回作者和topic_count；q匹配title/detail，status过滤；viewer可读不可创建。

**AC-GOV-IDEA-COLLECTION-MANAGE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P想法I作者U，另一writer V及Admin A；各分支复位。
- 操作：
  1. U PATCH I source=null,status=archived；A修改title。
  2. V修改I；独立U提交空白title/非法status。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：授权者可改title/detail/source/status；非作者普通成员requirement_idea_forbidden；空title或非法status拒绝，原内容不变。

#### 来源与已有测试定义

- `packages/application/src/requirement-collaboration-use-cases.ts:164-200`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:204-221`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 作者显示名在update返回中使用操作者对象，非作者管理者更新后的created_by展示可能失真；列表重新读取才从真实created_by关联。

### REQ-GOV-TOPIC-AGGREGATION · 议题聚合、关系与维护权限

**观察类型：** `observed_in_code`

**摘要：** 议题聚合、关系与维护权限的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 可写项目成员；作者或管理者改文本；管理者改状态

**触发：** 新建议题、关联想法/文档或更新议题

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 创建非空title议题，以同项目想法初始关联，默认open。
- 成员读取议题及记录，按title/problem_statement/goal搜索和status筛选。
- 增量关联想法/需求文档时去重并保留已有关系；作者修改文本，真实状态变化必须manage。

#### 业务规则

- BR-GOV-TOPIC-AGGREGATION-CREATE-LINK：条件：可写成员提交同项目想法及需求文档关联；判定/结果：议题open，重复code只保留一个链接；再次关联或空数组不取消已有链接。
- BR-GOV-TOPIC-AGGREGATION-MISMATCH：条件：想法/文档不存在或属于其他项目；判定/结果：requirement_topic_idea_invalid或requirement_topic_document_invalid，已有关系不变；新建若初始想法无效不建topic。
- BR-GOV-TOPIC-AGGREGATION-STATE-AUTH：条件：普通作者更新文本或尝试改变议题状态；判定/结果：作者文本更新成功，真实状态变化需manage故普通作者被拒绝；Owner/Admin可改变枚举状态，非法状态拒绝。

#### 状态变化/保留

- create议题/初始想法链接及审计同事务；后续link更新updated_at。
- 一般文本更新不删除历史entries、ideas或documents。

#### 数据契约

- 状态open/decided/reopened/archived；关联code去空白去重复；不存在/越项目关联整体拒绝。
- 关联操作是追加去重，空数组不删除旧关系；接口未提供unlink。
- can_decide为active项目管理者且议题未归档；can_manage为作者或管理者且可写。

#### 异常与边界

- 条件：想法/文档不存在或属于其他项目；处理：requirement_topic_idea_invalid或requirement_topic_document_invalid，已有关系不变；新建若初始想法无效不建topic。
- 条件：普通作者更新文本或尝试改变议题状态；处理：作者文本更新成功，真实状态变化需manage故普通作者被拒绝；Owner/Admin可改变枚举状态，非法状态拒绝。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-TOPIC-AGGREGATION-CREATE-LINK` | 可写成员提交同项目想法及需求文档关联时，议题open，重复code只保留一个链接；再次关联或空数组不取消已有链接。 |
| `AC-GOV-TOPIC-AGGREGATION-MISMATCH` | 想法/文档不存在或属于其他项目时，requirement_topic_idea_invalid或requirement_topic_document_invalid，已有关系不变；新建若初始想法无效不建topic。 |
| `AC-GOV-TOPIC-AGGREGATION-STATE-AUTH` | 普通作者更新文本或尝试改变议题状态时，作者文本更新成功，真实状态变化需manage故普通作者被拒绝；Owner/Admin可改变枚举状态，非法状态拒绝。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-TOPIC-AGGREGATION-CREATE-LINK** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P中writer U、ideas I1/I2、需求文档D；另一项目I3/D3。
- 操作：
  1. POST topic idea_codes=[I1,I1]；再POST topic/ideas [I2]及topic/documents [D,D]；空数组再关联。
  2. GET topic核对数量及原链接保留。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：议题open，重复code只保留一个链接；再次关联或空数组不取消已有链接。

**AC-GOV-TOPIC-AGGREGATION-MISMATCH** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P中topic T、已有I1/D1；另项目I3/D3；U writer。
- 操作：
  1. 独立向T关联[I1,I3]、[D1,D3]和未知编码；GET比对。
  2. 新建带I3的议题。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：requirement_topic_idea_invalid或requirement_topic_document_invalid，已有关系不变；新建若初始想法无效不建topic。

**AC-GOV-TOPIC-AGGREGATION-STATE-AUTH** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P，T作者U member，另一writer V，Admin A；T初态open。
- 操作：
  1. U改goal；U改status=archived；V改title；A改status=archived；GET核对。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：作者文本更新成功，真实状态变化需manage故普通作者被拒绝；Owner/Admin可改变枚举状态，非法状态拒绝。

#### 来源与已有测试定义

- `packages/application/src/requirement-collaboration-use-cases.ts:240-263`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:382-406`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:247-249`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:382-405`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:299-313`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- linkIdeas/linkDocuments不检查topic archived状态，只有项目write检查；不得声称归档议题所有关系都不可变。
- 状态可由管理者直接修改，无通用业务转换表；不可套用结构化需求生命周期。

### REQ-GOV-TOPIC-DECISIONS · 讨论记录、反馈重开、决策替代与图片边界

**观察类型：** `observed_in_code`

**摘要：** 讨论记录、反馈重开、决策替代与图片边界的当前行为：覆盖5组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目可写成员讨论；Owner/Admin决策

**触发：** 向非归档议题添加comment/alternative/feedback/decision

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 公开HTTP入口先受整体JSON请求体1MiB限制，超出在到达议题用例前返回413/request_body_too_large；该路由未覆盖服务器默认bodyLimit。
- 通过HTTP解析后或测试直接调用应用用例时，校验内容、记录类型、图片名称/type/大小和替代关系。
- 一般记录需write，decision需manage；历史决策不删除。
- decision令议题decided；decided后feedback令reopened，其他记录保持状态。

#### 业务规则

- BR-GOV-TOPIC-DECISIONS-CYCLE：条件：管理者决策后成员提交feedback，再由管理者新决策；判定/结果：状态依次decided→reopened→decided，第二决策保存supersedes关系且历史决策仍在。
- BR-GOV-TOPIC-DECISIONS-PERMISSION：条件：普通writer新增decision或向archived议题新增记录；判定/结果：decision被project_forbidden拒绝；archived为requirement_topic_archived，entries/topic不变。
- BR-GOV-TOPIC-DECISIONS-IMAGES：条件：在尚需建设的隔离测试夹具中直接调用addTopicEntry（不经过HTTP解析），图片满足应用用例的声明格式/推算字节限制；判定/结果：应用层1字节及单张2MiB、合计恰5MiB的合法声明data URL可保存且顺序保留；5张、空名/256字符名、不允许MIME、单张2MiB+1或合计5MiB+1分别报images_too_many/image_name_invalid/image_type_invalid/image_too_large/images_too_large（完整前缀requirement_topic_），相应失败不新增entry/images。此结论不表示这些大负载可经公开HTTP提交。
- BR-GOV-TOPIC-DECISIONS-IMAGES-HTTP：条件：实际议题HTTP路由的JSON序列化请求体超过默认1048576字节，即使图片decoded大小低于应用2MiB门槛；判定/结果：大于1MiB的整体JSON在用例前返回HTTP 413、ok=false/error.code=request_body_too_large，entry/images/topic状态不变；小于或恰1MiB且其他条件合法的对照请求可进入用例保存。应用层2MiB/5MiB允许值不构成HTTP可达性承诺。
- BR-GOV-TOPIC-DECISIONS-SUPERSEDES：条件：supersedes指向另一议题/非decision或不存在；判定/结果：找到但不合格的记录requirement_topic_supersedes_invalid；不存在的编码保存supersedes=null。

#### 状态变化/保留

- entry/images/topic状态及审计同事务；request成功代表记录已保存，不含外部处理。

#### 数据契约

- entry_type为comment/alternative/feedback/decision；正文非空，rationale/source字段去空白空值归null。
- 应用用例图片门槛：最多4张；file_name非空≤255；仅png/jpeg/webp/gif的base64 data URL；每张按base64长度推算decoded bytes 1至2MiB，总计≤5MiB。该门槛不是公开HTTP可提交大小承诺。
- 当前HTTP整体bodyLimit=1048576字节（1MiB），以UTF-8 JSON序列化总字节计，含base64、文件名、正文及字段开销；1MiB解码图片的base64 JSON已超限，虽低于应用单图2MiB也会先返回413。未提出或批准扩容HTTP限制。
- 找到supersedes时必须同topic且decision；不存在的supersedes编码目前被当成无替代，不拒绝。
- summary current_decision按created_at降序首个decision，没有最终tie-break；详情entries按created_at/id降序。

#### 异常与边界

- 条件：普通writer新增decision或向archived议题新增记录；处理：decision被project_forbidden拒绝；archived为requirement_topic_archived，entries/topic不变。
- 条件：在尚需建设的隔离测试夹具中直接调用addTopicEntry（不经过HTTP解析），图片满足应用用例的声明格式/推算字节限制；处理：应用层1字节及单张2MiB、合计恰5MiB的合法声明data URL可保存且顺序保留；5张、空名/256字符名、不允许MIME、单张2MiB+1或合计5MiB+1分别报images_too_many/image_name_invalid/image_type_invalid/image_too_large/images_too_large（完整前缀requirement_topic_），相应失败不新增entry/images。此结论不表示这些大负载可经公开HTTP提交。
- 条件：supersedes指向另一议题/非decision或不存在；处理：找到但不合格的记录requirement_topic_supersedes_invalid；不存在的编码保存supersedes=null。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-TOPIC-DECISIONS-CYCLE` | 管理者决策后成员提交feedback，再由管理者新决策时，状态依次decided→reopened→decided，第二决策保存supersedes关系且历史决策仍在。 |
| `AC-GOV-TOPIC-DECISIONS-PERMISSION` | 普通writer新增decision或向archived议题新增记录时，decision被project_forbidden拒绝；archived为requirement_topic_archived，entries/topic不变。 |
| `AC-GOV-TOPIC-DECISIONS-IMAGES` | 在尚需建设的隔离测试夹具中直接调用addTopicEntry（不经过HTTP解析），图片满足应用用例的声明格式/推算字节限制时，应用层1字节及单张2MiB、合计恰5MiB的合法声明data URL可保存且顺序保留；5张、空名/256字符名、不允许MIME、单张2MiB+1或合计5MiB+1分别报images_too_many/image_name_invalid/image_type_invalid/image_too_large/images_too_large（完整前缀requirement_topic_），相应失败不新增entry/images。此结论不表示这些大负载可经公开HTTP提交。 |
| `AC-GOV-TOPIC-DECISIONS-IMAGES-HTTP` | 实际议题HTTP路由的JSON序列化请求体超过默认1048576字节，即使图片decoded大小低于应用2MiB门槛时，大于1MiB的整体JSON在用例前返回HTTP 413、ok=false/error.code=request_body_too_large，entry/images/topic状态不变；小于或恰1MiB且其他条件合法的对照请求可进入用例保存。应用层2MiB/5MiB允许值不构成HTTP可达性承诺。 |
| `AC-GOV-TOPIC-DECISIONS-SUPERSEDES` | supersedes指向另一议题/非decision或不存在时，找到但不合格的记录requirement_topic_supersedes_invalid；不存在的编码保存supersedes=null。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-TOPIC-DECISIONS-CYCLE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P；非归档open topic T；Admin A和writer U；无已有entries。
- 操作：
  1. A新增decision D1；U新增feedback；A新增decision D2 supersedes_entry_code=D1。
  2. GET topic核对状态、历史及current_decision。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：状态依次decided→reopened→decided，第二决策保存supersedes关系且历史决策仍在。

**AC-GOV-TOPIC-DECISIONS-PERMISSION** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立T open，writer U；独立T2 archived。
- 操作：
  1. U向T新增decision；向T2新增comment；GET比对entry_count/status。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：decision被project_forbidden拒绝；archived为requirement_topic_archived，entries/topic不变。

**AC-GOV-TOPIC-DECISIONS-IMAGES** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：建设前提（尚未提供/运行）：可直接调用固定createRequirementCollaborationUseCases(db).addTopicEntry的隔离应用夹具、一次性PostgreSQL、有效active项目P/open议题T及writer U，并能复位和只读查询entries/images。令MiB=1048576；b64(n)=Buffer.alloc(n,0x41).toString("base64")，长度4*ceil(n/3)，image(n)={fileName:"a.png",dataUrl:"data:image/png;base64,"+b64(n)}；这是合成字节声明，不冒称有效图片文件；应用仅按声明/长度校验。各分支独立还原T无记录的基线。
- 操作：
  1. 直接应用调用addTopicEntry({topicCode:T,principalCode:U,entryType:"comment",content:"x",images:[image(1)]})，再独立测试[image(2*MiB)]及[image(2*MiB),image(2*MiB),image(MiB)]；核对1、2MiB、5MiB边界成功、byte_size及sort_order。
  2. 各自独立复位后测试：5张image(1)→requirement_topic_images_too_many；fileName为空或256个a→requirement_topic_image_name_invalid；dataUrl声明image/svg+xml→requirement_topic_image_type_invalid。
  3. 独立复位测试[image(2*MiB+1)]→requirement_topic_image_too_large；[image(2*MiB),image(2*MiB),image(MiB+1)]→requirement_topic_images_too_large；每个失败后读取entry/image数仍为0。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：应用层1字节及单张2MiB、合计恰5MiB的合法声明data URL可保存且顺序保留；5张、空名/256字符名、不允许MIME、单张2MiB+1或合计5MiB+1分别报images_too_many/image_name_invalid/image_type_invalid/image_too_large/images_too_large（完整前缀requirement_topic_），相应失败不新增entry/images。此结论不表示这些大负载可经公开HTTP提交。

**AC-GOV-TOPIC-DECISIONS-IMAGES-HTTP** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：建设前提（尚未提供/运行）：使用固定server.ts配置的隔离HTTP实例、一次性数据库和可读entry/images/topic状态；P active/T open/U writer且使用有效Bearer以排除鉴权失败。不得提高bodyLimit。令L=1048576；tiny={file_name:"a.png",data_url:"data:image/png;base64,"+Buffer.alloc(1,0x41).toString("base64")}; B0={entry_type:"comment",content:"",images:[tiny]}；bytes(B)=Buffer.byteLength(JSON.stringify(B),"utf8")；pad(N)为B0但content="x".repeat(N-bytes(B0))，使完整ASCII JSON恰N字节。各请求前复位T初态。
- 操作：
  1. 以Content-Type:application/json向POST /requirement-topics/T/entries提交pad(L-1)、pad(L)，提交前各自断言bytes正好为L-1/L；其他条件合法时核对成功且各自只新增一条entry/图片。
  2. 独立复位后提交pad(L+1)，断言bytes=L+1；核对413/request_body_too_large且entry/images数和topic状态保持。
  3. 独立复位构造单张image/png data_url，其base64为Buffer.alloc(L,0x41).toString("base64")，放入正常entry JSON；断言base64长度=1398104、整体bytes&gt;L且decoded=L&lt;2*L；提交HTTP仍应413且数据库不变。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：大于1MiB的整体JSON在用例前返回HTTP 413、ok=false/error.code=request_body_too_large，entry/images/topic状态不变；小于或恰1MiB且其他条件合法的对照请求可进入用例保存。应用层2MiB/5MiB允许值不构成HTTP可达性承诺。

**AC-GOV-TOPIC-DECISIONS-SUPERSEDES** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：T有comment C；另topic有decision D2；未知Z；Admin A。
- 操作：
  1. 分别独立新增decision替代C、D2、Z并读取关系。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：找到但不合格的记录requirement_topic_supersedes_invalid；不存在的编码保存supersedes=null。

#### 来源与已有测试定义

- `packages/application/src/requirement-collaboration-use-cases.ts:106-125`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:267-294`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:317-348`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:317-343`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:27-51`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `apps/core-api/src/server.ts:67-74`；SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/core-api/src/routes/requirement-collaboration.ts:50-53`；SHA-256 `cbd63cdecc412dc8121925a1df0dc70f7054d8ccbfa4bd3c1fc598d8601cf406`
- `packages/application/src/requirement-collaboration-use-cases.ts:27-50`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:327-335`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 图片校验按data URL声明与base64长度估算，不校验图片魔数或实际解码内容；安全性上不宣称真实图片有效。
- 应用2MiB单图/5MiB合计门槛与HTTP整体1MiB是不同层级；直接用例边界与默认HTTP边界计划所需隔离夹具本次未提供/运行。未把提高HTTP bodyLimit当作当前实现或已批准建议。
- supersedes不存在的宽松处理是实现观察，是否应拒绝待业务/工程确认。

### REQ-GOV-TOPIC-WITHDRAWAL · 非决策记录软撤回与议题状态重算

**观察类型：** `observed_in_code`

**摘要：** 非决策记录软撤回与议题状态重算的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 记录作者或Owner/Admin

**触发：** 撤回非归档议题中的未撤回非decision记录

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 检查项目write、作者或管理者、议题非归档、记录未撤回且不是decision。
- 记录withdrawn_at/withdrawn_by/reason并保留存储历史。
- 从剩余未撤回记录按时间/id重算最新决策及其后的feedback，返回open/decided/reopened。

#### 业务规则

- BR-GOV-TOPIC-WITHDRAWAL-RECALCULATE：条件：最新decision之后只有一条feedback且该feedback被授权者撤回；判定/结果：reopened回到decided；详情屏蔽feedback正文/图片/来源但显示撤回者/原因，底层历史仍保留。
- BR-GOV-TOPIC-WITHDRAWAL-DENIED：条件：decision、已撤回记录、非作者普通writer、archived topic或reason超过500；判定/结果：分别相应withdraw_forbidden/already_withdrawn/topic_archived/reason_too_long错误，记录与topic状态不变。

#### 状态变化/保留

- 撤回、重算topic状态及审计同事务。
- 决策只能通过新决策替代，不能撤回；其原记录保留。

#### 数据契约

- reason可空、非空最长500字符；重复撤回报already_withdrawn。
- 详情中撤回记录content=""，rationale/source为空、images=[]，仍保留作者和撤回元数据；不是物理删除。

#### 异常与边界

- 条件：decision、已撤回记录、非作者普通writer、archived topic或reason超过500；处理：分别相应withdraw_forbidden/already_withdrawn/topic_archived/reason_too_long错误，记录与topic状态不变。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-TOPIC-WITHDRAWAL-RECALCULATE` | 最新decision之后只有一条feedback且该feedback被授权者撤回时，reopened回到decided；详情屏蔽feedback正文/图片/来源但显示撤回者/原因，底层历史仍保留。 |
| `AC-GOV-TOPIC-WITHDRAWAL-DENIED` | decision、已撤回记录、非作者普通writer、archived topic或reason超过500时，分别相应withdraw_forbidden/already_withdrawn/topic_archived/reason_too_long错误，记录与topic状态不变。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-TOPIC-WITHDRAWAL-RECALCULATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：T先D1 decision再U的feedback F，含一张图片；T reopened；U作者、A管理者。
- 操作：
  1. A POST /requirement-topic-entries/F/withdraw reason="误发"；GET T并检查F fields。
  2. 检查底层F content及image记录仍存在，未删除。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：reopened回到decided；详情屏蔽feedback正文/图片/来源但显示撤回者/原因，底层历史仍保留。

**AC-GOV-TOPIC-WITHDRAWAL-DENIED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个变体独立复位T与entry；U作者、V普通writer、A管理者。
- 操作：
  1. 分别撤回decision、二次撤回F、由V撤回F、归档T后撤回、501字符reason；逐次读取状态。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别相应withdraw_forbidden/already_withdrawn/topic_archived/reason_too_long错误，记录与topic状态不变。

#### 来源与已有测试定义

- `packages/application/src/requirement-collaboration-use-cases.ts:288-294`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:352-378`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:352-376`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`

- `packages/application/tests/requirement-collaboration-use-cases.test.mjs` · 非决策记录由作者或 Owner 软撤回，正文与图片脱敏且决策不可撤回 · `defined`；仅检查固定源码中的测试定义，未执行；此条不证明运行成功。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-DOCUMENT-REVIEW · 文档固定Revision评审、意见更新及人工结论

**观察类型：** `observed_in_code`

**摘要：** 文档固定Revision评审、意见更新及人工结论的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 文档维护人或Owner/Admin发起；可写成员投票；Owner/Admin结束

**触发：** 发起/读取评审、投票或关闭

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 发起时绑定当前document_revision_id；已有同revision评审则直接返回，含已closed评审。
- 评审固定版本但不锁定文档修订；新revision可另开评审。
- 成员可更新自己的support/changes_requested/abstain意见；管理者给出passed/changes_requested/no_consensus人工结论。

#### 业务规则

- BR-GOV-DOCUMENT-REVIEW-FIXED：条件：作者对R1发起评审后把文档修订至R2；判定/结果：旧评审仍revision=1且文档可修订；R2新评审为不同review；重复start R1在未修订分支返回原review。
- BR-GOV-DOCUMENT-REVIEW-VOTE：条件：可写成员在open评审投票或改票；判定/结果：同principal一条vote被更新，其他人的vote保留；viewer写入project_forbidden，closed后requirement_review_closed。
- BR-GOV-DOCUMENT-REVIEW-CONCLUSION：条件：管理者关闭open评审并指定合法结论；判定/结果：保存指定结论即使票未达多数或无票，不改变文档/REQ状态；普通writer关闭拒绝，重复关闭requirement_review_closed。

#### 状态变化/保留

- review open→closed保存结论、closed_by/time；文档current_revision独立演进。
- 再次start同版本返回原review而不是重开。

#### 数据契约

- 投票要求project write，故viewer只读；每review/principal一条意见upsert；closed后不允许投票/再次关闭。
- 关闭不按多数票/全票自动计算，不自动改变requirementDocument state或结构化需求状态。
- 列表按opened_at降序，votes按responded_at升序，无最终tie-break。

#### 异常与边界

- 条件：可写成员在open评审投票或改票；处理：同principal一条vote被更新，其他人的vote保留；viewer写入project_forbidden，closed后requirement_review_closed。
- 条件：管理者关闭open评审并指定合法结论；处理：保存指定结论即使票未达多数或无票，不改变文档/REQ状态；普通writer关闭拒绝，重复关闭requirement_review_closed。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-DOCUMENT-REVIEW-FIXED` | 作者对R1发起评审后把文档修订至R2时，旧评审仍revision=1且文档可修订；R2新评审为不同review；重复start R1在未修订分支返回原review。 |
| `AC-GOV-DOCUMENT-REVIEW-VOTE` | 可写成员在open评审投票或改票时，同principal一条vote被更新，其他人的vote保留；viewer写入project_forbidden，closed后requirement_review_closed。 |
| `AC-GOV-DOCUMENT-REVIEW-CONCLUSION` | 管理者关闭open评审并指定合法结论时，保存指定结论即使票未达多数或无票，不改变文档/REQ状态；普通writer关闭拒绝，重复关闭requirement_review_closed。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-DOCUMENT-REVIEW-FIXED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P及U自有active文档D R1；U writer，A管理者。
- 操作：
  1. U POST D/reviews；重复start核对同code。
  2. PATCH D到R2再GET旧review和POST D/reviews，核对版本和code。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：旧评审仍revision=1且文档可修订；R2新评审为不同review；重复start R1在未修订分支返回原review。

**AC-GOV-DOCUMENT-REVIEW-VOTE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：open review R，writer U/V、viewer X；R尚无票。
- 操作：
  1. U support后changes_requested，V abstain；GET核对2票及U最终意见。
  2. X投票；A关闭后U再投票。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：同principal一条vote被更新，其他人的vote保留；viewer写入project_forbidden，closed后requirement_review_closed。

**AC-GOV-DOCUMENT-REVIEW-CONCLUSION** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立open review R无票；A Admin、U普通writer；记录D和关联REQ状态。
- 操作：
  1. U尝试close；A结论passed关闭；GET R/D/REQ核对；再次close。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：保存指定结论即使票未达多数或无票，不改变文档/REQ状态；普通writer关闭拒绝，重复关闭requirement_review_closed。

#### 来源与已有测试定义

- `packages/application/src/requirement-collaboration-use-cases.ts:410-437`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-document-use-cases.ts:395-451`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-collaboration-use-cases.ts:453-465`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`
- `packages/application/src/requirement-collaboration-use-cases.ts:469-486`；SHA-256 `e656b3ee417e53e0b9450af6503a981bc6a4bb35c8ac99358fba712548307710`

- `packages/application/tests/requirement-collaboration-use-cases.test.mjs` · 文档评审固定当前 Revision 且不限制新 Revision，项目成员可投票 · `defined`；仅检查固定源码中的测试定义，未执行；此条不证明运行成功。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 发起/投票部分权限检查与写入未统一在锁内，未运行并发变权/重复发起竞争；不承诺严格全路径线性一致。

## M05 · 需求文档、结构化需求与基线

对应平台父模块：`tsp-module-collaboration`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-GOV-REQUIREMENT-DOCUMENT-CREATE-READ · 按模块发布可协作查阅的需求文档

**观察类型：** `observed_in_code`

**摘要：** 按模块发布可协作查阅的需求文档的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 可写项目成员创建；有效成员读取

**触发：** 获取模板、创建、筛选或读取需求文档

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 提供Markdown模板；创建时指定模块编码或兼容module_key。
- 规范化正文/摘要/关键词，创建active文档与R1，创建后即能被项目成员读取。
- 列表按模块/状态/查询筛选；详情含目录、历史版本、关联结构化需求及can_edit。

#### 业务规则

- BR-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-CREATE：条件：writer指定已存在同项目模块、非空标题/正文；判定/结果：建立active R1并立即允许其他成员读；自动摘要/关键词规范化、标题目录与关联REQ均在详情可见，viewer不可创建。
- BR-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-COMPAT：条件：moduleKey未知且未提供moduleCode；判定/结果：管理者自动创建大写模块再建立文档；普通writer尝试未知moduleKey被manage检查拒绝；显式未知moduleCode不自动新建。
- BR-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-READ：条件：有效项目成员包括viewer读取归档项目需求文档；判定/结果：可读取已有文档与历史，can_edit=false；非成员不能list/get，非成员读取返回forbidden而不泄露正文。

#### 状态变化/保留

- 文档与R1及审计同事务；module_key兼容自动模块创建在该事务前，不能承诺失败无任何副作用。
- 状态active与文档评审分离；读取不等于批准。

#### 数据契约

- title/content必填，summary缺省从首个非标题段提取最多240字符或用title；CRLF转LF并trim。
- keyword trim后按不区分大小写键去重、保留首次写法，忽略空白；module_key可按当前项目模块名称不区分大小写匹配。
- 仅未提供moduleCode的未知moduleKey可由manage者自动建大写模块；普通writer无manage不能自动建模块。
- 列表搜索title/module_key/current revision summary/content/keywords，按module_key/title升序；目录只取Markdown 1至4级标题。

#### 异常与边界

- 条件：writer指定已存在同项目模块、非空标题/正文；处理：建立active R1并立即允许其他成员读；自动摘要/关键词规范化、标题目录与关联REQ均在详情可见，viewer不可创建。
- 条件：moduleKey未知且未提供moduleCode；处理：管理者自动创建大写模块再建立文档；普通writer尝试未知moduleKey被manage检查拒绝；显式未知moduleCode不自动新建。
- 条件：有效项目成员包括viewer读取归档项目需求文档；处理：可读取已有文档与历史，can_edit=false；非成员不能list/get，非成员读取返回forbidden而不泄露正文。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-CREATE` | writer指定已存在同项目模块、非空标题/正文时，建立active R1并立即允许其他成员读；自动摘要/关键词规范化、标题目录与关联REQ均在详情可见，viewer不可创建。 |
| `AC-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-COMPAT` | moduleKey未知且未提供moduleCode时，管理者自动创建大写模块再建立文档；普通writer尝试未知moduleKey被manage检查拒绝；显式未知moduleCode不自动新建。 |
| `AC-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-READ` | 有效项目成员包括viewer读取归档项目需求文档时，可读取已有文档与历史，can_edit=false；非成员不能list/get，非成员读取返回forbidden而不泄露正文。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-CREATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P有模块X，writer U/V、viewer W；无同编码文档。
- 操作：
  1. GET template；U POST requirement-documents module_code=X,title="设计",content="# 设计

目标正文",keywords=[" API ","API",""]。
  2. V GET新文档/list；W尝试创建。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：建立active R1并立即允许其他成员读；自动摘要/关键词规范化、标题目录与关联REQ均在详情可见，viewer不可创建。

**AC-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-COMPAT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P已有模块X；O管理者、U普通writer；未知KEY_NEW无匹配模块；各分支独立复位。
- 操作：
  1. O用module_key=key_new创建；检查模块名KEY_NEW。
  2. U用另一未知module_key；O提交未知module_code；检查各结果和模块列表。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：管理者自动创建大写模块再建立文档；普通writer尝试未知moduleKey被manage检查拒绝；显式未知moduleCode不自动新建。

**AC-GOV-REQUIREMENT-DOCUMENT-CREATE-READ-READ** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P归档，D有R1/R2；成员V viewer，外部X无访问。
- 操作：
  1. V GET列表与D详情，核对R2与历史。
  2. X读取同列表/D。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：可读取已有文档与历史，can_edit=false；非成员不能list/get，非成员读取返回forbidden而不泄露正文。

#### 来源与已有测试定义

- `packages/application/src/requirement-document-use-cases.ts:75-112`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-document-use-cases.ts:206-245`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-document-use-cases.ts:252-360`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/intake-entity-writers.ts:49-65`；SHA-256 `bd7a3c4d153178187225424bb36431d1ecdfea83b39dd7574d8191719bfca696`
- `packages/application/src/requirement-document-use-cases.ts:130-162`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-document-use-cases.ts:228-245`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-document-use-cases.ts:252-267`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-document-use-cases.ts:313-361`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 文档archive入口不在该需求文档用例中；原生文档库代理操作由文档模块覆盖。

### REQ-GOV-REQUIREMENT-DOCUMENT-REVISION · 需求文档负责人修订并保留历史

**观察类型：** `observed_in_code`

**摘要：** 需求文档负责人修订并保留历史的当前行为：覆盖2组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 文档维护人或项目Owner/Admin且非viewer

**触发：** 提交完整新版本与变更说明

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 检查active文档/active项目及文档作者或管理者权限。
- 要求标题、摘要、正文、change_summary非空，校验/解析模块。
- 新增R(current+1)并更新文档head；旧revision继续可读。

#### 业务规则

- BR-GOV-REQUIREMENT-DOCUMENT-REVISION-REVISE：条件：负责人或管理者提交完整合法修订；判定/结果：current_revision从N变N+1且旧正文保留，change_summary记录；即使内容相同的合法新请求也产生新版本。
- BR-GOV-REQUIREMENT-DOCUMENT-REVISION-DENIED：条件：非维护普通writer、viewer、archived文档/项目或缺变更说明；判定/结果：分别requirement_document_forbidden/权限拒绝/requirement_document_archived/project_archived/change_summary_required；head和历史数量不变。

#### 状态变化/保留

- 新增revision、更新head/title/module及审计同事务；不可从此推导数据库层revision内容绝对不可改。
- 旧版本正文、关键词、change_summary和创建者在历史列表保留。

#### 数据契约

- 修订每次递增版本，没有内容相同免增或客户端expected_revision参数。
- module重绑以当前项目兼容解析；结构化REQ不会自动跟随文档模块变化，需另行对齐。

#### 异常与边界

- 条件：非维护普通writer、viewer、archived文档/项目或缺变更说明；处理：分别requirement_document_forbidden/权限拒绝/requirement_document_archived/project_archived/change_summary_required；head和历史数量不变。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-REQUIREMENT-DOCUMENT-REVISION-REVISE` | 负责人或管理者提交完整合法修订时，current_revision从N变N+1且旧正文保留，change_summary记录；即使内容相同的合法新请求也产生新版本。 |
| `AC-GOV-REQUIREMENT-DOCUMENT-REVISION-DENIED` | 非维护普通writer、viewer、archived文档/项目或缺变更说明时，分别requirement_document_forbidden/权限拒绝/requirement_document_archived/project_archived/change_summary_required；head和历史数量不变。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-REQUIREMENT-DOCUMENT-REVISION-REVISE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P中D R1归U，U writer、A Admin；记录R1。
- 操作：
  1. U PATCH D完整字段和change_summary；读取D/R1/R2。
  2. A重复相同合法内容但提交新请求，读取R3。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：current_revision从N变N+1且旧正文保留，change_summary记录；即使内容相同的合法新请求也产生新版本。

**AC-GOV-REQUIREMENT-DOCUMENT-REVISION-DENIED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支独立D R1、U维护、V其他writer、W viewer；归档fixture限定隔离库。
- 操作：
  1. 各角色/状态提交完整修订，另用U提交空change_summary；每次读取D head及revision数。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别requirement_document_forbidden/权限拒绝/requirement_document_archived/project_archived/change_summary_required；head和历史数量不变。

#### 来源与已有测试定义

- `packages/application/src/requirement-document-use-cases.ts:368-451`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-document-use-cases.ts:384-413`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 并发修订从事务前head计算nextRevision，缺expected_revision/CAS协议；唯一版本索引可能造成冲突，未知响应重试可能多出版本，需运行验证。

### REQ-GOV-REQUIREMENT-CREATE-READ · 模块、来源文档或Feature中的结构化需求录入与检索

**观察类型：** `observed_in_code`

**摘要：** 模块、来源文档或Feature中的结构化需求录入与检索的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 可写项目成员录入；有效成员读取

**触发：** 创建、搜索或读取结构化需求

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 至少给出module、document、Feature中的一个有效同项目上下文。
- 规范化title/body/AC/open_questions，强制从draft和R1建立。
- 列表限制有效可见项目并搜索标识/关系/title/body；详情展示历史、关联任务、可编辑标志和可转换状态。

#### 业务规则

- BR-GOV-REQUIREMENT-CREATE-READ-CREATE：条件：writer以module或document创建需求而暂不绑定Feature；判定/结果：成功draft R1，保存规范化AC/问题，允许后补Feature；非draft初态被requirement_initial_status_invalid拒绝。
- BR-GOV-REQUIREMENT-CREATE-READ-SCOPE：条件：无有效范围、越项目关系、显式模块不一致或规范后AC ID重复；判定/结果：分别scope_required/project_mismatch/模块不一致/acceptance_id_duplicate拒绝；无新head/revision。
- BR-GOV-REQUIREMENT-CREATE-READ-READ：条件：成员搜索已授权项目需求并读取任务/版本详情；判定/结果：仅有效可见范围返回；q匹配代码/标题/关系/正文，task_count真实关联数；非成员详情requirement_forbidden且列表无该项。

#### 状态变化/保留

- 事务内创建head(state=draft,current_revision=1,owner本人)、revision及审计。
- 读取不改变状态，不把关联任务完成等同于需求自动推进。

#### 数据契约

- AC去空白text、空text丢弃；空ID生成为AC-N，规范后重复ID拒绝；open_questions去空白及空条目。
- 显式module与document/Feature模块一致；创建共享writer还校验推导module与其他关系一致。
- 列表不声明稳定排序；搜索不含AC text/open_questions，大小写不敏感。
- 普通writer可创建但修改/生命周期推进需Owner/Admin；can_edit仅active项目且draft/clarifying/change_proposed管理者。

#### 异常与边界

- 条件：writer以module或document创建需求而暂不绑定Feature；处理：成功draft R1，保存规范化AC/问题，允许后补Feature；非draft初态被requirement_initial_status_invalid拒绝。
- 条件：无有效范围、越项目关系、显式模块不一致或规范后AC ID重复；处理：分别scope_required/project_mismatch/模块不一致/acceptance_id_duplicate拒绝；无新head/revision。
- 条件：成员搜索已授权项目需求并读取任务/版本详情；处理：仅有效可见范围返回；q匹配代码/标题/关系/正文，task_count真实关联数；非成员详情requirement_forbidden且列表无该项。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-REQUIREMENT-CREATE-READ-CREATE` | writer以module或document创建需求而暂不绑定Feature时，成功draft R1，保存规范化AC/问题，允许后补Feature；非draft初态被requirement_initial_status_invalid拒绝。 |
| `AC-GOV-REQUIREMENT-CREATE-READ-SCOPE` | 无有效范围、越项目关系、显式模块不一致或规范后AC ID重复时，分别scope_required/project_mismatch/模块不一致/acceptance_id_duplicate拒绝；无新head/revision。 |
| `AC-GOV-REQUIREMENT-CREATE-READ-READ` | 成员搜索已授权项目需求并读取任务/版本详情时，仅有效可见范围返回；q匹配代码/标题/关系/正文，task_count真实关联数；非成员详情requirement_forbidden且列表无该项。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-REQUIREMENT-CREATE-READ-CREATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P有模块X、其文档D；U writer；有效title/body；各初态变体独立。
- 操作：
  1. POST /requirements module_code=X,document_code=D,title="检索",body="检索目标",AC含空ID和空text。
  2. GET新需求；独立提交status=confirmed。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：成功draft R1，保存规范化AC/问题，允许后补Feature；非draft初态被requirement_initial_status_invalid拒绝。

**AC-GOV-REQUIREMENT-CREATE-READ-SCOPE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P/P2各有模块/文档/Feature；每个错误输入独立复位；U有P写权限。
- 操作：
  1. 独立提交无scope、P模块配P2文档、错模块Feature和AC=[{id:" A ",text:"一"},{id:"A",text:"二"}]。
  2. 查询创建数保持。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别scope_required/project_mismatch/模块不一致/acceptance_id_duplicate拒绝；无新head/revision。

**AC-GOV-REQUIREMENT-CREATE-READ-READ** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P中R带任务T及R1/R2，U viewer有read；X无P访问但有另一项目P2。
- 操作：
  1. U GET /requirements?q=正文子串及详情，核对task_count/history。
  2. X列表和GET R；另用只出现在AC的独特词查询不应因AC命中。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：仅有效可见范围返回；q匹配代码/标题/关系/正文，task_count真实关联数；非成员详情requirement_forbidden且列表无该项。

#### 来源与已有测试定义

- `packages/application/src/requirement-use-cases.ts:127-145`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:297-369`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/intake-entity-writers.ts:67-86`；SHA-256 `bd7a3c4d153178187225424bb36431d1ecdfea83b39dd7574d8191719bfca696`
- `packages/application/src/requirement-use-cases.ts:127-140`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:263-293`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:309-357`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/intake-entity-writers.ts:73-76`；SHA-256 `bd7a3c4d153178187225424bb36431d1ecdfea83b39dd7574d8191719bfca696`
- `packages/application/src/requirement-use-cases.ts:376-429`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:437-511`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-REQUIREMENT-REVISION-BINDING · 需求内容版本与关系重绑分开处理

**观察类型：** `observed_in_code`

**摘要：** 需求内容版本与关系重绑分开处理的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目Owner/Admin

**触发：** 修改title/body/AC/问题或重新关联Feature、module、document

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 管理者检查当前revision与项目并解析给定字段；未给保持，null解除关联。
- 内容真正变化仅在draft/clarifying/change_proposed允许，并新增revision。
- 仅关联变化不增加revision，可在其他状态处理，但必须保留至少一个同项目上下文；无变化直接返回。

#### 业务规则

- BR-GOV-REQUIREMENT-REVISION-BINDING-CONTENT：条件：管理者编辑draft/clarifying/change_proposed需求内容；判定/结果：新增revision且旧正文/AC/问题保留；其他普通writer拒绝，即使其是原创建者；无变化保持版本。
- BR-GOV-REQUIREMENT-REVISION-BINDING-LOCK：条件：confirmed/implementing/delivered/deprecated状态的内容修改；判定/结果：requirement_revision_locked，head/revision不变；允许的change_proposed转换后可新增内容revision。
- BR-GOV-REQUIREMENT-REVISION-BINDING-BIND：条件：只重绑同项目Feature/document/module且至少保留一个上下文；判定/结果：成功保留revision并改变关系，含confirmed状态；所有关系清空/跨项目重绑拒绝；显式module冲突拒绝。

#### 状态变化/保留

- contentChanged→R+1且head关系更新；binding-only保留R并记requirement.bound。
- 无变化保持head/revision；原owner_principal_id不因管理者编辑改变。

#### 数据契约

- 内容变化以title、body、规范化AC和问题JSON比较；title变化也新增revision。
- 显式module与document/Feature已有module必须一致，跨项目重绑禁止。
- 绑定更新与审计同事务；内容锁不禁止所有binding-only更新。

#### 异常与边界

- 条件：管理者编辑draft/clarifying/change_proposed需求内容；处理：新增revision且旧正文/AC/问题保留；其他普通writer拒绝，即使其是原创建者；无变化保持版本。
- 条件：只重绑同项目Feature/document/module且至少保留一个上下文；处理：成功保留revision并改变关系，含confirmed状态；所有关系清空/跨项目重绑拒绝；显式module冲突拒绝。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-REQUIREMENT-REVISION-BINDING-CONTENT` | 管理者编辑draft/clarifying/change_proposed需求内容时，新增revision且旧正文/AC/问题保留；其他普通writer拒绝，即使其是原创建者；无变化保持版本。 |
| `AC-GOV-REQUIREMENT-REVISION-BINDING-LOCK` | confirmed/implementing/delivered/deprecated状态的内容修改时，requirement_revision_locked，head/revision不变；允许的change_proposed转换后可新增内容revision。 |
| `AC-GOV-REQUIREMENT-REVISION-BINDING-BIND` | 只重绑同项目Feature/document/module且至少保留一个上下文时，成功保留revision并改变关系，含confirmed状态；所有关系清空/跨项目重绑拒绝；显式module冲突拒绝。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-REQUIREMENT-REVISION-BINDING-CONTENT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：active P中R draft R1由普通U创建，O/A管理者；M普通writer；记录owner和R1。
- 操作：
  1. A PATCH R body新值，GET核对R2和owner未变；同内容再PATCH，核对仍R2。
  2. 独立U/M修改正文。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：新增revision且旧正文/AC/问题保留；其他普通writer拒绝，即使其是原创建者；无变化保持版本。

**AC-GOV-REQUIREMENT-REVISION-BINDING-LOCK** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立R confirmed且有AC无问题；O；保存R1。
- 操作：
  1. PATCH改body被拒绝；POST transition change_proposed；再PATCH body成功R2。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：requirement_revision_locked，head/revision不变；允许的change_proposed转换后可新增内容revision。

**AC-GOV-REQUIREMENT-REVISION-BINDING-BIND** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：R confirmed R1在P模块X、文档D，另有同X FeatureF；P2有F2；O。
- 操作：
  1. PATCH仅feature_code=F并读取R1不增加；独立清空全部关系、绑定F2、显式错误module。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：成功保留revision并改变关系，含confirmed状态；所有关系清空/跨项目重绑拒绝；显式module冲突拒绝。

#### 来源与已有测试定义

- `packages/application/src/requirement-use-cases.ts:535-593`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:615-670`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:30-40`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:585-593`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:628-670`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:559-625`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- updateBindingContext没有统一检查document推导module与Feature推导module在未显式传module时的所有组合；不承诺所有遗留绑定都已一致。
- 并发内容编辑缺expected_revision协议，事务外读取版本后写入存在竞争；测试未执行。

### REQ-GOV-REQUIREMENT-LIFECYCLE · 需求确认、实施、交付与变更提议守卫

**观察类型：** `observed_in_code`

**摘要：** 需求确认、实施、交付与变更提议守卫的当前行为：覆盖3组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 项目Owner/Admin

**触发：** 请求显式状态转换

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 验证目标枚举及当前状态允许边；要求active项目管理者。
- confirmed要求至少一条AC且零开放问题；implementing要求关联任务；delivered要求至少一任务且全部closed。
- 写新state和审计；状态变更不新增内容revision。

#### 业务规则

- BR-GOV-REQUIREMENT-LIFECYCLE-CONFIRM：条件：draft/clarifying/change_proposed向confirmed且有AC、无问题；判定/结果：确认成功且revision不变；无AC或仍有问题分别acceptance_required/questions_unresolved，状态不变。
- BR-GOV-REQUIREMENT-LIFECYCLE-DELIVERY：条件：confirmed进入implementing、implementing进入delivered；判定/结果：实施需至少关联一个任务；交付需非空且所有任务closed；存在failed/cancelled/其他状态均拒绝交付。
- BR-GOV-REQUIREMENT-LIFECYCLE-EDGES：条件：非法目标、非法边、普通writer推进或deprecated尝试恢复；判定/结果：分别requirement_status_invalid/requirement_transition_invalid/requirement_forbidden；状态/revision保持，deprecated无允许转换。

#### 状态变化/保留

- 成功只改变requirement.state，current_revision不变；此路径state写和audit不是同事务，不能承诺审计失败全回滚。

#### 数据契约

- draft→clarifying/confirmed/deprecated；clarifying→draft/confirmed/deprecated；confirmed→implementing/change_proposed/deprecated。
- implementing→delivered/change_proposed/deprecated；delivered→change_proposed/deprecated；change_proposed→clarifying/confirmed/deprecated；deprecated无出口。
- failed/cancelled任务不满足delivered，虽然它们在成员交接规则中是终态。

#### 异常与边界

- 条件：confirmed进入implementing、implementing进入delivered；处理：实施需至少关联一个任务；交付需非空且所有任务closed；存在failed/cancelled/其他状态均拒绝交付。
- 条件：非法目标、非法边、普通writer推进或deprecated尝试恢复；处理：分别requirement_status_invalid/requirement_transition_invalid/requirement_forbidden；状态/revision保持，deprecated无允许转换。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-REQUIREMENT-LIFECYCLE-CONFIRM` | draft/clarifying/change_proposed向confirmed且有AC、无问题时，确认成功且revision不变；无AC或仍有问题分别acceptance_required/questions_unresolved，状态不变。 |
| `AC-GOV-REQUIREMENT-LIFECYCLE-DELIVERY` | confirmed进入implementing、implementing进入delivered时，实施需至少关联一个任务；交付需非空且所有任务closed；存在failed/cancelled/其他状态均拒绝交付。 |
| `AC-GOV-REQUIREMENT-LIFECYCLE-EDGES` | 非法目标、非法边、普通writer推进或deprecated尝试恢复时，分别requirement_status_invalid/requirement_transition_invalid/requirement_forbidden；状态/revision保持，deprecated无允许转换。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-REQUIREMENT-LIFECYCLE-CONFIRM** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：三个独立draft需求R：有AC无问题、空AC、AC加开放问题；O管理者。
- 操作：
  1. 逐一POST transition confirmed并读取state/revision。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：确认成功且revision不变；无AC或仍有问题分别acceptance_required/questions_unresolved，状态不变。

**AC-GOV-REQUIREMENT-LIFECYCLE-DELIVERY** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立confirmed R0无任务；R1有任务；独立implementing R2的所有任务closed、R3含failed或cancelled。
- 操作：
  1. R0/R1请求implementing；R2/R3请求delivered；检查state与revision。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：实施需至少关联一个任务；交付需非空且所有任务closed；存在failed/cancelled/其他状态均拒绝交付。

**AC-GOV-REQUIREMENT-LIFECYCLE-EDGES** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每分支独立R与状态；O管理者、U writer；包含deprecated R。
- 操作：
  1. 提交非法状态、draft→delivered、U draft→clarifying和deprecated→draft；GET详情核对available_transitions。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：分别requirement_status_invalid/requirement_transition_invalid/requirement_forbidden；状态/revision保持，deprecated无允许转换。

#### 来源与已有测试定义

- `packages/application/src/requirement-use-cases.ts:30-40`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:696-754`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:740-776`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:428-429`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/requirement-use-cases.ts:696-738`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。

### REQ-GOV-BASELINE-FREEZE · 显式版本选择形成不可变需求基线

**观察类型：** `observed_in_code`

**摘要：** 显式版本选择形成不可变需求基线的当前行为：覆盖15组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** active项目Owner/Admin

**触发：** 提交需求选择、元数据及可选父基线

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 验证name/scope/reason非空及选择非空无重复正整数revision。
- 项目fence内检查当前最新父级和用户资格，确认每需求唯一属于当前项目且当前state为confirmed/implementing/delivered。
- 按requirement_code排序，保存指定revision正文/AC/问题和当前head标题/状态/绑定，计算canonical JSON SHA-256并冻结。

#### 业务规则

- BR-GOV-BASELINE-FREEZE-FREEZE：条件：管理者选择同项目已确认需求的存在revision和合法元数据；判定/结果：建立V1父null或最新V+1，排序内容hash可复算；后续修改原需求不改变旧基线。
- BR-GOV-BASELINE-FREEZE-PARENT：条件：两个创建请求都声明同一旧父级或首次显式null；判定/结果：项目fence序列化，先成功者推进版本，后者baseline_parent_conflict且不留下header/items；省略父级的新请求采用最新。
- BR-GOV-BASELINE-FREEZE-INVALID：条件：合法基准HTTP基线请求仅将requirements改为空数组；判定/结果：HTTP边界返回ok=false/error.code=validation_failed，不进入基线创建用例；P不新增header/items。此保留ID仅表示空选择，不作为所有拒绝分支的通用断言。
- BR-GOV-BASELINE-FREEZE-SELECTION-DUPLICATE：条件：基准请求仅把同一合法R/revision=1重复选择两次；判定/结果：HTTP字段形状合法进入应用后返回baseline_invalid_selection；P的header/items不增加。
- BR-GOV-BASELINE-FREEZE-UNKNOWN-REQUIREMENT：条件：基准请求仅把requirement_code替换为格式合法但不存在的20位编码Z；判定/结果：返回baseline_invalid_selection（所选需求不存在），不是未知revision/状态错误；创建事务不留header/items。
- BR-GOV-BASELINE-FREEZE-UNKNOWN-REVISION：条件：合法基准R仍confirmed且属于P，仅所选revision从1改为不存在的2；判定/结果：返回baseline_revision_not_found，创建事务不留header/items；R的current_revision与内容保留。
- BR-GOV-BASELINE-FREEZE-CROSS-PROJECT：条件：基准请求仅选择P2中confirmed且revision=1确实存在的R2；判定/结果：返回baseline_requirement_project_mismatch，P/P2均无本次新增header/items，R2内容和状态保持。
- BR-GOV-BASELINE-FREEZE-STATE-DRAFT：条件：基准请求仅选择P内revision=1存在但state=draft的Rd；判定/结果：返回baseline_requirement_not_approved；此错误码不是名为approved的需求状态。P不新增header/items，Rd仍draft。
- BR-GOV-BASELINE-FREEZE-ROLE-MEMBER：条件：请求及数据完全等于合法基准，仅操作者由Owner O改为P的有效普通member U；判定/结果：返回baseline_owner_required，P不新增header/items；不把普通member等同未授权用户或归档项目。
- BR-GOV-BASELINE-FREEZE-PROJECT-ARCHIVED：条件：在合法基准上仅将P先由O归档，仍由O创建基线；判定/结果：返回project_archived，P仍archived且不新增header/items；R confirmed R1不变。
- BR-GOV-BASELINE-FREEZE-UNKNOWN-FIELD：条件：合法基准HTTP body仅额外加入unexpected:true；判定/结果：HTTP形状检查返回validation_failed，P不新增header/items；不会由应用层忽略该字段继续创建。
- BR-GOV-BASELINE-FREEZE-FIELD-SIZE：条件：HTTP基准仅一个元数据字段超过其当前字符上限；判定/结果：name=201字符、scope=2001字符或reason=4001字符的三个独立请求均返回validation_failed，P不新增header/items；不是HTTP体积413，也不夹带其他错误。
- BR-GOV-BASELINE-FREEZE-SELECTION-SIZE：条件：HTTP其他字段合法且选择的1001个不同同项目confirmed需求均有revision=1，唯一超限因素是集合数量；判定/结果：requirements长度1001返回validation_failed，创建用例不写header/items；对照1000个合法选择允许创建且项目基线包含1000项。
- BR-GOV-BASELINE-FREEZE-METADATA-EMPTY：条件：HTTP合法基准仅将name/scope/reason之一改为空白；判定/结果：每个独立空白字段请求均validation_failed且不新增header/items；其他元数据字段/选择/权限/state保持有效。
- BR-GOV-BASELINE-FREEZE-IMMUTABLE：条件：冻结header/items被直接修改、删除或后续追加；判定/结果：数据库拒绝写入，原基线snapshot/hash保持；这只是计划的隔离数据库检查，不代表已执行。

#### 状态变化/保留

- 基线version=latest+1、parent指向latest；header/items/audit同事务。
- 原需求后续修改不回写基线；baseline是冻结快照，不等于审批流程执行。

#### 数据契约

- HTTP限制name≤200、scope≤2000、reason≤4000、requirements≤1000，拒绝未知字段及非法public code。
- parent_baseline_code省略时采用锁内最新；显式null仅允许第一版；显式旧父级baseline_parent_conflict。
- 选择旧revision允许，但状态/标题/feature/module/document使用捕获时head，不是该旧revision的历史元数据。
- 数据库trigger拒绝基线header/items更新/删除及创建事务外追加。

#### 异常与边界

- 条件：两个创建请求都声明同一旧父级或首次显式null；处理：项目fence序列化，先成功者推进版本，后者baseline_parent_conflict且不留下header/items；省略父级的新请求采用最新。
- 条件：合法基准HTTP基线请求仅将requirements改为空数组；处理：HTTP边界返回ok=false/error.code=validation_failed，不进入基线创建用例；P不新增header/items。此保留ID仅表示空选择，不作为所有拒绝分支的通用断言。
- 条件：基准请求仅把同一合法R/revision=1重复选择两次；处理：HTTP字段形状合法进入应用后返回baseline_invalid_selection；P的header/items不增加。
- 条件：基准请求仅把requirement_code替换为格式合法但不存在的20位编码Z；处理：返回baseline_invalid_selection（所选需求不存在），不是未知revision/状态错误；创建事务不留header/items。
- 条件：冻结header/items被直接修改、删除或后续追加；处理：数据库拒绝写入，原基线snapshot/hash保持；这只是计划的隔离数据库检查，不代表已执行。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-BASELINE-FREEZE-FREEZE` | 管理者选择同项目已确认需求的存在revision和合法元数据时，建立V1父null或最新V+1，排序内容hash可复算；后续修改原需求不改变旧基线。 |
| `AC-GOV-BASELINE-FREEZE-PARENT` | 两个创建请求都声明同一旧父级或首次显式null时，项目fence序列化，先成功者推进版本，后者baseline_parent_conflict且不留下header/items；省略父级的新请求采用最新。 |
| `AC-GOV-BASELINE-FREEZE-INVALID` | 合法基准HTTP基线请求仅将requirements改为空数组时，HTTP边界返回ok=false/error.code=validation_failed，不进入基线创建用例；P不新增header/items。此保留ID仅表示空选择，不作为所有拒绝分支的通用断言。 |
| `AC-GOV-BASELINE-FREEZE-SELECTION-DUPLICATE` | 基准请求仅把同一合法R/revision=1重复选择两次时，HTTP字段形状合法进入应用后返回baseline_invalid_selection；P的header/items不增加。 |
| `AC-GOV-BASELINE-FREEZE-UNKNOWN-REQUIREMENT` | 基准请求仅把requirement_code替换为格式合法但不存在的20位编码Z时，返回baseline_invalid_selection（所选需求不存在），不是未知revision/状态错误；创建事务不留header/items。 |
| `AC-GOV-BASELINE-FREEZE-UNKNOWN-REVISION` | 合法基准R仍confirmed且属于P，仅所选revision从1改为不存在的2时，返回baseline_revision_not_found，创建事务不留header/items；R的current_revision与内容保留。 |
| `AC-GOV-BASELINE-FREEZE-CROSS-PROJECT` | 基准请求仅选择P2中confirmed且revision=1确实存在的R2时，返回baseline_requirement_project_mismatch，P/P2均无本次新增header/items，R2内容和状态保持。 |
| `AC-GOV-BASELINE-FREEZE-STATE-DRAFT` | 基准请求仅选择P内revision=1存在但state=draft的Rd时，返回baseline_requirement_not_approved；此错误码不是名为approved的需求状态。P不新增header/items，Rd仍draft。 |
| `AC-GOV-BASELINE-FREEZE-ROLE-MEMBER` | 请求及数据完全等于合法基准，仅操作者由Owner O改为P的有效普通member U时，返回baseline_owner_required，P不新增header/items；不把普通member等同未授权用户或归档项目。 |
| `AC-GOV-BASELINE-FREEZE-PROJECT-ARCHIVED` | 在合法基准上仅将P先由O归档，仍由O创建基线时，返回project_archived，P仍archived且不新增header/items；R confirmed R1不变。 |
| `AC-GOV-BASELINE-FREEZE-UNKNOWN-FIELD` | 合法基准HTTP body仅额外加入unexpected:true时，HTTP形状检查返回validation_failed，P不新增header/items；不会由应用层忽略该字段继续创建。 |
| `AC-GOV-BASELINE-FREEZE-FIELD-SIZE` | HTTP基准仅一个元数据字段超过其当前字符上限时，name=201字符、scope=2001字符或reason=4001字符的三个独立请求均返回validation_failed，P不新增header/items；不是HTTP体积413，也不夹带其他错误。 |
| `AC-GOV-BASELINE-FREEZE-SELECTION-SIZE` | HTTP其他字段合法且选择的1001个不同同项目confirmed需求均有revision=1，唯一超限因素是集合数量时，requirements长度1001返回validation_failed，创建用例不写header/items；对照1000个合法选择允许创建且项目基线包含1000项。 |
| `AC-GOV-BASELINE-FREEZE-METADATA-EMPTY` | HTTP合法基准仅将name/scope/reason之一改为空白时，每个独立空白字段请求均validation_failed且不新增header/items；其他元数据字段/选择/权限/state保持有效。 |
| `AC-GOV-BASELINE-FREEZE-IMMUTABLE` | 冻结header/items被直接修改、删除或后续追加时，数据库拒绝写入，原基线snapshot/hash保持；这只是计划的隔离数据库检查，不代表已执行。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-BASELINE-FREEZE-FREEZE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：隔离active P，R当前confirmed R2且保留R1；O/Admin A；无基线。
- 操作：
  1. A POST baseline选择R revision=1，记录返回snapshot/hash。
  2. 按需求变更流程更新原需求；GET旧基线与初值比较。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：建立V1父null或最新V+1，排序内容hash可复算；后续修改原需求不改变旧基线。

**AC-GOV-BASELINE-FREEZE-PARENT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：独立P已有B1；两请求均parent=B1、选择同一已确认R。另独立P0无基线。
- 操作：
  1. 并发提交两个父B1请求并读基线列表；P0并发显式null创建。
  2. 以省略parent的新请求确认下一版。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：项目fence序列化，先成功者推进版本，后者baseline_parent_conflict且不留下header/items；省略父级的新请求采用最新。

**AC-GOV-BASELINE-FREEZE-INVALID** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。
- 操作：
  1. 仅将基准body.requirements改成[]，保持O、P active、元数据与parent=null均合法；向基准URL POST。
  2. 核对error.code=validation_failed，并只读核对P的header/items均0；保留R confirmed R1不变。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：HTTP边界返回ok=false/error.code=validation_failed，不进入基线创建用例；P不新增header/items。此保留ID仅表示空选择，不作为所有拒绝分支的通用断言。

**AC-GOV-BASELINE-FREEZE-SELECTION-DUPLICATE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。
- 操作：
  1. 仅改requirements为[{requirement_code:R,revision:1},{requirement_code:R,revision:1}]；POST基准URL。
  2. 核对error.code=baseline_invalid_selection，并读取P的header/items各0。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：HTTP字段形状合法进入应用后返回baseline_invalid_selection；P的header/items不增加。

**AC-GOV-BASELINE-FREEZE-UNKNOWN-REQUIREMENT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。 Z用20位合法public code并在隔离库确认没有该需求；不使用格式非法字符串。
- 操作：
  1. 仅将requirements改成[{requirement_code:Z,revision:1}]；POST，核对error.code=baseline_invalid_selection。
  2. 读取P的header/items均0及R原状态；不把Z错误混为跨项目。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：返回baseline_invalid_selection（所选需求不存在），不是未知revision/状态错误；创建事务不留header/items。

**AC-GOV-BASELINE-FREEZE-UNKNOWN-REVISION** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。
- 操作：
  1. 先只读确认R存在且仅有R1，然后只改requirements[0].revision=2；POST基准URL。
  2. 核对error.code=baseline_revision_not_found；P的header/items均0且R仍confirmed R1。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：返回baseline_revision_not_found，创建事务不留header/items；R的current_revision与内容保留。

**AC-GOV-BASELINE-FREEZE-CROSS-PROJECT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。
- 操作：
  1. 仅改requirements为[{requirement_code:R2,revision:1}]；O仍对P发起，其他字段不变。
  2. 核对error.code=baseline_requirement_project_mismatch；读取P/P2的基线数与原需求，均无本次变化。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：返回baseline_requirement_project_mismatch，P/P2均无本次新增header/items，R2内容和状态保持。

**AC-GOV-BASELINE-FREEZE-STATE-DRAFT** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。
- 操作：
  1. 仅改requirements为[{requirement_code:Rd,revision:1}]；保持active P和O及全部元数据合法。
  2. POST后核对error.code=baseline_requirement_not_approved；读取Rd状态和P header/items=0。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：返回baseline_requirement_not_approved；此错误码不是名为approved的需求状态。P不新增header/items，Rd仍draft。

**AC-GOV-BASELINE-FREEZE-ROLE-MEMBER** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。
- 操作：
  1. 使用U自己的有效Bearer提交未改动的基准请求；P保持active，R confirmed且R1存在。
  2. 核对error.code=baseline_owner_required；只读P header/items仍各0，原用户角色和R状态保持。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：返回baseline_owner_required，P不新增header/items；不把普通member等同未授权用户或归档项目。

**AC-GOV-BASELINE-FREEZE-PROJECT-ARCHIVED** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。
- 操作：
  1. O通过现有status入口将P归档，保存归档后的初始状态；用O提交未改变的基准body。
  2. 核对error.code=project_archived；只读header/items为0，P保持archived、R保持confirmed。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：返回project_archived，P仍archived且不新增header/items；R confirmed R1不变。

**AC-GOV-BASELINE-FREEZE-UNKNOWN-FIELD** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。
- 操作：
  1. 仅给基准body增加unexpected:true后POST；其他字段/角色/状态均合法。
  2. 核对error.code=validation_failed且header/items为0。独立复位后仅给requirements[0]增加unexpected:true再提交，预期同错误与保持状态。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：HTTP形状检查返回validation_failed，P不新增header/items；不会由应用层忽略该字段继续创建。

**AC-GOV-BASELINE-FREEZE-FIELD-SIZE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。 三个分支各自复位；请求以ASCII字符构造并先核对UTF-8 JSON总字节远小于1MiB。
- 操作：
  1. 独立A仅name="a".repeat(201)；独立B仅scope="a".repeat(2001)；独立C仅reason="a".repeat(4001)；每次其余body与O/active P/R confirmed R1完全保持基准。
  2. 分别POST并核对error.code=validation_failed；每次只读P header/items各0。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：name=201字符、scope=2001字符或reason=4001字符的三个独立请求均返回validation_failed，P不新增header/items；不是HTTP体积413，也不夹带其他错误。

**AC-GOV-BASELINE-FREEZE-SELECTION-SIZE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：建设前提（尚未提供/运行）：隔离P/O可用正常需求create+transition流程准备1001个不同confirmed R_i，各有真实20位code、R1、非空title/body/AC且无开放问题；P无基线且header/items=0。构造与基准相同name/scope/reason及parent=null，requirements按真实返回code排序。每个分支独立恢复无基线快照，1000/1001输入JSON总字节先算出小于1MiB，避免请求体限制混淆。
- 操作：
  1. 分支A以全部1001个不同R_i/revision=1提交，核对validation_failed及P header/items各0。
  2. 独立恢复无基线快照，分支B只去掉最后一项，保留其余1000个选择及其他因素；提交并核对成功、header=1、items=1000和冻结选项一致。
  3. 本计划未执行；大集合数据准备夹具必须先建设或按正常流程逐条准备，不假定存在批量seed命令。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：requirements长度1001返回validation_failed，创建用例不写header/items；对照1000个合法选择允许创建且项目基线包含1000项。

**AC-GOV-BASELINE-FREEZE-METADATA-EMPTY** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：每个分支从独立隔离快照重新开始：P为active、O为Owner、U为有效member，P无基线，header/items计数均0；用当前正常流程先创建R draft R1，body/title非空，AC=[{id:"AC-1",text:"可观察结果"}]且open_questions=[]，再转换到confirmed，R仅存在revision=1；Rd按相同内容创建但保持draft R1；P2亦无基线，P2内R2为confirmed且存在R1。保存真实返回的20位编码。基准请求POST /projects/P/requirement-baselines使用O自己的Bearer，body={name:"B1",scope:"单项R",reason:"确认范围",parent_baseline_code:null,requirements:[{requirement_code:R,revision:1}]}。其他因素始终保持此基准；各失败后只读确认P的header/items仍各0，R/关系/状态未变。本段仅为待建设/准备的隔离数据，不声称这些fixture已存在或执行。
- 操作：
  1. 三个独立复位分支仅改name=" "、scope=" "、reason=" "并POST基准URL。
  2. 各自核对error.code=validation_failed以及header/items各0。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：每个独立空白字段请求均validation_failed且不新增header/items；其他元数据字段/选择/权限/state保持有效。

**AC-GOV-BASELINE-FREEZE-IMMUTABLE** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：仅隔离测试数据库已提交B1；保存原header/items；连接使用正常迁移角色，勿对生产操作。
- 操作：
  1. 独立事务分别尝试UPDATE/DELETE header/items、在新事务INSERT item，捕获数据库拒绝并回滚。
  2. API GET B1验证完整hash和内容。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：数据库拒绝写入，原基线snapshot/hash保持；这只是计划的隔离数据库检查，不代表已执行。

#### 来源与已有测试定义

- `packages/application/src/baseline-use-cases.ts:17-25`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `packages/application/src/baseline-use-cases.ts:68-83`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `packages/application/src/baseline-use-cases.ts:169-198`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `packages/application/src/baseline-use-cases.ts:173-198`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `apps/core-api/src/routes/baselines.ts:24-38`；SHA-256 `8f7b71495d6f52cee8a6c54eeb54a738d53a82f118f1a124a87929a916b9ed70`
- `packages/application/src/baseline-use-cases.ts:169-172`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `packages/application/src/baseline-use-cases.ts:180-185`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `apps/core-api/src/routes/baselines.ts:31-34`；SHA-256 `8f7b71495d6f52cee8a6c54eeb54a738d53a82f118f1a124a87929a916b9ed70`
- `packages/application/src/requirement-use-cases.ts:18-37`；SHA-256 `403ec4dd77b673fc3a065561c31b5aec98e4fc0dd1d60a32bbeef11f384e9612`
- `packages/application/src/baseline-use-cases.ts:36-45`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `packages/persistence/drizzle/0027_requirement_baselines.sql:32-56`；SHA-256 `458fe4ef8477f3346637d32b95ff9aa658b96b2fcd7b0ca2ed2bf64f5d2b5b82`

- `packages/application/tests/baseline-use-cases.test.mjs` · 基线固定正文和元数据；后续需求修改不改变历史；不可追加、更新或删除 · `defined`；仅检查固定源码中的测试定义，未执行；此条不证明运行成功。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- 旧revision并不冻结当时title/state/binding，需按当前实现理解；基线业务批准权仍需Owner确认，未从快照导出批准结论。

### REQ-GOV-BASELINE-READ-COMPARE · 基线历史、完整性、差异与任务交接绑定

**观察类型：** `observed_in_code`

**摘要：** 基线历史、完整性、差异与任务交接绑定的当前行为：覆盖4组可观察场景，保留授权、状态、异常与恢复限制。

**角色：** 有效项目成员含Viewer

**触发：** 读取基线、差异或绑定轨迹

#### 前置条件

- 使用目标项目当前有效授权；特殊权限和数据状态按各AC计划单独建立。
- 正文描述的是捕获版本当前实现，包含已识别缺陷/宽松分支，不自动作为业务目标政策。

#### 主流程

- 读取项目基线按version降序，先验SHA-256内容完整性；归档仍可读但can_create=false。
- 比较同项目基线或current需求，按需求code排序计算added/modified/removed及changed_fields。
- 展示任务所选基线与交接冻结manifest内基线；未发布交接限管理者或源run执行者。

#### 业务规则

- BR-GOV-BASELINE-READ-COMPARE-HISTORY：条件：有效成员读取本项目基线/归档项目历史；判定/结果：列表version降序，get返回原冻结内容；Viewer可读，归档can_create=false；其他项目基线code baseline_not_found。
- BR-GOV-BASELINE-READ-COMPARE-DIFF：条件：B1到B2或current发生新增、修改、移除；判定/结果：返回准确counts和before/after/changed_fields，按requirement_code升序；B2对自身变化为空；current包含当前草稿新需求。
- BR-GOV-BASELINE-READ-COMPARE-INTEGRITY：条件：隔离库内snapshot与保存hash不一致；判定/结果：get/list/compare读取损坏基线返回baseline_integrity_error，不把损坏内容当有效历史。
- BR-GOV-BASELINE-READ-COMPARE-BINDINGS：条件：项目任务及交接有/无基线且交接未发布；判定/结果：任务总保留未绑定项；草稿交接仅Owner/Admin或源run用户可见；有效冻结基线返回其code/version，失配为null。

#### 状态变化/保留

- 读取/比较不改基线或需求；compare持共享项目fence；轨迹权限不授予其他交接草稿内容。

#### 数据契约

- current比较遍历当前同项目需求，包含当前draft/change_proposed等状态，不复用基线准入过滤。
- 同一基线比较changes为空；跨项目基线code不可访问；完整性错误baseline_integrity_error。
- 绑定包含未绑定任务/交接，以null表示；交接仅接受manifest基线project_code/version与本项目基线匹配。

#### 异常与边界

- 条件：目标项目存在，当前存在的有效用户没有该项目成员访问权。；处理：返回baseline_access_denied，不返回该项目基线或交接绑定内容，不改基线/需求（BR-GOV-BASELINE-READ-COMPARE-HISTORY / AC-GOV-BASELINE-READ-COMPARE-HISTORY）。
- 条件：读取或比较指定基线在当前项目不存在，包括持有另一项目的有效baseline code。；处理：返回baseline_not_found，不跨项目返回冻结内容；所有已有基线保持（BR-GOV-BASELINE-READ-COMPARE-HISTORY / AC-GOV-BASELINE-READ-COMPARE-HISTORY）。
- 条件：装载冻结items后重算内容哈希与header.content_hash不一致。；处理：get/list/compare在装载该基线时返回baseline_integrity_error，不把损坏snapshot当成有效历史；本读取不修写数据（BR-GOV-BASELINE-READ-COMPARE-INTEGRITY / AC-GOV-BASELINE-READ-COMPARE-INTEGRITY）。
- 条件：绑定轨迹中的交接未发布，而当前成员既非Owner/Admin也不是源run执行者。；处理：从绑定结果省略该交接行，仍按各自规则保留可见任务和其他交接；不会授予草稿访问权（BR-GOV-BASELINE-READ-COMPARE-BINDINGS / AC-GOV-BASELINE-READ-COMPARE-BINDINGS）。
- 条件：可见交接manifest没有冻结基线，或冻结基线project_code/version与当前项目基线不匹配。；处理：该可见交接仍保留，但baseline_code/baseline_version为null；不借外项目或失配manifest绑定真实基线（BR-GOV-BASELINE-READ-COMPARE-BINDINGS / AC-GOV-BASELINE-READ-COMPARE-BINDINGS）。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-GOV-BASELINE-READ-COMPARE-HISTORY` | 有效成员读取本项目基线/归档项目历史时，列表version降序，get返回原冻结内容；Viewer可读，归档can_create=false；其他项目基线code baseline_not_found。 |
| `AC-GOV-BASELINE-READ-COMPARE-DIFF` | B1到B2或current发生新增、修改、移除时，返回准确counts和before/after/changed_fields，按requirement_code升序；B2对自身变化为空；current包含当前草稿新需求。 |
| `AC-GOV-BASELINE-READ-COMPARE-INTEGRITY` | 隔离库内snapshot与保存hash不一致时，get/list/compare读取损坏基线返回baseline_integrity_error，不把损坏内容当有效历史。 |
| `AC-GOV-BASELINE-READ-COMPARE-BINDINGS` | 项目任务及交接有/无基线且交接未发布时，任务总保留未绑定项；草稿交接仅Owner/Admin或源run用户可见；有效冻结基线返回其code/version，失配为null。 |

#### 验证计划（本轮全部未执行）

**AC-GOV-BASELINE-READ-COMPARE-HISTORY** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P含B1/B2，U viewer；P2含B3；P已归档；X非P成员。
- 操作：
  1. U列表/get B1及跨项目B3，X请求P列表；记录响应是否泄露。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：列表version降序，get返回原冻结内容；Viewer可读，归档can_create=false；其他项目基线code baseline_not_found。

**AC-GOV-BASELINE-READ-COMPARE-DIFF** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P中B1含R1/R2，B2含修改后R1与新增R3；current额外有draft R4。
- 操作：
  1. GET B1/diff?compare_to=B2
  2. B2/diff?compare_to=B2
  3. B2/diff?compare_to=current。
  4. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：返回准确counts和before/after/changed_fields，按requirement_code升序；B2对自身变化为空；current包含当前草稿新需求。

**AC-GOV-BASELINE-READ-COMPARE-INTEGRITY** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：仅独立故障注入测试库B1副本；通过测试专用机制构造存储损坏，正常数据库trigger不得在生产绕过。
- 操作：
  1. 在隔离副本构造snapshot/hash不匹配；调用get/list/diff，捕获错误。
  2. 恢复原数据库快照后读取成功。
  3. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：get/list/compare读取损坏基线返回baseline_integrity_error，不把损坏内容当有效历史。

**AC-GOV-BASELINE-READ-COMPARE-BINDINGS** · manual

- 前提/数据/权限：每个用例使用独立隔离数据并在开始前恢复所述初始状态；账号有效且已完成初始密码修改，除非该用例明确测试初始密码。认证使用该角色自己的有效Bearer会话；浏览器用例使用自身Cookie/Origin/CSRF。保存创建操作真实返回的编码，不硬编码生产数据。时钟采用UTC并记录起始时间；仅在有效期/锁定场景控制时钟。所有步骤为待执行计划。 专用初态：P有任务T1绑定B1、T2未绑定；交接H1未发布由U的run产生，H2已发布；U/V普通成员，O管理者。
- 操作：
  1. 分别用U/V/O GET requirement-baselines/bindings，比较任务清单、草稿H1可见性和基线版本。
  2. 检查响应与所列实体/授权/版本/历史的最终状态；失败分支核对本文明确承诺保持的字段，清理隔离数据。
- 观察结果：任务总保留未绑定项；草稿交接仅Owner/Admin或源run用户可见；有效冻结基线返回其code/version，失配为null。

#### 来源与已有测试定义

- `packages/application/src/baseline-use-cases.ts:36-64`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `packages/application/src/baseline-use-cases.ts:142-165`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `apps/core-api/src/routes/baselines.ts:14-22`；SHA-256 `8f7b71495d6f52cee8a6c54eeb54a738d53a82f118f1a124a87929a916b9ed70`
- `packages/application/src/baseline-use-cases.ts:86-101`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `packages/application/src/baseline-use-cases.ts:203-225`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `packages/application/src/baseline-use-cases.ts:49-64`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`
- `packages/application/src/baseline-use-cases.ts:106-137`；SHA-256 `b1428e588369c71d9df4b405aff3dc87e24d1fb60ec55e5d0c527ea1b5ca7193`

- `packages/application/tests/baseline-use-cases.test.mjs` · 基线轨迹与差异包含新增、移除、正文、验收、标题和状态的变化 · `defined`；仅检查固定源码中的测试定义，未执行；此条不证明运行成功。

#### 未确认与未验证

- 基于固定源码的现状观察，未执行业务/验收测试、未验证部署配置或外部系统、未取得业务批准；verification_plan全部待执行。
- hash故障注入仅为未来测试设计，未关闭任何真实触发器或改动业务数据库；交接生命周期由交付模块覆盖。

## M06 · 任务执行与 Run

对应平台父模块：`tsp-module-collaboration`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-DEL-M06-01 · 任务看板、详情与依赖审计查询

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的任务看板、详情与依赖审计查询行为，作为待业务确认的逆向规格。

**角色：** 具有项目读取权的有效用户

**触发：** 查询任务列表、状态、依赖图、历史及证据

#### 前置条件

- 使用当前认证身份；可选项目、状态、指派人及分页参数

#### 主流程

- 计算可见项目集合及指派人条件
- 按创建时间降序、内部 ID 降序分页并返回 total/has_more
- 详情合并合同、Run、工作区、证据、产物及固定需求来源
- 依赖图只返回可见任务间的边

#### 业务规则

- BR-DEL-M06-01-01：资格：不可见项目或无效身份返回空列表/空图，详情拒绝访问；不能凭任务编码越权。
- BR-DEL-M06-01-02：选择/顺序：列表以 created_at DESC、id DESC 排序；limit 默认50且为1至500整数，offset为0至2147483647整数。
- BR-DEL-M06-01-03：运行控制：完成/取消时间从对应审计事件取最新时间；有固定需求修订时详情保留该修订，并提示当前源是否变化。

#### 状态变化/保留

- 只读查询不推进任务状态或 base_snapshot

#### 数据契约

- 公开返回 task_code/feature_code、status、acceptance、base_snapshot、Run/工作区与产物证据；图边为 from/to

#### 异常与边界

- 条件：非法分页值；处理：validation_failed；不改变任务
- 条件：无项目访问权；处理：列表/图为空，详情 project_forbidden

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-01-01` | 同时间任务分页保持确定ID次序，计数及依赖图只覆盖当前用户可见任务。 |
| `AC-M06-01-02` | 无项目访问权不能通过列表、图或详情读取任务数据。 |

#### 验证计划（本轮全部未执行）

**AC-M06-01-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；有效项目成员；播种同一创建时间的3个可见任务、1个不可见项目任务
- 操作：
  1. 查询limit=2再以offset=2查询
  2. 读取total及依赖图
- 观察结果：两页顺序按ID降序无重复，total=3，图中无不可见任务或跨可见域边，数据库不变

**AC-M06-01-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；无项目读取权用户；另存任务基线及记录计数
- 操作：
  1. 列表及图查询指定项目
  2. 读取该任务详情
- 观察结果：列表和图为空；详情拒绝；任务基线/状态/记录数不变

#### 来源与已有测试定义

- `packages/application/src/task-service.ts:234-323`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `packages/application/src/task-service.ts:570-591`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `packages/application/src/task-service.ts:659-742`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `apps/core-api/src/routes/tasks.ts:77-120`；SHA-256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`

- `packages/application/tests/task-service.test.mjs` · task pages use stable id tie-break, counts, filters and empty out-of-bounds pages · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M06-02 · 创建带来源及依赖的任务合同

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的创建带来源及依赖的任务合同行为，作为待业务确认的逆向规格。

**角色：** 项目负责人/管理员；可写成员可提出 ad-hoc

**触发：** 通过任务创建入口提交合同

#### 前置条件

- 目标Feature存在且属于可写的活动项目
- acceptance非空；profile及source采用合同枚举

#### 主流程

- 校验来源对应权限
- 解析关联需求并固定其当前修订/文档修订，或按已选基线固定需求修订
- 校验缺陷与依赖归属
- 事务保存draft任务、依赖及审计，基线版本为0

#### 业务规则

- BR-DEL-M06-02-01：资格：非ad-hoc来源仅项目管理者可创建；ad-hoc允许可写成员；viewer不允许。
- BR-DEL-M06-02-02：关联：defect-fix必须绑定同Feature缺陷；其他来源携带defect_code拒绝；依赖必须存在且同项目。
- BR-DEL-M06-02-03：基线：选择需求基线要求活动项目的有效管理者；关联需求必须包含于该基线；固定基线需求修订并不跟随今日需求文档头。
- BR-DEL-M06-02-04：运行控制：任务/依赖/审计在创建事务内保存；创建不代表已分派或启动。

#### 状态变化/保留

- 新任务 status=draft、base_snapshot=0；尚无Run

#### 数据契约

- 输入feature_code、title、brief、profile、source、acceptance[{id,text}]、depends_on_codes及可选需求/基线/缺陷、scope、validation_seams

#### 异常与边界

- 条件：无验收标准或依赖缺失/跨项目；处理：拒绝创建，不留下任务及依赖
- 条件：基线不含需求/修订无效；处理：拒绝该事务

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-02-01` | 可写成员创建ad-hoc任务后形成未执行合同。 |
| `AC-M06-02-02` | 跨项目依赖和不匹配缺陷不会形成任务。 |

#### 验证计划（本轮全部未执行）

**AC-M06-02-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动项目写成员；已存在Feature F；无同名任务；两条AC
- 操作：
  1. 以ad-hoc来源创建任务并读取详情
- 观察结果：保存draft及两条AC，base_snapshot=0，作者审计正确，无Run

**AC-M06-02-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动项目管理者；同项目依赖D和另一项目依赖X；缺陷Z属于另一Feature
- 操作：
  1. 分别在独立重置状态提交跨项目依赖或不匹配defect-fix任务
- 观察结果：每次拒绝且无新任务/依赖/审计部分写入

#### 来源与已有测试定义

- `packages/application/src/project-use-cases.ts:359-527`；SHA-256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`
- `apps/core-api/src/routes/tasks.ts:122-149`；SHA-256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`

- `packages/application/tests/project-use-cases.test.mjs` · task create：验收标准缺失拒绝；依赖不存在拒绝；成功创建 draft + 依赖落库 · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M06-03 · 按当前状态修改合同或取消、首次绑定需求基线

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的按当前状态修改合同或取消、首次绑定需求基线行为，作为待业务确认的逆向规格。

**角色：** 活动项目负责人或管理员

**触发：** 编辑合同、选择基线或取消当前可管理状态的任务

#### 前置条件

- 持有当前base_snapshot
- 合同编辑/取消限draft、ready、assigned；基线绑定还要求从未有Run

#### 主流程

- 重查管理权限并锁任务
- 拒绝未完成交接或版本不匹配
- 修改合同/基线时推进快照并写审计；取消转cancelled
- 相同基线绑定为不推进版本的返回

#### 业务规则

- BR-DEL-M06-03-01：资格：只有管理者可改合同、绑定基线和取消；合同必须保留非空标题与验收标准。
- BR-DEL-M06-03-02：基线：只允许当前draft/ready/assigned且没有任何历史Run；关联需求必须在同项目基线中且匹配任务已固定的修订。
- BR-DEL-M06-03-03：运行控制：乐观base_snapshot与任务行锁保护；pending交接禁止修改；重复绑定同一基线不增加快照，但仍先检查无历史Run等资格。
- BR-DEL-M06-03-04：当前状态：合同编辑/取消只检查当前draft/ready/assigned，不检查是否曾执行；失败后重新分派到assigned的返工任务即使有completed历史Run仍可编辑或取消。当前running等状态拒绝。仅基线绑定另有无任何历史Run限制。

#### 状态变化/保留

- 编辑/不同基线绑定 base_snapshot+1；取消→cancelled且base_snapshot+1；相同基线保持版本

#### 数据契约

- 合同字段title、brief、acceptance、validation_seams、scope；基线输入baseline_code及base_snapshot

#### 异常与边界

- 条件：运行中、存在Run的基线重绑、版本过期；处理：返回对应locked/started/mismatch，保存旧合同
- 条件：基线缺需求或固定修订不符；处理：baseline_requirement_missing或baseline_revision_mismatch

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-03-01` | 首次基线绑定推进合同版本，重复绑定同一基线保持版本。 |
| `AC-M06-03-02` | 当前running状态拒绝合同编辑、基线绑定和取消；此断言不扩展为曾执行过即永久不可改。 |
| `AC-M06-03-03` | 曾执行并重新分派到assigned的返工任务可按当前状态编辑/取消，而任何历史Run仍阻止基线绑定。 |

#### 验证计划（本轮全部未执行）

**AC-M06-03-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动项目管理者；assigned任务、无Run，base_snapshot=4；已存在同项目匹配基线B
- 操作：
  1. 绑定B读取版本，再用最新版本重复绑定B
- 观察结果：首次版本5，重复仍5且基线身份不变

**AC-M06-03-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动项目管理者；当前running任务且有active Run；无pending交接；保存合同/基线/状态快照
- 操作：
  1. 分别在独立重置的running种子上尝试改合同、绑定基线、取消
- 观察结果：均拒绝；原合同/基线/状态及快照版本保持

**AC-M06-03-03** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来隔离验收夹具须建设，not_run：管理者O；任务有completed builder/verifier历史Run，验证失败后重新分派已为assigned、快照8、无active Run或pending交接；分别复制独立A/B/C种子且需求基线不变
- 操作：
  1. 种子A：O以base_snapshot8修改标题及非空AC
  2. 重置独立种子B：O以base_snapshot8取消
  3. 重置独立种子C：O以base_snapshot8绑定同项目匹配基线；逐项读取任务、历史Run和审计
- 观察结果：A仍assigned、合同已修改且快照9；B cancelled快照9；C baseline_task_started且快照8/基线不变；所有历史Run及既有证据保留

#### 来源与已有测试定义

- `packages/application/src/task-service.ts:966-1096`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `packages/application/src/task-service.ts:366-379`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `packages/application/src/task-baseline-use-cases.ts:11-61`；SHA-256 `cb7014fb111f34118d49d0393e0bec1c9031f6a4c99f91b6c2ca4b76b8a405ec`

- `packages/application/tests/task-service.test.mjs` · cancel：Owner 可取消未执行任务并记录审计，执行中任务保持锁定 · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M06-04 · 分派与失败任务返工重入

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的分派与失败任务返工重入行为，作为待业务确认的逆向规格。

**角色：** 当前项目管理者及具有写权的被分派人

**触发：** 分派任务

#### 前置条件

- 任务可按状态机进入assigned；当前版本可用
- 无未完成交接

#### 主流程

- 校验管理者与被分派人的当前项目权限
- 用户→团队→项目→任务加锁后重查权限
- draft/failed先经ready门槛，再变为assigned
- 更新指派人、版本及审计

#### 业务规则

- BR-DEL-M06-04-01：资格：actor必须为项目管理者；assignee为可写项目成员，viewer或非成员拒绝。
- BR-DEL-M06-04-02：状态：draft/failed通过ready验收标准门槛后进入assigned；其他状态必须符合邻接状态机。
- BR-DEL-M06-04-03：运行控制：锁定后重查权限；base_snapshot不符或CAS失败拒绝；不创建Run。

#### 状态变化/保留

- →assigned、assignee变更、base_snapshot+1；Run数量保持

#### 数据契约

- 输入task、assignee_principal_code、base_snapshot；HTTP兼容user_code作为指派人后备字段

#### 异常与边界

- 条件：无权限、被分派人不可写；处理：assign_forbidden/assignee_not_member或项目权限拒绝
- 条件：过期版本或未完成交接；处理：保持原指派及状态

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-04-01` | 失败任务经ready门槛重新分派后可进入返工队列。 |
| `AC-M06-04-02` | 普通成员不能分派，viewer不能成为执行者。 |

#### 验证计划（本轮全部未执行）

**AC-M06-04-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动管理者A、写成员B；failed任务含AC且无pending交接，快照7
- 操作：
  1. 将任务分派给B并读取任务和审计
- 观察结果：状态assigned，assignee=B，快照8，新增task.assigned审计而无Run

**AC-M06-04-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；普通写成员A、viewer B；draft任务快照0
- 操作：
  1. 分别以A分派和以管理者分派给B
- 观察结果：均拒绝，任务仍draft且快照0、无Run

#### 来源与已有测试定义

- `packages/application/src/task-service.ts:326-408`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `packages/domain/src/task-state-machine.ts:17-29`；SHA-256 `2d9ff86b7e9eadc41545b53789cf74de0bdd620d26afb7e9c914ea060b88df26`
- `apps/core-api/src/routes/tasks.ts:178-188`；SHA-256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`

- `packages/application/tests/task-service.test.mjs` · assign 成功：assigned + 审计 + 快照推进（ready → assigned 由分派负责） · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M06-05 · 领取任务与独立验证Run

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的领取任务与独立验证Run行为，作为待业务确认的逆向规格。

**角色：** 匹配Profile的任务执行者；submitted任务的verifier

**触发：** 使用全新Run/工作区编码领取

#### 前置条件

- 当前写权限、无未完成交接、无active Run；提供非空工作区路径与git_base
- 普通领取为assigned且本人为Assignee

#### 主流程

- 锁任务并核对版本、身份、Profile及已关闭依赖
- 普通领取推进running并创建互绑Run/工作区
- submitted+verifier走验证领取分支，保留任务状态与版本
- 固定本次Run技能清单，记录领取审计

#### 业务规则

- BR-DEL-M06-05-01：资格：普通领取必须assigned、本人Assignee及Profile一致，所有已解析依赖closed。
- BR-DEL-M06-05-02：例外：submitted状态的verifier领取仍要求写权/版本/无活跃Run，但绕过普通assigned/Assignee/Profile匹配与依赖检查。
- BR-DEL-M06-05-03：运行控制：Run/工作区编码全新且路径与Git基线非空；事务内创建互绑记录，技能授权失败回滚整个领取。
- BR-DEL-M06-05-04：状态：普通领取快照+1；验证领取保持submitted且不增加任务快照。

#### 状态变化/保留

- 普通assigned→running且Run active；验证任务仍submitted且Run profile=verifier

#### 数据契约

- run_code/workspace_code唯一；workspace_path、git_base；Run固定principal/profile/base_snapshot及execution_epoch

#### 异常与边界

- 条件：已有active Run；处理：claim_run_conflict，不创建第二Run
- 条件：依赖未closed、身份/Profile不符或版本过期；处理：拒绝并保留assigned
- 条件：技能交付不可用；处理：事务回滚任务、Run、工作区

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-05-01` | 符合身份、Profile及依赖条件的领取原子生成执行Run。 |
| `AC-M06-05-02` | 验证领取允许其他可写成员取得verifier Run并保持任务已提交状态。 |
| `AC-M06-05-03` | 重复领取不能创建第二个活动Run。 |

#### 验证计划（本轮全部未执行）

**AC-M06-05-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；写成员B为assigned builder任务Assignee；依赖均closed；快照2；有效项目技能清单
- 操作：
  1. 以全新Run/工作区编码builder领取并查询记录
- 观察结果：任务running、快照3；恰一active Run与工作区互绑；技能固定

**AC-M06-05-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；写成员V不是原builder Assignee；submitted任务快照5、无active Run
- 操作：
  1. 以verifier领取且读取任务与Run
- 观察结果：任务仍submitted快照5，新增V的active verifier Run

**AC-M06-05-03** · manual

- 前提/数据/权限：独立场景，执行前重置数据；assigned任务已有active Run；另准备不同Run和工作区编码
- 操作：
  1. 再次领取
- 观察结果：claim_run_conflict，原Run保持，未新增Run/工作区

#### 来源与已有测试定义

- `packages/application/src/task-service.ts:178-231`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `packages/application/src/task-service.ts:415-567`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `packages/application/src/skills-run.ts:18-46`；SHA-256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`
- `packages/persistence/src/schema.ts:990-1033`；SHA-256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`

- `packages/application/tests/project-use-cases.test.mjs` · 全闭环：create → assign → claim(builder) → submit → claim(verifier) → verify → close · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M06-06 · 自测证据与产物提交

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的自测证据与产物提交行为，作为待业务确认的逆向规格。

**角色：** 活动Run本人且仍有项目写权

**触发：** 从running任务提交Artifact及self_test Evidence

#### 前置条件

- 任务running，Run属于任务且active，当前base_snapshot
- 通过执行写栅栏；非legacy代数提供当前设备租约

#### 主流程

- 校验Run身份、状态、版本和执行栅栏
- 要求self_test/pass且非空AC引用全部为任务已知ID
- 逻辑经self_tested再submitted
- 事务保存published产物、证据、两段审计，完成Run

#### 业务规则

- BR-DEL-M06-06-01：资格：Run本人才能提交；租约/权限/交接栅栏均适用。
- BR-DEL-M06-06-02：证据：仅self_test且pass；acceptance_refs至少一条且不能引用未知AC；此入口不强制覆盖全部AC。
- BR-DEL-M06-06-03：状态：一事务内任务running→submitted、快照+1、Run→completed；self_tested保留为两段审计而非单独停留。
- BR-DEL-M06-06-04：边界：服务保存客户端报告的测试结果、命令与产物URI/hash，本身不执行测试或证明产物正确。

#### 状态变化/保留

- running→submitted；Run active→completed；新增published Artifact、self_test Evidence及两段审计

#### 数据契约

- artifact.kind/uri/content_hash；evidence.type/result/acceptance_refs/command/summary；兼容camelCase引用及contentHash字段

#### 异常与边界

- 条件：fail/inconclusive、错误类型、空或未知AC；处理：拒绝且不新增产物/证据
- 条件：身份、版本、租约失效；处理：拒绝原子提交并保留原状态

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-06-01` | 通过自测提交可引用非空已知AC子集并原子保存产物与两段状态审计。 |
| `AC-M06-06-02` | 非通过自测或未知AC引用不产生提交副作用。 |

#### 验证计划（本轮全部未执行）

**AC-M06-06-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；Run本人B具有写权；running任务AC1/AC2、快照3、epoch0；有效产物元数据
- 操作：
  1. 提交pass self_test，仅引用AC1
  2. 读取任务、Run、产物、证据和审计
- 观察结果：任务submitted快照4、Run completed，新增一产物一证据及self_tested/submitted审计；AC2未引用不使该入口拒绝

**AC-M06-06-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立running任务快照3及本人active Run；无其他产物/证据
- 操作：
  1. 提交self_test fail后查询
  2. 重置后提交未知AC引用
- 观察结果：两次均拒绝，任务/Run/版本、产物和证据计数不变

#### 来源与已有测试定义

- `packages/application/src/task-service.ts:811-960`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `apps/core-api/src/routes/tasks.ts:210-248`；SHA-256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`

- `packages/application/tests/task-service.test.mjs` · 全链路：assign → claim → submit 走用例边界，两段审计 + 快照推进（review 阻断 1/重要 1） · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### tsp-req-task-verification · 验证、失败退回与管理关闭

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的验证、失败退回与管理关闭行为，作为待业务确认的逆向规格。

**角色：** active verifier Run本人；关闭由项目管理者

**触发：** 提交verifier_review结果，随后管理者关闭

#### 前置条件

- 验证任务submitted、Run profile=verifier且属于本人/任务
- 关闭任务verified且持当前快照；无未完成交接

#### 主流程

- 验证时校验写栅栏、Run身份/Profile和AC引用
- pass必须覆盖所有AC；fail/inconclusive转failed
- 保存验证证据、完成verifier Run并推进版本
- 管理者独立执行verified→closed

#### 业务规则

- BR-DEL-M06-07-01：资格：builder Run不能验证；验证要求active verifier Run本人；关闭要求当前管理权。实现隔离的是Run Profile，没有检查Verifier与先前Builder必须为不同自然人。
- BR-DEL-M06-07-02：证据：未知引用总是拒绝；pass按去重AC集合全覆盖；fail/inconclusive不要求全覆盖。
- BR-DEL-M06-07-03：状态：pass→verified，fail/inconclusive→failed，均完成验证Run并快照+1；failed可重新分派返工；关闭仅verified且快照匹配。
- BR-DEL-M06-07-04：边界：验证接口保存报告并流转；测试执行记录不自动触发verify/close。

#### 状态变化/保留

- submitted→verified或failed；verifier Run→completed；verified→closed由后续管理操作

#### 数据契约

- evidence固定verifier_review，result为pass/fail/inconclusive；输入task/run/base_snapshot与已知AC ID

#### 异常与边界

- 条件：pass未覆盖全部AC；处理：acceptance_coverage_incomplete，任务仍submitted且Run active
- 条件：非verified关闭或非管理者；处理：拒绝且不关闭

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-07-01` | 验证通过要求全部AC覆盖，且只有管理者能继续关闭。 |
| `AC-M06-07-02` | 不确定的验证结果进入failed返工分支且保留验证证据。 |
| `AC-M06-07-03` | 当前实现按Run Profile隔离，未禁止同一自然人先后担任Builder与Verifier。 |

#### 验证计划（本轮全部未执行）

**AC-M06-07-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；verifier V可写；submitted任务AC1/AC2、快照5与V的active verifier Run
- 操作：
  1. 提交pass仅覆盖AC1读取拒绝
  2. 同一场景随后使用当前快照提交pass覆盖AC1/AC2
  3. 管理者以返回快照关闭
- 观察结果：先保持submitted/active，再verified/Run completed快照6，关闭后closed快照7

**AC-M06-07-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立submitted任务AC1/AC2、快照5；本人verifier Run
- 操作：
  1. 提交inconclusive且空引用
- 观察结果：任务failed快照6、验证Run completed、保存inconclusive证据，供管理者重新分派

**AC-M06-07-03** · manual

- 前提/数据/权限：独立场景，执行前重置数据；可写成员B已完成本任务builder Run；任务submitted、无active Run，AC1/2及当前快照已种子准备；B设备有效
- 操作：
  1. 同一个B领取新的verifier Run
  2. 以该verifier Run提交全AC pass
- 观察结果：源码现状允许B的新verifier Run完成验证；原builder Run不能直接verify；此观察不批准职责分离策略

#### 来源与已有测试定义

- `packages/application/src/project-use-cases.ts:541-769`；SHA-256 `e4f37f3c9959b89aeb81640add6a7d576625c143acb140022c6d7447534386a6`
- `apps/core-api/src/routes/tasks.ts:251-283`；SHA-256 `5cce07aea61349fadff3deebc4f78acd265a580ae4507c5447229e41df3146fa`

- `packages/application/tests/project-use-cases.test.mjs` · 全闭环：create → assign → claim(builder) → submit → claim(verifier) → verify → close · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 是否强制Builder与Verifier为不同自然人需业务负责人决定；代码仅实施Profile/Run分离，本稿不将潜在职责分离缺口批准为业务目标。

### REQ-DEL-M06-08 · 本机领取、外部工作区附着与上下文失败恢复

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的本机领取、外部工作区附着与上下文失败恢复行为，作为待业务确认的逆向规格。

**角色：** 已设备登录的CLI执行者；外部编排器操作者

**触发：** task claim/run/attach

#### 前置条件

- 有可读取项目与任务，源Git仓库HEAD有效
- claim/run目标工作区新建；attach接受已有Git工作区并由调用者隔离文件范围

#### 主流程

- 读取项目首页、需求文档、交接材料与任务合同
- claim创建独立worktree后调用服务领取；attach直接登记已有路径
- 同步Run固定技能并渲染本机任务上下文
- 已服务领取后失败保留工作区与Run，返回恢复所需编码

#### 业务规则

- BR-DEL-M06-08-01：模式：claim与run共享worktree领取实现；attach不创建或改写Git worktree，状态仍经服务领取校验。
- BR-DEL-M06-08-02：运行控制：服务领取之前失败尝试回收本机半成品；服务已成功后上下文/技能写失败返回claim_context_failed并保留已创建Run与工作区。
- BR-DEL-M06-08-03：恢复：返回run_code/workspace_code/workspace_path和原因用于人工检查权限/本地文件；不自动回滚服务器领取。
- BR-DEL-M06-08-04：渲染：attach将project-state置于Run独立目录；生成工作空间guidance为best effort，不阻断已完成任务包。

#### 状态变化/保留

- 服务领取状态由REQ-DEL-M06-05定义；本机新增隔离worktree或附着目录下的Run状态材料

#### 数据契约

- 新Run/工作区编码；任务包包含brief、项目/需求/设计/交接/技能索引路径；workspace_path传给服务并保存于Run工作区记录，不能宣称所有本机路径都不出本机

#### 异常与边界

- 条件：服务器领取拒绝；处理：本机worktree尝试回收；无服务Run
- 条件：领取成功后本地上下文准备失败；处理：claim_context_failed并保留现场

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-08-01` | 本机领取生成可继续执行的上下文及隔离工作区。 |
| `AC-M06-08-02` | 服务器领取后本机上下文失败保留已创建执行现场并暴露恢复身份。 |

#### 验证计划（本轮全部未执行）

**AC-M06-08-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；可写Assignee；assigned builder任务；本机独立Git仓库有HEAD；目标目录不存在；服务正常
- 操作：
  1. 执行task claim并记录返回的Run与工作区
  2. 读取本机brief及技能索引
- 观察结果：独立worktree及上下文生成，服务恰有一Run；结果包含必要材料路径

**AC-M06-08-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；同样独立基线；控制在服务claim成功后令技能同步发生可识别本机冲突
- 操作：
  1. 执行claim
  2. 读取错误details并查服务Run与本机目录
- 观察结果：claim_context_failed含Run/工作区身份；服务Run及本机目录保留，不能当作未领取重试

#### 来源与已有测试定义

- `apps/cli/src/index.ts:478-594`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`
- `apps/cli/src/index.ts:598-683`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 实际Git、文件权限及HTTP故障注入均未执行；本条说明源代码补偿边界。

### REQ-DEL-M06-09 · 设备租约、会话启动幂等与状态写入

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的设备租约、会话启动幂等与状态写入行为，作为待业务确认的逆向规格。

**角色：** Run本人及其未撤销设备

**触发：** 读取执行上下文/会话、领取续租或登记Agent Session

#### 前置条件

- 所有入口要求Run本人、有效归属设备、active用户及当前项目读权
- context/sessions读取不要求Run active或task/Run代数相等；mint/renew/start/state写另要求写权、active及各自租约/代数校验，epoch0兼容按下述规则

#### 主流程

- 锁任务并校验Run本人、设备和当前项目读权限
- 只读context/sessions可返回暂停/历史或代数不匹配Run，不签发执行权
- 写请求另查项目写权、Run状态/代数和有效租约，领取/续租30秒租约
- 按Run、设备、代数、start_key登记会话并更新starting/running状态和诊断输出

#### 业务规则

- BR-DEL-M06-09-01：身份：execution/lease/sessions接口仅接受中间件解析的bearer设备凭据，不接受cookie或body声明的Principal；与handover允许bearer/cookie不同。租约有效期绑定一设备；同设备mint返回相同token，其他设备在有效期内拒绝；过期后撤销旧租约并签发新租约；renew延长30秒不轮换token。
- BR-DEL-M06-09-02：启动：先验当前写栅栏、租约及固定技能授权，再按start_key查重；同key命令/Prompt不同为conflict；同代数已有starting/running会话拒绝新启动。
- BR-DEL-M06-09-03：状态：Session仅同设备与代数可写，终态更新为只读返回；last_error最多4000字符，last_output保留尾部32000字符；会话列表按ID降序。
- BR-DEL-M06-09-04：兼容：业务执行写在task/run epoch均0时免租约，但仍查当前项目写权和pending交接；Session启动另行强制有效租约。

#### 状态变化/保留

- context/sessions只读不改Run、epoch或租约；mint创建或重放租约；续租只延长expires_at；新Session starting；状态→running/finished/failed/cancelled

#### 数据契约

- start_key非空且≤128字符，agent_command非空且≤100000；epoch、lease_token；会话公开诊断不等于可移植完整对话

#### 异常与边界

- 条件：权限/设备撤销；处理：相应读取或写入均按当前权限制止；Run不active或代数不匹配本身不禁止有权读取context/sessions
- 条件：写入遇Run不active、旧代数/过期token；处理：拒绝mint/续租或执行写；不把此限制套到历史读取
- 条件：重复key不同负载/重复活跃会话；处理：conflict且不新增Session

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-09-01` | 同设备租约领取和相同启动请求重试复用身份，不会增加会话。 |
| `AC-M06-09-02` | 有效租约拒绝同用户另一设备，过期交替后旧token不能继续写入。 |
| `AC-M06-09-03` | 暂停或代数不匹配的本人Run仍可读取上下文及会话历史，读取成功不代表取得执行写权。 |

#### 验证计划（本轮全部未执行）

**AC-M06-09-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；active Run本人B、设备D、当前epoch2且可写；冻结服务器时钟至T0，无租约
- 操作：
  1. mint两次比较token
  2. 同key与命令/Prompt启动两次
  3. 读取Session数后用同key换命令
- 观察结果：mint token相同；只一Session且第二次created=false；换命令conflict无新增记录

**AC-M06-09-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立active Run B/epoch2；D1租约有效到T0+30秒，D2亦属于B
- 操作：
  1. 在T0用D2 mint；再把时钟推进至过期后mint
  2. 用旧token续租
- 观察结果：有效期内D2拒绝；过期后D2可领新租约，D1旧token拒绝且旧租约已撤销

**AC-M06-09-03** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来隔离验收种子须建设，not_run：active用户B仍有项目读写权，bearer设备D未撤销，R属于B且suspended、R epoch1/task epoch2，有一条历史Session及工作区；记录原任务/Run/租约计数
- 操作：
  1. D分别读取R execution context与sessions
  2. D尝试mint租约并尝试续租/登记新Session
  3. 重新读取任务、Run及租约/Session计数
- 观察结果：读取成功且显示suspended/epoch1及历史Session；mint因Run不active拒绝，执行写亦拒绝；状态/代数与记录计数不变

#### 来源与已有测试定义

- `packages/application/src/execution-use-cases.ts:14-56`；SHA-256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`
- `packages/application/src/execution-use-cases.ts:63-127`；SHA-256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`
- `packages/application/src/execution-guard.ts:9-54`；SHA-256 `0a7208e9b9f1a3729b53397505a44a2ff0f3920017686f91d7443d6d49df7ec5`
- `apps/core-api/src/routes/execution.ts:6-33`；SHA-256 `cdb3e1867162f1b10638ff450a30aa01f711c573e2a1ef72c73fc8ce4ef104b4`
- `packages/persistence/src/schema.ts:1097-1114`；SHA-256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`

- `apps/agentd/tests/agentd.test.mjs` · 租约mint幂等返回相同token，续租不rotate，过期后允许本人另一设备重新领取 · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M06-10 · 本机Agent托管、停止、同步与租约丢失保护

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的本机Agent托管、停止、同步与租约丢失保护行为，作为待业务确认的逆向规格。

**角色：** 持有Run本人设备凭据的本机操作者

**触发：** agentd start/resume/sessions/sync/stop

#### 前置条件

- 本机存在执行仓库；默认模式有Prompt文件；当前服务Run可执行
- journal与当前API/设备凭据指纹匹配

#### 主流程

- 读取Run执行上下文和租约，服务端幂等登记Session
- 写本地journal再启动隐藏监督进程；默认Codex从stdin接收完整Prompt
- 监督进程定期续租并保存尾部诊断
- 退出/显式停止后写journal并尽力报告；sync补报，resume显式恢复暂停Run

#### 业务规则

- BR-DEL-M06-10-01：启动恢复：相同本机start_key对应存活监督进程直接返回；服务已登记但本机无journal拒绝重复启动；启动失败终止进程并保留失败journal。
- BR-DEL-M06-10-02：监督：轮询间隔夹在250至5000ms；传输不可达仅可使用未到期租约，明确拒绝或到期终止托管进程树。
- BR-DEL-M06-10-03：输出与终态：合并stdout/stderr最后50行且≤32000字符为诊断尾部；正常无错exit0→finished，否则failed；不能声称完整会话转移。
- BR-DEL-M06-10-04：停止/同步：stop仅匹配本人设备指纹的本机journal，恰选session或run；被服务栅栏后仍能本机停止并保留journal；sync传输失败向上报错，其他服务拒绝可保留现场继续。

#### 状态变化/保留

- 本机journal记录完成/错误/exitCode；Session按可报告结果终态；stop不自动恢复源Run或回滚业务

#### 数据契约

- 托管环境含Run/task/workspace/brief/租约/代数；删除TSP_DATABASE_URL传递；默认Prompt不插值到shell参数

#### 异常与边界

- 条件：服务重复登记但journal缺失；处理：session_already_registered，不启动第二进程
- 条件：续租明确拒绝或到期；处理：终止进程，保存失败诊断；服务不能写时保留本机结果
- 条件：暂停Run resume仍有pending交接；处理：服务拒绝，不启动新Agent

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M06-10-01` | 受控进程结束后同步保存会话终态及诊断。 |
| `AC-M06-10-02` | 明确租约丢失后监督器终止本机托管进程并保留诊断。 |

#### 验证计划（本轮全部未执行）

**AC-M06-10-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；本人active Run、有效设备、存在本机仓库与Prompt；使用受控测试命令输出后exit0；新start_key
- 操作：
  1. 启动并等待受控命令退出
  2. 调用sync并读取journal和服务Session
- 观察结果：一个Session最终finished且exit_code=0，journal completed，输出尾部可读；测试是否完成由观测确认

**AC-M06-10-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立托管长运行命令；服务器时钟受控，租约有效；可在服务撤销设备/租约
- 操作：
  1. 启动后明确撤销其租约
  2. 等待实际监督轮询发现拒绝并观察进程树
  3. 读取journal
- 观察结果：托管进程被终止且journal保存Execution lease lost；不宣称远端业务回滚

#### 来源与已有测试定义

- `apps/agentd/src/index.ts:17-108`；SHA-256 `3a13c99cadace468ca30cd740340bb0930a9eb06eb53c358bce451a565936fc3`
- `apps/agentd/src/supervisor.ts:7-83`；SHA-256 `649d870072b6cd0764ad8d3e39907093c493860e8d759647244d13b98e67f703`
- `apps/agentd/src/runtime.ts:17-51`；SHA-256 `8deba2d435aca0ccdf7dd2434b019d076e98a6176e3f5e230b7c4bf578be26b4`

- `apps/agentd/tests/agentd.test.mjs` · 撤销租约后watchdog终止托管Agent，旧设备不能续租或更新Session · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 监督响应的实测延迟、不同OS进程树行为、网络恢复后的补报结果均未验证。

## M07 · 交接恢复与本机工作空间

对应平台父模块：`tsp-module-workspace`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-DEL-M07-01 · 项目工作空间初始化、绑定与识别

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的项目工作空间初始化、绑定与识别行为，作为待业务确认的逆向规格。

**角色：** 本机CLI操作者及具有项目权的登录用户

**触发：** workspace init/project bind/current/workspace guidance

#### 前置条件

- 可写本机目标目录；项目身份由远端权限查询确认
- 项目工作空间根不位于其他Git工作树内部

#### 主流程

- 创建独立Git根（需要时git init）与.agent/work/outbox/code骨架
- 保留原.gitignore并补充本机目录忽略规则
- 绑定项目编码、API地址及可选云工作空间编码
- 从当前目录向上识别最近绑定，按项目材料生成本机guidance

#### 业务规则

- BR-DEL-M07-01-01：资格：工作空间初始化拒绝另一个Git根内部的嵌套目标；已有同根Git可复用。
- BR-DEL-M07-01-02：本机身份：新绑定写project_code；读取兼容旧project_id；去掉API地址尾斜杠；向上查找最近.agent/bound-project.yaml。
- BR-DEL-M07-01-03：边界：代码目录、本机绑定/仓库注册、Run状态与技能包忽略提交；绑定文件不含设备token。

#### 状态变化/保留

- 本机新增/复用工作空间Git及目录、绑定文件；不代表启动任务Run

#### 数据契约

- bound-project.yaml含schema_version、project_code、project_workspace_code、api_url、bound_at；机器路径仅本机

#### 异常与边界

- 条件：嵌套Git根或git init失败；处理：返回明确错误，未形成成功绑定
- 条件：无有效绑定/缺项目或API；处理：project_binding_not_found或required/invalid

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-01-01` | 初始化和向上识别使项目工作空间保持独立本机绑定。 |
| `AC-M07-01-02` | 其他Git根内部不能初始化嵌套项目工作空间。 |

#### 验证计划（本轮全部未执行）

**AC-M07-01-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；可写新目录W且不在任何Git工作树下；已登录可访问项目P
- 操作：
  1. workspace init绑定P
  2. 从W/work下运行project current
  3. 检查Git根、骨架、忽略项与绑定
- 观察结果：识别P与API、骨架存在；本机注册不含token；没有创建任务Run

**AC-M07-01-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；父目录已为Git根，目标为其普通子目录；记录父Git状态
- 操作：
  1. 尝试初始化子目录
- 观察结果：project_workspace_nested_git，父Git配置及原文件不被覆盖

#### 来源与已有测试定义

- `apps/cli/src/project-workspace.ts:23-85`；SHA-256 `aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143`
- `apps/cli/src/project-binding.ts:37-95`；SHA-256 `355a4849a0840b43c797ba0466f462a4a67a14ff55a0c089d505fd1f5ae71871`
- `apps/cli/src/index.ts:1603-1664`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 远端项目工作空间创建/归档权限由治理模块规格覆盖；本模块只定义本机初始化与识别。

### REQ-DEL-M07-02 · 项目仓库附着、克隆与本机状态诊断

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的项目仓库附着、克隆与本机状态诊断行为，作为待业务确认的逆向规格。

**角色：** 已绑定项目工作空间的本机操作者

**触发：** repository list/attach/clone/status

#### 前置条件

- 远端项目仓库记录可读且状态active
- attach目标为独立Git根；clone的path.resolve/path.relative词法目标为code非根子路径且existsSync为false；普通目录隔离场景另需无链接祖先

#### 主流程

- 从最近项目绑定定位工作空间与本机仓库注册表
- 附着时校验Git根、remote存在及规范化remote匹配
- 克隆先检查字符串路径与目标存在性，再mkdir/Git clone；成功后才复用附着校验
- 返回每仓库本机ready/missing/invalid/remote_missing/remote_mismatch/not_checked_out

#### 业务规则

- BR-DEL-M07-02-01：附着：允许外部独立仓库，内部路径写相对路径，外部写绝对本机路径；仅本机注册表替换该repository_code绑定。
- BR-DEL-M07-02-02：克隆：仅以path.resolve/path.relative检查目标字符串在code的非根子路径，已存在目标拒绝；没有realpath或祖先symlink/junction检查，不能承诺物理树限制在code内。Git clone或后置attach失败无统一清理/回滚保证。
- BR-DEL-M07-02-03：诊断：status按远端仓库列表逐项比较本机绑定、根及远端；ready返回HEAD与dirty，缺失信息为null。

#### 状态变化/保留

- 成功仅写本机repositories.local.yaml及克隆目录；不修改云端仓库记录

#### 数据契约

- 本机映射repository_code/path/remote_name；remote等价比较由normalizeRemote执行；status含checkout_status/local_path/git_head/dirty

#### 异常与边界

- 条件：归档仓库/非Git根/remote不符；处理：拒绝附着，不更新绑定；若在clone后附着才失败，不能推断此前Git写入已撤销
- 条件：词法目标越界或已存在；处理：在mkdir/Git clone前拒绝
- 条件：链接祖先、clone失败或clone后的附着失败；处理：链接祖先不在此前字符串边界校验范围；可能先写其他物理树，后置附着校验不能撤回已写内容；保留现场检查

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-02-01` | 匹配的独立本机仓库可附着并输出可诊断状态。 |
| `AC-M07-02-02` | 普通无链接目录场景拒绝词法越界或已有目标；该结果只证明字符串边界与存在性检查。 |
| `AC-M07-02-03` | 带链接祖先的词法内目标必须作为未获物理隔离保证的风险场景记录，不能把后置附着校验视为先前写入回滚。 |

#### 验证计划（本轮全部未执行）

**AC-M07-02-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；绑定工作空间W；active登记仓库R；本机独立Git根G的origin规范化后匹配R
- 操作：
  1. repository attach R到G
  2. 运行repository status
- 观察结果：注册R→G及remote，状态ready并返回HEAD/dirty；云端记录不变

**AC-M07-02-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立重置普通目录W及其code，不含symlink/junction祖先；目标code/new不存在，另有词法位于W/code之外的O及已有目标X；受控本地Git远端可用
- 操作：
  1. 尝试clone到词法外部O
  2. 重置后尝试clone到已存在X
  3. 记录两次未进入Git clone调用且原文件保持
- 观察结果：分别词法越界/已存在拒绝；在此无链接夹具中O/X不被修改；不由此推断有链接祖先时的物理隔离

**AC-M07-02-03** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来受控OS/Git验收夹具尚须建设，not_run：仅临时目录W/O，W/code/link为指向O的symlink或junction；code/link/new词法内且不存在；仅受控本地远端，无用户资料。须先记录OS/Git是否实际遵循链接并支持成功clone；若不支持则保持未运行/阻塞原因，不能宣称验证成功
- 操作：
  1. 核对传给cloneRepository的目标字符串为code/link/new并记录path.relative通过
  2. 在隔离验收中观察mkdir/Git clone调用及实际物理落点、再观察附着校验结果
  3. 若Git成功但后置附着拒绝，检查已写目录是否仍在；保留所有临时现场以供检查
- 观察结果：字符串校验不因祖先链接自行拒绝；实际Git落点及后置失败须记录，不能据后置attach拒绝报告已回滚；此探索检查不提供物理隔离保证

#### 来源与已有测试定义

- `apps/cli/src/project-workspace.ts:98-151`；SHA-256 `aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143`
- `apps/cli/src/project-workspace.ts:155-244`；SHA-256 `aa21097fb30ecfec14a3e77e229735664b7a15a335cd0abe39916303e95e0143`
- `apps/cli/src/index.ts:2626-2707`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- Git认证失败、OS/Git对symlink/junction祖先的实际行为及clone残余内容均未实测；物理目录隔离没有由当前代码建立，未来受控夹具尚待建设。

### REQ-DEL-M07-03 · 独立Run工作区创建、识别与可恢复清理

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的独立Run工作区创建、识别与可恢复清理行为，作为待业务确认的逆向规格。

**角色：** 本机CLI工作区操作者

**触发：** workspace create/identify/cleanup

#### 前置条件

- create要求有效仓库及基线commit且新根不存在
- cleanup要求可解析.agent/workspace.yaml与独立回收目录

#### 主流程

- create生成detached worktree repo及标准骨架和元数据
- identify向上定位工作区元数据
- cleanup默认查询任务：pending交接或该Run active/suspended/preparing即阻止
- 未引用的脏工作区先写binary diff Patch，再整体移入回收区并prune

#### 业务规则

- BR-DEL-M07-03-01：创建：存在目录拒绝覆盖；基线commit不存在拒绝；worktree add失败删除新建半成品根。
- BR-DEL-M07-03-02：清理资格：必须有合法marker；回收区不得为工作区内部子目录；默认远端引用检查失败闭合拒绝，显式force才跳过引用检查。
- BR-DEL-M07-03-03：保留：dirty按git status判断；写git diff --binary不包含全部untracked，但整体rename保留全部原目录；不承诺Patch单独即可恢复所有内容。
- BR-DEL-M07-03-04：运行控制：dry-run只报告动作；真实回收使用时间戳目标路径，同卷rename；prune失败没有额外回滚实现保证。

#### 状态变化/保留

- create本机新工作区；cleanup成功原目录整体移入回收；远端Run状态不修改

#### 数据契约

- workspace.yaml固定project/feature/task/run/workspace/profile/snapshot/git_base；结果decision/actions/patchPath/recycleTarget

#### 异常与边界

- 条件：有效引用或查询失败；处理：不移动工作区
- 条件：非法marker或回收目标内部；处理：拒绝清理
- 条件：跨卷rename/磁盘故障；处理：错误上抛，保留现场核查

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-03-01` | 清理提供预演，并把未提交及未跟踪内容保留在可恢复回收目录。 |
| `AC-M07-03-02` | 暂停/恢复中Run和未完成交接阻止默认工作区清理。 |

#### 验证计划（本轮全部未执行）

**AC-M07-03-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；本机合法marker工作区且远端Run completed，无pending交接；有修改tracked文件和untracked文件；同卷外部回收区
- 操作：
  1. 先dry-run并比较目录快照
  2. 再正常cleanup并读取回收目标
- 观察结果：dry-run无写；真实回收有Patch且原目录被整体移至回收，untracked仍存在，远端Run不变

**AC-M07-03-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；合法工作区远端Run suspended且pending交接；force未设置
- 操作：
  1. 执行cleanup并查看原路径
- 观察结果：blocked_by_reference且文件原位保留；没有Patch或回收移动

#### 来源与已有测试定义

- `packages/integrations/src/git-workspace.ts:44-175`；SHA-256 `326367f85ec4ad647453703b4df18b6137646555fd007da343e2e85efd6ea265`
- `packages/domain/src/workspace-cleanup.ts:7-34`；SHA-256 `5797b8b1bca2dba5bab1143d7e97309fc809704fe64565fff86561b57c87c81b`
- `apps/cli/src/index.ts:1667-1760`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`

- `packages/integrations/tests/git-workspace.test.mjs` · cleanup：未提交变更先 Patch 保护再移入回收区（不变量 7） · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- isReferenced由CLI只检查当前任务Run/交接；未证实域注释提及的发布、事故、人工固定引用全部接入。

### REQ-DEL-M07-04 · 准备交接、源停止确认与冻结草稿

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的准备交接、源停止确认与冻结草稿行为，作为待业务确认的逆向规格。

**角色：** 当前builder执行者及其源设备；目标为另一可写成员

**触发：** prepare后提交stop-ack与draft

#### 前置条件

- bearer/cookie当前设备身份；任务running或self_tested且builder
- 源Run active/builder且本人为Assignee；无未完成交接；当前快照

#### 主流程

- 检查另一目标成员有效可写
- 任务执行代数及快照+1，源Run suspended并撤销租约
- 保存prepare时不可变上下文，签发30分钟准备grant；交接期限24小时
- 源执行者同设备以grant确认停止并保存摘要/仓库manifest草稿

#### 业务规则

- BR-DEL-M07-04-01：资格：仅源执行者+准备设备能更新草稿/停止确认；目标必须另一位active非viewer项目成员。
- BR-DEL-M07-04-02：栅栏：prepare事务立即暂停源Run、撤销租约并推进epoch；不等Git发布才停止服务写。
- BR-DEL-M07-04-03：冻结：draft保存摘要/workspace_manifest时复用prepare时已冻结sources，不跟随新材料；workspace仓库为当前项目active且remote匹配。
- BR-DEL-M07-04-04：停止：明确stopped=true及允许的assurance才写stop_ack，并将源活跃Session标cancelled；客户端停止声明不等于服务已观察全部外部进程停止。
- BR-DEL-M07-04-05：重试：同key、同actor/设备/负载的prepare重放在preparing状态刷新30分钟grant；同key不同请求或设备拒绝。

#### 状态变化/保留

- task epoch+1/base_snapshot+1；source Run active→suspended；handover preparing；draft创建新冻结snapshot引用

#### 数据契约

- task/source_run/target_user/base_snapshot；preparation_grant不入可移植上下文；summary及workspace_manifest受严格schema约束

#### 异常与边界

- 条件：非builder状态/目标无资格/已有交接；处理：拒绝prepare且不暂停Run
- 条件：准备grant过期/撤销或设备不符；处理：停止确认/草稿拒绝，保持源暂停
- 条件：Git或草稿后续失败；处理：保留preparing交接，取消后再显式resume

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-04-01` | 准备交接立即隔离源执行权，同请求重试保留交接身份与冻结来源。 |
| `AC-M07-04-02` | 不合格接收人不能导致源任务暂停。 |

#### 验证计划（本轮全部未执行）

**AC-M07-04-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动builder任务running、快照3、源Run=A且A为Assignee；有效源设备D；目标B可写；无pending；受控时钟T0
- 操作：
  1. 用key K prepare
  2. 在30分钟内以同设备grant停止确认并保存合法仓库草稿
  3. 同key同请求重试prepare
- 观察结果：仅一交接；源Run suspended、任务快照4且epoch+1、租约撤销；draft不刷新原sources；重试刷新grant

**AC-M07-04-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；同样独立基线但目标为viewer或本人；保存Run/任务版本
- 操作：
  1. 尝试prepare
- 观察结果：handover_target_invalid，Run仍active且task版本/epoch不变

#### 来源与已有测试定义

- `packages/application/src/handover-use-cases.ts:52-72`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/handover-use-cases.ts:198-237`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/handover-use-cases.ts:300-365`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `apps/core-api/src/routes/handovers.ts:30-50`；SHA-256 `58e9cbb44cea92eb6974c445dbc9f7a884563fe85ef84174a313882f02f9addb`
- `packages/persistence/drizzle/0024_shared_context_handovers.sql:1-16`；SHA-256 `d9120734eca469b51c35b65a6c0ab497c28b5ea472247d33d78da80cf41021dd`

- `packages/application/tests/handover-use-cases.test.mjs` · handover: prepare fences the legacy source submit path immediately · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M07-05 · 交接发布、固定上下文读取与差异检查

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的交接发布、固定上下文读取与差异检查行为，作为待业务确认的逆向规格。

**角色：** 项目管理者发布；有效设备登录项目成员按可见范围读取

**触发：** publish或查询交接/context/diff

#### 前置条件

- preparing交接含stop_ack和workspace_manifest
- 当前来源版本未漂移或有精确版本批准，目标仍有效可写

#### 主流程

- 发布重查管理权、目标与材料漂移
- 仅改交接为published，不修改冻结正文
- 读交接列表/详情/context时验证设备与项目权限和未发布可见性
- context读取核对canonical SHA256，diff比较冻结版本向量与当前来源

#### 业务规则

- BR-DEL-M07-05-01：发布：管理者才可发布，缺停止确认/代码快照或发生来源漂移拒绝；不是再次采集今日材料。
- BR-DEL-M07-05-02：可见：未发布仅源执行者和管理者可读；已发布对有当前项目访问权的设备用户可读，非只限目标；legacy身份声明不能读取共享上下文。
- BR-DEL-M07-05-03：固定与顺序：上下文包含任务合同、固定需求/基线、活动文档/原型/有效决策及来源向量，canonical载荷最大4MiB；项目列表updated_at DESC、id DESC，任务列表id ASC。
- BR-DEL-M07-05-04：只读：读取不执行过期流转；到期标记在后续命令惰性处理；diff提示source_changed且不改旧快照。

#### 状态变化/保留

- publish preparing→published；读与diff保持所有执行状态及冻结sources

#### 数据契约

- context_snapshot_code/content_hash/manifest/material_revision_vector；diff为排序后的source/before/after及baseline_conflicts

#### 异常与边界

- 条件：上下文hash不匹配；处理：context_hash_mismatch，不返回未验证内容
- 条件：未发布被目标/其他普通成员查询；处理：拒绝/过滤该记录
- 条件：publish发现源漂移；处理：context_source_changed，保持preparing

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-05-01` | 发布改变可见性，后续上游修改仅被diff标识而不会改写固定上下文。 |
| `AC-M07-05-02` | 未处理来源漂移时不能发布交接。 |

#### 验证计划（本轮全部未执行）

**AC-M07-05-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；已准备且停止确认/仓库草稿齐备，材料未变；管理者O、源A、目标B及其他项目成员C均设备登录
- 操作：
  1. 发布前B读取context
  2. O发布；记录hash后修改上游需求
  3. C读取固定context并查询diff
- 观察结果：发布前B拒绝；发布后C可读旧正文/hash不变，diff显示变化；不默默刷新来源

**AC-M07-05-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；preparing交接、source版本已变、未批准；管理者O
- 操作：
  1. publish并查交接及快照
- 观察结果：context_source_changed、仍preparing，旧快照保留

#### 来源与已有测试定义

- `packages/application/src/handover-use-cases.ts:87-181`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/handover-use-cases.ts:207-214`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/handover-use-cases.ts:239-263`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/handover-use-cases.ts:367-377`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/handover-use-cases.ts:472-538`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`

- `packages/application/tests/handover-use-cases.test.mjs` · handover: published context remains byte-for-byte fixed when upstream requirements change · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M07-06 · 目标接收、恢复尝试与客户端就绪回执

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的目标接收、恢复尝试与客户端就绪回执行为，作为待业务确认的逆向规格。

**角色：** 指定目标成员及其恢复设备

**触发：** accept→restore→ready

#### 前置条件

- 已发布未过期交接；当前目标写权与设备有效
- 源代码快照可获取；新独立目标路径，git_base等于snapshot_commit

#### 主流程

- 目标accept发布交接，可重复accepted
- restore按原幂等键建立唯一preparing目标Run、工作区及attempt并绑定目标设备
- 复制源Run固定技能，不采用当前安装头
- 本机恢复后提交准确attempt/commit/context hash和client_reported digest为ready

#### 业务规则

- BR-DEL-M07-06-01：资格：仅目标成员接收/恢复/ready，restore不能换设备或覆写已有尝试；已有target_run需原key继续。
- BR-DEL-M07-06-02：路径：目标非空且不能与服务记录的源workspace.path字符串完全相同；git_base必须准确匹配snapshot_commit；服务不检查目标磁盘真实性，服务登记不代表本机Git已经恢复。
- BR-DEL-M07-06-03：回执：ready匹配目标设备、attempt、context hash、snapshot commit、64位digest且assurance=client_reported；再次查漂移和技能当前授权。
- BR-DEL-M07-06-04：运行控制：accept不启动Run；restore创建preparing Run，ready仍未激活；重复restore原请求/key返回同尝试。

#### 状态变化/保留

- published→accepted→restoring→ready；目标Run保持preparing，源Run保持suspended

#### 数据契约

- workspace_path/git_base；返回target_run_code/workspace_code/attempt_code；ready_receipt为客户端报告，不是服务端文件证明

#### 异常与边界

- 条件：另一设备/不同尝试/错误hash或commit；处理：handover_device_conflict/receipt_invalid，保留原Run
- 条件：材料漂移、技能被撤销；处理：拒绝restore/ready；已有恢复记录不被自动删掉

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-06-01` | 目标接收和就绪不会提前获得运行权，原请求重试复用恢复尝试。 |
| `AC-M07-06-02` | 就绪回执严格绑定设备、恢复尝试和固定快照。 |

#### 验证计划（本轮全部未执行）

**AC-M07-06-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；指定目标B/设备D，published交接未过期，材料/技能授权稳定；独立新目标目录
- 操作：
  1. accept
  2. 以key R restore两次
  3. 本机恢复后提交准确ready回执
- 观察结果：仅一target Run和attempt、Run preparing；ready成功但源仍暂停、任务Assignee不变

**AC-M07-06-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立restoring交接绑定B/D1；B还有D2；准确context与commit已知
- 操作：
  1. D2尝试ready
  2. 重置后D1用错误attempt/hash提交ready
- 观察结果：均receipt_invalid；交接仍restoring，目标Run仍preparing

#### 来源与已有测试定义

- `packages/application/src/handover-use-cases.ts:378-419`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/skills-run.ts:75-83`；SHA-256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`

- `packages/application/tests/handover-use-cases.test.mjs` · handover: ready requires exact attempt, code snapshot and context hash · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M07-07 · 交接激活与原请求重试

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的交接激活与原请求重试行为，作为待业务确认的逆向规格。

**角色：** 指定目标成员及就绪设备

**触发：** activate已ready交接

#### 前置条件

- ready回执与目标设备、attempt、context hash匹配
- 源Run suspended，目标Run preparing；材料及技能当前授权仍有效

#### 主流程

- 事务内重查就绪、漂移和源/目标Run状态
- 源Run transferred，目标Run active
- 任务Assignee转目标、状态running，推进epoch和快照
- 完成交接并签发目标租约；相同请求key重试返回原身份及当前租约

#### 业务规则

- BR-DEL-M07-07-01：激活：请求接受不是执行完成，activate才转交业务写权；source作者身份不改写。
- BR-DEL-M07-07-02：并发：任务锁和事务保护源/目标/任务/交接与receipt，不能产生两个active目标Run。
- BR-DEL-M07-07-03：重试：completed仅接受同设备且原request receipt重放；不再重复推进任务版本；租约可按当前epoch重签。
- BR-DEL-M07-07-04：再检查：ready后发生漂移、设备撤销、成员撤权或技能授权失效均阻止激活。

#### 状态变化/保留

- source suspended→transferred；target preparing→active；task running/assignee/epoch/base_snapshot更新；handover→completed

#### 数据契约

- activate输入attempt_code/context_snapshot_hash及可选version/idempotency-key；返回原Run/workspace身份和lease

#### 异常与边界

- 条件：源/目标Run状态改变或回执缺失；处理：state_conflict/receipt_invalid，保持未激活
- 条件：完成后用新key/其他设备重试；处理：state_conflict，不创建新Run

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-07-01` | 激活原子转移执行权且相同请求重试不重复推进任务。 |
| `AC-M07-07-02` | 就绪以后发生的新漂移仍阻止激活。 |

#### 验证计划（本轮全部未执行）

**AC-M07-07-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；ready交接绑定B/D，源A suspended、目标B preparing，任务快照8、epoch2，材料未变；同key K
- 操作：
  1. activate
  2. 用完全同key同负载重复activate
  3. 读取Run/任务/receipt与审计
- 观察结果：源transferred、目标唯一active，Assignee=B、快照9/epoch3；重试保持9/3并返回同Run及有效lease

**AC-M07-07-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立ready交接；在ready后修改关联项目材料；未批准漂移
- 操作：
  1. activate
- 观察结果：context_source_changed；源suspended、目标preparing、Assignee及epoch/快照保持

#### 来源与已有测试定义

- `packages/application/src/handover-use-cases.ts:421-451`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/handover-use-cases.ts:265-297`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/persistence/src/schema.ts:1059-1094`；SHA-256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`

- `packages/application/tests/handover-use-cases.test.mjs` · handover: concurrent activation never creates two active Runs · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M07-08 · 取消、到期、漂移批准与显式源恢复

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的取消、到期、漂移批准与显式源恢复行为，作为待业务确认的逆向规格。

**角色：** 管理者/源/目标可取消；管理者批准漂移；源本人恢复

**触发：** cancel、写命令触发过期、approve-drift或run resume

#### 前置条件

- 当前项目写权及有效设备；操作符合交接状态
- resume要求源本人仍为Assignee且无未完成交接

#### 主流程

- 取消或惰性到期取消preparing目标Run、关闭准备grant
- 保持源Run暂停，等待明确处理
- 管理者按当前来源向量与理由批准旧材料继续；任务合同变化不可豁免
- 源显式resume后推进epoch/快照并获新租约

#### 业务规则

- BR-DEL-M07-08-01：取消：源/目标或管理者可取消未完成交接；重复cancelled/expired只返回；不自动重启源Run。
- BR-DEL-M07-08-02：到期：published/accepted/restoring/ready在写命令发现24小时时限后持久化expired并返回handover_expired；preparing不由该惰性分支过期，grant仍独立30分钟。
- BR-DEL-M07-08-03：漂移：管理者理由非空且≤4000；只批准当前精确向量；task合同摘要变化永不可豁免；批准清除ready_receipt，ready退restoring，再产生变化再阻止。
- BR-DEL-M07-08-04：恢复：仅源Run本人兼当前Assignee能恢复suspended，必须先终结pending交接；重查固定技能；同key重放active结果不再推进版本。

#### 状态变化/保留

- cancel/expired终结交接；目标preparing→cancelled；显式resume source→active并epoch+1/base_snapshot+1

#### 数据契约

- drift_approval含versions/reason/actor/at；resume receipt绑定actor/设备/请求；停止不是回滚已发布Git提交或其他业务

#### 异常与边界

- 条件：仍有未完成交接请求resume；处理：task_handover_pending，源保持暂停
- 条件：task合同已变仍批准漂移；处理：context_contract_changed，不能豁免
- 条件：到期activation；处理：目标Run取消，源暂停，不伪装完成

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-08-01` | 取消保持源暂停，显式恢复及原请求重试才重获源执行权。 |
| `AC-M07-08-02` | 到期在写命令惰性处理，读取无流转且永不自动恢复源Run。 |
| `AC-M07-08-03` | 漂移批准只覆盖已记录版本，要求重新就绪。 |

#### 验证计划（本轮全部未执行）

**AC-M07-08-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；restoring交接未过期，源A suspended，目标Run preparing；A有效设备且仍Assignee、技能有效
- 操作：
  1. 目标B取消交接
  2. 读取源/目标Run
  3. A以key U显式resume两次
- 观察结果：交接cancelled、目标cancelled、源先仍suspended；resume后active且版本/epoch只推进一次

**AC-M07-08-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；ready交接，冻结时刻T0，expires_at=T0+24h，推进受控服务器时钟超过期限；目标有效设备
- 操作：
  1. 先读取交接状态
  2. 调用activate
- 观察结果：读取不改变ready；activate返回expired并持久化expired/目标cancelled，源仍suspended

**AC-M07-08-03** · manual

- 前提/数据/权限：独立场景，执行前重置数据；ready交接，管理者O；上游需求变化但任务合同未变
- 操作：
  1. O提交明确理由批准当前向量
  2. 查询状态；再改变上游后尝试ready
- 观察结果：批准后restoring且ready回执清除；后续新变化再次阻止ready

#### 来源与已有测试定义

- `packages/application/src/handover-use-cases.ts:265-292`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/handover-use-cases.ts:452-470`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/handover-use-cases.ts:539-562`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`

- `packages/application/tests/handover-use-cases.test.mjs` · handover: cancellation invalidates preparation grant and resume is explicit · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M07-09 · 安全Git交接快照、本机恢复及续接材料

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的安全Git交接快照、本机恢复及续接材料行为，作为待业务确认的逆向规格。

**角色：** 源本机操作者与目标本机操作者

**触发：** CLI handover prepare/restore/activate

#### 前置条件

- 源仓库独立Git根且remote匹配登记仓库
- 源文件须通过分阶段检查：早期预检含NUL/私密路径/LFS/submodule，后续Git diff还可能判为binary；目标有可fetch的匹配remote及新目录

#### 主流程

- prepare先本机预检仓库/summary/选中路径，再服务prepare与停止确认
- 独立Git index建立snapshot tree/commit并推送专用交接ref，保留源HEAD/index
- 目标按ref取回并核验commit/tree，创建detached新worktree和恢复journal
- 校验干净工作树、必要产物、context hash后渲染固定续接包和技能；激活前再次校验

#### 业务规则

- BR-DEL-M07-09-01：分阶段限制：默认过滤私人/凭据/Agent配置路径，显式选择禁用路径拒绝；相对普通文件不得越界或符号链接；早期预检查submodule/LFS及选中现存文件含NUL。无NUL不等于Git判为文本，后续私有index的git diff --numstat仍可返回binary并拒绝。
- BR-DEL-M07-09-02：远端幂等：已有交接ref只有相同tree且相同父提交时可复用，不允许替换已发布快照。
- BR-DEL-M07-09-03：恢复：已存在目录只可匹配相同attempt/commit恢复journal继续；ref移动、tree不符、脏工作区或必要产物hash不符拒绝；Run独立受管技能目录是允许未跟踪例外。
- BR-DEL-M07-09-04：边界：CLI先服务prepare/stop-ack才调用快照发布；之后的Git binary判定失败会留下preparing交接和suspended源Run，该次不执行后续ref发布。需取消再显式resume恢复。Git/服务不跨系统原子；原key/journal保留原请求，ready仅client_reported。

#### 状态变化/保留

- 远端新增acp/handover专用ref；本机新增detached worktree、journal与context/brief；服务状态按交接要求分阶段变更

#### 数据契约

- manifest含repository_code/remote_url/base_commit/snapshot_commit/snapshot_tree/snapshot_ref及required_artifacts；摘要和上下文hash固定

#### 异常与边界

- 条件：在服务prepare之前已发现显式禁路径、含NUL、LFS/submodule或仓库不匹配；处理：早期拒绝，不调用服务prepare或推送；无暂停断言仅限这一时间点
- 条件：prepare及stop-ack之后Git diff --numstat将无NUL变更判为binary；处理：handover_binary_unsupported；保留preparing交接/stop_ack及suspended源Run，该次不发布交接ref；取消交接后须显式resume源Run
- 条件：fetch/ref/hash/journal冲突或恢复后本机修改；处理：保留现场拒绝就绪/启动
- 条件：API接受后本机失败；处理：用原key/journal继续；不能当作新恢复尝试

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-09-01` | 安全文本快照通过专用ref复用并在独立目标工作树恢复。 |
| `AC-M07-09-02` | 明确在prepare前发现的禁用材料不会暂停源Run；恢复后的本机修改也会拒绝本机激活。 |
| `AC-M07-09-03` | 无NUL文件仍可能在prepare之后被Git判为binary而失败，保留已暂停交接现场并要求取消及显式恢复。 |

#### 验证计划（本轮全部未执行）

**AC-M07-09-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；临时受控Git远端及源/目标仓库；安全文本变更，源HEAD/index摘要已记录；合法项目登记；新目标目录
- 操作：
  1. 准备并推送快照
  2. 以相同交接信息重复发布
  3. 目标恢复并核对commit/tree、原源HEAD/index
- 观察结果：同ref复用相同commit；源HEAD/index不变；新worktree准确；续接context/brief可读

**AC-M07-09-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来独立临时种子尚待建设，not_run：A显式选择.env，B选中文件原始字节含NUL，两者均在调用CLI前已存在；另独立C为已完成恢复后改tracked文件；均记录原服务状态/remote refs
- 操作：
  1. A/B分别运行CLI早期预检并观测调用顺序
  2. 重置独立C，在恢复工作树改文件后尝试activate
- 观察结果：仅A/B早期预检拒绝且未调用service prepare/推送；C脏树拒绝本机激活保留现场；不涵盖后续Git binary分类分支

**AC-M07-09-03** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来隔离集成夹具须建设，not_run：有效源builder任务running/源Run active及设备，且源Run有当前未撤销的有效设备租约；目标成员、登记的临时本地Git remote；无旧交接/ref；HEAD内.gitattributes将blob.dat标为-diff，现有blob.dat修改字节不含NUL且非LFS/submodule；人工停止确认仅用于受控空进程场景
- 操作：
  1. 执行CLI handover prepare并按阶段记录早期preflight、service prepare、stop-ack及Git numstat结果
  2. 读取交接/源Run和临时remote refs；不得因命令失败就假定未prepare
  3. 在此顺序场景内取消交接；源本人显式resume后再读执行状态
- 观察结果：早期preflight通过；后续numstat binary拒绝且该次未发布交接ref；交接仍preparing、源suspended、租约已撤销；取消后仍暂停，显式resume才active并新epoch/租约

#### 来源与已有测试定义

- `packages/integrations/src/handover-workspace.ts:18-80`；SHA-256 `fd65dac16eafd549cc0e8e3e4561cd6cd6b054a09223f519bb28c42ccf17ea23`
- `packages/integrations/src/handover-workspace.ts:82-164`；SHA-256 `fd65dac16eafd549cc0e8e3e4561cd6cd6b054a09223f519bb28c42ccf17ea23`
- `apps/cli/src/handover.ts:119-199`；SHA-256 `621c4247a3108de12c95ceb7324cb18265962792a0b4c15a5365ad88080b2c7d`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 未实际推送/fetch或启动Agent；外部Git权限、远端保留期和跨系统失败人工恢复时限未知。
- NUL-free且.gitattributes=-diff的受控集成验收夹具尚待建设；本稿仅按源调用顺序修正保留状态，不声称该场景已运行。

### REQ-DEL-M07-10 · 本机规范指引生成、范围差异与过期检查

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的本机规范指引生成、范围差异与过期检查行为，作为待业务确认的逆向规格。

**角色：** 已绑定项目且可读取项目规范的本机操作者

**触发：** workspace guidance或guidance --check；初始化后best-effort生成

#### 前置条件

- 本机项目绑定可解析；平台有standards系统根
- standards根直接包含至少一份active且正文非空的文档

#### 主流程

- 读取standards根直接文档及详情
- 逐文件临时写入后rename规范快照，清除不在本次集内的旧md快照
- 生成manifest并覆盖工作空间AGENTS.md/CLAUDE.md，向code一级Git仓库分发副本
- check只比较远端当前集合的revision与本机manifest版本并输出up_to_date

#### 业务规则

- BR-DEL-M07-10-01：范围：本机guidance仅取standards根的直接active文档；项目首页/交接collectProjectStandardsDocuments递归包含active后代并按title/code排序，这是当前入口差异，不能把本机指引当作完整递归规范集。
- BR-DEL-M07-10-02：写入：工作空间AGENTS.md与CLAUDE.md为生成文件且直接替换；code一级Git仓库只有AGENTS.md未被Git跟踪时才同时生成两份副本，并补Git exclude；没有通用保留手工修改承诺。
- BR-DEL-M07-10-03：检查：--check不写文件，只对远端当前文档ID比较revision；不计算本机正文hash，也不将manifest多余旧条目单独判为过期；有任一远端版本不符则CLI退出码1。
- BR-DEL-M07-10-04：失败边界：缺root/无直接有效文档/缺正文立即报错；workspace init对guidance错误只返回error仍保留成功绑定；多文件生成是逐文件rename，不承诺跨文件原子。

#### 状态变化/保留

- generate替换规范快照/manifest和生成指引；check保持本机及平台状态；平台文档版本不改变

#### 数据契约

- manifest包含generated_at/project_code/api_url/standards_folder_code，documents[]每项为document_code/title/summary/revision/snapshot；check以entry.document_code建立版本索引并返回document_code/local_revision/remote_revision/stale

#### 异常与边界

- 条件：缺规范根、空直接集合或正文空；处理：standards_folder_missing/standards_empty/standard_content_missing，不能报告指引完备
- 条件：本机manifest缺失或不可解析；处理：check把当前远端文档local_revision视null并报告stale
- 条件：写入中断；处理：可能部分文件已更新，保留现场后重新生成/检查

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M07-10-01` | 本机指引manifest按document_code记录直接规范，过期检查按同一字段和revision匹配。 |
| `AC-M07-10-02` | 过期检查不证明本机正文完整性，代码仓库已跟踪AGENTS文件保留。 |

#### 验证计划（本轮全部未执行）

**AC-M07-10-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立已绑定工作空间；平台standards根直接A r1，active子目录B r1；本机无manifest；API稳定可读
- 操作：
  1. 先guidance --check记录stale和退出码
  2. 运行guidance后读manifest/指引，逐项核对documents[].document_code和revision，不使用code别名
  3. 再次check；另读项目规范递归集合对照
- 观察结果：首次stale/退出1；manifest的documents[0].document_code=A且revision=1，仅含直接A，check按该字段匹配为真；递归集合仍含B，平台不变

**AC-M07-10-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立已生成A r1的工作空间，manifest版本正确但手工改写A本机正文；code仓库已有Git跟踪AGENTS.md
- 操作：
  1. guidance --check
  2. 再运行generate并比较code的已跟踪AGENTS.md
- 观察结果：check仍可能up_to_date，因为不校验正文hash；generate保留code已跟踪AGENTS.md，根生成文件重写

#### 来源与已有测试定义

- `apps/cli/src/guidance.ts:66-107`；SHA-256 `6833e29cbb1ef35482f7d2b60deda922edef985e30a09d30ed42469677d7c1c7`
- `apps/cli/src/guidance.ts:187-317`；SHA-256 `6833e29cbb1ef35482f7d2b60deda922edef985e30a09d30ed42469677d7c1c7`
- `packages/application/src/project-standards.ts:23-44`；SHA-256 `1ee66eacd3dc8e3ab0da07def771985b584f5fd66ed8a0575e810c470b9c99ac`
- `apps/cli/src/index.ts:1633-1663`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 规范根递归差异和check未校验本机正文属于待产品确认风险；本条不是要求批准该缺口。

## M08 · 项目资料与设计资产

对应平台父模块：`tsp-module-documents`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-INT-M08-01 · 按原始权限统一查询项目文档库

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：库展示业务资料原始版本，原始资料变化在关联读取时体现，不复制成第二份可编辑正文。

**角色：** 当前项目有效成员

**触发：** GET 项目 handoff / docs list、search、show

#### 前置条件

- 存在项目及有效成员关系；查询本身不授予写权限。

#### 主流程

- 解析项目访问身份，必要时幂等补齐系统目录。
- 聚合原生文档与需求、架构、测试资料的只读关联条目，返回来源身份、版本和可编辑信息。
- 按关键词筛选，目录按 sort_order/id，文档按标题及代码确定顺序。

#### 业务规则

- BR-INT-M08-01：库展示业务资料原始版本，原始资料变化在关联读取时体现，不复制成第二份可编辑正文。
- BR-INT-M08-01：source_can_edit 是原始入口提示，通用 can_edit 对关联视图保持 false。

#### 状态变化/保留

- 普通读取不增加文档版本；历史项目可能幂等创建缺少的系统目录。

#### 数据契约

- 响应包含 source_kind、current_revision、revisions；搜索标题、摘要及原生正文，不假定所有来源具有相同全文索引。

#### 异常与边界

- 条件：无项目访问权；处理：拒绝读取，不通过关联资料绕过原始领域权限。
- 条件：对关联视图调用通用修订；处理：返回 source_read_only，转原始业务入口。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M08-01-AC01` | 同项目需求文档更新后，库关联条目返回相同原始代码和当前版本且不可通用编辑。 |
| `REQ-INT-M08-01-AC02` | Viewer 可按其项目读取范围查看；无关用户不能借公开代码读取资料。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M08-01-AC01** · automated

- 前提/数据/权限：准备active项目与active账号Member A，A为非Viewer的当前有效项目成员并有当前write权限，持有效普通登录session；原始需求文档D未归档且owner_principal_id=A，所属有效module固定。另建原生DOC作对照。记录D代码、当前revision=r、原始正文及历史数。使用专门可丢弃测试库，从独立基线重建；夹具尚未创建，计划not_run。
- 操作：
  1. 以A的有效普通session通过原始需求文档修订入口，提交非空title/summary/content/change_summary，保留有效module归属，成功得到revision=r+1并记录新正文。
  2. 以A同一有效读取身份查询handoff并按D来源代码读详情，核对source_kind、current_revision、正文及通用can_edit。
  3. 以A调用通用项目文档修订入口，目标为关联来源代码D，提供合法非空字段；随后重读原始需求文档D和历史。
- 观察结果：原始修订成功为r+1；库关联条目仍使用D原始代码并展示当前r+1及新正文，通用can_edit=false。通用修订精确返回project_document_source_read_only；原始D仍为r+1，正文和历史不会因查询或被拒通用修订再改变。

**REQ-INT-M08-01-AC02** · automated

- 前提/数据/权限：分别准备项目 Viewer 与非成员 U，原始资料存在。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 两身份分别调用 handoff 及详情。
- 观察结果：Viewer 按原始领域权限读取；U 拒绝，响应不带正文。

#### 来源与已有测试定义

- `packages/application/src/project-document-use-cases.ts:193-250`；SHA-256 `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`
- `packages/application/src/project-document-use-cases.ts:428-510`；SHA-256 `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`
- `apps/core-api/src/routes/project-documents.ts:25-39`；SHA-256 `3aabba47643c6b67394e44fdae802115bf7a72626856010ec3007e7ada6b38b7`
- `packages/application/src/requirement-document-use-cases.ts:121-123`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/requirement-document-use-cases.ts:384-404`；SHA-256 `075866d541311da9453b5f54540ec89e3302867a05fb426806a0d7a9dcef56ac`
- `packages/application/src/project-document-use-cases.ts:529-538`；SHA-256 `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`

- `packages/application/tests/project-document-use-cases.test.mjs` · 需求文档关联沿用项目权限，文档库写入口不能修改需求原文 · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M08-02 · 保护固定目录并管理普通目录树

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：固定项目资料及项目说明/规范/需求/架构/测试目录依 system_role 标识，不按显示名把普通目录静默收编。

**角色：** 非 Viewer 的目录创建者或项目管理者

**触发：** folder-create / folder-update 及目录 API

#### 前置条件

- 项目可写；管理者包含有效 Owner/Admin，不能仅按错误文字解释为 Owner。

#### 主流程

- 在普通父目录下创建，trim 名称并检查创建时同级重名和保留根名称。
- 更新时检查创建者/管理者、系统目录身份及父链。
- 禁止自指和循环；系统祖先下不新增子目录；保留历史子目录的读取与允许的文档操作。

#### 业务规则

- BR-INT-M08-02：固定项目资料及项目说明/规范/需求/架构/测试目录依 system_role 标识，不按显示名把普通目录静默收编。
- BR-INT-M08-02：普通目录创建检查同级大小写无关重名；更新路径未见同等重名复查，不能承诺所有重命名唯一。

#### 状态变化/保留

- 允许更新改变普通目录父节点、名称、顺序/状态；拒绝不改变树。

#### 数据契约

- 目录 code、parent_code、system_role、sort_order；没有候选批准或项目冻结动作。

#### 异常与边界

- 条件：系统目录更名、移动或归档；处理：拒绝；同名历史普通根目录保留独立身份。
- 条件：移动到自身/后代或系统目录下；处理：拒绝，原树不变。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M08-02-AC01` | 普通目录不能移到后代，固定系统目录不能更名。 |
| `REQ-INT-M08-02-AC02` | 系统目录补齐不吞并同名普通内容。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M08-02-AC01** · automated

- 前提/数据/权限：准备 active 项目管理者与普通 A→B 目录树及系统规范目录 S。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. PATCH A 的父目录为 B。
  2. 在独立基线 PATCH S 名称。
- 观察结果：两个请求均拒绝；A/B父链与S身份名称保持原值。

**REQ-INT-M08-02-AC02** · automated

- 前提/数据/权限：准备缺少 system_role 的旧项目，以及普通“项目资料”根目录和一篇文档。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 以有效成员读取库两次。
  2. 比较目录代码、文档父目录和系统角色数量。
- 观察结果：系统目录幂等存在；原普通目录及文档保留独立代码和归属。

#### 来源与已有测试定义

- `packages/application/src/project-document-use-cases.ts:252-355`；SHA-256 `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`
- `packages/application/src/project-document-folders.ts:1-77`；SHA-256 `c50e6f6a5c975a8ef69e9f9bbb981177d8ff038d46f3fc54a778b92c5be5974b`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 目录更新的同级重名约束与创建不同，是否应统一需业务确认。

### REQ-INT-M08-03 · 创建、批量上传与修订原生文档并保留历史

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：单篇创建/修订各自保留历史；CLI目录上传先规划再逐请求创建目录和文档，后项失败保留先前成功，不提供整批原子性或自动续传。

**角色：** 创建/上传：当前非Viewer可写成员；修订：当前仍可写的原作者或项目管理者

**触发：** docs create/upload/revise；原生文档 POST/PATCH

#### 前置条件

- 项目 active 且当前 write 授权有效；普通目录或允许写的 standards/overview 系统祖先。

#### 主流程

- CLI upload先在本地规划：根路径用lstat拒绝符号链接；单文件仅接受大小写不敏感的.md/.markdown/.txt；目录按zh-CN名称排序递归，跳过嵌套符号链接、所有点开头目录及.git/.agent/.omx/node_modules/dist/build/coverage目录，只收集支持后缀的普通文件。目录不因无可上传文档而自动剔除。
- 每篇默认取首个一级Markdown标题，无则取无扩展名文件名；摘要取首个非空且不以#或```开头的trim行，移除首个列表/引用标记后截160字符。auto类型先按路径识别api，再按路径/mermaid围栏识别diagram，其余doc。显式--kind覆盖各篇；--name只覆盖云端根目录名，--title/--summary只覆盖单文件。
- 目录模式先在--folder或根下创建云端根目录，再按本地规划顺序逐请求创建所有子目录，记录父目录code映射；随后逐篇读取文件内容并创建文档。单文件直接在--folder或根创建，不创建包装目录。所有成功完成才输出创建数量及代码/相对路径清单。
- 每个服务端创建归一化标题、正文、摘要及用途，保存Revision1、历史和审计；CLI串行的多个请求不是一个事务。
- 修订在项目围栏和文档行锁中重验写权，提供base_revision时比较当前版本；以锁定当前版本+1追加不可变正文历史、更新当前头并同事务记录修订审计。

#### 业务规则

- BR-INT-M08-03：标题、正文及修订说明不能为空；CRLF 归一为 LF。
- BR-INT-M08-03：普通修订允许可选 base_revision；客户端只有实际发送它才获得旧版本冲突保护。
- BR-INT-M08-03：CLI upload是本地规划加多次独立创建，先目录后文档；只对每个成功的服务端创建分别保存Revision1/历史/审计，不承诺整批全有全无。
- BR-INT-M08-03：根链接拒绝，嵌套链接和隐藏/忽略目录跳过；只接收.md/.markdown/.txt普通文件。auto优先api再diagram再doc，显式kind可覆盖，title/summary覆盖限单文件。
- BR-INT-M08-03：失败后的恢复需先查询远端已创建对象并核对内容/代码，再对缺失文件选择已有父目录单独上传；盲目重跑目录不是resume，可能遇同级目录重名或制造重复文档。该操作建议不是已实现自动恢复能力。

#### 状态变化/保留

- 创建 revision=1；成功修订revision+1；可显式移动目录/变更用途及状态，省略字段沿用当前。
- CLI后项失败时，之前已成功创建的目录/文档继续存在，当前失败项是否有远端副作用取决于失败发生位置；本地错误不是远端整批事务回滚。

#### 数据契约

- DOC/API/DIAGRAM输出保留legacy_kind旧用途；原生正文应用层未见统一字节上限，HTTP POST/PATCH明确8MiB请求体override；未override路由才沿用server默认1MiB。
- 成功上传返回folders_created/documents_created及folders/documents代码、relative_path列表；失败分支仅failResult，不保证提供已经完成的对象清单。规划与实际上传正文为两次读取，本地期间变化未见内容hash锁定。

#### 异常与边界

- 条件：显式 base_revision 无效或过期；处理：拒绝，不覆盖新正文。
- 条件：省略 base_revision；处理：按锁定当前头递增，并不提供基于旧正文的乐观并发保护。
- 条件：非作者普通 Member、Viewer或只读系统领域；处理：拒绝写；文档详情可按原始读权查看。
- 条件：根符号链接、不支持的单文件后缀、无效显式kind或本地规划读取失败；处理：在远端创建循环前报错并非零退出；嵌套链接与不支持的目录内文件则被跳过。此结论只适用于这些规划前错误，不扩展为所有上传错误无副作用。
- 条件：先前目录/文档已创建后，后续请求、响应缺code或再次读取本地正文失败；处理：catch输出失败并非零退出，停止后续创建；没有回滚先前成功对象，也不输出成功分支的完整批次清单。客户端未提供幂等key、覆盖、去重或自动断点续传。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M08-03-AC01` | 旧 base_revision 修订不覆盖较新正文且不增加历史。 |
| `REQ-INT-M08-03-AC02` | 省略 base_revision 使用当前锁定版本追加。 |
| `REQ-INT-M08-03-AC03` | 目录上传保留层级，过滤非支持文件/隐藏忽略目录和嵌套链接，并先建目录再逐篇创建。 |
| `REQ-INT-M08-03-AC04` | 目录上传的确定性后项失败保留先前成功；查询后只补缺失文件，不能把全量重跑视为续传。 |
| `REQ-INT-M08-03-AC05` | 单文件可覆盖标题/摘要/类型且不新建目录；规划前根链接或不支持后缀拒绝不发送创建请求。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M08-03-AC01** · automated

- 前提/数据/权限：准备作者A、active项目、原生D revision=2，完整记录D正文、历史和审计数。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 发送含 base_revision=1 的非空修订。
  2. 重读D和历史。
- 观察结果：返回 revision_conflict；D仍为2，正文历史及修订审计不变。

**REQ-INT-M08-03-AC02** · automated

- 前提/数据/权限：准备作者A与D revision=2，正文为v2；本案例不并发运行。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 发送不含base_revision的合法修订v3。
  2. 读取当前与历史revision1/2/3。
- 观察结果：当前版本为3；旧revision保留，新增一条对应修订审计。

**REQ-INT-M08-03-AC03** · automated

- 前提/数据/权限：准备可写非Viewer A的有效普通session与active项目、可写普通父目录P；本地R含根readme.md、sub/api.txt、sub/nested/flow.markdown（含mermaid围栏），以及.bin、.hidden/skip.md、node_modules/skip.md与嵌套符号链接。夹具环境需实际支持符号链接，不能静默把链接断言当已覆盖；所有有效正文非空、标题与云端根名无冲突。 专用可丢弃夹具尚未建设，计划not_run；各变体从独立基线重建，不复用其他计划残留数据。
- 操作：
  1. 执行docs upload R --folder P --name 上传根；记录API调用顺序和最终返回。
  2. 查询新根、sub/nested层级及3份文档，比较类型、正文、relative_path与父code；核对跳过对象。
- 观察结果：先创建上传根/sub/nested三目录，再创建三文档；readme为doc、api.txt为api、flow为diagram，均Revision1且各有历史/创建审计。二进制、隐藏/忽略目录内容和嵌套链接不被上传；成功输出3目录/3文档及对应路径与代码。

**REQ-INT-M08-03-AC04** · automated

- 前提/数据/权限：独立active项目与可写A/session，空普通父目录P；本地R仅含两非空普通文件a.md、b.md，排序确定a先于b，名称均合法。未来专用CLI/API代理在b的POST发出前注入确定性失败，a真实请求已收到成功，且无网络不确定提交；该故障hook尚未建设。 专用可丢弃夹具尚未建设，计划not_run；各变体从独立基线重建，不复用其他计划残留数据。
- 操作：
  1. 执行docs upload R --folder P；代理让根目录及a创建成功，再在b请求发出前返回指定失败。
  2. 核对非零退出、失败结果、无后续请求；从API查询云端根、a、b和历史/审计。
  3. 记录已确认的云端根code，取消故障后仅执行docs upload b.md --folder 已有根code；再查询a/b。
- 观察结果：第一次失败仍保留根与a及各自成功记录，b未发送所以不存在；客户端没有自动删除先前成功或输出成功清单。确认远端状态后单文件补传b成功，a不重复。此计划不证明超时后的自动重试安全，也不执行盲目全量重跑。

**REQ-INT-M08-03-AC05** · automated

- 前提/数据/权限：独立active项目、可写A/session、空普通目录P；公开非空source.md含一级标题和摘要。另设不支持扩展名source.mmd以及指向该md的根符号链接，夹具需明确系统链接权限。API请求记录器在调用前就位。 专用可丢弃夹具尚未建设，计划not_run；各变体从独立基线重建，不复用其他计划残留数据。
- 操作：
  1. 执行docs upload source.md --folder P --kind api --title 自定标题 --summary 自定摘要，读取结果与请求。
  2. 独立基线分别上传source.mmd及根符号链接，记录错误和远端创建请求数。
- 观察结果：合法单文件只创建1篇、不新建包装目录，类型api且标题/摘要按指定值；不支持后缀与根链接各自报错非零退出且没有创建请求。Mermaid/draw.io/图片原图源不能据此当原生正文上传，使用architecture入口另行处理。

#### 来源与已有测试定义

- `packages/application/src/project-document-use-cases.ts:357-417`；SHA-256 `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`
- `packages/application/src/project-document-use-cases.ts:517-600`；SHA-256 `bde1782a984e71724f173d5468b0f0c4cb5de9e4e36e5c7bdfd4e34baa749317`
- `packages/application/src/project-document-kinds.ts:1-13`；SHA-256 `4f79035e0f983c427502bca96e47455410b74ff198e6c6271833dd0b3b296421`
- `apps/core-api/src/routes/project-documents.ts:70-112`；SHA-256 `3aabba47643c6b67394e44fdae802115bf7a72626856010ec3007e7ada6b38b7`
- `apps/core-api/src/server.ts:65-70`；SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/cli/src/handoff-upload.ts:29-74`；SHA-256 `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`
- `apps/cli/src/handoff-upload.ts:84-122`；SHA-256 `1cb22422f606bde814a49783cad1d67db0a473f61a5b93cdd9073ef62ca5df0f`
- `apps/cli/src/index.ts:2089-2113`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`
- `apps/cli/src/index.ts:2115-2181`；SHA-256 `ad4efa3eb1e4ac9c9c1158232d069ce721acce671359aa98e4c2354ef182268b`

- `packages/application/tests/project-document-use-cases.test.mjs` · same-project document revisions retain optimistic conflicts under the scoped fence · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。
- `apps/cli/tests/handoff-upload.test.mjs` · 交接上传计划递归保留文件夹结构并只收集文档文件 · `defined`；已静态读取现有定义，本轮未执行；不等同新上传验收计划已覆盖或通过。
- `apps/cli/tests/handoff-upload.test.mjs` · 单文件上传从一级标题生成标题并自动识别类型 · `defined`；已静态读取现有定义，本轮未执行；不等同新上传验收计划已覆盖或通过。
- `apps/cli/tests/handoff-upload.test.mjs` · 上传按内容类型归类，原部署运维用途不再作为文档类型 · `defined`；已静态读取现有定义，本轮未执行；不等同新上传验收计划已覆盖或通过。
- `apps/cli/tests/handoff-upload.test.mjs` · 原始图源引导使用架构命令，不当作 Markdown 丢失格式 · `defined`；已静态读取现有定义，本轮未执行；不等同新上传验收计划已覆盖或通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- CLI目录上传没有整批事务、幂等/去重/自动续传或本地内容快照；发生超时等不确定结果时须查询远端确认，不把手动补传建议当成安全自动重试保证。链接筛选依据扫描时Dirent/lstat，未证明覆盖并发文件替换或全部文件系统边界。

### REQ-INT-M08-04 · 对可读取资料的明确版本生成质量报告

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：质量报告是规则检查结果，不等同业务通过或文档自动修改。

**角色：** 可读取目标资料的用户

**触发：** GET /handoff-documents/:code/quality

#### 前置条件

- 目标及指定版本可访问；purpose 属于支持集合。

#### 主流程

- 以 readOnly 文档读取避免目录补齐副作用。
- 解析明确 revision 或当前头，验证匹配修订唯一。
- 按来源提取可检查文本，返回报告与原始版本身份，需求来源可附当前审阅事实。

#### 业务规则

- BR-INT-M08-04：质量报告是规则检查结果，不等同业务通过或文档自动修改。
- BR-INT-M08-04：指定版本必须为正整数；报告依据准确来源版本，不隐式写新修订。

#### 状态变化/保留

- 仅生成报告，无文档业务状态变化。

#### 数据契约

- document_code、revision、content_sha256、purpose 与检查结果；实际 route 默认1MiB适用于请求体，GET不传文档正文。

#### 异常与边界

- 条件：版本不存在/重复或无正文；处理：返回明确 unavailable/not_found，不以当前正文冒充指定历史。
- 条件：历史需求版本、非 Markdown 测试附件等来源受限；处理：在报告保留无法检查的说明；不伪造源文本。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M08-04-AC01` | 合法指定历史原生版本得到该版本摘要而不是当前文本摘要。 |
| `REQ-INT-M08-04-AC02` | 请求不存在的版本返回失败且不退回最新。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M08-04-AC01** · automated

- 前提/数据/权限：准备D revision1和2内容不同，当前用户可读；本地计算两个正文摘要。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. GET quality?revision=1。
  2. 检查report版本、摘要与源身份。
- 观察结果：报告指向1且摘要匹配v1；D当前2及全部历史不变。

**REQ-INT-M08-04-AC02** · automated

- 前提/数据/权限：准备D只有1、2版本，用户可读。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. GET quality?revision=99。
- 观察结果：返回not_found/unavailable；无revision2的替代报告、无写入。

#### 来源与已有测试定义

- `apps/core-api/src/routes/document-quality.ts:40-150`；SHA-256 `639c56c926264bae76559379fc81e16d28298b2d913e99672ca2aa1ec6b64080`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M08-05 · 保存多格式架构图并强制版本冲突检查

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：可写成员可创建架构；修订额外要求负责人/管理者及CAS，XML仅浅层筛查。

**角色：** 创建：当前有项目write权限的成员；修订：仍有write权限的架构负责人或有效项目管理者

**触发：** architecture list/show/create/revise；架构资料 API

#### 前置条件

- 读取需当前有效项目读权；创建需active项目与当前write权限，不另要求Owner/管理者；修订还需当前负责人或isProjectManager(Owner/Admin)。

#### 主流程

- 接受 mermaid/drawio/image 图源、说明和可选SVG预览，创建Revision1。
- 列出或读取当前图源和版本历史；按更新时间与ID倒序提供索引。
- 修订必须提交正整数 base_revision，锁定当前版本一致才追加新版本和审计。

#### 业务规则

- BR-INT-M08-05：创建对当前可写成员开放；修订须当前write加负责人/管理者资格，并始终显式base_revision CAS。
- BR-INT-M08-05：draw.io仅筛查mxfile/mxGraphModel根、尾部闭合或自闭合及无DOCTYPE/ENTITY；SVG预览同样为根/尾标签浅层筛查，不证明完整XML良构、渲染正确或安全。
- BR-INT-M08-05：image仅接受实现所检PNG/JPEG/WebP Base64与字节特征；图源6MiB、预览2MiB，HTTP POST/PATCH整体24MiB。

#### 状态变化/保留

- 新增不可变架构revision并推进current_revision；图源改变时未提供的旧预览失效。

#### 数据契约

- content_kind、source_content、notes_markdown、preview_svg、base_revision；24MiB路由override覆盖默认1MiB，但仍须通过字段上限。

#### 异常与边界

- 条件：旧 base_revision；处理：拒绝，原图和历史不变。
- 条件：图源超6MiB、含NUL、不符合XML根/尾标签与DOCTYPE/ENTITY筛查、图片字节格式不符或预览超2MiB；处理：拒绝对应字段；图源变化且不传新预览时清空旧预览。XML筛查不是完整良构解析。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M08-05-AC01` | 旧架构版本不能覆盖当前图源。 |
| `REQ-INT-M08-05-AC02` | 图源变化而未传preview时删除过时预览。 |
| `REQ-INT-M08-05-AC03` | 普通可写Member可创建架构，但不能据成员身份修订他人的架构。 |
| `REQ-INT-M08-05-AC04` | XML筛查拒绝明确禁用声明，但不能保证拒绝所有畸形XML。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M08-05-AC01** · automated

- 前提/数据/权限：准备负责人、active项目与架构D current_revision=2。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. PATCH D base_revision=1并提交合法Mermaid。
  2. 读D及历史。
- 观察结果：冲突；current仍2，旧图源和历史不变。

**REQ-INT-M08-05-AC02** · automated

- 前提/数据/权限：准备D revision1含合法预览SVG，使用当前base_revision。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. PATCH新Mermaid图源，省略preview_svg。
- 观察结果：revision2源为新值、preview为null；revision1保留原预览。

**REQ-INT-M08-05-AC03** · automated

- 前提/数据/权限：准备active项目、普通Member M/N和Owner O；M/N均有write，N拥有既有架构D。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 以M提交合法Mermaid创建，读取新架构Revision1。
  2. 以M修订N的D，使用D当前base_revision。
  3. 独立基线以O修订D，使用当前base_revision。
- 观察结果：M创建成功且成为新架构负责人；M修订N的D被拒，D不变；O管理者修订允许并增加一版本。

**REQ-INT-M08-05-AC04** · automated

- 前提/数据/权限：建立normalizeArchitectureContent纯函数夹具，提供满足字节预算的draw.io输入；不启动数据库或渲染器。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 独立输入带DOCTYPE或ENTITY声明、其余根标签符合的XML。
  2. 独立输入&lt;mxfile&gt;&lt;foo&gt;&lt;/mxfile&gt;，检查normalize结果。
- 观察结果：声明匹配禁用筛查的输入被拒；静态实现预期第二输入可归一化通过，不能据此声称它是良构XML或渲染安全。本计划未执行。

#### 来源与已有测试定义

- `packages/application/src/architecture-document-use-cases.ts:1-169`；SHA-256 `07211e0c59702a4175956859a85b3aca248e72f2b1207cefbe5b786362db3592`
- `packages/application/src/architecture-document-content.ts:17-77`；SHA-256 `4a54f2d7c937010cdfe7b501e9ad22e3bdf8c580de41aa33ce1b88138f1b7cb7`
- `apps/core-api/src/routes/architecture-documents.ts:29-61`；SHA-256 `b0f0f242be538b736062a0bbee54d176696dfab62c584b4f79c5eb0a370f1ec7`
- `apps/cli/src/architecture.ts:59-129`；SHA-256 `cfc4b616096a64947e4d0d1271271d5505aca92e0cd6d75b31173c238cf869a8`
- `packages/application/src/architecture-document-use-cases.ts:103-129`；SHA-256 `07211e0c59702a4175956859a85b3aca248e72f2b1207cefbe5b786362db3592`
- `packages/application/src/architecture-document-content.ts:25-33`；SHA-256 `4a54f2d7c937010cdfe7b501e9ad22e3bdf8c580de41aa33ce1b88138f1b7cb7`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 本轮未实际发起临近24MiB的HTTP请求；字段预算与反向代理额外限制需部署实测。
- XML没有完整良构解析：例如&lt;mxfile&gt;&lt;foo&gt;&lt;/mxfile&gt;可通过当前根/尾标签筛查；这是静态路径推导，未运行渲染或安全测试。完整解析/渲染安全属于未验证缺口，不新增实现承诺。

### REQ-INT-M08-06 · 创建与查看多形式设计原型

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：html/image正文长度最多6MiB字符；附件最多20MiB解码字节、规范Base64，保存大小和SHA-256。

**角色：** 可写项目成员；读取者为项目有效成员

**触发：** design list/show/create 与原型API

#### 前置条件

- 项目active时写；标题非空，输入类型合法。

#### 主流程

- 根据显式content_kind或兼容HTML标记解析 html/image/url/file。
- 解析同项目需求关联并检查父级一致性。
- 创建当前头、初始修订及审计，详情返回历史和元数据但不夹带附件字节。

#### 业务规则

- BR-INT-M08-06：html/image正文长度最多6MiB字符；附件最多20MiB解码字节、规范Base64，保存大小和SHA-256。
- BR-INT-M08-06：URL仅HTTP/HTTPS且无用户名密码；file名称不能含路径、Windows保留名等危险字符。

#### 状态变化/保留

- 创建draft或ready及revision1；失败不创建原型。

#### 数据契约

- 原型POST/PATCH路由预算30MiB；详情与任务投影剔除file_content_base64；image种类正文仍以HTML承载，不能称为与架构图相同的位图验证。

#### 异常与边界

- 条件：跨项目需求或不一致父关系；处理：拒绝整次创建。
- 条件：不安全URL、无效Base64、危险文件名、超限文件；处理：拒绝；创建不允许archived初始状态。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M08-06-AC01` | 合法附件创建后详情只有元数据，下载入口才提供字节。 |
| `REQ-INT-M08-06-AC02` | 跨项目需求绑定与含凭据URL均不能创建。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M08-06-AC01** · automated

- 前提/数据/权限：准备可写成员、active项目、已知SHA的小附件与安全文件名。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 创建file原型。
  2. GET详情并比较file元数据与原字节摘要。
- 观察结果：revision1且大小/摘要正确；详情无附件Base64，未暴露本机路径。

**REQ-INT-M08-06-AC02** · automated

- 前提/数据/权限：准备项目P成员、P外需求R；分别独立重建基线。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 提交R作为关联创建。
  2. 独立案例用URL对象构造含非空username/password的测试链接，再提交。
- 观察结果：两项均拒绝；P无新增原型或孤儿修订。

#### 来源与已有测试定义

- `packages/application/src/design-prototype-use-cases.ts:38-215`；SHA-256 `8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c`
- `packages/application/src/design-prototype-content.ts:28-109`；SHA-256 `c9e4c42338cfe3402d9fddc080d917fe06817cb3809906677cc23061aca2a2d1`
- `apps/core-api/src/routes/design-prototypes.ts:33-65`；SHA-256 `26432ff9927e5f5fc20ab8b8ee25eedf377e402aedee2fb266e33e4cc3a22b7f`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M08-07 · 修订原型、替换关联并保留版本

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：省略notes可保留原说明，但省略requirement_codes会清空全部需求关联。

**角色：** 原型负责人或有效项目管理者

**触发：** design revise / PATCH prototype

#### 前置条件

- 当前write授权有效且原型未archived；标题与change_summary非空。

#### 主流程

- 读取当前修订并归一化新内容，省略内容字段时保留兼容当前内容。
- 解析 requirement_codes；未传时按空数组处理。
- 追加下一版本，整体替换关联，更新状态及头，记录审计。

#### 业务规则

- BR-INT-M08-07：省略notes可保留原说明，但省略requirement_codes会清空全部需求关联。
- BR-INT-M08-07：当前修订没有与架构一致的显式乐观锁契约，不能将所有版本资产描述成同一种并发语义。

#### 状态变化/保留

- 成功current_revision+1；关联集替换；可转archived后禁止继续修订。

#### 数据契约

- title、summary、change_summary、status及完整requirement_codes；没有base_revision字段。

#### 异常与边界

- 条件：已归档或无写权；处理：拒绝。
- 条件：并发修订；处理：此路径没有base_revision或锁头CAS，不保证旧客户端的覆盖冲突被友好检测。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M08-07-AC01` | 省略关联字段会清空已有绑定，旧修订仍可读。 |
| `REQ-INT-M08-07-AC02` | 归档原型不能再修订。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M08-07-AC01** · automated

- 前提/数据/权限：准备负责人及原型D revision1已关联同项目需求R。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. PATCH合法新标题/修订说明但不传requirement_codes。
  2. 读取D关联与历史。
- 观察结果：当前revision2关联为空；revision1正文历史仍存在，审计包含修订事件。

**REQ-INT-M08-07-AC02** · automated

- 前提/数据/权限：准备D status=archived、合法负责人。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 发送合法PATCH。
- 观察结果：失败；版本、正文及关联保持基线。

#### 来源与已有测试定义

- `packages/application/src/design-prototype-use-cases.ts:321-405`；SHA-256 `8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c`
- `apps/core-api/src/routes/design-prototypes.ts:84-101`；SHA-256 `26432ff9927e5f5fc20ab8b8ee25eedf377e402aedee2fb266e33e4cc3a22b7f`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 原型并发修订的冲突体验及遗漏关联是否应保留，需要业务确认；本候选忠实记录当前行为。

### REQ-INT-M08-08 · 按权限下载明确版本的原型附件

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：下载响应固定application/octet-stream、attachment、nosniff、private/no-store。

**角色：** 可读取原型的当前用户

**触发：** design download / GET prototype file?revision

#### 前置条件

- 目标版本存在且为file内容；按原型所属项目读取鉴权。

#### 主流程

- 指定revision则读取该历史；省略取当前。
- 返回附件字节并使用安全下载头，不把声明MIME直接作为可执行内联正文。

#### 业务规则

- BR-INT-M08-08：下载响应固定application/octet-stream、attachment、nosniff、private/no-store。

#### 状态变化/保留

- 无业务状态或版本变化。

#### 数据契约

- 路径code、可选revision；Content-Disposition以编码文件名提供，不公开磁盘路径。

#### 异常与边界

- 条件：版本不是正整数、不存在或非file；处理：返回业务错误，无其他版本替代。
- 条件：无身份/无项目访问；处理：拒绝，不发送字节。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M08-08-AC01` | 历史附件下载保持原字节与安全头。 |
| `REQ-INT-M08-08-AC02` | 无关用户不能凭附件代码下载。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M08-08-AC01** · automated

- 前提/数据/权限：准备同一原型的file revision1与不同revision2，记录两份字节；用户可读。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. GET file?revision=1，读取响应头和摘要。
- 观察结果：字节匹配v1；octet-stream、attachment、nosniff、private/no-store齐全；当前版本不变。

**REQ-INT-M08-08-AC02** · automated

- 前提/数据/权限：准备非项目用户U和file原型D。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. U调用file下载。
- 观察结果：拒绝且无附件字节。

#### 来源与已有测试定义

- `apps/core-api/src/routes/design-prototypes.ts:67-82`；SHA-256 `26432ff9927e5f5fc20ab8b8ee25eedf377e402aedee2fb266e33e4cc3a22b7f`
- `packages/application/src/design-prototype-use-cases.ts:408-435`；SHA-256 `8762d0cd6516ae4d6ffe1cb69aa51a5b3d124b5c249c64435cd10ce0757ce43c`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

## M09 · 测试与缺陷

对应平台父模块：`DEL-M09`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-DEL-M09-01 · 测试用例版本、检索与修订权限

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的测试用例版本、检索与修订权限行为，作为待业务确认的逆向规格。

**角色：** 可读项目成员；创建为可写成员，修订为作者或管理者

**触发：** test case list/search/show/create/revise及Web用例工作台

#### 前置条件

- 有效active用户；读有当前项目访问权，写为活动可写项目
- 模块/需求/资料引用均属同一项目

#### 主流程

- 创建初版标准用例与审计
- 按关键词、模块、需求、suite、method筛选当前版本
- 读取当前及倒序历史修订
- 修订锁定义并校验base_revision后新增不可变版本

#### 业务规则

- BR-DEL-M09-01-01：资格：创建需写权；修订还要求作者或管理者；作者被降viewer、项目归档后保留读取但拒绝写。
- BR-DEL-M09-01-02：版本：base_revision正整数且与当前头一致；修订必须有≤4096字符变更说明；并发仅一位得到下一版本。
- BR-DEL-M09-01-03：内容/选择：标题≤512且必填；最多200步骤，每步action必填≤8192；method manual/automated，priority low/medium/high/critical；suite为字符串分组，不产生独立计划/套件实体。
- BR-DEL-M09-01-04：顺序：列表updated_at DESC、id DESC，历史revision DESC；关键词对当前内容小写包含匹配，关联过滤为精确ID/值。
- BR-DEL-M09-01-05：HTTP差异：创建必须有title，修订必须base_revision/change_summary；提供steps时每项schema要求action和expected均存在，虽用例normalizer可对缺expected默认空。route数组max100不替代领域tags max30；schema未统一声明additionalProperties:false，不把它描述为skills同样的严格字段合同。

#### 状态变化/保留

- create revision1；revise current_revision+1并保存旧版本、审计；读不变更任务状态

#### 数据契约

- title/summary/module_code/requirement_codes/priority/method/suite/tags/preconditions/steps[{action,expected}]/notes_markdown/asset_codes
- HTTP边界：testing写路由bodyLimit=10MiB；所有路由检查中间件principal，无独立预先getProject调用，项目存在性/访问权由用例scope/findProject/assertProjectAccess检查；HTTP JSON Schema校验与后续testing_invalid领域校验分开。

#### 异常与边界

- 条件：过期base_revision；处理：testing_revision_conflict，不覆盖他人修订
- 条件：外部引用或非作者/非管理者修订；处理：拒绝且旧版本保留

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M09-01-01` | 用例修订形成可检索的当前头与可读历史版本。 |
| `AC-M09-01-02` | 并发修订不会形成两个同号版本或覆盖已存内容。 |

#### 验证计划（本轮全部未执行）

**AC-M09-01-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动项目写成员A、管理者O；模块/需求/资料同项目；用例初版r1含suite=smoke
- 操作：
  1. A以base_revision1修订并查询r1/r2
  2. 关键词及suite=smoke筛选
- 观察结果：r1正文保留，r2为当前，列表按更新顺序返回且条件正确

**AC-M09-01-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立r1用例；两个作者授权请求均base_revision1
- 操作：
  1. 并发提交两个不同修订
  2. 读取历史修订及错误
- 观察结果：仅一条r2、另一testing_revision_conflict；r1完整保留

#### 来源与已有测试定义

- `packages/application/src/testing-use-cases.ts:24-65`；SHA-256 `370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858`
- `packages/application/src/testing-use-cases.ts:67-169`；SHA-256 `370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858`
- `packages/application/src/testing-content.ts:53-68`；SHA-256 `7f4c4782a7c2ba6588a39c7b1567e328ee2bb925dbb37589a3b6b35a3d5eabe7`
- `apps/web/src/TestingWorkbench.tsx:19-40`；SHA-256 `edc6f899e65bb5f3d246351b8556a672de654ea2df1eb58d1edeb68593638d43`
- `packages/persistence/src/schema.ts:1324-1345`；SHA-256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`
- `apps/core-api/src/routes/testing.ts:7-47`；SHA-256 `ba9e3535b304feb7436ec9aa2e33ff9b25da035d279cba203d178d4be624c240`
- `apps/core-api/src/server.ts:67-75`；SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/core-api/src/server.ts:155-167`；SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/core-api/src/auth.ts:98-128`；SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`

- `packages/application/tests/testing.test.mjs` · simultaneous case revision attempts create exactly one next revision · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 公共HTTP边界仅静态核对：未执行请求预算、Fastify schema/额外字段处理、错误形状或legacy配置组合验证；认证通道策略见身份模块，不能把允许legacy的开发配置说成仅设备凭据。

### REQ-DEL-M09-02 · 多来源测试资料与安全版本下载

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的多来源测试资料与安全版本下载行为，作为待业务确认的逆向规格。

**角色：** 项目可读成员下载；作者/管理者修订

**触发：** test asset创建/修订/搜索/历史读取/下载

#### 前置条件

- 活动可写项目维护资料，读取有项目读权
- storage_kind为markdown/file/url/git，purpose为guide/script/data/environment/report

#### 主流程

- 按资料类型归一化正文/文件/URL/Git引用并检查项目关联
- 保存与用例一致的版本与权限模型
- 索引剥离文件字节，详情按授权读取准确历史字节
- CLI下载到显式普通文件目标，不运行脚本、不拉取Git

#### 业务规则

- BR-DEL-M09-02-01：文件：普通文件名≤255且无路径/控制字符；规范Base64解码≤6MiB，元数据size/hash从字节计算并核对可选声明；MIME格式合法。
- BR-DEL-M09-02-02：URL/Git：仅无凭据HTTP(S)；Git必须仓库内相对路径且无..，仓库属于当前项目，commit如填写须完整40/64位SHA。
- BR-DEL-M09-02-03：最小交付：资料列表与执行快照剥离content_base64，授权详情保留；修订旧版文件字节保持。
- BR-DEL-M09-02-04：下载：已有非普通文件目标拒绝；已有普通文件默认拒绝且仅force允许覆盖；下载报告实际字节数/hash，不自动执行任何资料命令。

#### 状态变化/保留

- 创建/修订版本化资料；下载只写指定本机文件且不改变平台版本

#### 数据契约

- file_name/mime_type/content_base64/size_bytes/sha256；url；git.repository_code/path/ref/commit/command/setup
- HTTP边界：testing写路由bodyLimit=10MiB；所有路由检查中间件principal，无独立预先getProject调用，项目存在性/访问权由用例scope/findProject/assertProjectAccess检查；HTTP JSON Schema校验与后续testing_invalid领域校验分开。
- HTTP的file对象要求file_name/content_base64，git对象要求repository_code；写body10MiB不等于单文件解码6MiB限制；两层预算同时适用。

#### 异常与边界

- 条件：非法Base64/超限/hash不符/URL含凭据/Git越界；处理：testing_invalid，未形成新版本
- 条件：覆盖目标冲突；处理：output_invalid或output_exists，原文件保持

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M09-02-01` | 资料索引省略载荷，授权历史详情与下载保留准确版本字节。 |
| `AC-M09-02-02` | 非法资料不入库，下载不静默覆盖已有文件。 |

#### 验证计划（本轮全部未执行）

**AC-M09-02-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；项目成员A可写；准备已知字节file资料r1及r2；本机新输出路径，A有读权
- 操作：
  1. 读取资料索引及r1详情
  2. 下载指定r1并计算hash
- 观察结果：索引不含base64，r1详情/下载为原字节及相符hash，r2不影响r1

**AC-M09-02-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立新资料输入；6MiB+1字节或凭据URL；另有已有普通输出文件X
- 操作：
  1. 分别尝试创建非法资料
  2. 无force下载到X
- 观察结果：创建拒绝且无新版本；X原内容不变并返回output_exists

#### 来源与已有测试定义

- `packages/application/src/testing-content.ts:22-51`；SHA-256 `7f4c4782a7c2ba6588a39c7b1567e328ee2bb925dbb37589a3b6b35a3d5eabe7`
- `packages/application/src/testing-content.ts:70-86`；SHA-256 `7f4c4782a7c2ba6588a39c7b1567e328ee2bb925dbb37589a3b6b35a3d5eabe7`
- `packages/application/src/testing-use-cases.ts:48-65`；SHA-256 `370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858`
- `packages/application/src/testing-use-cases.ts:316-319`；SHA-256 `370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858`
- `apps/cli/src/testing.ts:176-192`；SHA-256 `963661b4da83388218c6e4b00d4466a72131f3a49e61175eff3d6a571acf5007`
- `apps/core-api/src/routes/testing.ts:7-22`；SHA-256 `ba9e3535b304feb7436ec9aa2e33ff9b25da035d279cba203d178d4be624c240`
- `apps/core-api/src/routes/testing.ts:49-64`；SHA-256 `ba9e3535b304feb7436ec9aa2e33ff9b25da035d279cba203d178d4be624c240`

- `packages/application/tests/testing.test.mjs` · file metadata is derived and bytes only returned for authenticated detail reads · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M09-03 · 固定版本测试执行记录、结果汇总与过期提示

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的固定版本测试执行记录、结果汇总与过期提示行为，作为待业务确认的逆向规格。

**角色：** 活动项目可写成员或其Agent/CI客户端

**触发：** record测试执行结果，或查询执行列表/详情

#### 前置条件

- 有效项目权限，测试实际由外部操作者执行；服务仅接收报告
- 1至500条唯一case_code结果；0至100个唯一asset_code资料引用

#### 主流程

- 校验标题/实际环境/测试版本、来源与可选同项目任务
- 按精确case_revision与资料revision解析历史内容
- 保证用例关联资料都有明确引用，固定Git commit
- 事务保存执行/结果/资料快照及实际认证执行者；查询汇总结果并提示用例是否已有新版本

#### 业务规则

- BR-DEL-M09-03-01：资格/边界：记录需要项目写权；source=manual/agent/ci是报告标签，executor取认证用户；不在服务器运行测试，不verify或close关联Task。
- BR-DEL-M09-03-02：固定：结果不重复case_code且每项引用存在同项目精确修订；资料唯一且每个用例要求的asset必须有明确版本。
- BR-DEL-M09-03-03：Git：每资料可单独固定commit；若未固定，仅单一仓库且执行commit_sha存在时补全；多仓库共享commit有歧义则拒绝。
- BR-DEL-M09-03-04：结果/顺序：not_run/pass/fail/blocked/skipped；报告最多30个无凭据HTTP(S) URL；列表created_at DESC、id DESC，结果id ASC；is_outdated只比较当前用例修订，不改历史快照。

#### 状态变化/保留

- 新增不可变执行与各结果；任务状态/基线不变；仅后续缺陷关联允许补充defect_code

#### 数据契约

- 执行title/environment/tested_version/commit_sha/source/task_code/notes；结果case_code/case_revision/result/actual_result/notes/report_urls；asset_refs[]
- HTTP边界：testing写路由bodyLimit=10MiB；所有路由检查中间件principal，无独立预先getProject调用，项目存在性/访问权由用例scope/findProject/assertProjectAccess检查；HTTP JSON Schema校验与后续testing_invalid领域校验分开。
- HTTP结果需要case_code/case_revision/result，case_revision为正整数；报告URL数组HTTP最多100，但用例层最多30且限制无凭据HTTP(S)。服务返回历史读取与实际执行报告，不自动运行测试。

#### 异常与边界

- 条件：重复结果、缺精确修订/必需资料、跨项目任务或多仓库commit歧义；处理：testing_invalid或revision_not_found，整条执行事务不保存
- 条件：用例之后被修订；处理：查询is_outdated=true，保存的旧快照/结果不变

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M09-03-01` | 执行记录固定当时版本与认证执行者，后续用例变更只产生过期提示且不自动验收任务。 |
| `AC-M09-03-02` | 多仓库资料不能用一个未明确归属的执行commit补齐。 |

#### 验证计划（本轮全部未执行）

**AC-M09-03-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动写成员A；项目P有用例C r1关联资料G r2（单仓库且commit空）；已知40位commit；任务T running
- 操作：
  1. record一次pass结果及G r2、实际环境/版本/commit
  2. 将C修订r2，再读该执行及T
- 观察结果：执行固定C r1/G r2且Git补入准确commit，executor=A，is_outdated=true；T仍running版本不变

**AC-M09-03-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立项目用例C与资料分别来自R1/R2且两个Git commit均空；仅给一个执行commit
- 操作：
  1. record包含两仓库资料的执行
- 观察结果：拒绝歧义；无执行及结果残留

#### 来源与已有测试定义

- `packages/application/src/testing-use-cases.ts:171-264`；SHA-256 `370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858`
- `packages/application/src/testing-content.ts:22-31`；SHA-256 `7f4c4782a7c2ba6588a39c7b1567e328ee2bb925dbb37589a3b6b35a3d5eabe7`
- `apps/cli/src/testing.ts:194-204`；SHA-256 `963661b4da83388218c6e4b00d4466a72131f3a49e61175eff3d6a571acf5007`
- `packages/persistence/src/schema.ts:1347-1361`；SHA-256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`
- `apps/core-api/src/routes/testing.ts:22-22`；SHA-256 `ba9e3535b304feb7436ec9aa2e33ff9b25da035d279cba203d178d4be624c240`
- `apps/core-api/src/routes/testing.ts:66-84`；SHA-256 `ba9e3535b304feb7436ec9aa2e33ff9b25da035d279cba203d178d4be624c240`

- `packages/application/tests/testing.test.mjs` · execution snapshots retain historical content, report evidence and actual authenticated executor · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M09-04 · 失败测试结果关联或派生缺陷

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的失败测试结果关联或派生缺陷行为，作为待业务确认的逆向规格。

**角色：** 当前项目可写成员

**触发：** 对已保存fail结果关联已有缺陷或新建缺陷

#### 前置条件

- 结果确属指定execution且result=fail
- 现有缺陷或新Feature属于同一项目

#### 主流程

- 锁结果行，检查已关联缺陷；同defect_code重放直接返回，不写新审计
- 关联已有同项目缺陷或从冻结用例/实际环境/结果/报告生成reported缺陷
- 恰一关联需求时自动保留其关联
- 新建缺陷并关联写defect.reported及test_execution.defect_linked；首次关联已有缺陷只写后者；相同缺陷重放两者都不新增

#### 业务规则

- BR-DEL-M09-04-01：资格：只有fail可关联；已有同defect_code请求无新增且不新增审计，已关联另一个则testing_defect_conflict。
- BR-DEL-M09-04-02：派生：默认标题来自保存的用例snapshot，severity默认medium；复现、环境、版本、实际结果与证据来自已保存执行，不能悄悄跟随当前用例。
- BR-DEL-M09-04-03：运行控制：结果行锁及事务保护新缺陷和关联；新建并关联有两类审计，首次关联已有缺陷仅defect_linked，同缺陷重放零新增审计；不得跨项目关联；结果本身pass/fail或任务状态不改变。

#### 状态变化/保留

- 首次关联fail结果defect_code null→code；新建缺陷才产生reported状态与defect.reported审计；已有缺陷状态不改；同缺陷重放关联/审计均不变；测试结果及关联任务状态不变

#### 数据契约

- 已有defect_code或新建feature_code/title/severity；新缺陷说明包含执行身份、历史用例步骤、实际结果与报告URL
- HTTP边界：testing写路由bodyLimit=10MiB；所有路由检查中间件principal，无独立预先getProject调用，项目存在性/访问权由用例scope/findProject/assertProjectAccess检查；HTTP JSON Schema校验与后续testing_invalid领域校验分开。

#### 异常与边界

- 条件：非fail或其他execution结果；处理：拒绝且无缺陷
- 条件：已关联不同缺陷/跨项目；处理：拒绝保持原关联

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M09-04-01` | 失败结果派生缺陷使用历史复现证据，创建关联有两类审计，而同缺陷重放无新增缺陷或审计。 |
| `AC-M09-04-02` | 只有未关联失败结果可建立新缺陷关联，原关联不可静默替换。 |
| `AC-M09-04-03` | 首次关联已有缺陷只新增关联审计，相同关联重放不产生审计副作用。 |

#### 验证计划（本轮全部未执行）

**AC-M09-04-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来隔离验收种子须建设，not_run：活动可写A；fail结果F冻结C r1而当前C r2，F无缺陷；同项目Feature；已保存环境/版本/报告；记录初始缺陷数及两类审计计数
- 操作：
  1. 从F派生缺陷并读取defect.reported/test_execution.defect_linked的增量
  2. 用返回同defect_code对F重复关联并再读两类计数
  3. 读取缺陷及F
- 观察结果：首次只创建一个reported缺陷，说明来自C r1/保存报告；首次两类审计各+1；重放两类均+0，F仍fail/原关联不变

**AC-M09-04-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立pass结果及另一个已关联D1的fail结果；另有同项目D2
- 操作：
  1. pass尝试关联
  2. fail尝试改关联D2
- 观察结果：pass拒绝；fail冲突且仍D1；无多余缺陷/任务变化

**AC-M09-04-03** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来独立种子须建设，not_run：活动项目写成员A，fail结果F未关联；同项目既有缺陷D状态triaged；记录缺陷/审计计数与任务状态
- 操作：
  1. 首次将F关联既有D
  2. 读取缺陷数、D状态和两类审计增量
  3. 以同D重放并再次读取
- 观察结果：首次缺陷数不变、D仍triaged；仅test_execution.defect_linked+1，defect.reported+0；重放两类+0；F仍fail且任务不变

#### 来源与已有测试定义

- `packages/application/src/testing-use-cases.ts:266-309`；SHA-256 `370fe3a428f2549a0a46272d9db9e5c9b552fb3352fa4ec9228922e0e9017858`
- `apps/core-api/src/routes/testing.ts:22-22`；SHA-256 `ba9e3535b304feb7436ec9aa2e33ff9b25da035d279cba203d178d4be624c240`
- `apps/core-api/src/routes/testing.ts:86-91`；SHA-256 `ba9e3535b304feb7436ec9aa2e33ff9b25da035d279cba203d178d4be624c240`

- `packages/application/tests/testing.test.mjs` · failed results create one audited defect using saved reproduction and evidence, with cross-project/link guards · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M09-05 · 缺陷上报、修复任务与回归关闭

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的缺陷上报、修复任务与回归关闭行为，作为待业务确认的逆向规格。

**角色：** 可写项目成员；分诊/关闭/拒绝为管理者

**触发：** defect report/list/transition

#### 前置条件

- 缺陷Feature可访问且项目可写，severity合法
- 流转满足当前状态邻接关系

#### 主流程

- 成员上报reported缺陷并可关联同项目需求
- 按可见项目/Feature/status查询并列出修复任务
- 管理者分诊，进入fixing绑定当前缺陷的defect-fix任务
- 至少一关联修复任务verified/closed后允许retest，管理者关闭或退回triaged

#### 业务规则

- BR-DEL-M09-05-01：状态：reported→triaged/rejected；triaged→fixing/rejected；fixing→retest/rejected；retest→closed/triaged/rejected；closed与rejected终态。
- BR-DEL-M09-05-02：权限：进入triaged/closed/rejected要求管理者；fixing/retest允许有当前写权成员满足其业务门槛。
- BR-DEL-M09-05-03：修复资格：fixing必带同项目、source=defect-fix且绑定当前缺陷的任务；retest需至少一个关联修复任务verified或closed，不要求全部。
- BR-DEL-M09-05-04：选择/一致性：列表缺陷id DESC，修复任务id DESC；此旧上报/流转实现更新与审计不在同一显式事务且未见版本CAS，不能宣称全链路原子或并发唯一流转。
- BR-DEL-M09-05-05：HTTP边界：defects路由未设置写body特例或完整JSON schema，继承server1MiB；认证由全局middleware/preHandler，actor仅request.principal。status/severity/to显式枚举校验，title/description等由String转换后交用例；不虚构额外非空/strict字段守卫或预先getProject检查。

#### 状态变化/保留

- 按状态机推进缺陷，Task独立保留自己的状态；操作追加审计

#### 数据契约

- severity critical/high/medium/low；公开defect_code/feature_code、description、found_in、related_requirement_code及fix_tasks
- HTTP查询status非法→invalid_status；report severity非法→invalid_severity；transition to非法→defect_transition_invalid并给valid列表。全局业务ok:false按error-status映射，未映射码回落400；超body预算→413 request_body_too_large。

#### 异常与边界

- 条件：非法状态、非管理者分诊/关闭/拒绝；处理：拒绝状态修改
- 条件：修复任务来源/缺陷关联不符或无已验证任务；处理：拒绝fixing/retest
- 条件：持久化后审计失败；处理：部分写入风险保留为待改进，不表述为已回滚

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M09-05-01` | 回归门槛来自至少一条已验证修复任务，最终关闭由管理者执行。 |
| `AC-M09-05-02` | 普通成员不能分诊，已拒绝缺陷不能重新流转。 |

#### 验证计划（本轮全部未执行）

**AC-M09-05-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动管理者O与写成员B；独立子场景A：reported缺陷D、已绑定D的defect-fix任务T running；独立子场景B：重新种子D fixing且T verified（计划准备条件，非已部署fixture）
- 操作：
  1. 场景A：O分诊D；B以T转fixing，再尝试retest
  2. 重置到独立子场景B的明确种子；B转retest，O关闭
  3. 分别读取D/T状态及审计
- 观察结果：场景A中T未验证时retest拒绝；独立场景B允许retest/close，D最终closed且T仍verified

**AC-M09-05-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立reported缺陷D，普通写成员B；另有rejected缺陷X
- 操作：
  1. B尝试分诊D
  2. 管理者尝试将X转triaged
- 观察结果：D权限拒绝，X终态拒绝；两者状态不变

#### 来源与已有测试定义

- `packages/application/src/defect-use-cases.ts:18-29`；SHA-256 `f60478b523e5ed9c945f7daeb7af5c1aa622671cdd8ab6ad06821b72bd037ad7`
- `packages/application/src/defect-use-cases.ts:38-171`；SHA-256 `f60478b523e5ed9c945f7daeb7af5c1aa622671cdd8ab6ad06821b72bd037ad7`
- `packages/application/src/defect-use-cases.ts:174-244`；SHA-256 `f60478b523e5ed9c945f7daeb7af5c1aa622671cdd8ab6ad06821b72bd037ad7`
- `apps/core-api/src/routes/defects.ts:27-76`；SHA-256 `5a764edd4920b410f19d97fc80c4ff79137a2d07a7f3cf69eb054902d50103f0`
- `apps/core-api/src/error-status.ts:261-264`；SHA-256 `07b66849ff69f858795b40ff28f0a6fada2401106b5360fdb40afae96ce18933`
- `apps/core-api/src/server.ts:67-75`；SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/core-api/src/server.ts:155-167`；SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/core-api/src/auth.ts:98-128`；SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`

- `packages/application/tests/defect-use-cases.test.mjs` · Defect 闭环：上报（任何成员）→ 分诊（Owner）→ 绑定缺陷修复任务 → 回归 → 关闭 · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 缺陷旧流转无显式事务、锁与乐观版本；并发治理与审计失败恢复是发现的风险，不应被逆向规格批准为目标。
- 公共HTTP边界仅静态核对：未执行请求预算、Fastify schema/额外字段处理、错误形状或legacy配置组合验证；认证通道策略见身份模块，不能把允许legacy的开发配置说成仅设备凭据。

## M10 · 技能版本与交付

对应平台父模块：`DEL-M10`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-DEL-M10-01 · 规范技能包校验与草稿创建

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的规范技能包校验与草稿创建行为，作为待业务确认的逆向规格。

**角色：** 来源团队成员或活动项目可写成员

**触发：** skill create提交目录/文件包

#### 前置条件

- 当前active且未删除用户，有来源写权
- 1至200普通文件，总解码字节≤6MiB，根SKILL.md存在且UTF-8

#### 主流程

- 规范化安全路径与Base64，拒绝重复/目录冲突/链接
- 校验文件字节大小/hash，按path字典序排列
- 解析根SKILL.md的name/description文本元数据
- 事务保存技能与revision1草稿、计算package_sha256及审计

#### 业务规则

- BR-DEL-M10-01-01：路径：相对NFC路径≤240字符，不含反斜线/绝对路径/控制字符/保留设备名/..或.git；大小写重复/目录拼写冲突及文件父路径冲突拒绝。
- BR-DEL-M10-01-02：包：不支持symlink/特殊文件；规范Base64；文件可选size/hash必须匹配；总解码≤6MiB且文件1至200。
- BR-DEL-M10-01-03：元数据：SKILL.md必在根且严格UTF-8，YAML frontmatter含唯一name与description标量；name为≤64字符小写字母数字单连字符且不为设备保留名，description≤1024。
- BR-DEL-M10-01-04：运行边界：解析不求值YAML标签/别名/包代码；创建为初稿，不自动发布或执行脚本。
- BR-DEL-M10-01-05：HTTP预算/错误：包解码总6MiB与JSON请求10MiB为不同限制；create需scope_type/scope_code/files，revise需base_revision/files/change_summary，version为≥1整数、base_generation≥0。超body预算全局返回413 request_body_too_large；JSON schema异常沿Fastify错误处理，不能假定均为skill_invalid或统一业务envelope。

#### 状态变化/保留

- 新Skill current_revision1、archived=false；新修订published_at为空

#### 数据契约

- 输入scope_type/team或project、scope_code、files[{path,content_base64,size_bytes?,sha256?}]；输出规范files/size_bytes/package_sha256/name/description
- HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。

#### 异常与边界

- 条件：越界、大小写冲突、缺元数据、超限或hash不符；处理：skill_invalid，不存部分技能/修订
- 条件：来源无写权；处理：skill_forbidden

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M10-01-01` | 合法规范技能包保存为可追溯未发布草稿。 |
| `AC-M10-01-02` | 不安全或超过限制的技能包在持久化前被整体拒绝。 |

#### 验证计划（本轮全部未执行）

**AC-M10-01-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；活动来源团队成员A；新合法包有SKILL.md和references/a.txt，字节及hash已知
- 操作：
  1. 创建技能并下载r1
  2. 对照规范path顺序和package_sha256
- 观察结果：revision1草稿、作者A，文件字节/摘要匹配且无脚本执行

**AC-M10-01-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立来源可写A；分别准备../x路径、大小写冲突及6MiB+1包
- 操作：
  1. 每次独立提交非法包并查询新记录数
- 观察结果：每次skill_invalid，无Skill/修订部分记录

#### 来源与已有测试定义

- `packages/application/src/skills-content.ts:5-95`；SHA-256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`
- `packages/application/src/skills-use-cases.ts:112-128`；SHA-256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`
- `packages/application/src/skills-access.ts:11-46`；SHA-256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`
- `apps/core-api/src/routes/skills.ts:7-65`；SHA-256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`
- `apps/core-api/src/server.ts:67-75`；SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/core-api/src/server.ts:155-167`；SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/core-api/src/auth.ts:98-128`；SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`

- `packages/application/tests/skills.test.mjs` · package validation fixes hashes and rejects traversal, case collisions, malformed metadata and oversize · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 公共HTTP边界仅静态核对：未执行请求预算、Fastify schema/额外字段处理、错误形状或legacy配置组合验证；认证通道策略见身份模块，不能把允许legacy的开发配置说成仅设备凭据。

### REQ-DEL-M10-02 · 技能目录、版本可见性与授权读取

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的技能目录、版本可见性与授权读取行为，作为待业务确认的逆向规格。

**角色：** 来源成员、接收团队成员或目标项目成员

**触发：** skill catalog/search/show/list及Web目录

#### 前置条件

- 目录只选一个team/project范围且当前有对应访问权
- 详情请求显式传project_code时，lockSkillReadScopes先要求项目存在且actor具有该项目当前read，不论是否有独立source.read；通过请求scope资格后才按source.read优先选版本，无source.read再按目标交付资格选择。未传project可独立使用来源读取权。

#### 主流程

- 按owned/available/shared视图选取来源或接收技能
- 详情如传project，先核对该项目存在及当前读权，再计算source.read并优先返回来源可见修订；没有source.read才按目标share/安装交付资格
- 非自有项目目录另行过滤：普通项目成员仅安装的获准发布版本，管理者可发现获准升级版；显式项目请求读资格通过后，详情来源分支不被目录的安装版本过滤收窄
- 安装列表普通读者available_revisions仅当前获准安装版本；返回可见摘要/详情版本并过滤关键词

#### 业务规则

- BR-DEL-M10-02-01：草稿：来源管理者及有写权的原作者可见草稿；来源普通读者仅发布版；目标共享不带编辑或再共享权。
- BR-DEL-M10-02-02：请求资格与可见性优先级：show/详情若显式传project_code，先检查该项目存在和actor当前项目read，source.read不绕过该请求scope守卫；通过后source.read优先保留来源可见发布版/获准草稿，只有无source.read的目标分支才按manager/安装版及projectGrant限版本。非自有project catalog/search和安装列表仍各自收窄，不等同详情。
- BR-DEL-M10-02-03：顺序：摘要/详情修订revision DESC；目录底层按skill.updated_at DESC无最终ID tie-break；不能保证同时间技能的稳定顺序。
- BR-DEL-M10-02-04：保护：详情下载先核对显式项目上下文的当前读权，再持用户/来源/目标scope锁至选取字节；来源草稿权不替代项目请求资格，隐藏草稿计数及目标-only期待仍按各分支适用。

#### 状态变化/保留

- 只读，无修改技能修订/共享/安装

#### 数据契约

- 视图owned/available/shared；summary.current_revision为可见最新，published_revision/available_revisions亦限可见范围；shares仅来源manager可见
- HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。

#### 异常与边界

- 条件：显式project不存在或无其当前read；处理：project_not_found/project_forbidden，在返回详情字节之前拒绝，即使actor有source.read
- 条件：无可见版本或无其他scope读权；处理：skill_forbidden；目录排除该技能
- 条件：多个/无范围、无效view；处理：skill_invalid

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M10-02-01` | 无独立来源权限的普通接收者只能读取安装交付版本；来源非作者也不见草稿。 |
| `AC-M10-02-02` | 在无来源权限的目标分支，升级发现由项目管理者持有，且发现新版不自动升级。 |
| `AC-M10-02-03` | 显式project请求先要求该项目当前read；通过后来源权限优先决定详情版本，无项目权的来源读者不能借source.read绕过请求scope资格。 |

#### 验证计划（本轮全部未执行）

**AC-M10-02-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来隔离种子须建设，not_run：来源作者A、普通来源成员B；目标普通成员C/管理者O均无任何source scope read；技能发布r1、草稿r2；目标只安装r1且明确授权该版本交付；当前身份均有效
- 操作：
  1. B以来源身份读取详情
  2. 目标-only C在project上下文读取详情并检查版本/摘要
  3. O查看项目可用修订
- 观察结果：B/C只见发布r1及相应可见计数，C不能见来源草稿；A来源作者权独立保留，不套用C的目标-only期待

**AC-M10-02-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来独立种子须建设，not_run：目标P安装r1且enabled，r1/r3均已明确授权向P及其成员交付；普通C和项目管理者O均无source.read；r2仍草稿
- 操作：
  1. 分别查询P的安装列表及非自有available目录
  2. 以C/O读取项目上下文详情
- 观察结果：C只发现/读取安装r1；O可发现获授权发布r3，双方都不能读r2；平台安装仍r1

**AC-M10-02-03** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来受控种子尚待建设，not_run：来源T1技能发布r1/r3、草稿r2；P属T2且安装r1、enabled、grant授权r1/r3及外部交付；S为T1普通成员兼P普通成员；A为来源作者且有P读权；目标-only C无source.read；另N为active T1普通成员但非T2成员、P成员或owner，P对N无继承或其他当前read；所有身份/设备有效
- 操作：
  1. S以project=P读详情及P非自有catalog/安装列表；A/C分别以project=P读详情
  2. 独立比较N：先不传project读取同一技能详情，再显式project=P读取；记录响应是否包含任何文件字节
  3. 比较版本集合、拒绝结果及安装状态
- 观察结果：S详情r1/r3且非自有catalog/安装升级集合仍限r1；A可见r2草稿，C只r1；N不传project可读来源发布r1/r3，传P则project_forbidden且不下发字节；安装仍r1

#### 来源与已有测试定义

- `packages/application/src/skills-use-cases.ts:37-110`；SHA-256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`
- `packages/application/src/skills-access.ts:54-74`；SHA-256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`
- `packages/application/src/skills-access.ts:103-129`；SHA-256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`
- `apps/core-api/src/routes/skills.ts:7-65`；SHA-256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`

- `packages/application/tests/skills.test.mjs` · published files are immutable, revisions conflict correctly and hidden drafts do not leak newest counters · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M10-03 · 技能修订、明确发布与归档恢复

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的技能修订、明确发布与归档恢复行为，作为待业务确认的逆向规格。

**角色：** 来源作者或管理者修订；来源管理者发布/归档

**触发：** skill revise/publish/archive --restore

#### 前置条件

- 当前来源维护权有效；修订技能未归档且base_revision当前
- 发布指定已存在修订；归档参数明确boolean

#### 主流程

- 锁来源scope及技能，重查作者/管理权
- 修订创建新不可变包版本并推进current_revision
- 管理者发布指定修订，重复发布已发布修订不重复写发布审计
- 管理者归档/恢复保留所有历史

#### 业务规则

- BR-DEL-M10-03-01：权限：修订需source.write且是作者或source.manage；发布/归档仅source.manage，目标项目管理员没有来源管理权。
- BR-DEL-M10-03-02：版本：base_revision必须当前；旧发布包从不覆盖，修订保存新包与change_summary。
- BR-DEL-M10-03-03：归档：已归档技能拒绝修订/发布/共享并阻止新交付；历史留存，来源权限仍能读历史；恢复只改archived标记，不自动恢复已撤销share。

#### 状态变化/保留

- revise current_revision+1；publish只设指定修订published_at；archive/unarchive标记及审计

#### 数据契约

- base_revision/files/change_summary；publish.revision；archive.archived；包hash随新版本而非覆盖旧版
- HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。

#### 异常与边界

- 条件：过期base_revision或作者被撤权；处理：revision_conflict/forbidden，旧包不变
- 条件：归档状态发布/修订；处理：skill_archived

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M10-03-01` | 技能新修订保持发布历史不可变，发布和归档均受来源管理权约束。 |
| `AC-M10-03-02` | 目标管理权不赋予来源技能发布或归档权。 |

#### 验证计划（本轮全部未执行）

**AC-M10-03-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；来源作者A与管理者O；技能r1已发布且未归档
- 操作：
  1. A用base1修订成r2
  2. O发布r2两次
  3. O归档后尝试新修订，再恢复归档
- 观察结果：r1字节不变，r2明确发布；重复发布不新增发布事件；归档拒绝写且历史仍可读，恢复保留版本

**AC-M10-03-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；目标项目管理者M仅有交付权，无来源scope权；技能已共享安装
- 操作：
  1. M尝试发布或归档该技能
- 观察结果：skill_forbidden；来源标记/修订/审计保持

#### 来源与已有测试定义

- `packages/application/src/skills-use-cases.ts:20-30`；SHA-256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`
- `packages/application/src/skills-use-cases.ts:130-169`；SHA-256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`
- `packages/application/src/skills-access.ts:27-46`；SHA-256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`
- `packages/persistence/src/schema.ts:1363-1374`；SHA-256 `b2b85d191bc636884933297979a8d0c49b5d422691674cd699a5d33b1fb62475`
- `apps/core-api/src/routes/skills.ts:7-65`；SHA-256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`

- `packages/application/tests/skills.test.mjs` · archive blocks delivery without deleting published history; role downgrade invalidates maintenance · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M10-04 · 精确版本共享、项目交付资格与撤销

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的精确版本共享、项目交付资格与撤销行为，作为待业务确认的逆向规格。

**角色：** 来源管理者；接收团队/项目按当前资格使用

**触发：** skill share/revoke及交付校验

#### 前置条件

- 技能未归档；目标scope存在且不是来源自身
- 共享列表1至200个已发布正整数修订

#### 主流程

- 版本去重升序并明确allow_projects/allow_external（默认false）
- 按目标团队或项目保存精确授权；完全相同未撤销授权重放不新增
- 交付时独立判断项目资格、外部活跃成员及版本授权
- 撤销授权阻止后续字节交付/新执行，保留历史及已下载副本

#### 业务规则

- BR-DEL-M10-04-01：精确授权：只能共享已发布版本，grant并不自动跟随新修订；完全相同目标/版本/flags不会重复插入。
- BR-DEL-M10-04-02：资格：本项目自有技能发布版直接可交付；本团队技能对无外部active成员的团队项目隐式可交付；一旦有外部成员需显式allow_external。
- BR-DEL-M10-04-03：团队接收：team share默认仅发现；向其项目交付须allow_projects且匹配该project.team；project share直接指向项目；任一种仍按精确版本及外部成员flag限制。
- BR-DEL-M10-04-04：撤销：soft revoke可重复；当前grant失败后阻断字节、manifest和新启动/恢复，不能远程收回已下载文件。

#### 状态变化/保留

- 新增或撤销share，不修改原包字节；历史安装可保留blocked状态

#### 数据契约

- target_type/target_code/revisions[]/allow_projects/allow_external；revoked_at/by；外部资格依据active未删除项目成员/owner是否有当前团队角色
- HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。

#### 异常与边界

- 条件：draft版本、自身scope或未授权外部成员；处理：拒绝共享/交付，不扩大权限
- 条件：share不存在；处理：skill_share_not_found

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M10-04-01` | 团队发现、项目采用与外部成员交付需要各自明确授权。 |
| `AC-M10-04-02` | 项目已启用团队技能后加入未获外部交付授权的成员，会阻止后续清单交付且保留安装元数据。 |

#### 验证计划（本轮全部未执行）

**AC-M10-04-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；来源管理者O；团队技能r1发布；目标外团队项目P含active外部成员；无share
- 操作：
  1. 先创建默认team share并尝试P采用
  2. 另创建明确r1、allow_projects=true、allow_external=true的目标team share
  3. 重试采用并撤销该share后请求manifest
- 观察结果：默认交付拒绝；明确授权允许精确r1；撤销后manifest拒绝，包历史和本机已下载副本仍留存

**AC-M10-04-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；未来隔离种子须建设，not_run：活动同团队项目P初无外部active成员；团队技能S r1已发布；明确存在ProjectSkillInstallation(project=P,skill=S,revision=1,alias=review,enabled=true)，generation=3；active请求者C仍有P读权；没有任何显式allow_external授权；外部用户X active且无来源团队角色
- 操作：
  1. C先请求manifest，确认包含S r1/alias review/generation3作为基准
  2. 保持此顺序场景，增加X为P的active项目成员且不授予团队角色或技能share
  3. C再请求同一project manifest并读取安装集合元数据
- 观察结果：基准清单明确包含S r1；新增外部成员后整份manifest返回skill_delivery_blocked而非空清单/静默跳项；安装仍enabled r1、generation3，已下载副本不承诺回收

#### 来源与已有测试定义

- `packages/application/src/skills-use-cases.ts:172-208`；SHA-256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`
- `packages/application/src/skills-access.ts:81-102`；SHA-256 `3890e2d47f0631c8ff0b0df3d795355928166d7059e5970eb930356f0260543d`
- `packages/application/src/skills-run.ts:18-35`；SHA-256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`
- `apps/core-api/src/routes/skills.ts:7-65`；SHA-256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`

- `packages/application/tests/skills.test.mjs` · team shares default to discovery only; project use and external membership require explicit policy · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M10-05 · 项目技能安装、升级、别名及受限停用

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的项目技能安装、升级、别名及受限停用行为，作为待业务确认的逆向规格。

**角色：** 活动项目管理者

**触发：** skill install/update/disable或更新项目采用集

#### 前置条件

- 输入当前base_generation、准确revision、合法alias及明确enabled
- 技能修订存在且交付资格有效，受限停用例外

#### 主流程

- 锁项目与安装集合generation
- 校验准确版本授权及项目内别名唯一
- upsert项目/技能安装并generation+1
- 返回安装状态、blocked原因和管理者获授权升级版本

#### 业务规则

- BR-DEL-M10-05-01：资格：安装/升级/别名/启停要求项目manage且活动；只选准确发布版本，不自动选latest。
- BR-DEL-M10-05-02：并发：base_generation为非负整数并严格匹配；同代数并发更新只一成功，成功每次generation+1。
- BR-DEL-M10-05-03：例外：授权撤销后仅允许对既有安装保持原revision/alias并enabled=false；不能借停用请求窥选其他隐藏版本。
- BR-DEL-M10-05-04：顺序与冲突：安装按alias排序；不同skill不能同alias；alias为≤64小写字母数字单连字符且避开设备保留名。

#### 状态变化/保留

- 安装upsert并generation+1；停用不删除历史安装；项目升级不改已固定Run

#### 数据契约

- revision/alias/enabled/base_generation；输出generation/installations[].blocked/blocked_reason/available_revisions
- HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。

#### 异常与边界

- 条件：代数过期；处理：skill_generation_conflict，安装集合不变
- 条件：别名冲突/版本未授权；处理：alias_conflict/delivery_blocked，不部分更新

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M10-05-01` | 安装集合使用代数防止过期写覆盖其他修改。 |
| `AC-M10-05-02` | 撤销后允许原版本原别名停用，不能借停用改变未授权版本。 |

#### 验证计划（本轮全部未执行）

**AC-M10-05-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；项目管理者O；generation3，已安装A r1 alias=a；r2已获授权；另技能B alias=b
- 操作：
  1. 以base_generation3把A升级r2
  2. 再次使用base3更改B
- 观察结果：A r2且generation4；第二请求generation_conflict，B不变

**AC-M10-05-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立项目generation4，A r1 alias=a已失去grant
- 操作：
  1. 保持r1/a停用A
  2. 重置后尝试以隐藏r2/a停用
- 观察结果：前者成功generation5且enabled=false；后者delivery_blocked并保持原安装

#### 来源与已有测试定义

- `packages/application/src/skills-use-cases.ts:215-268`；SHA-256 `3be360fceb737a860969d6f7e4d8704ad26cf77abec6edd8a5119e03e0eba8d6`
- `packages/application/src/skills-content.ts:12-19`；SHA-256 `4891a9a8d0558d67ff76f3037ae9516bc267f4f4a05c42c17ded281aa18c7983`
- `packages/persistence/drizzle/0036_skills.sql:29-38`；SHA-256 `6bba7f49d770b9306c5e1a45aa09c1f1e14170865d4eb92b37e09140e38a8afa`
- `apps/core-api/src/routes/skills.ts:7-65`；SHA-256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`

- `packages/application/tests/skills.test.mjs` · installation optimistic generation serializes concurrent updates and explicit aliases prevent collisions · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M10-06 · 项目与Run固定技能清单、继承及当前授权重检

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的项目与Run固定技能清单、继承及当前授权重检行为，作为待业务确认的逆向规格。

**角色：** 当前项目可读用户；领取/交接/启动Run的执行者

**触发：** 读取project/run manifest及capture/copy

#### 前置条件

- 当前项目访问有效；所有被交付版本当前grant有效
- Run属于项目；固定hash和已发布包一致

#### 主流程

- 项目清单按alias读取enabled安装及准确文件
- claim事务固定metadata清单至Run
- 后续Run读取按固定修订取字节并核对package hash及当前授权
- handover复制源Run同一固定清单；legacy无快照显式空

#### 业务规则

- BR-DEL-M10-06-01：项目：仅enabled安装进入清单；任一引用缺失/归档/撤销/外部资格不符即整份清单拒绝，不能悄悄丢项。
- BR-DEL-M10-06-02：固定：Run保存generation和准确revision/alias/hash metadata；项目升级仅影响后续Run，不改旧Run。
- BR-DEL-M10-06-03：重检：固定不是永久授权；下载、Session start、resume、handover restore/ready/activate再查当前grant，hash不符拒绝；handover禁止跨项目复制。
- BR-DEL-M10-06-04：legacy：没有run_skill_manifest的历史Run解析为generation0空清单，从不套用当前项目安装。

#### 状态变化/保留

- 一次capture或copy固定Run metadata；只读解析不修改已固定版本

#### 数据契约

- ProjectSkillManifest包含project_code/generation/skills[].files；Run metadata去除files但保留hash与版本；下载按固定版本恢复字节
- HTTP边界：skills路由使用中间件principal（不接受body actor）；没有预先getProject请求，项目访问由应用用例检查。写body帮助器10MiB且声明additionalProperties:false；files1至200，文件对象也声明additionalProperties:false并要求path/content_base64。JSON Schema声明与实际未知字段删除/拒绝细节未运行验证。

#### 异常与边界

- 条件：任何固定版本失去资格/hash不符；处理：skill_delivery_blocked；claim时事务回滚，其后操作保持已有Run等待修复
- 条件：目标已有固定快照/跨项目复制；处理：revision_conflict/forbidden

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M10-06-01` | Run清单固定原版本，legacy Run保持空且不跟随项目升级。 |
| `AC-M10-06-02` | 固定Run仍在交付和启动时重查当前授权。 |

#### 验证计划（本轮全部未执行）

**AC-M10-06-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；项目安装A r1 generation1，写成员B；新任务可领取；另有无技能快照的legacy Run L
- 操作：
  1. 领取新Run R并读取manifest
  2. 项目管理者升级A r2后再次读取R和L
- 观察结果：R仍r1/hash原值；L generation0/skills=[]；后续新Run才r2

**AC-M10-06-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立R固定跨团队A r1且当前share有效；可用设备D
- 操作：
  1. 撤销A r1的唯一share
  2. 请求R manifest并尝试Session start
- 观察结果：均delivery_blocked且没有新增Session；旧Run元数据不改写

#### 来源与已有测试定义

- `packages/application/src/skills-run.ts:8-83`；SHA-256 `7f99d850404df4adab97e9944ba79c5182492daa2a7e3f527707d84f421a96c9`
- `packages/application/src/task-service.ts:215-230`；SHA-256 `54cac5db6d6c0ca7a14ef4f6e623b0ba3114e25c1c04ca788150aaa6bbc0666f`
- `packages/application/src/handover-use-cases.ts:398-402`；SHA-256 `a26521201ca0cc8e84f21fad39285c262f22e06645f844ed14f3da3d8d1b1f2e`
- `packages/application/src/execution-use-cases.ts:88-92`；SHA-256 `009e4b863e86a62a0c4a280e7198008aa343e21b69e6a624928eff8f7bb3bcf6`
- `apps/core-api/src/routes/skills.ts:7-65`；SHA-256 `f98b5f5ec7a2bbc3bd94a1ff7bfc40dc1fd4125c8676375d7c3232dc8d9151ea`

- `packages/application/tests/skills-run.test.mjs` · claim pins exact skill bytes and metadata; project upgrades affect only subsequent Runs · `defined`；已读取测试定义/断言线索，未运行；不构成验收通过。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。

### REQ-DEL-M10-07 · 本机技能清单检查、受管同步与失败恢复

**观察类型：** `observed_in_code`

**摘要：** 记录固定源码中实现的本机技能清单检查、受管同步与失败恢复行为，作为待业务确认的逆向规格。

**角色：** 当前项目/Run清单可读的本机CLI操作者

**触发：** skill manifest/sync，可用--check或--run

#### 前置条件

- 目标为普通本机工作区，manifest全部路径/别名/摘要已校验
- 同步目录及所有祖先不是symlink/junction；本机受管文件未修改

#### 主流程

- 全量校验清单再读取本机lock和受管树
- check报告add/update/remove且不写；真实同步独占mutex
- 先stage新文件与lock，重查本机树后替换受管包与lock
- 失败只回滚本次移动路径；回滚不成保留stage和mutex要求人工恢复

#### 业务规则

- BR-DEL-M10-07-01：保护：拒绝摘要/路径/大小写/特殊文件及祖先链接冲突；本地受管文件增删改或额外目录均拒绝，未管理同名目录不能覆盖。
- BR-DEL-M10-07-02：锁与引导：mutex已存在拒绝；版本控制lock先到但整个managed root完全缺失可bootstrap，局部树缺失仍视修改而保护。
- BR-DEL-M10-07-03：运行控制：--check无写；仅同步.tsp/skills及lock，不改变平台选定版本、Agent配置或执行包内脚本；--run使用Run独立目录与固定清单。
- BR-DEL-M10-07-04：恢复：stage前后两次核验；替换异常反向rename原包及lock；回滚失败skill_sync_recovery_required保留旧内容stage与mutex，要求保留现场人工恢复。

#### 状态变化/保留

- 成功替换受管包及skills.lock.json；check不变更；失败恢复原树或明确保留人工恢复现场

#### 数据契约

- lock format1/project_code/generation/skills摘要；结果check/changed/added/updated/removed/directory/lock_path；包字节完全按已验清单

#### 异常与边界

- 条件：本地修改/未管理冲突/mutex；处理：明确错误并保留原文件
- 条件：manifest获取被授权撤销拒绝；处理：不开始本机替换
- 条件：回滚失败；处理：保留恢复文件而不自动清除现场

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `AC-M10-07-01` | 检查和同步分别提供无写预览及准确受管替换，重复同步保持一致。 |
| `AC-M10-07-02` | 本地修改导致同步拒绝并保留现场。 |

#### 验证计划（本轮全部未执行）

**AC-M10-07-01** · manual

- 前提/数据/权限：独立场景，执行前重置数据；本机独立普通工作区，已受管A r1未修改且lock正确；授权manifest要求A r2与新增B
- 操作：
  1. sync --check并比较完整目录hash
  2. sync后核对包/lock
  3. 再次sync
- 观察结果：check只报告不写；真实同步字节/hash与manifest匹配；再次无差异；不执行包脚本

**AC-M10-07-02** · manual

- 前提/数据/权限：独立场景，执行前重置数据；独立受管A r1；手工修改A文件；manifest要求r2
- 操作：
  1. sync并读取错误和文件hash
- 观察结果：skill_local_modified，手改内容/旧lock保持，不覆盖；需操作者先处理本地修改

#### 来源与已有测试定义

- `apps/cli/src/skill-sync.ts:135-199`；SHA-256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`
- `apps/cli/src/skill-sync.ts:205-307`；SHA-256 `0648fe5bf6908a199d1aa96474653e1e9b8354985265251c15cc7e6aa2c1610a`
- `apps/cli/src/skills.ts:134-170`；SHA-256 `e617ea4e7b769d189b2431fa41252aacd6ef11ab0be18ca7f870f940f9fcea77`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 仅审阅固定快照源码；未执行实际验收、运行期权限或外部服务验证。
- 未执行真实文件替换或故障注入；跨平台rename和断电时恢复有效性未实测。

## M11 · 代码与资料接入、规则化需求生产

对应平台父模块：`tsp-module-intake`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-INT-M11-01 · 准备安全的仓库与文本资料采集包

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：prepare只采集与导航，不生成已批准业务实体；材料正文不能作为Agent指令。

**角色：** 在本机绑定项目的Agent或用户

**触发：** intake prepare

#### 前置条件

- 有效平台身份、项目工作空间和明确来源；输出目录不覆盖材料目录。

#### 主流程

- 解析repository/material/team-note与scope及pilot/enterprise档位。
- 按安全扫描清单生成来源路径、摘要、排除原因和本机映射。
- 获取平台现有实体与映射context，写入空候选、固定Skill和参考模板，不调用模型。

#### 业务规则

- BR-INT-M11-01：prepare只采集与导航，不生成已批准业务实体；材料正文不能作为Agent指令。
- BR-INT-M11-01：来源种类决定assessment：真实源码观察、材料陈述和模型推断分别标记。

#### 状态变化/保留

- 仅本地新采集目录，无平台业务写入。

#### 数据契约

- IntakeBundle严格schema、source.files摘要、inputs来源、namespace及profile；Skill固定2.2.0。

#### 异常与边界

- 条件：链接、敏感路径、二进制或超限来源；处理：排除或失败并记录，不静默说已全量理解。
- 条件：enterprise缺少完整档案和规格；处理：候选可在草稿阶段检视质量问题，不能因此自动降档。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M11-01-AC01` | prepare产出空候选和来源清单但不提交业务。 |
| `REQ-INT-M11-01-AC02` | 材料包含链接或输出目录覆盖材料时拒绝不安全采集。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M11-01-AC01** · automated

- 前提/数据/权限：准备可读的绑定仓库、一个Markdown补充材料、空输出目录及有效项目会话。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 运行prepare并记录CLI网络请求。
  2. 读取source.files、inputs、AGENT和intake.items。
- 观察结果：清单有真实摘要/来源种类，items为空；无submit/apply或模型调用。

**REQ-INT-M11-01-AC02** · automated

- 前提/数据/权限：分别准备链接材料与同路径输出目录，独立临时目录基线。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 执行prepare对应参数。
- 观察结果：失败或明确排除；不读取链接目标、不覆盖原材料。

#### 来源与已有测试定义

- `apps/cli/src/intake.ts:55-125`；SHA-256 `5324d2f8c2e080c89dae5fbf66727b1dd66242339442a18162295890e968d61a`
- `apps/cli/src/intake-materials.ts:1-145`；SHA-256 `2a5cb2a29512cd9214fc0628b5de20a80c179a760527a96daf5ff9923e401f70`
- `apps/cli/src/intake-source.ts:1-90`；SHA-256 `c141b183d0e2e6befb182693bc8e1198daa92956efb2adaacb137009c15386db`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M11-02 · 从已发布代码分析桥接原始固定快照

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：UA/codegraph仅导航，代码事实从该run原始源码查证；知识JSON本身不升级为源码事实。

**角色：** 当前有项目权限的本机Agent

**触发：** intake prepare --code-run RUN

#### 前置条件

- run成功已发布，本机有同一run捕获的完整source与映射；使用固定run不是浮动view。

#### 主流程

- 验证本地snapshot全部文件、run/repository/root身份和远端授权。
- 将原始code路径作为合法源码证据输入；另写带版本/插件/图摘要的知识材料。
- 允许缩小捕获scope，不切换到当前checkout；draft标识与基底commit保持原样。

#### 业务规则

- BR-INT-M11-02：UA/codegraph仅导航，代码事实从该run原始源码查证；知识JSON本身不升级为源码事实。
- BR-INT-M11-02：不同分析run可共享稳定namespace/来源身份，但每份证据摘要必须匹配本次固定文件。

#### 状态变化/保留

- 只生成新本地采集包，旧run/source不改，项目默认view不改。

#### 数据契约

- --code-run、snapshot:&lt;id&gt; inputs revision、本机code_snapshot.root和远端成功run；生成知识材料与原始代码分属不同input。

#### 异常与边界

- 条件：snapshot缺失/漂移、额外文件、映射重定向或知识材料漂移；处理：在validate/submit/replace网络写入前拒绝；snapshot标记不能靠删除映射降级成普通来源。
- 条件：并用include-untracked等不兼容选项；处理：拒绝，因为快照文件集已固定。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M11-02-AC01` | 当前HEAD不同也从明确run快照生成证据。 |
| `REQ-INT-M11-02-AC02` | 删除/修改映射不能把快照候选悄悄降级为当前仓库校验。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M11-02-AC01** · automated

- 前提/数据/权限：准备成功run R、本地原始snapshot S；另让当前checkout HEAD与S不同；有效项目会话。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 执行prepare --code-run R。
  2. 检查code输入路径/摘要及draft、commit身份。
- 观察结果：代码证据逐字节匹配S；不取checkout最新文件，未改变默认view。

**REQ-INT-M11-02-AC02** · automated

- 前提/数据/权限：准备固定run候选和有效本地映射；每个案例独立复制候选目录。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 先篡改一个源文件再validate。
  2. 独立基线删除snapshot映射再validate。
- 观察结果：均失败，submit/replace前停止；不写平台候选。

#### 来源与已有测试定义

- `apps/cli/src/intake-code-knowledge.ts:14-68`；SHA-256 `274697e231e69c7286ea79379446c6f1b7e166d0e6a9ad8e6c03a08a29db682a`
- `apps/cli/src/intake-materials.ts:146-169`；SHA-256 `2a5cb2a29512cd9214fc0628b5de20a80c179a760527a96daf5ff9923e401f70`
- `apps/cli/src/intake.ts:55-125`；SHA-256 `5324d2f8c2e080c89dae5fbf66727b1dd66242339442a18162295890e968d61a`

- `apps/cli/tests/intake-code-knowledge.test.mjs` · code-run prepares original snapshot evidence and rule handoff despite a different live HEAD · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。
- `apps/cli/tests/intake-code-knowledge.test.mjs` · snapshot mapping cannot redirect to another root or silently fall back to the live checkout · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M11-03 · 形成可追溯模块、规则、验收与验证计划

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：完整规格与模块规则文档互相引用，来源hash与行号可复验；图谱缺边或分页裁剪不能证明能力不存在。

**角色：** 读取采集包的当前Agent

**触发：** 依据固定Skill进行代码逆向并intake validate/export

#### 前置条件

- 先读AGENT、Skill、context和来源清单；原始源码作为不可信输入。

#### 主流程

- 先用UA定位业务域与流程，再用原生codegraph查符号/调用，带相同run。
- 回读实际入口、资格判断、排序、状态和存储分支，规则表写条件/结果/例外/来源/测试断言。
- 形成模块→Feature→结构化需求，稳定BR/REQ/AC及逐AC验证计划，记录未读与不确定内容。

#### 业务规则

- BR-INT-M11-03：完整规格与模块规则文档互相引用，来源hash与行号可复验；图谱缺边或分页裁剪不能证明能力不存在。
- BR-INT-M11-03：每个验证场景独立声明角色、状态、时钟与外部结果；不能虚构已存在夹具或承诺候选已批准。

#### 状态变化/保留

- 本地候选/预览变化，不直接创建项目需求。

#### 数据契约

- strict IntakeItem.specification、acceptance_criteria、verification_plan及source.production.capabilities/conflicts；企业档案模板另由全局资料维护。

#### 异常与边界

- 条件：只有知识文档没有原始源码；处理：只能documented/inferred，不能observed_in_code。
- 条件：建议测试未实际执行；处理：保留计划状态；现有测试代码只标defined，不据此声称passed。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M11-03-AC01` | 缺失AC对应验证计划的企业候选暴露质量问题。 |
| `REQ-INT-M11-03-AC02` | 导出完整候选保持BR与REQ/AC可追踪。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M11-03-AC01** · automated

- 前提/数据/权限：准备一份完整enterprise来源候选，仅删除某REQ的一条verification_plan，保留该AC。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 执行本地validate并读取质量报告。
- 观察结果：报告定位未覆盖AC/结构化质量差距；不会自动补造测试通过或提交。

**REQ-INT-M11-03-AC02** · automated

- 前提/数据/权限：准备合法候选，含稳定BR表、两个AC及独立计划、真实文件证据。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 执行export到新目录。
  2. 比对JSON与可读规格的REQ/AC/BR及来源。
- 观察结果：预览完整呈现规则与验证；候选身份未变，平台无业务写入。

#### 来源与已有测试定义

- `apps/cli/src/intake-skill.ts:1-42`；SHA-256 `920ed9ccb8b7a843ffe18389c9e304fb7b762f199b37320d798b45b501274009`
- `packages/contracts/src/intake.ts:29-61`；SHA-256 `1144bf8d893db668afebeba0022515b478f64f0442a6f3b134f92b19ef2048e1`
- `apps/cli/src/intake-delivery.ts:1-80`；SHA-256 `b826bb07cb66659dce157c678f7f1a7af2ee1b6982c28bcd0d5634f020c1dda8`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 业务角色对逆向规则的确认仍需审阅；该方法本身不证明产品业务意图。

### REQ-INT-M11-04 · 幂等提交并保护已发布项的来源

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：已成功项存在时其内容及整个source不可变；尚无completed行不触发这项保护，替换可更新允许的来源内容。

**角色：** 具有当前项目write权限的提交者；管理者可管理批次

**触发：** intake submit/replace 与批次 POST/PUT

#### 前置条件

- 来源本机校验通过，包的project/repository/namespace与批次一致。

#### 主流程

- submit以(project,creator,key)检查相同包重试，返回同一批次；不同包复用key冲突。
- 保存draft候选及质量指纹，不创建目标业务实体。
- replace需当前revision且非applying/applied；保护已completed项及其source，重建其余项并使旧计划失效。

#### 业务规则

- BR-INT-M11-04：已成功项存在时其内容及整个source不可变；尚无completed行不触发这项保护，替换可更新允许的来源内容。
- BR-INT-M11-04：legacy pilot回放兼容旧无profile哈希，不覆盖之后明确确认的enterprise档位。

#### 状态变化/保留

- 新批次draft revision1；成功replace revision+1、draft、清空plan/frozen质量依据，保留completed行。

#### 数据契约

- 幂等键、base_revision、payload_hash、source_json、逐项pending/applied/bound等状态；POST/PUT受10MiBroute预算。

#### 异常与边界

- 条件：成员替换他人或已审阅批次；处理：拒绝；管理者仍受已发布项保护。
- 条件：enterprise降为pilot、改变来源归属或已成功项；处理：拒绝。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M11-04-AC01` | 同key同包重试只返回原批次。 |
| `REQ-INT-M11-04-AC02` | 有成功项的替换不能修改来源。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M11-04-AC01** · automated

- 前提/数据/权限：准备write成员、合法包B和新submit key K，记录批次计数。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 连续两次提交B/K。
  2. 同K提交改标题后的B2。
- 观察结果：前两次同batch code且只有一批；第三次冲突且原包不变。

**REQ-INT-M11-04-AC02** · automated

- 前提/数据/权限：准备已有一条applied的partial批次，管理者有当前权限，revision=5。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 用base_revision5提交source摘要变化的包。
- 观察结果：拒绝；已成功目标、来源、收据、批次revision保持不变。

#### 来源与已有测试定义

- `packages/application/src/intake-use-cases.ts:182-235`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `apps/core-api/src/routes/intake.ts:19-38`；SHA-256 `316f974a008a9c75019d8b2a1ea671070e0eaeb6cb19e3edbee33b155dc0b623`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M11-05 · 逐项审阅并固定批次发布依据

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：固定的是本批次来源、质量和逐项决策，不冻结项目开发或源码。

**角色：** 当前项目Owner/Admin

**触发：** Web review / POST intake/:code/review

#### 前置条件

- 批次非applying、applied、cancelled；base_revision匹配。

#### 主流程

- 明确pilot/enterprise档位，完整计算质量报告。
- 逐项选择create/bind/skip；校验父依赖与绑定目标当前指纹、项目、类型和父关系。
- 形成决策与payload及质量依据签名，保存ready计划并增加批次版本。

#### 业务规则

- BR-INT-M11-05：固定的是本批次来源、质量和逐项决策，不冻结项目开发或源码。
- BR-INT-M11-05：已completed行不能改变决策；历史无档位批次须显式选择后形成新依据。

#### 状态变化/保留

- 成功draft/partial/stopped等→ready，revision+1、plan_hash和frozen质量依据持久化。

#### 数据契约

- decisions恰好覆盖候选key；bind带target_code与fingerprint；全部目标再次按当前项目授权解析。

#### 异常与边界

- 条件：enterprise blocker&gt;0；处理：拒绝ready，返回可定位质量报告；不能降档绕过。
- 条件：已有来源映射；处理：非skip项必须显式bind同一目标；skip仍允许。
- 条件：父项skip而子项新增/绑定；处理：拒绝不完整计划。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M11-05-AC01` | 已映射来源可以显式跳过，而非强制绑定。 |
| `REQ-INT-M11-05-AC02` | enterprise结构阻断不能被审阅忽略。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M11-05-AC01** · automated

- 前提/数据/权限：准备已有同namespace/key来源映射的未成功候选；管理者、完整无阻断包和当前revision。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. review该项skip并为所有其他项给有效决策。
- 观察结果：ready成功，该项skipped，既有目标正文未修改。

**REQ-INT-M11-05-AC02** · automated

- 前提/数据/权限：准备缺必需规格的enterprise批次和Owner。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 发送完整decisions与当前revision。
- 观察结果：返回质量阻断，plan不转ready；业务实体未创建。

#### 来源与已有测试定义

- `packages/application/src/intake-use-cases.ts:237-277`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M11-06 · 按固定依赖顺序逐项发布并保存局部结果

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：发布不是整批全有全无；已有成功业务结果不会因后项失败回滚。

**角色：** 当前项目Owner/Admin

**触发：** intake apply 已审阅plan

#### 前置条件

- 当前管理权、ready/partial/stopped可新建尝试，plan_hash与质量依据仍匹配。

#### 主流程

- 新尝试先重验当前管理权、全部决策、依赖、绑定与目标指纹；预检通过后才提交durable attempt。
- 每项重验权限/停止状态和固定依据，按kindOrder再数据库ID升序选择pending。
- 每个业务项在savepoint内原子写目标、来源映射、审计、结果；非重试性单项失败仅回滚该项，独立后项继续，失败依赖标blocked。

#### 业务规则

- BR-INT-M11-06：发布不是整批全有全无；单项savepoint失败不回滚此前成功，且不自动停止独立后项。
- BR-INT-M11-06：预检拒绝、全局授权/固定依据失效、项内映射漂移分别按发生位置决定作用范围；不能统一描述为停止全部发布。
- BR-INT-M11-06：bind只建立/确认映射，不用候选正文覆盖既有目标。

#### 状态变化/保留

- 新尝试applying后，逐项保存applied/bound/failed/blocked与收据；所有pending处理完时attempt completed，批次按失败/阻塞为partial或applied。
- 全局失败清理与项内失败不同；仅项内失败本身不设置stop_requested，已提交目标保留。

#### 数据契约

- 父类型先行、同类id升序；来源映射键含project/repository或null/namespace/kind/source_key；不是业务优先级队列。

#### 异常与边界

- 条件：新attempt提交前发现映射或目标指纹漂移；处理：预检拒绝，不创建该次attempt，也不进入逐项写入。
- 条件：逐项savepoint之外发现当前管理权、批次计划/固定质量依据失效；处理：异常退出后续处理；捕获到的durable running attempt由外层清理为stopped，批次按成功数partial或stopped；保留此前提交。
- 条件：applyNext的item savepoint内发现source binding或bind target/fingerprint漂移等非重试性DomainError；处理：该项failed并写结果；applyNext继续，独立pending项可成功，依赖该失败项的后项blocked，最终可partial/completed。
- 条件：可重试busy/serialization/deadlock类基础设施错误；处理：向外抛出走有界重试与原key恢复路径，不能当作普通单项失败或保证已全局停止。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M11-06-AC01` | 后项失败只回滚自身并保留前项成功。 |
| `REQ-INT-M11-06-AC02` | 绑定既有目标不覆盖正文。 |
| `REQ-INT-M11-06-AC03` | 预检通过后的项内绑定目标漂移使该项failed，独立后项仍继续且失败依赖blocked。 |
| `REQ-INT-M11-06-AC04` | 同样漂移若在新attempt预检之前发生则拒绝该次开始。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M11-06-AC01** · automated

- 前提/数据/权限：准备管理者、通过质量且ready的模块M→FeatureF→REQ Q计划；测试故障注入仅对Q业务writer生效。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. apply新key。
  2. 查询模块、Feature、Q、映射、审计与results。
- 观察结果：M/F真实存在且收据成功；Q业务写入/映射/审计同项回滚并failed；批次partial。

**REQ-INT-M11-06-AC02** · automated

- 前提/数据/权限：准备带最新指纹的bind决策和已ready计划，目标正文X、候选正文Y。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. apply并读取目标和映射。
- 观察结果：目标仍X；item为bound且映射和收据指向原目标。

**REQ-INT-M11-06-AC03** · automated

- 前提/数据/权限：建设可暂停的pilot apply集成夹具：ready且固定依据有效，管理者有权；module候选A bind目标TA、独立module B create且数据库id B&gt;A，Feature F依赖A；声明测试hook尚未实现。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 新attempt预检提交后、A项savepoint开始前暂停。
  2. 另一独立事务改变TA用于fingerprint的实际字段并提交，再恢复apply；不要修改候选/plan。
  3. 读取A/B/F、attempt状态、stop_requested、目标和收据。
- 观察结果：A因最新指纹不匹配而failed，未覆盖TA；B真实创建并applied；F blocked；attempt可completed、批次partial，单项失败不自行设置stop_requested。

**REQ-INT-M11-06-AC04** · automated

- 前提/数据/权限：独立pilot ready计划含bind目标TA；当前管理者与合法固定依据；保存attempt数量，先修改TA指纹字段。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 调用apply新key。
  2. 读取attempt、item和目标。
- 观察结果：预检冲突且不创建这个新key的attempt、不开始项写入；不能把它描述成已经运行后的单项failed。

#### 来源与已有测试定义

- `packages/application/src/intake-use-cases.ts:299-358`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `packages/application/src/intake-use-cases.ts:376-464`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `packages/application/src/intake-use-cases.ts:325-336`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `packages/application/src/intake-use-cases.ts:405-419`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `packages/application/src/intake-use-cases.ts:453-463`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M11-07 · 区分运行中恢复与新尝试续传

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：执行状态、请求身份与冻结依据决定是否恢复，不能把所有重试解释成重新发布全部项。

**角色：** 当前仍有管理权的原操作者

**触发：** apply重试/恢复

#### 前置条件

- 相同key必须对应同一principal与plan；网络重试并不代替授权。

#### 主流程

- 读取已有attempt；running才继续执行。
- 新profile/固定依据存在时重检签名与当前候选；历史二者皆无的running路径兼容原恢复。
- 已completed/stopped的同key返回持久详情；有意继续使用新key且满足当前批次可执行状态。

#### 业务规则

- BR-INT-M11-07：执行状态、请求身份与冻结依据决定是否恢复，不能把所有重试解释成重新发布全部项。
- BR-INT-M11-07：历史兼容路径不等于所有旧运行都有现行企业质量门禁。

#### 状态变化/保留

- 恢复只处理pending；新尝试将failed/blocked重置pending，成功项保留。

#### 数据契约

- attempt idempotency_key、plan_hash、principal_id、status和results；重试顺序与materialTransaction边界需保留。

#### 异常与边界

- 条件：相同key不同操作者或plan；处理：冲突。
- 条件：有界busy/serialization/deadlock重试耗尽；处理：保留已经提交结果，提示原key重试；可能保留running而非一律stopped。
- 条件：初始权限检查在attemptId捕获前失败；处理：不声称旧running尝试一定被自动停止。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M11-07-AC01` | 停止attempt的同key回放不继续，新key才可续传。 |
| `REQ-INT-M11-07-AC02` | attempt提交后发生material busy时保留可恢复事实。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M11-07-AC01** · automated

- 前提/数据/权限：准备partial批次及stopped attempt K，当前管理者与未失效计划；存在一成功、一failed项。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. apply K并对比状态。
  2. 再apply新key K2。
- 观察结果：K只返回持久结果；K2重试失败项，成功目标不重复。

**REQ-INT-M11-07-AC02** · automated

- 前提/数据/权限：在可丢弃集成环境准备ready计划，注入点位于新attempt提交之后的materialTransaction，模拟有界busy耗尽。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. apply K。
  2. 检查attempt与已提交项，再解除故障用K重试。
- 观察结果：失败提示原key恢复，durable attempt可查询；恢复不重复成功项。不得把提交前失败当作本场景。

#### 来源与已有测试定义

- `packages/application/src/intake-use-cases.ts:299-373`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `packages/application/src/intake-use-cases.ts:147-156`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `packages/application/src/intake-use-cases.ts:376-390`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 历史无profile且无固定质量依据的running兼容路径需后续迁移策略；本轮不把它修饰为已满足enterprise要求。

### REQ-INT-M11-08 · 停止后续发布并保留来源映射与结果

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：stop不是回滚；source mapping与已提交真实资料保留。

**角色：** 草稿创建者或当前项目管理者

**触发：** intake stop/list/preview/result及API读取

#### 前置条件

- 读需当前项目访问且拒绝Viewer；stop需write，已审阅计划只允许管理者；base_revision匹配。

#### 主流程

- 读取批次、候选、映射建议、当前权限和持久收据。
- stop设置持久停止标记并结束running attempts。
- 有成功项变partial；零成功draft/ready变cancelled；其他零成功状态变stopped；applied直接返回。

#### 业务规则

- BR-INT-M11-08：stop不是回滚；source mapping与已提交真实资料保留。
- BR-INT-M11-08：变更namespace产生新来源身份，旧映射不会自动接管；读/写/管理权限分别判断。

#### 状态变化/保留

- stop revision+1（applied no-op除外）；attempt running→stopped；先前成功不撤销。

#### 数据契约

- list/detail/preview/result对应同一持久批次；停止后继续是否可行需当前状态和计划共同判断。

#### 异常与边界

- 条件：无当前权限或旧revision；处理：拒绝。
- 条件：重复stop零成功cancelled；处理：现实现可能再变stopped，不能承诺所有stop状态完全幂等。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M11-08-AC01` | 部分成功批次停止保留目标和收据。 |
| `REQ-INT-M11-08-AC02` | 普通提交者只能停止本人尚无计划草稿。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M11-08-AC01** · automated

- 前提/数据/权限：准备applying批次，一项applied且一个running attempt，Owner与当前revision。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. stop。
  2. 读取result、目标、映射与attempt。
- 观察结果：partial、stop_requested=true、attempt stopped；成功目标和收据存在。

**REQ-INT-M11-08-AC02** · automated

- 前提/数据/权限：准备MemberA的draft无plan及另一ready有plan批次。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. A分别stop，使用各自当前revision。
- 观察结果：draft取消；ready拒绝，ready计划和业务结果不变。

#### 来源与已有测试定义

- `packages/application/src/intake-use-cases.ts:72-83`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `packages/application/src/intake-use-cases.ts:158-181`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `packages/application/src/intake-use-cases.ts:281-296`；SHA-256 `b1e315e5a5f9a9a82740262a9bd034ec39f4a9bafb5206e0adffd662418b7eb9`
- `apps/cli/src/intake.ts:170-194`；SHA-256 `5324d2f8c2e080c89dae5fbf66727b1dd66242339442a18162295890e968d61a`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 零成功cancelled再stop可变stopped，是否继续允许新attempt与产品取消语义一致尚待确认。

## M12 · 系统文档 Agent 修改稿

对应平台父模块：`INT-MODULE-M12`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-INT-M12-01 · 按固定文档版本幂等创建修改稿任务

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：相同key精确回放先于当前文档revision检查，已有任务仍可返回；新key必须匹配当前头。

**角色：** 当前有原生文档编辑权的请求者

**触发：** POST project system-agent/jobs

#### 前置条件

- 执行器已配置；项目active、原生文档及允许目录可写；正整数base_revision。

#### 主流程

- 校验instruction≤8000、quote≤20000、request_key≤200和文档快照预算。
- 同请求者/项目/key比较document/base/instruction/quote摘要，相同返回原job。
- 新请求校验当前revision及quote真实子串，持久化输入快照和queued任务、审计。

#### 业务规则

- BR-INT-M12-01：相同key精确回放先于当前文档revision检查，已有任务仍可返回；新key必须匹配当前头。
- BR-INT-M12-01：文档正文≤100000字符，组合JSON快照≤300000字节；实际HTTP另受默认1MiB。

#### 状态变化/保留

- 只创建queued job及快照，不变文档revision。

#### 数据契约

- document_code/base_revision/instruction/quote/request_key；request_hash不包含浮动最新正文。

#### 异常与边界

- 条件：同key不同输入；处理：冲突。
- 条件：业务关联视图或受限系统目录、超预算、quote不在正文；处理：拒绝入队。
- 条件：引擎未配置；处理：HTTP503，不能先排无法执行的队列。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M12-01-AC01` | 精确幂等回放不创建新任务，即使文档后来更新。 |
| `REQ-INT-M12-01-AC02` | 无效quote和不可编辑来源不入队。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M12-01-AC01** · automated

- 前提/数据/权限：准备作者、原生D revision1、配置可用执行器；提交K后将D人工修订到2。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 以完全相同输入/K重试。
  2. 独立新key K2但仍base1提交。
- 观察结果：K返回原job；K2 revision冲突；无额外queued job。

**REQ-INT-M12-01-AC02** · automated

- 前提/数据/权限：准备作者可读的D与一份关联需求文档；每案独立基线。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 对D提交不在正文的quote。
  2. 对关联来源提交任务。
- 观察结果：均失败，无新job或文档修订。

#### 来源与已有测试定义

- `packages/application/src/system-agent-use-cases.ts:139-174`；SHA-256 `fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148`
- `apps/core-api/src/routes/system-agent.ts:6-18`；SHA-256 `629772266060f896c2be9803c00f7e15555071269067b51675106679ae6e2829`

- `packages/application/tests/system-agent.test.mjs` · create request idempotency detects changed instruction and validates quote/version · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M12-02 · 以有界候选和执行租约领取任务

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：created_at排序没有稳定ID次序，skip-locked且候选上限10，不能承诺全队列严格FIFO。

**角色：** 平台内部执行器

**触发：** worker轮询claimNextJob / heartbeat / recover

#### 前置条件

- 平台内部调用，executorId非空；执行元数据受限且Skill摘要为64位SHA。

#### 主流程

- 先恢复过期running任务为failed。
- 按created_at升序锁前10个queued候选并skip locked，逐个复核当前权限与源revision；失效者failed。
- 第一个有效任务置running，发随机execution_token与租约；心跳同时匹配任务、执行器、token及未过期租约。

#### 业务规则

- BR-INT-M12-02：created_at排序没有稳定ID次序，skip-locked且候选上限10，不能承诺全队列严格FIFO。
- BR-INT-M12-02：过期任务显示failed并要求重新发起，不自动无限重排队。

#### 状态变化/保留

- queued→running或failed；有效心跳延长租约；过期running→failed。

#### 数据契约

- execution_token只用于内部执行；对用户视图不构成可接管执行权限。

#### 异常与边界

- 条件：权限/源版本失效；处理：失败并审计，继续本轮其余候选。
- 条件：租约过期/取消/执行器或token不符；处理：拒绝心跳、完成与失败写回。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M12-02-AC01` | 两个执行器不能成功领取同一job。 |
| `REQ-INT-M12-02-AC02` | 过期任务恢复后迟到结果不能变awaiting_review。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M12-02-AC01** · automated

- 前提/数据/权限：准备一个有效queued任务、两个不同executorId和受控时钟。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 并发claim。
  2. 用错误token心跳和complete。
- 观察结果：仅一个领取该job；错误token被拒，无第二个proposal。

**REQ-INT-M12-02-AC02** · automated

- 前提/数据/权限：准备running job租约过去，保存旧token；文档基线未变。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. recoverExpiredJobs后用旧执行身份complete。
- 观察结果：job failed、旧token失效；无proposal采用或文档变更。

#### 来源与已有测试定义

- `packages/application/src/system-agent-use-cases.ts:219-280`；SHA-256 `fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148`
- `packages/application/src/system-agent-use-cases.ts:312-322`；SHA-256 `fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148`
- `apps/core-api/src/system-agent-worker.ts:25-90`；SHA-256 `514f7095e7d9cd123c54ba4251883341b1bf968081bf9ff0ef0e7de61d522d0a`

- `packages/application/tests/system-agent.test.mjs` · expired lease fails visibly on recovery and late completion stays rejected · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M12-03 · 以固定受限模型配置执行无工具草稿生成

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：模型只收到主机提供的证据，无平台凭据和写接口；模型自报evidence不是经核验引用。

**角色：** 平台执行器

**触发：** SystemAgentRuntime.draft

#### 前置条件

- 显式启用、有效DSH路径/私有工作根及凭据；运行时版本由平台固定。

#### 主流程

- 为每次任务创建隔离运行目录，仅注入授权快照、instruction/quote与平台固定Skill文本。
- 使用sdk-minimal和no-tools guard启动固定模型，无filesystem/web/MCP/terminal/subagent工具。
- 限制超时、token、协议输出总量，严格解析完整JSON；失败清理或有限保留。

#### 业务规则

- BR-INT-M12-03：模型只收到主机提供的证据，无平台凭据和写接口；模型自报evidence不是经核验引用。
- BR-INT-M12-03：默认超时180000ms、允许1000–600000；默认16384 tokens、允许512–32768；协议8MiB上限，失败保留目录数0–20。

#### 状态变化/保留

- 本机临时执行目录和内部作业状态变化；正式文档不变。

#### 数据契约

- 完整JSON title/summary/content/rationale/evidence/warnings；来源引用必须来自提供快照；输出content≤200000字符。

#### 异常与边界

- 条件：未配置、协议异常、max-tokens/中断、超时；处理：失败，不保留半篇可采用草稿。
- 条件：心跳失效或关闭worker；处理：中止模型并等待进程退出，迟到结果不提交。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M12-03-AC01` | 达到token上限或截断JSON不成为可审阅稿。 |
| `REQ-INT-M12-03-AC02` | 模型请求不能使用工具，凭据不进入提示词。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M12-03-AC01** · automated

- 前提/数据/权限：准备真实协议形状的可控假子进程，固定输入快照；分别返回max-tokens和截断JSON。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 调用runtime.draft。
  2. 记录返回错误、进程退出和job处理。
- 观察结果：明确失败，无awaiting_review草稿；无正式文档写入。

**REQ-INT-M12-03-AC02** · automated

- 前提/数据/权限：准备可控DSH协议测试服务与唯一测试用凭据哨兵，仅供隔离测试。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 捕获初始化、patch及prompt。
  2. 发送工具调用协议帧。
- 观察结果：工具schema为空/guard拒绝；prompt无凭据哨兵；失败输出被安全处理。

#### 来源与已有测试定义

- `apps/core-api/src/system-agent-runtime.ts:58-152`；SHA-256 `45227f28858e1ce45357fa084cb1c1904bf78f289ce885e67ca7733a3cc46773`
- `apps/core-api/src/system-agent-runtime.ts:155-239`；SHA-256 `45227f28858e1ce45357fa084cb1c1904bf78f289ce885e67ca7733a3cc46773`
- `apps/core-api/src/system-agent-runtime.ts:244-368`；SHA-256 `45227f28858e1ce45357fa084cb1c1904bf78f289ce885e67ca7733a3cc46773`
- `apps/core-api/src/system-agent-worker.ts:1-109`；SHA-256 `514f7095e7d9cd123c54ba4251883341b1bf968081bf9ff0ef0e7de61d522d0a`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 未实际调用外部模型或验证服务供应商可用性；无工具配置是平台约束，不能推断模型文本结论已正确。

### REQ-INT-M12-04 · 保存完整修改稿、质量与提案摘要

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：质量报告和proposal_hash用于明确采用，不自动更新原文；质量报告并非通过业务验收。

**角色：** 持有有效租约的内部执行器

**触发：** completeJob / failJob

#### 前置条件

- running且执行器/token/租约匹配，当前请求者仍可编辑源文档。

#### 主流程

- 归一化完整proposal并校验各字段长度。
- 复核执行授权，以job/base/proposal计算proposal_hash，产生规则质量报告。
- 同事务保存awaiting_review、proposal与质量，清空执行租约，审计drafted。

#### 业务规则

- BR-INT-M12-04：质量报告和proposal_hash用于明确采用，不自动更新原文；质量报告并非通过业务验收。

#### 状态变化/保留

- running→awaiting_review或failed；正式文档revision不变。

#### 数据契约

- proposal包含title/summary/content/rationale/evidence/warnings；hash绑定job_code和base_revision。

#### 异常与边界

- 条件：不合法/不完整proposal；处理：拒绝，不转可审阅。
- 条件：期间失去write权限；处理：job failed、令牌清空，禁止新草稿写回。
- 条件：执行失败；处理：记录受限失败说明，清空令牌/租约并审计。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M12-04-AC01` | 有效完成只生成待采用修改稿。 |
| `REQ-INT-M12-04-AC02` | 执行中撤权后完成被拒且正文不变。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M12-04-AC01** · automated

- 前提/数据/权限：准备running job、未过期租约、授权请求者与D revision1。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 以匹配token提交合法完整proposal。
  2. 读取job和D。
- 观察结果：job awaiting_review且有稳定hash/quality；D仍revision1，执行token与lease为空。

**REQ-INT-M12-04-AC02** · automated

- 前提/数据/权限：准备running job后撤销请求者write资格，使用旧有效token。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. completeJob合法proposal。
- 观察结果：job failed或返回权限错误；D正文和revision不变。

#### 来源与已有测试定义

- `packages/application/src/system-agent-use-cases.ts:29-52`；SHA-256 `fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148`
- `packages/application/src/system-agent-use-cases.ts:255-309`；SHA-256 `fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M12-05 · 请求者读取、取消和拒绝自己的修改稿

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：取消/拒绝只改变job，不回滚或写入原文；取消可阻止迟到完成。

**角色：** 创建job的当前请求者

**触发：** job list/get/cancel/reject

#### 前置条件

- 当前用户active、project读权存在，job.requester_id等于自身。

#### 主流程

- 列表仅本人项目job，created_at降序最多50。
- get按同一请求者边界读快照与状态。
- 取消queued/running/awaiting_review；拒绝仅awaiting_review；相同目标状态可返回，清除执行令牌并审计。

#### 业务规则

- BR-INT-M12-05：取消/拒绝只改变job，不回滚或写入原文；取消可阻止迟到完成。

#### 状态变化/保留

- queued/running/awaiting_review→cancelled；awaiting_review→rejected。

#### 数据契约

- public job code并非授权；list上限50且没有本文承诺的翻页。

#### 异常与边界

- 条件：其他管理者但并非请求者；处理：不能仅凭管理者身份读/取消他人job。
- 条件：不可处置状态；处理：拒绝；已cancelled/rejected相同处置回放返回现有状态。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M12-05-AC01` | 管理者不能读取另一请求者job正文。 |
| `REQ-INT-M12-05-AC02` | 取消running后迟到完成不能复活任务。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M12-05-AC01** · automated

- 前提/数据/权限：准备请求者A、同项目OwnerB和A的job。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. B get job、cancel job。
  2. A get相同job。
- 观察结果：B均被拒；A可读；job状态不因B变化。

**REQ-INT-M12-05-AC02** · automated

- 前提/数据/权限：准备A的running job及有效内部token。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. A cancel。
  2. 旧执行器complete。
- 观察结果：cancelled、租约清空；complete拒绝，文档不变。

#### 来源与已有测试定义

- `packages/application/src/system-agent-use-cases.ts:92-137`；SHA-256 `fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148`
- `packages/application/src/system-agent-use-cases.ts:176-189`；SHA-256 `fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148`
- `apps/core-api/src/routes/system-agent.ts:20-29`；SHA-256 `629772266060f896c2be9803c00f7e15555071269067b51675106679ae6e2829`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M12-06 · 仅在明确哈希和当前授权下采用修改稿

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：模型生成与采用是两个明确操作；未采用草稿不会变正式文档。

**角色：** 原请求者且当前仍有文档编辑权

**触发：** POST job/apply

#### 前置条件

- awaiting_review、proposal存在；提交proposal_hash与base_revision完全一致。

#### 主流程

- 锁job与原生文档，复核请求者、project和目录write资格。
- 比较当前文档revision与job基底，不对过期稿自动合并。
- 同事务追加原生文档revision与历史、标记job applied并记录双方关联审计。

#### 业务规则

- BR-INT-M12-06：模型生成与采用是两个明确操作；未采用草稿不会变正式文档。

#### 状态变化/保留

- document revision+1；job→applied并持久applied_revision；同事务审计。

#### 数据契约

- proposal_hash、base_revision；不是任意新正文提交接口。

#### 异常与边界

- 条件：hash/base或当前版本不匹配；处理：拒绝，修改稿仍待用户处理，不覆盖新正文。
- 条件：已applied精确重试；处理：当前权限/hash/base仍先校验，再返回既有结果，不追加第二版本。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M12-06-AC01` | 采用后精确重试不会重复追加版本。 |
| `REQ-INT-M12-06-AC02` | 人工先修订使旧稿不可采用。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M12-06-AC01** · automated

- 前提/数据/权限：准备A可写D revision1、A的awaiting_review job及已知proposal/hash。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. A apply正确hash/base1两次。
- 观察结果：D仅revision2；job applied指向2；没有重复历史或采用审计。

**REQ-INT-M12-06-AC02** · automated

- 前提/数据/权限：准备待采用base1稿，再将D修订至2。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 用原hash/base1 apply。
- 观察结果：版本冲突；D保持2与人工正文，未创建revision3。

#### 来源与已有测试定义

- `packages/application/src/system-agent-use-cases.ts:191-217`；SHA-256 `fafe35c7f379ba262d2120ab4a62ebf37f81f8abb743e6df4934dd56e25f2148`

- `packages/application/tests/system-agent.test.mjs` · manual revision between proposal and adoption blocks stale write · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

## M13 · 平台治理与运维

对应平台父模块：`INT-MODULE-M13`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-INT-M13-01 · 分页检索全局团队与项目元数据

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：全局元数据访问不意味着获得项目正文、代码知识或成员身份。

**角色：** active、未注销且非待注销的系统管理员

**触发：** GET /admin/teams /admin/projects

#### 前置条件

- 真实bearer/cookie会话；系统管理员标记有效。

#### 主流程

- 按q、团队、状态过滤元数据，转义LIKE通配符以按字面搜索。
- 计算过滤后的total，按公开code升序、cursor&gt;code及limit+1分页。
- 只返回管理索引字段与owner/creator和有效成员计数，不创建成员关系。

#### 业务规则

- BR-INT-M13-01：全局元数据访问不意味着获得项目正文、代码知识或成员身份。
- BR-INT-M13-01：项目成员数按active用户与owner/显式/非private继承关系计数；页总数和游标语义不同。

#### 状态变化/保留

- 只读，不改变团队/项目/成员。

#### 数据契约

- team/project代码、name、description、status、member_policy、current_snapshot、owner与计数；游标按公开code不按更新时间。

#### 异常与边界

- 条件：业务Owner但非系统管理员或无效管理员；处理：拒绝。
- 条件：limit非1–200、cursor非法、搜索超200字符；处理：拒绝而不无界扫描。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-01-AC01` | 分页保持过滤、稳定游标与正确总数。 |
| `REQ-INT-M13-01-AC02` | 管理员读取索引不自动得到业务正文。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-01-AC01** · automated

- 前提/数据/权限：准备管理员、名称含字面“%”的3团队、其他团队；limit=2。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. q=%请求第一页。
  2. 用返回cursor和相同q请求下一页。
- 观察结果：只匹配字面百分号；code顺序无重复，total为完整匹配数；不会把%当任意字符串。

**REQ-INT-M13-01-AC02** · automated

- 前提/数据/权限：准备不属于项目P的系统管理员A，P有原生文档和代码run。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. A读admin/projects。
  2. A读P文档及code graph。
- 观察结果：前者可见管理元数据；后两项仍按项目ACL拒绝，未产生成员关系。

#### 来源与已有测试定义

- `packages/application/src/admin-governance-use-cases.ts:12-102`；SHA-256 `5b7a9594f324003455ed61fb8822256ab6fbff160cb2ae31923b7ebe4d40367a`
- `apps/core-api/src/routes/admin-governance.ts:8-23`；SHA-256 `81b1ab9520ef0311605f9dbafc6a2b60a0d106db6f19d4dee39a53638c78d1f3`

- `apps/core-api/tests/admin-governance.test.mjs` · system administrators see global metadata without becoming team or project members · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M13-02 · 附原因修改治理元数据并阻止活动项目被归档

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：治理接口不更换Owner或添加成员；权限来自实际管理员谓词，不能从错误文字推导。

**角色：** 当前有效系统管理员

**触发：** PATCH /admin/teams/:code /admin/projects/:code

#### 前置条件

- 团队仅改名；项目仅改名称、说明、active/archived及有效base_snapshot；reason非空≤1000。

#### 主流程

- 锁定目标并再次确认管理员。
- 项目CAS匹配当前snapshot，归档前查active/preparing/suspended运行。
- 实际变化才更新snapshot并同事务记录before/after和原因审计；无变化返回当前版本。

#### 业务规则

- BR-INT-M13-02：治理接口不更换Owner或添加成员；权限来自实际管理员谓词，不能从错误文字推导。
- BR-INT-M13-02：团队更名和项目元数据变更均带原因；只有项目具有此base_snapshot CAS。

#### 状态变化/保留

- 项目有变化snapshot+1，状态可active↔archived；无变化不新增版本。

#### 数据契约

- name≤200、description≤10000；归档失败返回有限run_codes；只对实际变化记审计。

#### 异常与边界

- 条件：项目旧base_snapshot或活动运行；处理：拒绝归档/覆盖，不中止运行代替。
- 条件：修改owner/member_policy或其他未允许字段；处理：route拒绝。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-02-AC01` | 活动/交接运行阻止归档且不改变任务。 |
| `REQ-INT-M13-02-AC02` | CAS过期不能覆盖较新管理修改。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-02-AC01** · automated

- 前提/数据/权限：准备管理员、active项目snapshot3、一条suspended运行；保存任务/运行状态。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. PATCH archived,base_snapshot3,reason。
- 观察结果：project_has_active_runs；项目仍active/3，运行和任务不变。

**REQ-INT-M13-02-AC02** · automated

- 前提/数据/权限：准备项目snapshot4；发送base_snapshot3合法名称修改。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. PATCH。
  2. 读取治理索引与审计。
- 观察结果：冲突；名称和snapshot4保持，未新增更新审计。

#### 来源与已有测试定义

- `packages/application/src/admin-governance-use-cases.ts:105-159`；SHA-256 `5b7a9594f324003455ed61fb8822256ab6fbff160cb2ae31923b7ebe4d40367a`
- `apps/core-api/src/routes/admin-governance.ts:24-48`；SHA-256 `81b1ab9520ef0311605f9dbafc6a2b60a0d106db6f19d4dee39a53638c78d1f3`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M13-03 · 创建账号并签发受限初始凭据

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：凭据不是普通用户目录字段，敏感返回不能从全局list读取。

**角色：** 有效系统管理员

**触发：** users list/create/bind-token/initial-password及user create/list CLI

#### 前置条件

- 管理员有效；目标账号存在或新账号规范合法。

#### 主流程

- 创建时账号trim/lowercase且3–64受限字符、显示名非空，分配随机初始口令。
- 账号管理索引不返回密码哈希/明文；绑定token只在签发响应返回明文，库保存哈希与24小时到期。
- 初始口令15分钟有效且must_change_password；重置初始密码撤销设备，不允许重置其他管理员。

#### 业务规则

- BR-INT-M13-03：凭据不是普通用户目录字段，敏感返回不能从全局list读取。
- BR-INT-M13-03：create和部分签发路径的业务写入与随后审计并非都同一事务，不能笼统承诺所有账号操作原子审计。

#### 状态变化/保留

- create active+must_change_password；issueInitialPassword更新hash/到期并撤销设备；bind覆盖当前token哈希。

#### 数据契约

- account、display_name；一次签发响应含initial_password/bind_token与expires_at，不在候选产物中记录真实值。

#### 异常与边界

- 条件：账号重复/格式非法或目标disabled；处理：拒绝对应创建/签发。
- 条件：对其他系统管理员重置初始口令；处理：拒绝，服务器本机恢复另走受控命令。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-03-AC01` | 新账号规范化并只在签发响应暴露初始口令。 |
| `REQ-INT-M13-03-AC02` | 管理员不能为另一个管理员重置初始密码。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-03-AC01** · automated

- 前提/数据/权限：准备管理员、尚不存在的账户名“ Test.User ”；使用测试环境可控时钟。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 创建用户。
  2. 随后list users和读持久user字段。
- 观察结果：account为test.user、must_change_password=true、到期15分钟；list无口令/hash；库仅存口令hash。

**REQ-INT-M13-03-AC02** · automated

- 前提/数据/权限：准备两个active系统管理员A/B，A会话有效。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. A调用B initial-password。
- 观察结果：protected错误；B密码、设备与到期信息不变。

#### 来源与已有测试定义

- `packages/application/src/user-use-cases.ts:80-143`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `packages/application/src/user-use-cases.ts:156-227`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `apps/core-api/src/routes/users.ts:9-56`；SHA-256 `ee3d01aceaefcbc20e1e57ccd5c00fb178ba25b88e1a613e374456a4386c8e01`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 部分账号签发先写业务后写审计，故障时二者原子性需另行改造或确认；本轮只记录。

### REQ-INT-M13-04 · 禁用与恢复普通账号但不复活旧设备

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：enable恢复账号资格，不恢复被停用前设备、会话或任务租约。

**角色：** 当前有效系统管理员

**触发：** users disable/enable及user disable CLI

#### 前置条件

- 目标为普通账号；禁用不能针对自身或任何系统管理员。

#### 主流程

- 禁用active目标，清空绑定token并审计；已disabled返回现有结果。
- 恢复在有序用户行锁事务中再次验管理员/目标。
- 目标未注销且非待注销才能恢复，撤销旧设备后置active、清空绑定token并审计。

#### 业务规则

- BR-INT-M13-04：enable恢复账号资格，不恢复被停用前设备、会话或任务租约。
- BR-INT-M13-04：disable路径与enable事务结构不同，不能以一条错误消息当作所有副作用的证明。

#### 状态变化/保留

- active→disabled或disabled→active；enable撤销所有旧设备并清空绑定token。

#### 数据契约

- 返回user_code/status；注销后的恢复不在此能力内。

#### 异常与边界

- 条件：注销/待注销目标或系统管理员；处理：恢复拒绝；管理员恢复需本机维护。
- 条件：已active恢复；处理：返回当前状态，不重新激活凭据。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-04-AC01` | 恢复账号不复活旧设备凭据。 |
| `REQ-INT-M13-04-AC02` | 不能禁用管理员或恢复注销账号。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-04-AC01** · automated

- 前提/数据/权限：准备disabled普通U及旧设备、会话/租约，管理员A。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. A enable U。
  2. 以旧设备凭据请求受保护API。
- 观察结果：U active；旧设备仍撤销/失效，旧认证不能恢复。

**REQ-INT-M13-04-AC02** · automated

- 前提/数据/权限：独立准备管理员目标B与pending_deletion普通U。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 分别disable B、enable U。
- 观察结果：均拒绝，身份状态及凭据保持基线。

#### 来源与已有测试定义

- `packages/application/src/user-use-cases.ts:231-288`；SHA-256 `98ed8fc245a2b42a08f4eecaaac1d8481c2415861d3575587b6d3fb84fb20d45`
- `apps/core-api/src/routes/users.ts:29-40`；SHA-256 `ee3d01aceaefcbc20e1e57ccd5c00fb178ba25b88e1a613e374456a4386c8e01`

- `apps/core-api/tests/admin-governance.test.mjs` · reenabling normal users is audited, refuses deletion, and cannot revive old device credentials · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M13-05 · 以服务器本机命令恢复管理员初始口令

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：本机维护授权不是已认证管理员会话：审计明确auth_method=local_database_operator和actor_authenticated=false。

**角色：** 有数据库与服务器操作权限的本机维护者

**触发：** tsp admin:reset-password

#### 前置条件

- 显式TSP_ALLOW_LOCAL_ADMIN_RESET=1及本机数据库连接；目标是active且未注销/待注销管理员；本机操作员及主机名非空。

#### 主流程

- CLI默认仅在TTY生成和显示随机口令；自动化须--password-stdin安全管道，输入最多1024字节且单行8–128字符，不经HTTP。
- 锁设备授权请求表与管理员行，撤销pending/approved授权及所有设备。
- 重设有到期且必须修改的密码，清除登录锁/绑定token/对应账号限流，记录本机维护审计。

#### 业务规则

- BR-INT-M13-05：本机维护授权不是已认证管理员会话：审计明确auth_method=local_database_operator和actor_authenticated=false。
- BR-INT-M13-05：恢复必须撤销并发已批准设备授权，避免旧凭据重新产生会话。

#### 状态变化/保留

- 密码更换、must_change_password=true、到期、设备/授权撤销、登录失败状态清理在事务内完成。

#### 数据契约

- 新口令不通过HTTP路由、命令行参数或JSON输出；默认临时明文只显示TTY，stdin模式不回显。恢复TTL默认30分钟，配置允许1–1440分钟；普通用户15分钟不随此配置改变。

#### 异常与边界

- 条件：普通账号或无效管理员、口令长度不8–128；处理：拒绝，不执行恢复。
- 条件：数据库错误；处理：返回安全通用失败，不输出连接凭据。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-05-AC01` | 本机恢复撤销设备及待兑换授权。 |
| `REQ-INT-M13-05-AC02` | 普通用户不能经该维护函数被升为管理员。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-05-AC01** · automated

- 前提/数据/权限：准备active管理员A、旧设备与approved/pending授权；隔离数据库和受控TTL配置，维护者身份明确。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 调用本地恢复函数/CLI安全输入路径。
  2. 检查密码到期、设备、授权和审计元数据。
- 观察结果：所有旧设备失效、授权denied、must_change_password=true；审计明确非会话本机身份，无口令明文。

**REQ-INT-M13-05-AC02** · automated

- 前提/数据/权限：准备active非管理员U与合法维护输入。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 调用resetLocalAdminPassword针对U。
- 观察结果：拒绝；U权限、密码及设备均不变。

#### 来源与已有测试定义

- `packages/application/src/admin-recovery.ts:15-60`；SHA-256 `dc5d2060d1ebd5e7c6dde92946ce866ef5c327c6edb95108c62b942a0ac19473`
- `packages/application/src/bootstrap-config.ts:3-11`；SHA-256 `09f3cc7e77292befbf97be3431e37e123c9dc61b7c190f3e890525d365008aa1`
- `apps/cli/src/admin-recovery.ts:1-74`；SHA-256 `089825b208b9ff52978554256575622bdfb61bd0ef605a60c3faca8151228805`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M13-06 · 以CAS管理安全公开地址并向客户端投影

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：公开地址配置不是凭据仓库，client-config不泄露管理员修改元数据。

**角色：** 系统管理员编辑；active用户读取客户端地址

**触发：** GET/PUT admin/settings；GET platform/client-config

#### 前置条件

- 真实会话；更新携带两个地址字段与非负base_revision，无未知字段。

#### 主流程

- 校验HTTPS，允许loopback HTTP；禁止凭据、query、fragment、控制符与shell字符。
- Web地址仅根路径，API允许受限普通路径段。
- 锁单例配置CAS，仅实际变化revision+1并审计；客户端仅返回两个公开URL。

#### 业务规则

- BR-INT-M13-06：公开地址配置不是凭据仓库，client-config不泄露管理员修改元数据。
- BR-INT-M13-06：相同值更新不增加revision。

#### 状态变化/保留

- 单例配置revision+1或no-op；客户端读取无状态变化。

#### 数据契约

- public_web_url/public_api_url/base_revision；两个字段必须完整提供。

#### 异常与边界

- 条件：旧版本、非本机HTTP或恶意路径编码；处理：拒绝。
- 条件：地址null/空；处理：归一为null；不生成危险命令片段。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-06-AC01` | 恶意地址无法进入客户端安装命令。 |
| `REQ-INT-M13-06-AC02` | 同值写入不增加版本，旧CAS冲突。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-06-AC01** · automated

- 前提/数据/权限：准备管理员与revision0配置。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. PUT API地址含用户名密码或分号，两个字段和base0完整。
- 观察结果：settings_url_invalid；配置revision0和值不变。

**REQ-INT-M13-06-AC02** · automated

- 前提/数据/权限：准备revision2合法地址。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 相同地址/base2 PUT。
  2. 随后实际改值/base2成功，再用旧base2写另一地址。
- 观察结果：第一次仍2，变化到3；旧请求冲突且保留3。

#### 来源与已有测试定义

- `packages/application/src/system-settings-use-cases.ts:18-112`；SHA-256 `756216e09750126b02e8af2d917535f45029c83e016ac646b45333434e1d1f47`
- `apps/core-api/src/routes/system-settings.ts:6-20`；SHA-256 `b7b14fe9412a0baf33613e9a3907a5753e0428520506062da853b63534a086ec`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M13-07 · 分页导出固定上界的脱敏全局审计

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：快照上界避免新写审计混入同一次翻页；ID排序不等于按timestamp排序。

**角色：** 有效系统管理员

**触发：** audit:export --since / GET audit/export

#### 前置条件

- 真实会话；since格式和真实日期有效，limit1–500，cursor/snapshot为合法大整数ID。

#### 主流程

- 首读固定snapshot最大审计ID，以since含起点与cursor开区间筛选。
- 按ID升序、limit+1返回next_cursor；后续沿用snapshot。
- 解析历史payload并递归脱敏凭据键、结构JSON及已知密钥/URL/文本模式；坏JSON标明确redacted。

#### 业务规则

- BR-INT-M13-07：快照上界避免新写审计混入同一次翻页；ID排序不等于按timestamp排序。
- BR-INT-M13-07：脱敏规则不是客户正文访问授权，也不保证所有任意自然语言正文被语义脱敏；支持授权仍未实现。

#### 状态变化/保留

- 只读；不修改或删除原审计。

#### 数据契约

- NDJSON CLI流与API分页items/snapshot/next_cursor；大整数转字符串。

#### 异常与边界

- 条件：普通项目Owner或失效管理员；处理：拒绝全局导出。
- 条件：非法日期/游标/分页；处理：拒绝，不能转无界导出。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-07-AC01` | 首屏后的新事件不进入同一snapshot后续页。 |
| `REQ-INT-M13-07-AC02` | 历史嵌套凭据和坏JSON不原样输出。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-07-AC01** · automated

- 前提/数据/权限：准备管理员与三条since之后事件，limit2，受控顺序ID；本案例顺序执行。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 取首屏保存snapshot。
  2. 插入第四条事件后用原snapshot/cursor取下一页。
- 观察结果：只返回原上界内剩余事件；第四条不混入，分页无重复。

**REQ-INT-M13-07-AC02** · automated

- 前提/数据/权限：准备带token键、Bearer文本、含凭据URL与非法payload JSON的审计测试行。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 导出并扫描响应及CLI输出。
- 观察结果：已知敏感模式被REDACTED，坏JSON有明确标记；原表不变。

#### 来源与已有测试定义

- `packages/application/src/audit-export.ts:1-33`；SHA-256 `5b1b19f315794fce7a43cc101fa2241113c67b6cc61dee29861ea11f4a3ad7c1`
- `packages/application/src/audit-redaction.ts:1-17`；SHA-256 `e15f66dff49b9263571527f1adada334347663e7cf729f31993873019af6f152`
- `apps/core-api/src/routes/audit.ts:1-19`；SHA-256 `1cdbfd345d048939290be2017f1bb6f657f0c2b9d964880578b357b5331c4644`
- `apps/cli/src/audit-export.ts:1-29`；SHA-256 `a45f577d9123668f6a5ccf2a417fc5b03495f6bfc74b6d2baee355b947bfc10a`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 未证明审计payload任意自然语言完全不含客户正文；当前脱敏不能替代限客户、限时、附原因的支持授权。

### REQ-INT-M13-08 · 提供有权限的汇总指标和最小健康信息

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：指标不含用户、项目标题、指令或正文；成功率衡量生成完成，不等同采用率或业务正确率。

**角色：** 系统管理员读metrics；匿名探针读health/ready

**触发：** GET metrics/health/ready 与CSP报告

#### 前置条件

- metrics需有效会话及系统管理员；匿名接口仅准确白名单方法/路径。

#### 主流程

- 记录有限method/route/status请求指标、延迟、连接池、任务及系统Agent状态计数。
- metrics以受限聚合返回，生成成功率=(awaiting_review+applied+rejected)/(这些+failed)，无完成为0。
- ready验证数据库和迁移就绪，health返回进程/合约静态事实；CSP报告仅允许有限directive日志，16KiB/120条每分钟。

#### 业务规则

- BR-INT-M13-08：指标不含用户、项目标题、指令或正文；成功率衡量生成完成，不等同采用率或业务正确率。
- BR-INT-M13-08：API CSP默认report-only，仅TSP_CSP_MODE=enforce强制；HSTS只在实际HTTPS请求设置，不信任转发头。

#### 状态变化/保留

- 只变运行指标和有限安全遥测；无业务数据更改。

#### 数据契约

- server默认bodyLimit1MiB；CSP报告16KiB；每route更大预算须显式override，应用上限不能替代HTTP边界。

#### 异常与边界

- 条件：metrics数据库/采集异常；处理：503；权限不足403，不泄露连接错误。
- 条件：ready依赖不就绪；处理：503 not_ready，health不据此宣称数据库ready。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-08-AC01` | 普通用户看不到全局指标，匿名健康不泄露依赖错误。 |
| `REQ-INT-M13-08-AC02` | 生成率按固定状态口径且不按采用率计算。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-08-AC01** · automated

- 前提/数据/权限：准备非管理员会话；模拟数据库探针失败，记录私有错误哨兵。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 调用metrics、health、ready。
- 观察结果：metrics403；health静态ok；ready503 not_ready且无错误哨兵/凭据。

**REQ-INT-M13-08-AC02** · automated

- 前提/数据/权限：准备awaiting_review2、applied1、rejected1、failed4、cancelled5，管理员。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. GET metrics并读取成功率。
- 观察结果：生成率0.5；cancelled与queued不进入分母，响应无正文/指令。

#### 来源与已有测试定义

- `apps/core-api/src/metrics.ts:9-66`；SHA-256 `71530541540cb0c55d057450e4a38c0999ec4ad294c3be04ef29b5c859c3a5be`
- `packages/application/src/operational-metrics.ts:4-15`；SHA-256 `b013f7397b7619494f478578e3b7e4e9d3624816edd80525193d5a910ea6265e`
- `apps/core-api/src/server.ts:166-188`；SHA-256 `3fbcd5a893c1cb70e93bc36ade9ad6b36b6d280abab823fc941386527ee19ada`
- `apps/core-api/src/security-headers.ts:4-33`；SHA-256 `e813b19fa0ef575830b8a47afccb830087f9942d4a8e0e8ad2bd3228f84542d4`
- `apps/core-api/src/auth.ts:25-34`；SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M13-09 · 在服务器本机运行有界只读完整性检查

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：SQL只读事务是数据库执行约束，不能以CLI描述中的“只读”替代实际事务证据。

**角色：** 有服务器数据库SELECT权限的运维人员

**触发：** db:check-orphans

#### 前置条件

- 显式TSP_DATABASE_URL；migrate:false，不经HTTP，代码内审阅过的静态关系目录。

#### 主流程

- 使用单client repeatable-read read-only事务及整个连接/执行总9秒期限，lock_timeout1秒。
- 执行静态孤儿与跨项目/父链一致性查询，输出规则结果摘要。
- 查询失败回滚并释放/销毁连接，不尝试自动修复。

#### 业务规则

- BR-INT-M13-09：SQL只读事务是数据库执行约束，不能以CLI描述中的“只读”替代实际事务证据。
- BR-INT-M13-09：检查通过只覆盖已审阅规则，不能证明所有嵌套JSON/历史manifest语义或RLS正确。

#### 状态变化/保留

- 只读诊断，无业务状态更改。

#### 数据契约

- 规则目录覆盖已声明父引用与跨域关系；source/head变动要同步目录，输出JSON而非正文。

#### 异常与边界

- 条件：无显式数据库连接或超时/权限不足；处理：安全失败，不自动迁移或写修复。
- 条件：检查返回问题；处理：作为诊断事实报告，不推断客户归属。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-09-AC01` | 即使调用角色有INSERT权限，READ ONLY包装事务仍拒绝对普通持久表写入。 |
| `REQ-INT-M13-09-AC02` | 存在已知孤儿时只报告不自动修复。 |
| `REQ-INT-M13-09-AC03` | 连接/查询总期限到达时中止等待并释放或销毁连接。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-09-AC01** · automated

- 前提/数据/权限：专用可丢弃PostgreSQL库、非临时普通表readonly_guard_probe、非超级用户角色R；R明确获SELECT/INSERT权限。另有连接确认表基线为空；不要使用允许只读事务写入的TEMP表。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 先以R在包装器外普通READ WRITE事务INSERT一行并验证成功，再ROLLBACK，证明权限且恢复空基线。
  2. 以同一R执行withReadOnlySnapshot，先SHOW transaction_read_only，再对同一普通表INSERT。
  3. 捕获SQLSTATE并在外部连接检查行数与连接释放。
- 观察结果：控制INSERT能成功；包装内transaction_read_only=on，INSERT因read-only SQLSTATE 25006拒绝；回滚后表仍空并释放连接。不得用permission_denied当作READ ONLY证明。

**REQ-INT-M13-09-AC02** · automated

- 前提/数据/权限：在可丢弃测试库中以测试设置构造静态规则目录中的孤儿，并记录行摘要。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 运行db:check-orphans。
  2. 重读异常行。
- 观察结果：对应规则报告问题；异常行仍在，未自动删除/迁移。

**REQ-INT-M13-09-AC03** · automated

- 前提/数据/权限：建立可控时钟与PoolClient/连接获取桩，独立覆盖获取连接不返回和work内查询阻塞；断言release/destroy调用；此夹具尚未构建。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 分别使连接获取超过9000ms，或已取得连接后令work阻塞至同一总9000ms预算。
  2. 推进受控时钟并观察错误与客户端清理；解除阻塞检测迟到连接释放。
- 观察结果：按连接或查询deadline安全失败；迟到连接释放，查询超时客户端销毁/释放，不因使用低权限角色而伪证超时机制。

#### 来源与已有测试定义

- `apps/cli/src/db-check-orphans.ts:1-27`；SHA-256 `bb0f4039d506e49fed236e29e515880982dcc665768dabd306089360d9a869ab`
- `packages/persistence/src/read-only-snapshot.ts:5-35`；SHA-256 `119e24194766f4055441ee4fddc9964b53b9eb245515db773c9ba4afa2cca6b6`
- `packages/persistence/src/integrity-check.ts:1-100`；SHA-256 `a191fd59036dd1f9ac1891a720fdfd60a8fa3fca1d6c113e34286459142dc1b7`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 本轮只检视目录及执行边界，没有对真实运行库执行检查；完整动态父链与JSON内部引用仍未验证。

### REQ-INT-M13-10 · 输出待确认客户映射盘点而不回填归属

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：read_complete=true仅指所列元数据读取；ownership_complete=false、ready_for_backfill=false、tenant_id=null。

**角色：** 有完整读取权限的服务器本机运维人员

**触发：** db:plan-tenants

#### 前置条件

- 显式数据库连接；实际表/列与审阅目录及迁移头完全一致，无启用RLS过滤。

#### 主流程

- 在有界只读快照验证schema、SELECT权限及迁移摘要。
- 读取各表计数与有限团队/项目/技能/共享/安装元数据，分区核对总量；关系最多5000，不静默截断。
- 输出fact_digest与pending映射、deferred事项，不读取审计payload/receipt正文或自动归属。

#### 业务规则

- BR-INT-M13-10：read_complete=true仅指所列元数据读取；ownership_complete=false、ready_for_backfill=false、tenant_id=null。
- BR-INT-M13-10：当前代码没有由盘点自动创建客户、邀请或限时正文支持授权；RLS是后续设计目标而不是现有能力。

#### 状态变化/保留

- 纯只读，所有customer_mapping=pending，不修改team/project/skill归属。

#### 数据契约

- 每表计数、公开代码、存在性/跨团队关系及摘要；历史不可变manifest/嵌套JSON明确deferred。

#### 异常与边界

- 条件：schema漂移、RLS、权限不足、结果超上限或分区不完整；处理：拒绝把局部读包装成完整盘点。
- 条件：跨团队共享/安装；处理：标customer_unknown和legacy acceptance未记录，不推断跨客户许可。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-10-AC01` | 完整元数据读仍保持pending且不声称可回填。 |
| `REQ-INT-M13-10-AC02` | 启用RLS或超过5000行关系时拒绝不完整盘点。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-10-AC01** · automated

- 前提/数据/权限：准备schema/迁移匹配的可丢弃数据库、完整SELECT角色、同/跨团队技能共享样本。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 运行planTenantMapping。
  2. 比对前后表摘要及返回标识。
- 观察结果：read_complete=true但ownership_complete=false、ready_for_backfill=false；跨团队customer未知，原数据不变。

**REQ-INT-M13-10-AC02** · automated

- 前提/数据/权限：两个独立测试库基线：一个启用目录表RLS，另一个相关关系5001条。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 分别运行盘点。
- 观察结果：均明确失败，不返回可用于回填的假完整报告。

#### 来源与已有测试定义

- `packages/persistence/src/tenant-inventory.ts:12-53`；SHA-256 `2f8799e5565966496cc08ef6b737807b0f4b577a9a709e886542427560c3eba4`
- `packages/persistence/src/tenant-inventory.ts:74-157`；SHA-256 `2f8799e5565966496cc08ef6b737807b0f4b577a9a709e886542427560c3eba4`
- `apps/cli/src/db-plan-tenants.ts:1-26`；SHA-256 `eddd756cfbbb85b73a3e686e5adfac09a10f478dab717b550995154d09dea6bb`

- `packages/persistence/tests/tenant-inventory.test.mjs` · inventory is pending, complete as a metadata read and never exposes private bodies or invents customer acceptance · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 客户实体、一账号多客户、显式接收方确认共享及限时支持授权已是用户设计方向，但此snapshot不包含其完整运行实现。

### REQ-INT-M13-11 · 以精确公共路径分发CLI清单、脚本和包

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：匿名分发不开放其他配置/业务API；release route仍严格校验文件名。

**角色：** 匿名安装者与平台发布运维人员

**触发：** GET /cli/manifest.json、install.ps1/install.sh、releases/:file

#### 前置条件

- 运维已部署受控distribution目录，manifest schema/version/target/filename/hash元数据合法。

#### 主流程

- 仅公开白名单路径，不挂通用静态目录。
- realpath限制文件直接处于发行目录且为普通文件；manifest投影公共字段，只列实际存在且尺寸匹配的artifact。
- 发行包必须命中清单和受限命名，固定attachment/nosniff/immutable缓存；脚本与清单no-store。

#### 业务规则

- BR-INT-M13-11：匿名分发不开放其他配置/业务API；release route仍严格校验文件名。
- BR-INT-M13-11：服务端清单下载检查文件尺寸而非每次重新计算文件SHA，客户端安装负责校验下载字节。

#### 状态变化/保留

- 只读分发；不创建用户、项目绑定或运行工作空间。

#### 数据契约

- 平台win32/linux/darwin，arch x64/arm64，Node22；zip或tar.gz格式与平台/filename一致；JSON及TSV清单。

#### 异常与边界

- 条件：清单/脚本不可用；处理：503，不暴露本机路径或运行配置。
- 条件：文件不在清单、尺寸不一致、目录逃逸/链接目标不在目录；处理：404或不可用，不传包。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-11-AC01` | 清单过滤缺失包且不泄露任意JSON字段。 |
| `REQ-INT-M13-11-AC02` | 未列入清单或目录外链接不可下载。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-11-AC01** · automated

- 前提/数据/权限：准备临时发行目录、合法清单含一个存在包和一个缺失包，额外secret字段作测试哨兵。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 匿名GET manifest.json与format=tsv。
- 观察结果：只列可用尺寸匹配artifact，无哨兵；响应no-store。

**REQ-INT-M13-11-AC02** · automated

- 前提/数据/权限：准备合法发行清单，另放未列名包及指向目录外的同名链接，分别独立目录基线。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 匿名GET对应release路径。
- 观察结果：404/不可用，无目录外或未授权文件字节。

#### 来源与已有测试定义

- `apps/core-api/src/routes/cli-distribution.ts:7-74`；SHA-256 `dfdd2173753e952b026c73c01780bf2c17879e03a7100743bc078b6e83dcdb41`
- `apps/core-api/src/auth.ts:29-34`；SHA-256 `2d8853681318747f759f32a19c961bd7fe260e9ae9dc6a587221e68b01de5bd8`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M13-12 · 在本机校验CLI包并按托管版本安装

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：摘要验证先于执行/激活；更新保留版本目录，不改用户项目源码和平台绑定。

**角色：** Windows或POSIX本机用户

**触发：** install.ps1 / install.sh

#### 前置条件

- HTTPS API地址，loopback可HTTP；托管安装目录或新目录，禁止根目录、危险路径与链接。

#### 主流程

- 选择唯一匹配平台/架构artifact并获取安装锁、临时stage。
- 下载后验证实际字节数和SHA-256，在解压前拒绝路径穿越与链接。
- 解压后只显式检查runtime/node(.exe)与apps/cli/dist/index.js存在；随后移动到新版本目录、写tsp/agentd shim与平台标记，按选项更新PATH并清理stage/锁。

#### 业务规则

- BR-INT-M13-12：摘要验证先于执行/激活；更新保留版本目录，不改用户项目源码和平台绑定。
- BR-INT-M13-12：--no-modify-path/NoModifyPath明确避免持久PATH修改；安装脚本是本机执行代码，平台仅分发。
- BR-INT-M13-12：两文件存在检查不证明agentd入口、launcher或依赖齐全；POSIX后续chmod引用launcher可能暴露部分缺失，但不是完整载荷验证。

#### 状态变化/保留

- 本机versions/shim/托管标记及可选PATH变化；服务端业务不变。

#### 数据契约

- Windows托管标记.tsp-install.json；POSIX为.tsp-install，首行为team-synergy-cli。两者均有安装锁、stage、versions、bin；Windows检查路径reparse point，POSIX归档拒绝软/硬链接。
- 观测到的载荷检查仅runtime/node(.exe)与apps/cli/dist/index.js；不能把文件存在当作Node/CLI/agentd可成功执行的证明。

#### 异常与边界

- 条件：摘要/长度错误、非托管旧目录、并行安装锁或危险归档；处理：失败，不替换现有可执行版本。
- 条件：不支持平台/架构；处理：明确失败，不随意使用另一目标包。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-12-AC01` | 摘要不符不替换原CLI。 |
| `REQ-INT-M13-12-AC02` | 穿越或链接归档在解压前拒绝。 |
| `REQ-INT-M13-12-AC03` | 两文件检查通过不能证明已激活agentd可运行。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-12-AC01** · automated

- 前提/数据/权限：准备托管安装目录已运行版本V1、可控HTTP测试发行服务仅loopback，包摘要与清单不符；先记录shim/V1摘要。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 运行安装脚本并捕获退出状态。
  2. 检查shim/V1及stage清理。
- 观察结果：失败；原shim和V1保持；不执行坏包、无项目文件变化。

**REQ-INT-M13-12-AC02** · automated

- 前提/数据/权限：分别为两脚本准备可信摘要但内含../条目或链接的测试包，独立临时安装根。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 运行安装。
  2. 检查安装根以外哨兵与versions。
- 观察结果：拒绝；外部路径不变、未激活新版本。

**REQ-INT-M13-12-AC03** · automated

- 前提/数据/权限：未来发行故障夹具：从完整测试包复制，保留runtime/node(.exe)、apps/cli/dist/index.js及tsp/agentd平台launchers，移除apps/agentd/dist/index.js；为改包重新计算合法测试清单摘要/大小，独立临时托管目录，loopback测试发行服务。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 在Windows/POSIX各自隔离环境运行对应安装器，不引入摘要或路径错误。
  2. 观察安装结果、shim与平台标记。
  3. 安装若激活，再调用测试agentd launcher并捕获缺入口失败。
- 观察结果：按静态代码预期，两项显式存在检查都通过；当前流程可能写shim/标记并激活，随后agentd因缺入口失败。此场景揭示缺口，不要求当前安装器尚未实现的完整性拒绝；未实际执行。

#### 来源与已有测试定义

- `scripts/cli-install/install.ps1:1-87`；SHA-256 `9cab5570cf3f5e30139422f0033324c95925f57ced690dad7a6744b4bc279298`
- `scripts/cli-install/install.sh:1-92`；SHA-256 `edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f`
- `scripts/cli-install/install.ps1:57-72`；SHA-256 `9cab5570cf3f5e30139422f0033324c95925f57ced690dad7a6744b4bc279298`
- `scripts/cli-install/install.sh:33-40`；SHA-256 `edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f`
- `scripts/cli-install/install.sh:68-80`；SHA-256 `edc9166066a2ffea736faf22db4acddecb442fcfc4efc5b9b2cbacfaf716df1f`
- `scripts/build-cli-distribution.mjs:119-122`；SHA-256 `991f78a2a3371742660b4ea133bc3b812d2564c6802a6c81a4905ba7233fd14e`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 本轮未在三种操作系统真实执行安装；脚本跨平台兼容性与网络可用性仍需实际发布测试。
- 当前安装器未完整校验agentd入口、launchers和依赖；缺失agentd入口但保留launchers及两检查文件的包仍可能被激活，须未来完整载荷验证改造。POSIX缺launcher可能在后续chmod阶段失败，不能据此声称解压后做过全量预检。

### REQ-INT-M13-13 · 按隐私哈希有界聚合登录安全事件

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：只返回哈希分组与汇总次数，不还原账号/IP；未知IP可为null组。

**角色：** 有效系统管理员

**触发：** GET /admin/security/login-events

#### 前置条件

- 真实会话；先判管理员再校验查询参数，非管理员不获查询细节。

#### 主流程

- 按account或ip哈希分组，缺省取数据库时钟为until、其前24小时为since。
- 验证时间窗口最多31天、limit1–200、offset0–100000及64位十六进制过滤hash。
- 统计登录失败、锁定、解锁，按失败数降序再key升序，返回分组总数及分页信息。

#### 业务规则

- BR-INT-M13-13：只返回哈希分组与汇总次数，不还原账号/IP；未知IP可为null组。
- BR-INT-M13-13：时间过滤使用含起止边界；未传until依据数据库时钟，不能假设与API主机时钟完全一致。

#### 状态变化/保留

- 只读安全遥测；不修改用户锁定状态或清理事件。

#### 数据契约

- group_by/since/until/limit/offset/account_hash/ip_hash；items.key/login_failures/locks/unlocks及total/has_more。

#### 异常与边界

- 条件：未知参数、非法时间/哈希或超窗口；处理：400 validation_failed；无效管理员403。
- 条件：数据库查询错误；处理：503安全通用失败，不暴露原始账号/IP或SQL。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M13-13-AC01` | 默认24小时窗口与确定排序基于数据库时间。 |
| `REQ-INT-M13-13-AC02` | 非管理员的非法查询先返回权限错误。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M13-13-AC01** · automated

- 前提/数据/权限：准备数据库时钟固定T，账号hashA/B失败次数相同、hash顺序A&lt;B，另有T-25h事件；管理员。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 不传时间、limit1查询。
  2. 用响应since/until、offset1读取下一页。
- 观察结果：窗口为[T-24h,T]，排除旧事件；同计数按hash排序，分页和total正确，响应无原始账号/IP。

**REQ-INT-M13-13-AC02** · automated

- 前提/数据/权限：准备有效非管理员会话，查询同时带未知参数和无效日期。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. GET login-events。
- 观察结果：403 admin_forbidden；不是参数细节400，未泄露安全汇总。

#### 来源与已有测试定义

- `packages/application/src/login-security.ts:12-20`；SHA-256 `ca972cfb9324d1417f4d8dd35e3d6e8ad2df3e471507f5be932f5db9e0761379`
- `packages/application/src/login-security.ts:54-92`；SHA-256 `ca972cfb9324d1417f4d8dd35e3d6e8ad2df3e471507f5be932f5db9e0761379`
- `apps/core-api/src/routes/login-security.ts:6-20`；SHA-256 `1e39acdcf081953609b64f2916aafb4d1c224bd533ed4bdfa4726bb0496b296c`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

## M14 · 项目代码理解与插件知识

对应平台父模块：`INT-MODULE-M14`。稳定业务章节用于阅读，平台父关系与既有绑定保持。

### REQ-INT-M14-01 · 注册旁路插件并锁定兼容版本和摘要

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：当前adapter明确支持UA2.9.8/codegraph1.6.2，插件式并不等于任意上游版本即刻兼容。

**角色：** 本机Agent或工作空间用户

**触发：** code plugins list/doctor/register 与分析prepare

#### 前置条件

- 本机安装UA/codegraph及需要的runtime；登记路径在本机配置中，不能将其当源码上传。

#### 主流程

- inspect辨认引擎版本并计算引擎/依赖/runtime摘要。
- 登记为本机旁路插件，不复制修改上游源码。
- 分析锁入plugin_id、version、adapter/protocol与digest；执行前复验全部锁定内容。

#### 业务规则

- BR-INT-M14-01：当前adapter明确支持UA2.9.8/codegraph1.6.2，插件式并不等于任意上游版本即刻兼容。
- BR-INT-M14-01：更新通过兼容检查和新run接入，避免旧分析身份含糊。

#### 状态变化/保留

- 本机registry更新；分析持久记录固定plugin locks，项目源码不变。

#### 数据契约

- plugins.json本机路径，plugin_id/version/engine_digest/adapter_version/protocol_version；注册不是工具目录/密钥配置上传接口；不得据此推导产物自由文本得到通用隐私保证。

#### 异常与边界

- 条件：版本不受支持、文件/依赖/runtime摘要漂移；处理：拒绝执行，不能静默换新版本继续旧run。
- 条件：插件升级；处理：另行注册兼容版本并新建分析，旧run继续保留旧锁。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M14-01-AC01` | 运行后插件字节漂移阻止继续旧run。 |
| `REQ-INT-M14-01-AC02` | 不支持版本不能被标为已兼容。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M14-01-AC01** · automated

- 前提/数据/权限：准备受支持插件并完成inspect/register与run锁；使用隔离工具副本。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 修改副本一个受摘要覆盖文件。
  2. 继续resume或publish。
- 观察结果：digest不匹配拒绝，旧run固定锁及产物不被新字节冒充。

**REQ-INT-M14-01-AC02** · automated

- 前提/数据/权限：准备版本号超出支持范围的工具副本。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. inspect/register并prepare。
- 观察结果：明确拒绝或显示不兼容；不启动错误引擎写入有效分析。

#### 来源与已有测试定义

- `apps/cli/src/code-understanding-plugins.ts:90-154`；SHA-256 `71605fed4bc11579fda464dbde8bd003c14dff7f0c9ddb16aa77e0325f42dcf1`
- `apps/cli/src/code-understanding.ts:101-128`；SHA-256 `d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 尚未为未来UA/codegraph版本做兼容测试；升级需维护adapter与reader构建契约。

### REQ-INT-M14-02 · 捕获提交快照与显式草稿快照

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：branch名是浮动标签，真正版本由commit或draft内容manifest/snapshot定义。

**角色：** 有项目write权限并拥有绑定workspace的当前用户

**触发：** code analyze prepare [--workspace-draft --include-untracked]

#### 前置条件

- 真实Git仓库与当前项目repository绑定；默认提交快照，草稿需显式。

#### 主流程

- 提交模式按固定Git对象读取文件；草稿模式对安全tracked与显式untracked做两次一致扫描。
- 按路径/类型/大小/敏感规则筛选，记录排除；保存manifest与快照身份。
- 后续操作逐文件复验完整集合和摘要，拒绝额外文件/链接或身份漂移。

#### 业务规则

- BR-INT-M14-02：branch名是浮动标签，真正版本由commit或draft内容manifest/snapshot定义。
- BR-INT-M14-02：草稿与提交分析分离，EOL字节变化必须新摘要，不沿用旧证据hash。

#### 状态变化/保留

- 本机只读捕获后创建不可变source缓存；不git commit、reset或修改用户源码。

#### 数据契约

- snapshot kind/commit/branch/dirty/files/manifest，scope和排除；draft包含未提交内容但不覆盖提交视图。

#### 异常与边界

- 条件：快照漂移/链接/文件超2MiB、总量超128MiB；处理：拒绝或记录排除，不能混入浮动checkout。
- 条件：未显式include-untracked；处理：不把所有新文件自动视为已捕获。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M14-02-AC01` | 默认提交快照不误取本机未提交正文。 |
| `REQ-INT-M14-02-AC02` | 复验拒绝快照额外文件与目录链接。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M14-02-AC01** · automated

- 前提/数据/权限：准备Git提交C含f=v1，工作树f=v2并有untracked g；绑定与权限有效。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 默认prepare。
  2. 再独立prepare显式draft+include-untracked。
- 观察结果：默认source f=v1且无g；draft f=v2且含安全g，二者snapshot不同，原工作树不变。

**REQ-INT-M14-02-AC02** · automated

- 前提/数据/权限：准备有效捕获缓存副本，分别添加额外源码或目录链接。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 在对应副本执行snapshot验证/后续CLI。
- 观察结果：失败，不上传漂移来源或读取链接目标。

#### 来源与已有测试定义

- `apps/cli/src/code-understanding-snapshot.ts:26-112`；SHA-256 `4699f4308d3e615009be35781c8b52029569dc2f73371d9c490ff639dc2980e9`
- `apps/cli/src/code-understanding.ts:130-164`；SHA-256 `d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M14-03 · 以创建者和版本控制分析生命周期及检查点

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：没有项目冻结状态；awaiting_agent是分析批次等待解释，不阻止项目开发。

**角色：** run创建者；其他项目协作者只有相应读取/视图权

**触发：** code analyze prepare/checkpoint/resume/status/cancel 与progress API

#### 前置条件

- 当前有效projectwrite；repository active且workspace属于当前principal。

#### 主流程

- register以project/creator/idempotency_key固定输入，精确回放同run，输入改变冲突。
- 本机扫描/索引完成进入awaiting_agent；当前Agent根据材料提交UA checkpoint。
- 检查点验证snapshot/batch/input_digest和expected revision；服务端progress拒绝倒退或终态后推进。

#### 业务规则

- BR-INT-M14-03：没有项目冻结状态；awaiting_agent是分析批次等待解释，不阻止项目开发。
- BR-INT-M14-03：已提交进度精确重试可返回，修改内容不能冒用相同版本。
- BR-INT-M14-03：非终态允许前向跳转，除preparing/failed/cancelled外推进必须已有或提交snapshot；状态序列不是严格逐阶段工作流。

#### 状态变化/保留

- 注册保存preparing；实际enum为preparing/indexing/awaiting_agent/validating/uploading/succeeded/failed/cancelled。扫描/注册是操作说明，不是registered/scanning持久状态。
- progress按顺序禁止向后，满足snapshot与revision条件时可跳过中间非终态；不保证每个阶段都经过。成功由publish写succeeded，failed/cancelled为终态。

#### 数据契约

- run code、revision、progress/checkpoint_digest；CLI局部锁防并发写检查点。

#### 异常与边界

- 条件：非创建者推进/发布；处理：拒绝，即使同项目管理者可读也不取得创建者角色。
- 条件：取消后迟到完成；处理：拒绝发布；旧revision冲突不覆盖其他检查点。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M14-03-AC01` | 相同注册输入回放同run，不同输入同key冲突。 |
| `REQ-INT-M14-03-AC02` | 协作者不能推进或发布他人run。 |
| `REQ-INT-M14-03-AC03` | 注册为preparing，合法前向跳过中间态可接受，向后推进拒绝。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M14-03-AC01** · automated

- 前提/数据/权限：准备项目write创建者A、合法repository/workspace和锁定snapshot。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. register相同key/input两次。
  2. 同key改snapshot重试。
- 观察结果：前两次同run；第三次冲突，原身份不变。

**REQ-INT-M14-03-AC02** · automated

- 前提/数据/权限：准备A创建run、同项目OwnerB，B可读取。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. B progress或publish。
- 观察结果：拒绝创建者边界；run revision/状态不变。

**REQ-INT-M14-03-AC03** · automated

- 前提/数据/权限：建立创建者A与合法repo/workspace注册夹具；准备可通过身份校验的固定snapshot；每次独立新run，保存当前revision。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. register并读status。
  2. 直接从preparing以正确expected_revision携带snapshot提交uploading。
  3. 再以最新revision提交indexing。
- 观察结果：初始preparing；满足其他条件的前向跳转到uploading可成功，不需先经过indexing/awaiting_agent/validating；回退indexing冲突且保持uploading。

#### 来源与已有测试定义

- `packages/application/src/code-understanding-use-cases.ts:105-145`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`
- `apps/cli/src/code-understanding.ts:56-76`；SHA-256 `d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4`
- `apps/cli/src/code-understanding.ts:130-205`；SHA-256 `d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4`
- `packages/contracts/src/code-understanding.ts:41-44`；SHA-256 `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`
- `packages/application/src/code-understanding-use-cases.ts:119-136`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M14-04 · 发布经结构与证据预算验证的图产物

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：发布执行严格结构/身份、单片段与累计预算和有限敏感模式检查；不等同通用隐私证明。

**角色：** run创建者且当前仍有write权限

**触发：** code analyze validate/publish 与publish API

#### 前置条件

- 快照、插件及本机产物验证通过；完整UA解释与图关系合法。

#### 主流程

- 校验严格图/UA字段、路径/行号/引用、已知敏感文本模式及明确的证据预算；不是完整隐私或语义验证。
- 生成统一UA/CG结构及受限证据片段；设计上完整原始快照留本机，但自由文本仍需Agent/审阅者检查。
- 服务端复验snapshot、可选ua_graph精确整文件字符串筛查及跨run累计片段预算后存成功artifact；相同成功artifact回放幂等。

#### 业务规则

- BR-INT-M14-04：每个含snippet证据最多1200字符、行区间至多30行且不可覆盖整文件；无snippet的定位行号不是正文片段。
- BR-INT-M14-04：单artifact按path累计片段最多2400字符、60个不同行且少于源文件总行数；服务端跨run按project+file SHA累计不同片段声明，同摘要改路径不重置预算，完全相同声明去重。
- BR-INT-M14-04：已知路径/凭据模式筛查覆盖产物字符串；额外整源码检查只递归可选ua_graph的字符串，对已知≥16字节文件做整字节hash相等判断，不是分段/变形/任意自由文本的DLP证明。
- BR-INT-M14-04：schema当前最多25000节点/100000边/20000证据，HTTP 32MiB；解释仍为inferred，不因发布自动变代码事实或业务批准。

#### 状态变化/保留

- run→succeeded并锁artifact_sha256；默认view不随publish改变。

#### 数据契约

- graph_identity、snapshot、plugin locks、artifact_sha256及provenance字段必须符合严格schema与引用；已知模式和精确hash筛查只覆盖各自明确条件。
- 服务端可保存受schema允许的自由文本；不能承诺其中不可能出现任意源码或私密语义。人工/Agent审核仍需独立判断，不新增已实现DLP声明。

#### 异常与边界

- 条件：严格字段/引用/身份/已知敏感模式或片段预算校验失败；处理：拒绝发布；可选ua_graph中字符串与已知≥16字节文件整字节摘要精确相同时亦拒绝。这些有限机制不能推导任意私密内容必然被发现。
- 条件：成功run换不同artifact重传；处理：冲突，不替换不可变结果。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M14-04-AC01` | 重复run或改路径不能突破同源摘要片段总预算。 |
| `REQ-INT-M14-04-AC02` | 发布成功不自动切换项目当前视图。 |
| `REQ-INT-M14-04-AC03` | 单片段1200字符可符合schema，1201字符拒绝；不混用累计2400阈值。 |
| `REQ-INT-M14-04-AC04` | 含snippet的30行区间可符合范围限制，31行拒绝。 |
| `REQ-INT-M14-04-AC05` | 有限已知模式与可选UA整字节筛查可触发拒绝，但不证明通用私密内容阻断。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M14-04-AC01** · automated

- 前提/数据/权限：准备同项目两个run引用相同文件字节但路径不同；第一run已用部分预算。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 对第二run提交超累计预算片段。
- 观察结果：拒绝；无成功artifact或额外泄露；既有run不变。

**REQ-INT-M14-04-AC02** · automated

- 前提/数据/权限：准备现有current committed视图V与新成功候选run R。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. publish R并重读context选择。
- 观察结果：R succeeded且artifact固定；当前指针仍V，直到明确compose/select。

**REQ-INT-M14-04-AC03** · automated

- 前提/数据/权限：建设纯契约合法图夹具与行数&gt;100的源manifest；每变体只有一个snippet、行区间&lt;30且不覆盖全文，无敏感模式；清除累计影响，必要DB发布另建独立项目。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 对一个1200字符snippet运行CodeEvidenceSchema及validateCodeArtifact。
  2. 独立变体仅把snippet改为1201字符，其他身份/行数保持合法。
- 观察结果：1200字符变体通过该长度条件且其余条件独立合法；1201在schema长度校验拒绝，不能因小于2400而允许。

**REQ-INT-M14-04-AC04** · automated

- 前提/数据/权限：独立纯契约夹具：源文件&gt;100行，短文本snippet≤1200字符且其换行数不超声明区间，不覆盖全文件；只有一条证据。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 构造line_start=10,line_end=39，验证合法图。
  2. 独立变体改end=40，其余合法。
- 观察结果：30行变体满足单范围条件；31行因range差值达到30而拒绝，不以累计60行替代单范围限制。

**REQ-INT-M14-04-AC05** · automated

- 前提/数据/权限：未来隔离发布夹具：创建者当前write且run可发布，expected_revision正确；合法snapshot含一份公开、无敏感模式、UTF-8原始字节≥16字节且全文可放入summary上限的短测试文件，记录byte_count/SHA与换行字节。图的native UA与projected UA身份、名称、路径、范围、证据、层、边与tour均一致；无snippet累计预算影响。先建设并校验专用可丢弃夹具，夹具尚未创建，计划not_run。各变体从独立基线重建。
- 操作：
  1. 变体一在允许字符串字段放入由测试代码拼接的已知凭据模式哨兵，验证已知模式拒绝；此变体独立于整文件hash用例。
  2. 变体二选定ua_graph.nodes中的合法节点，将其summary与artifact.nodes中同native_id的provider='ua'投影节点summary同时设为测试文件完整原始字符串；保持其余投影、证据、layer/edge/tour、snapshot与run条件合法。
  3. 发布前分别断言CodeArtifactSchema.safeParse成功且validateCodeArtifact(artifact,snapshot)返回空issues；若不成立则该夹具无效，不把投影/预算/身份拒绝当作hash筛查证据。
  4. 只在上述控制成立后，以正确expected_revision调用publish，断言错误原因精确包含UA metadata contains complete source bytes，并重读确认未保存成功artifact。
  5. 记录分段、变形及非UA自由文本语义仍未覆盖，不将两个有限机制结果扩展为通用DLP结论。
- 观察结果：已知模式变体按对应模式拒绝；整文件变体先通过严格schema和validateCodeArtifact的全部检查，再以UA metadata contains complete source bytes这个明确原因被publish拒绝，run不进入succeeded。若先发生projection mismatch或其他拒绝，测试失败而非通过。任意私密语义阻断仍unknown；计划not_run，不构成安全证明。

#### 来源与已有测试定义

- `apps/cli/src/code-understanding-plugins.ts:242-321`；SHA-256 `71605fed4bc11579fda464dbde8bd003c14dff7f0c9ddb16aa77e0325f42dcf1`
- `packages/application/src/code-understanding-use-cases.ts:80-100`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`
- `packages/application/src/code-understanding-use-cases.ts:147-161`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`
- `packages/contracts/src/code-understanding.ts:1-162`；SHA-256 `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`
- `apps/core-api/src/routes/code-understanding.ts:1-32`；SHA-256 `d2c8bcf363474fb736078a9191044aac1eed7abb2f0811798b1a45af06fb106d`
- `packages/contracts/src/code-understanding.ts:16-18`；SHA-256 `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`
- `packages/contracts/src/code-understanding.ts:67-83`；SHA-256 `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`
- `packages/contracts/src/code-understanding.ts:131-150`；SHA-256 `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`
- `packages/application/src/code-understanding-use-cases.ts:69-98`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`
- `packages/application/src/code-understanding-use-cases.ts:139-150`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`
- `packages/contracts/src/code-understanding.ts:94-105`；SHA-256 `ca6e7d3bf5aa6d2a3ff3f3bda5e72cdff11149470aa26bed62a1a54aeaf6d696`

- `packages/application/tests/code-understanding.test.mjs` · excerpt budget spans repeated runs and renamed paths for identical source bytes · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 任意自由文本中的分段、编码/变形源码、未匹配模式的私密语义与模型解释正确性未被完整证明；当前有限schema/模式/可选UA精确hash检查不能替代完整DLP或独立语义审查。

### REQ-INT-M14-05 · 组合多仓库不可变视图并分离草稿与提交指针

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：draft指针永不替换committed指针；不带run/view的远端默认查询取current committed。

**角色：** 有项目write权限的有效成员

**触发：** code view compose/select 及view API

#### 前置条件

- 组成run均成功且归同项目与对应repository；base view明确；最多50仓。

#### 主流程

- 以每仓run独立汇总，基于base保留其他仓，任何draft参与则视图为draft。
- 计算不可变内容hash，相同组合可复用结果。
- select用同kind当前指针CAS，已选同view可幂等返回。

#### 业务规则

- BR-INT-M14-05：draft指针永不替换committed指针；不带run/view的远端默认查询取current committed。
- BR-INT-M14-05：多仓汇总不是自动确认跨仓调用，跨仓业务关系必须有明确证据。

#### 状态变化/保留

- 新增immutable view；明确select后仅对应kind selection变化，旧run/view保留。

#### 数据契约

- repository→run映射、kind/content hash、base_view、expected_current_view；branch仅展示标签。

#### 异常与边界

- 条件：跨项目/仓库错配、不成功run；处理：拒绝组合。
- 条件：旧expected current view；处理：冲突，不覆盖并发新选择。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M14-05-AC01` | 草稿选择不覆盖提交选择。 |
| `REQ-INT-M14-05-AC02` | 并发选择旧CAS失败。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M14-05-AC01** · automated

- 前提/数据/权限：准备committed view C已选，draft view D未选，用户有write。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. select D到draft指针。
  2. 查询无run/view默认graph和context。
- 观察结果：committed仍C，draft为D；默认远端读取C。

**REQ-INT-M14-05-AC02** · automated

- 前提/数据/权限：准备同kind当前V1和候选V2/V3，两个用户均write。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. A以expected V1选V2。
  2. B仍以expected V1选V3。
- 观察结果：A成功，B冲突；当前V2，历史V1/V3仍可明确读取。

#### 来源与已有测试定义

- `packages/application/src/code-understanding-use-cases.ts:162-191`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`
- `packages/application/src/code-understanding-use-cases.ts:205-241`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M14-06 · 统一CLI查询整体关系与原生代码符号

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：原生query可在本机awaiting_agent阶段帮助当前Agent；发布后仍读取固定同run来源。

**角色：** 当前有代码知识读取权的Agent

**触发：** code overview/search/node/relations/context/callers/callees/impact/affected-tests

#### 前置条件

- 显式run或view用于版本固定；当前project读权且非Viewer。

#### 主流程

- UA remote查询整体模块/流程，统一graph执行有界过滤与一跳关系。
- 本机codegraph原生query在临时可丢弃index副本执行，验证原始缓存后定位符号/调用影响。
- 返回engine/source、证据身份、分页/裁剪信息，Agent再回查原始源码。

#### 业务规则

- BR-INT-M14-06：原生query可在本机awaiting_agent阶段帮助当前Agent；发布后仍读取固定同run来源。
- BR-INT-M14-06：返回节点ID需真实查询获得；cg前缀与原生ID不能混用/猜造；缺关系或结果裁剪不代表不存在。

#### 状态变化/保留

- query不改变平台run/default view；可丢弃副本与查询日志只在本地。

#### 数据契约

- --run/--view/--engine/--remote/--limit、cg:&lt;native-id&gt;；本机源验证与远端授权均需满足。

#### 异常与边界

- 条件：远端请求不支持的native context/callers等；处理：明确不支持，不伪装投影为原生深层查询。
- 条件：Viewer、无关系统管理员、跨项目run；处理：拒绝，不因知识不是完整源码而放宽正文权限。
- 条件：旧native数据库需要迁移；处理：不修改旧index；拒绝或在可丢弃副本处理支持查询。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M14-06-AC01` | 本机native查询不迁移或修改旧索引。 |
| `REQ-INT-M14-06-AC02` | Viewer与无关管理员不能读代码知识。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M14-06-AC01** · automated

- 前提/数据/权限：准备成功run固定source与native index，记录index摘要；有效用户。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. context取得真实node ID，再callers/callees。
  2. 比较原index与snapshot。
- 观察结果：返回local_native及固定engine身份；原index/源码摘要不变。

**REQ-INT-M14-06-AC02** · automated

- 前提/数据/权限：准备项目Viewer V、非成员系统管理员A和run R。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 分别remote graph/ua-map及本机CLI context。
- 观察结果：拒绝ACL；不返回证据片段或本机native结果。

#### 来源与已有测试定义

- `apps/cli/src/code-understanding.ts:224-258`；SHA-256 `d069017fef7a4637d32d41909af41aa0e7e9a70b4a993338b0ed3dbac64213c4`
- `apps/cli/src/code-understanding-plugins.ts:323-374`；SHA-256 `71605fed4bc11579fda464dbde8bd003c14dff7f0c9ddb16aa77e0325f42dcf1`
- `packages/application/src/code-understanding-use-cases.ts:33-41`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`
- `packages/application/src/code-understanding-use-cases.ts:205-241`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`

- `packages/application/tests/code-understanding.test.mjs` · ACL denies viewer, unrelated system admin and cross-project run IDs; archives preserve read only · `defined`；只检视现有测试定义；本轮未执行。此条不等同业务验收或测试通过。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。

### REQ-INT-M14-07 · 以原生UA阅读整体关系并定位codegraph证据

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：固定UA2.9.8 reader与平台图契约一起测试升级；iframe仅allow-scripts，CSP connect-src none，不访问网络/存储。

**角色：** 有项目代码知识读取权的Web用户

**触发：** 项目“代码理解”页面与native reader

#### 前置条件

- 明确run/view/repository；图为已发布成功原生UA；构建脚本固定UA版本并记录资源摘要，运行加载未比较这些摘要。

#### 主流程

- Web显示快照/commit/draft/插件身份及版本切换。
- ua-map提供完整原生结构；父页面fetch reader.js/css检查HTTP response.ok并读取文本，再置入opaque sandbox iframe的自包含文档。
- 选择模块/域/流程可定位符号、路径行号及限量证据；完整源码仍本机。

#### 业务规则

- BR-INT-M14-07：构建脚本约束UA2.9.8、资源自包含并写摘要，属于构建来源记录；React运行加载只检查HTTP成功，不实施资源摘要校验。iframe仅allow-scripts，文档CSP connect-src none；这些是静态控制配置，未执行实时浏览器安全测试。
- BR-INT-M14-07：Web第一版只查看，解释更新由Agent重分析后发布；图上的业务推断不当成已批准需求。

#### 状态变化/保留

- 页面选择与URL变化；不自动修改run或项目默认view。

#### 数据契约

- ua-map完整nodes/edges/layers/tours；父子桥通道及允许node ID；不向iframe提供平台cookie/API权限。
- 构建manifest中的资源SHA用于provenance记录；当前reader加载路径未消费它作运行完整性判断。

#### 异常与边界

- 条件：reader.js/css HTTP非成功或fetch/read失败；处理：显示资源加载错误；现有运行加载器没有读取manifest并比较资源digest，HTTP200的改动资源不保证触发完整性错误。构建阶段版本/打包检查另行约束。
- 条件：伪造postMessage；处理：按source/channel/node存在性及null origin边界拒绝。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M14-07-AC01` | 原生完整图不受普通分页上限丢失节点。 |
| `REQ-INT-M14-07-AC02` | 外部消息和iframe网络能力不能修改平台。 |
| `REQ-INT-M14-07-AC03` | 运行加载对HTTP失败报错，但没有摘要比较来拒绝HTTP200的变更资源。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M14-07-AC01** · automated

- 前提/数据/权限：准备超过普通graph页节点数的已发布UA图、可读项目用户。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 获取ua-map并在reader打开。
  2. 检索末尾节点、层与tour引用。
- 观察结果：原生图节点/边与artifact对应完整；可定位末尾节点，URL版本身份明确。

**REQ-INT-M14-07-AC02** · automated

- 前提/数据/权限：准备reader隔离页面和测试消息发送者，观察网络/存储。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 发错误source/channel/不存在node的消息。
  2. 在iframe尝试网络连接。
- 观察结果：错误消息忽略、连接被CSP阻断；无平台写请求/选择变化。

**REQ-INT-M14-07-AC03** · automated

- 前提/数据/权限：建设UaNativeReader fetch/文档构造单元夹具，捕获response.ok/text调用与iframe文档；两个独立基线，使用无害测试script标记，不据此测试整个reader渲染。 先建设并校验专用可丢弃夹具；夹具目前未创建，计划not_run。每个变体从独立基线重建，不沿用其他计划残留状态。
- 操作：
  1. 基线一让reader.js返回404，观察加载错误。
  2. 基线二返回200且body为修改过的无害测试script，css亦200；记录构造文档和是否请求/消费digest manifest。
- 观察结果：404产生加载错误；200文本进入资产/文档构造路径，不存在当前代码未实现的digest mismatch拒绝；不据此声称任意变更脚本可完整正常运行或安全。

#### 来源与已有测试定义

- `apps/web/src/UaNativeReader.tsx:1-63`；SHA-256 `9d51872ebca91cdf7b90a04693e46f041a8671b0b257249995f56c524c2fc0a1`
- `apps/web/src/uaReaderBridge.ts:1-36`；SHA-256 `d561d3671f5b16e5498ba9a6dbea9dfc32f05cbd751eb46cede924996d795998`
- `apps/web/ua-reader/bridge.tsx:1-107`；SHA-256 `ab7722a48599be73a2bb8889b999c0dc98acb869c78a3e7c9b96ecaa701ebd43`
- `apps/web/src/CodeUnderstandingWorkbench.tsx:1-148`；SHA-256 `d0bf9a141792b39138cb3c0d8baeb29e960716934cd04ec26b087d143bb8e0cd`
- `scripts/build-ua-reader.mjs:1-118`；SHA-256 `9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3`
- `packages/application/src/code-understanding-use-cases.ts:192-204`；SHA-256 `f240269bc29446003573dbc01595b8eb41b3ee916072a5e94849c2132c997628`
- `apps/web/src/UaNativeReader.tsx:19-29`；SHA-256 `9d51872ebca91cdf7b90a04693e46f041a8671b0b257249995f56c524c2fc0a1`
- `scripts/build-ua-reader.mjs:16-18`；SHA-256 `9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3`
- `scripts/build-ua-reader.mjs:70-78`；SHA-256 `9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3`
- `scripts/build-ua-reader.mjs:111-117`；SHA-256 `9459180b2462034848eb72971c2742cfea4a63cc13d2d3fcb9a4aa357eb147a3`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
- 运行资源摘要校验尚未实现；部署期间HTTP200返回变更资源不会因digest不符被现有加载器自动拒绝。构建摘要记录不等同运行SRI；sandbox/CSP实机效果仍not_run。

### REQ-INT-M14-08 · 保留文档导出与原始源码桥接的可信度边界

**观察类型：** `observed_in_code`

**摘要：** 当前实现观察：两种intake入口互补：旧文档导出供材料阅读，新2.2.0原始快照桥接可供源码证据。

**角色：** 有已发布知识读取权的Agent

**触发：** code requirements-context 与intake普通material模式

#### 前置条件

- 明确成功run/view；新输出目录，导出文档≤2MiB。

#### 主流程

- 导出含project/repository/snapshot/插件/artifact身份的知识JSON与AGENT。
- 标明export只验证知识文档本身，remote投影不宣称复验本地原始源码。
- 需要源码观察时转M11 --code-run固定原始source桥接，不从导出文档推定源码已读取。

#### 业务规则

- BR-INT-M14-08：两种intake入口互补：旧文档导出供材料阅读，新2.2.0原始快照桥接可供源码证据。
- BR-INT-M14-08：导出知识不创建需求、不自动submit/apply。

#### 状态变化/保留

- 本地只新增知识导出目录；平台业务和默认视图不变。

#### 数据契约

- requirements-context固定知识identity与verification说明；完整源码不进入导出材料。

#### 异常与边界

- 条件：未成功run或缺少明确范围；处理：拒绝导出。
- 条件：把导出知识作为observed_in_code证据；处理：候选需改为documented/inferred或补原始source，不升级可信度。

#### 验收条件

| AC | 可观察条件与结果 |
| --- | --- |
| `REQ-INT-M14-08-AC01` | 文档导出清楚声明未复验原始源码。 |
| `REQ-INT-M14-08-AC02` | 原始观察需要code-run桥接而不是改文档标签。 |

#### 验证计划（本轮全部未执行）

**REQ-INT-M14-08-AC01** · automated

- 前提/数据/权限：准备可读成功run、远端知识与新的临时输出目录，不提供本地原始cache。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 运行requirements-context。
  2. 读取知识文档verification及AGENT。
- 观察结果：导出成功且明确document-only/未复验源码，不含完整原始文件或假observed结论。

**REQ-INT-M14-08-AC02** · automated

- 前提/数据/权限：准备上述材料包，仅以材料source.files作为证据。 使用专门测试库或临时目录，从声明的基线独立重建；不依赖前一条计划的残留数据。此环境尚未实际创建。
- 操作：
  1. 构造observed_in_code候选并本地validate。
  2. 另准备有效code-run包对比source inputs。
- 观察结果：材料包不能自称原始代码观察；code-run包才有固定原始code路径/摘要。

#### 来源与已有测试定义

- `apps/cli/src/code-understanding-context.ts:1-70`；SHA-256 `571add5c2e1a300c1d8e40b9071fb4d84e23726f7e54db605ec0970c9bb04769`
- `apps/cli/src/intake-code-knowledge.ts:14-68`；SHA-256 `274697e231e69c7286ea79379446c6f1b7e166d0e6a9ad8e6c03a08a29db682a`

- 本条未链接已有测试定义；验证计划不是测试通过结果。

#### 未确认与未验证

- 本轮仅根据固定源码形成可审阅候选，未执行应用测试、数据库写入、模型调用或业务验收；以下验证计划需要独立准备可丢弃测试环境。
