# 批次 B：安全加固

## 施工计划

以 `team-synergy` 为唯一代码源，验证后备份并同步到运行目录 service；不修改 user-space。

1. B-05：先覆盖认证、默认与大文档请求体边界，再把全局默认降至 1 MiB，保留显式文档上限，统一 413 envelope。
2. B-01：API 使用 helmet；Web 开发服务器与生产静态入口补安全头。CSP 默认报告模式，记录观察和切换强制模式的方法；HSTS 仅 HTTPS。
3. B-04：在现有持久化限流、失败审计基础上补锁定/解锁审计、低基数指标和管理员聚合查询。
4. B-02：保留 CLI Bearer；Web 使用 HttpOnly 会话 Cookie、绑定会话的双提交 CSRF，清除旧浏览器令牌，验证登录、恢复、改密、退出和拒绝路径。
5. B-03：保留已使用的独立 draw.io origin，补严格消息结构校验和隔离证据，维持编辑/保存/预览协议。

行为测试先于边界修改；不新增路由 SQL、全局锁或不必要的依赖。各项独立提交，最后运行 build/typecheck/lint/迁移检查/全套测试与运行环境验证。

## 验证与限制

### B-02 后端实施计划

- 先覆盖 Web 登录、Cookie 恢复、改密/退出、Origin 与 CSRF 拒绝路径，再修改认证中间件。
- `/auth/web/login` 仅以受信 Origin 防登录 CSRF；忽略旧 Cookie，允许过期会话重新登录。响应只含用户与 CSRF，不返回设备令牌。
- `tsp_session` 使用 HttpOnly、SameSite=Lax、Path=/；生产环境始终 Secure，并使用 `__Host-tsp_session` / `__Host-tsp_csrf` / `__Host-tsp_browser` 防子域 Cookie 注入。仅开发环境且 Host、客户端地址均为回环时允许 HTTP。
- 浏览器安装身份由服务端生成并保存在 HttpOnly browser Cookie；忽略请求体的 installation_id/secret，退出保留此 Cookie，重新登录仍对应同一设备。
- `tsp_csrf` 是与会话令牌绑定的 HMAC 双提交值；Cookie 身份的所有非安全方法在进入路由前验证 Origin、Cookie 与 `X-CSRF-Token`。有 Cookie 时不允许 Authorization/旧身份头绕过检查。
- `/auth/web/session` 返回用户与 CSRF；`/auth/web/logout` 吊销当前会话并清 Cookie。原 Bearer 通道继续服务 CLI；浏览器路由使用统一的已验证会话 guard。
- `TSP_WEB_ORIGIN` 指定唯一 Web Origin；同源始终可用，开发回环代理额外允许回环 5173 Origin。代理后的 HTTPS 部署应显式配置该 Origin。

CSP 报告观察需要真实使用时间，不能用一次冒烟测试代替长期观察。本批交付 B-02～B-05，B-01 的代码与报告模式就绪，保留观察期未完成状态。

## B-03：draw.io 独立 origin 与消息边界

施工前确认：iframe 指向固定 `https://embed.diagrams.net`，当前已经比应用独立 origin；接收端同时比较精确 origin 和 iframe Window，发送端指定 targetOrigin。保留该隔离策略和协议所需 sandbox 权限。

小计划：先运行既有编辑/保存/预览协议回归；再按 configure/init/load/save/export/exit 逐事件校验消息字段、类型与大小，拒绝非法结构且保留 draw.io 的扩展字段兼容。补合法完整流程、非法 origin/source/结构及过期导出拒绝行为测试。用本地不同 origin 的真实浏览器 fixture 验证子框架无法读取父页面 cookie/localStorage 或移除 sandbox，并记录线上 embed 服务未实际调用的范围。新增 ADR 固化独立 origin 前提；不放宽 HTML/SVG 渲染或用户内容执行权限。

## B-04 施工小计划

1. 先补行为回归：连续错误口令产生失败/锁定审计；自然到期仅解锁一次；未锁定时成功清零不伪造解锁；本地恢复真实解锁；未知账号不创建虚构 principal。
2. 新增独立 `auth_security_events` 表记录时间、固定事件/原因、可空真实主体和账号/IP 哈希，原始 IP、口令与令牌不落库。正式用户审计仍通过领域审计校验。
3. 应用层提供有时间范围、分页和管理权限校验的按账号/IP 哈希聚合；路由不写 SQL。登录路由传入 IP 上下文，限流拒绝也计入安全事件。
4. `/metrics` 暴露只含固定原因标签的持久化 `login_failures_total`，每次采集读取总量，不把账号/IP 作为 Prometheus 标签，不重复累加。
5. 与 B-02 共用已验证的 Bearer/Cookie 管理员边界，覆盖普通成员、未知身份、IP 脱敏、指标计数与并发锁定回归，再运行迁移检查、构建、类型检查和相关测试。

B-03 验证记录：既有协议 17 项先通过，新补结构与门控流程后共 19 项通过；本机真实 Chrome 的独立 origin fixture 通过，父 localStorage/cookie、sandbox 属性不可由子框架访问或移除；子 origin 自有存储可正常使用。Web typecheck 与改动文件 ESLint 通过。保留外部服务和现有 sandbox 权限。线上 diagrams.net 的完整 UI/网络可用性未据此宣称通过，相关边界与复测方法见 ADR-0013。

## 交付与提交

