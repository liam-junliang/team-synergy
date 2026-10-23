# ADR-0014：浏览器凭据与登录安全观测

- 状态：Accepted
- 日期：2026-10-23
- superseded_by: null

## 决策

浏览器使用 `/auth/web/login`、`/auth/web/session`、`/auth/web/logout`。会话令牌和稳定安装凭据分别放在 HttpOnly Cookie；数据库只保存对应 SHA-256。Web JavaScript 的认证响应仅接收用户展示信息与会话绑定的 CSRF 值，后者仅存在内存。旧 localStorage 中的会话及安装秘密直接删除，不读取迁移。第一次升级需要重新登录，之后安装 Cookie 保持设备身份稳定。

生产 Cookie 必须 Secure、SameSite=Lax、Path=/，不设置 Domain，使用 `__Host-` 前缀；拒绝重名与降级 Cookie。只有非生产且服务 Host、直连客户端 IP 同时为回环时允许 HTTP。TLS 代理配置精确的 `TSP_WEB_ORIGIN`，不把客户端可伪造的 forwarded 头当作安全来源。

Cookie 请求的非安全方法验证精确 Origin、双提交 CSRF 与绑定当前会话的 HMAC。有 Cookie 时不能通过附加 Bearer 或旧身份头跳过校验。登录由 Origin 防止登录 CSRF；原生 CSP 报告是唯一无业务权限的遥测例外。CLI 继续使用 Authorization Bearer，执行租约入口继续要求 Bearer。既有浏览器业务 guard 接受已由中间件验证的 Cookie，仍保留原权限与设备绑定。

登录安全事件独立记录真实可空主体、固定原因、账号/IP 哈希及 timestamptz；未知账号不伪造审计 principal。正式用户失败/锁定/解锁事件沿用领域审计入口。锁到期在下一次口令尝试的事务中记录解锁。不可修改事件表用于持久计数；管理员聚合查询限制时间窗、分页，指标只有固定原因标签。

## 权衡

HttpOnly 防止直接读取凭据，不阻止同源 XSS 代用户发请求；内容渲染隔离和 CSP 仍需保留。账号/IP 哈希供管理员关联分析，不声称对字典枚举不可逆，也不进入 Prometheus 标签。

CSP 首先以报告模式上线；基础 frame-ancestors/object/base 限制立即强制。现有 sandbox HTML 原型包含 inline script，生产 Web 策略暂保留 unsafe-inline 与受沙箱限制的 HTTPS 外部预览入口，不宣称严格 CSP 已完成。报告窗口与后续收紧依据由 runbook 记录。

未引入新的 Cookie 或 CSRF 依赖；使用 Node crypto 完成有界 Cookie 解析、随机值和 HMAC。拒绝把浏览器原 Bearer 迁移后继续暴露给 JavaScript，也不让 CLI 改走 Cookie。

## 验证

Cookie/CSRF、Origin、生产前缀、设备稳定性、Bearer 兼容及安全计数均有行为用例。隔离数据库的真实 Chrome 验证登录、刷新、用户/设备页面、设备重命名、CSRF 拒绝与退出；检查 document.cookie/localStorage 不含凭据，观察上述流程 CSP violation 为零。完整门禁与部署结果见 `55-remediation-batch-b.md`。
