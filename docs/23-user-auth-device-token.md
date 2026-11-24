# 23 · 用户账号、Web 密码与设备认证

> 状态：Adopted（2026-08-14）

## 1. 身份分层

平台把系统身份、登录账号和团队权限明确拆开：

```text
users（账号本体）              team_members（团队权限）       devices（登录设备）
├─ id (bigint identity) ◄──── user_id (bigint) ◄────────── user_id (bigint)
├─ code（公开编码，唯一）      ├─ team_id (bigint)           ├─ id (bigint identity)
├─ account（登录账号，唯一）   └─ role owner|member          ├─ code（公开编码，唯一）
├─ display_name                                             ├─ credential_hash
├─ is_system_admin                                          └─ device_name
├─ password_hash
├─ must_change_password
└─ password_expires_at
```

- `users.id` 是数据库数字主键，所有数据库关系只引用这个数字值；不进入 API、CLI 或界面。
- `users.code` 是 20 位无前缀公开编码，API、CLI、URL 和界面均使用它。
- `account` 是用户输入的登录账号，例如 `chen`；账号不承担数据库关联职责。
- 系统管理员与团队 Owner 是不同权限。系统管理员创建和禁用账号；用户创建团队后才成为该团队 Owner。
- 密码只存 scrypt 哈希，设备 token 只存 SHA-256 哈希。

## 2. 首次部署与管理员

core-api 首次连接数据库时保证存在系统管理员：

- 登录账号固定为 `admin`；
- 数字主键和公开 `code` 自动生成；
- 初始密码随机生成、15 分钟有效，仅在首次启动时一次性输出到 stderr（不进入结构化日志，避免被日志采集聚合泄露）；
- admin 使用初始密码登录后必须立即修改密码；修改完成前，后端只允许 `whoami`、修改密码和退出登录。

若初始密码尚未修改但已经过期，重启 core-api 会刷新临时密码并再次输出到 stderr，避免首次部署永久锁死。永久密码一旦设置，后续启动不会生成或打印新密码。

## 3. 普通用户首次登录

```text
系统管理员创建账号
  POST /users { account, display_name }
  → 返回 user_code + 仅显示一次的初始密码

用户登录
  POST /auth/password-login { account, password, device_name }
  → 创建当前浏览器的 device token
  → whoami.must_change_password = true

用户设置永久密码
  POST /auth/password-change { new_password, current_password }
  → 首次改密：current_password 填管理员发放的初始密码
  → 保存 scrypt 哈希并清除初始密码有效期
  → 吊销该用户除当前设备外的全部设备凭据
  → 写入 user.password_changed 审计事件
  → 用户进入团队与项目工作台
```

已设置永久密码的用户再次主动改密时必须提供正确的 `current_password`，否则拒绝
（`auth_current_password_required` / `auth_credentials_invalid`），防止被窃 token 直接换锁。
每次改密都会吊销其他设备；单个用户最多同时绑定 10 台设备
（`MAX_DEVICES_PER_USER`，超限返回 `auth_device_limit_reached`）。

系统管理员可重新签发初始密码。重置会吊销该用户已有设备会话，确保旧会话不再继续访问。

## 4. 团队与项目权限

- 新账号创建后不自动成为任何团队或项目成员。
- 已登录用户可以创建团队，并自动成为该团队 Owner。
- 团队 Owner 从用户目录按 `account` 选择成员；API 使用 `user_code`，写库时解析并保存数字 `user_id`。
- 项目必须归属团队，项目成员和任务、需求、缺陷、文档都按项目维度隔离。

## 5. CLI / Agent 设备认证

CLI 与 Agent 共享本机设备会话。默认先执行 `tsp auth login --api <地址>`，
在浏览器核对设备名称和授权码。批准窗口为 10 分钟。

```text
系统管理员签发一次性 bind token
  POST /users/:user_code/bind-token

tsp auth login --api <地址> --token <bind-token> --name <device>
  → POST /auth/login
  → 保存与平台及安装身份绑定的本机凭据
```

新版 CLI 通过 HTTPS 登录后获得 1 小时访问令牌，临近到期时由 `tsp` 和
`agentd` 自动续期。每次续期轮换访问令牌和刷新令牌，设备编码、会话编码和
90 天会话上限沿用登录时的值。可验证安装身份的旧 CLI 会话可在到期前迁移。
本机回环开发环境也可测试续期。授权记录保存在 PostgreSQL，API 进程重启后
继续校验同一会话。退出或吊销会话、吊销设备、账号禁用等操作立即停止该授权的访问和续期。

`tsp auth status` 显示当前 API 地址、凭据来源、到期时间和最近一次续期。
`ACP_DEVICE_TOKEN` / `ACP_TOKEN` 会选择显式凭据，显式凭据由调用方管理。
若 `ACP_API_URL` 指向其他平台，先核对地址再重新登录。
Run 执行租约独立于设备登录，其默认期限为 30 秒。长时间 API 断连可能令
`agentd` 停止任务，即使设备授权仍有效，可用 `tsp auth status` 核对。

所有账号管理与设备管理接口都要求 Bearer 认证。机器模式的 `X-Principal-Code` 身份头是
无凭据验证的过渡通道，受环境开关控制：默认仅在非生产环境放行；生产环境（`NODE_ENV=production`
或 `ACP_ENV=production`）会以 401 `legacy_identity_disabled` 拒绝，除非显式设置
`ACP_ALLOW_LEGACY_IDENTITY=1`。旧 `X-Principal-Id` 已废弃且任何环境都不再接受。