| 项目 | 提交 | 结果 |
|---|---|---|
| B-05 请求体 | 5b3a630 | 默认 1 MiB、认证 16 KiB；文档 8/24/30 MiB 显式保留；统一 413 |
| B-01 安全头 | 5a5b261 | API Helmet、Vite/nginx 安全头、受限 CSP 报告收集；完整策略仍为报告模式 |
| B-03 draw.io | b5b2374 | 独立 origin 不变，逐事件类型/大小/来源及导出回显校验 |
| B-04 登录安全 | 7d48444 | 不可修改的安全事件、真实用户失败/锁定/解锁审计、管理员聚合、持久指标 |
| B-02 Cookie 后端 | 17d9494 | HttpOnly session/browser Cookie、生产 Host 前缀、HMAC 双提交 CSRF 和 Origin |
| B-02 Web 接线 | 55de214 | 去除 JS 凭据存储；恢复后加载工作台；业务 guard 接受已验证 Cookie；退出确认 |

主要改动文件：core-api 的 auth.ts、web-session.ts、security-headers.ts、metrics.ts、server.ts 与相关路由；Web 的 api.ts、App.tsx、clientIdentity.ts、drawioProtocol.ts 及 Vite headers；application 的 auth-use-cases.ts、login-security.ts、web-session-user.ts、handover-use-cases.ts；persistence 的 schema.ts 与 0047；deploy/nginx.conf、compose.yaml、环境模板和本文件/runbook/ADR。

简化：删除 Web 本地令牌读取、Bearer 拼接、客户端安装秘密生成/持久化及旧身份补绑逻辑；复用原设备/会话哈希存储和应用权限用例；浏览器业务路由共用已验证会话 guard。新增依赖仅为清单明确要求的 @fastify/helmet，Cookie/CSRF 使用 Node crypto。

## 验证证据

- build、typecheck：9 workspace 通过；lint：0 errors、70 既有 warnings；迁移策略：47 个迁移通过，46 个历史文件不改写，策略测试 3/3。
- 完整串行 workspace 回归：1108 项，1106 通过、0 失败、2 既有条件跳过（Windows 符号链接权限、可选真实 DSH）。没有减少用例。旧浏览器 Bearer/JS 安装身份断言按新 HttpOnly 契约替换，并增加凭据不可读、安装稳定性和 CSRF 拒绝断言；A-03 限流审计计数明确加入新增的限流观察，原状态码/Retry-After/脱敏断言保留。
- B-05 回归先在原实现失败，证明旧 413 为 Fastify 默认形状；改后登录 20 KiB、默认 1 MiB 超限及文档边界均通过。24/30 MiB 以下解析能到达业务/schema 校验；领域内容上限不放宽。
- 真 Chrome 隔离数据库：登录、刷新恢复、管理员用户/设备页面、账号弹窗、UI 重命名设备并刷新、缺 CSRF=403、退出后会话=401 通过；document.cookie 不含 session/browser proof，localStorage 无两种旧凭据。登录页和上述认证流程 CSP violation 均为 0。修改只发生在隔离测试库。
- draw.io 协议 19/19、本机真实 Chrome 跨 origin 沙箱 1/1；另一次实际 embed.diagrams.net 探测在 60 秒内未收到 configure/init/load（原始消息 0、结构拒绝 0），没有进入图源/导出。按外部服务启动/网络可用性限制记录，不能据此认定线上完整 UI 通过。
- nginx 容器 `nginx -t` 通过。HTTP 不发 HSTS；真实公网 TLS 入口未在本机建立，终止层验证步骤见 runbook。

## 保留事项

B-01 报告期从本次部署开始，至少覆盖真实使用与 runbook 列出的流程后再切强制；当前不会自动切换。Web 既有 sandbox 原型所需 unsafe-inline 与 HTTPS 外部预览允许项尚未进一步收紧。锁到期解锁为下一次密码尝试时懒记录；IP/账号哈希不是匿名化保证，查询仅限系统管理员。

下一批 C：先 C-02 孤儿巡检，再 C-01 核心外键及 C-03 时间迁移；C-04 RLS 仍须先明确同库多客户部署诉求，不自动施工。

## 运行副本与收尾

部署前生成并校验自定义备份 `team-synergy-20261023-160549-364.dump`（1,715,292 字节）。通过 scripts/deploy-runtime.ps1 完成 service 同步、冻结锁文件安装、构建、显式迁移与启动；运行库为 75 张业务表、47 个迁移，auth_security_events 已建立。

实测 8080 health/ready、5173 Web 与代理 ready 均为 200；Web session 与安全聚合匿名为 401；现有本机 CLI Bearer whoami=200，普通成员访问 metrics、audit export、安全聚合均为 403。API/Web 安全头和 HTTP 无 HSTS 检查通过，运行服务登录 20 KiB 返回 request_body_too_large 的 413 envelope。没有在运行库创建测试账户、重置密码或生成测试登录会话。

部署后另用独立 Chrome profile 访问实际 5173 Vite 登录页，页面加载通过、CSP violation=0，没有读取或修改用户正在使用的浏览器会话。

526 个已追踪源码、脚本、迁移与部署配置文件和 runtime/team-synergy-service 逐字节一致。8080、5173 监听进程均来自 service 路径。user-space 未修改。隔离浏览器、API fixture、专用 PostgreSQL 测试容器均在收尾时关闭；部署备份保留。
