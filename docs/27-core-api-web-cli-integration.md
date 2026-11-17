# Core API 与 Web / CLI 对接约定

## 使用场景

Web 与 `tsp` 通过 Core API 读写项目事实。客户端只使用 20 位公开编码，数据库自增数字 ID 不得出现在外部契约中。

## 地址与鉴权

- 本地 Core API：`http://127.0.0.1:8080`
- Web：账号密码登录后使用 `Authorization: Bearer <device_token>`
- CLI：首次使用一次性绑定 Token 登录，后续使用本机设备 Token
- `x-principal-code` 仅用于本地过渡、测试和受控编排；Bearer 身份优先

## 响应信封

成功：

```json
{
  "ok": true,
  "data": {}
}
```

业务错误：

```json
{
  "ok": false,
  "error": {
    "code": "stable_machine_code",
    "message": "可读错误信息",
    "details": {}
  }
}
```

客户端必须先判断 `ok`，不能只根据 HTTP 200 推断业务成功。

## 项目文档库接口

公开 CLI 命令为 `tsp docs`；以下 HTTP 路径沿用已有名称以兼容客户端，不因 CLI 改名而迁移。

### 查询目录与文档

`GET /projects/:project_code/handoff?q=<query>`

返回 `folders` 与 `documents`。文件夹通过 `parent_folder_code` 组成树；文档通过 `folder_code` 归属目录。接口文档的 `kind` 为 `api`。

### 创建文件夹

`POST /projects/:project_code/handoff/folders`

```json
{
  "name": "前后端对接",
  "parent_folder_code": "<optional-folder-code>"
}
```

### 创建文档

`POST /projects/:project_code/handoff/documents`

```json
{
  "folder_code": "<optional-folder-code>",
  "kind": "api",
  "title": "登录接口约定",
  "summary": "登录、首次改密和错误码。",
  "content": "# 登录接口约定"
}
```

### 读取与修订

- `GET /handoff-documents/:document_code`
- `PATCH /handoff-documents/:document_code`

修订必须携带完整当前正文与 `change_summary`。服务端递增 `current_revision`，旧 Revision 不可覆盖。

## 接口文档内容标准

每份 API 文档至少说明：

1. 使用场景和调用方
2. 鉴权与权限边界
3. 请求方法、路径、参数和示例
4. 成功响应和业务错误码
5. 幂等、重试、超时与并发约定
6. 数据兼容和版本变更注意事项
7. 前端、后端或外部系统的维护责任

## 兼容与缓存

- 客户端可缓存文档索引，但打开文档时应按编码读取当前 Revision。
- Task Context Pack 是领取时快照，不替代线上真相；需要提交或修订前应重新读取文档详情。
- 已归档文件夹或文档不进入默认 Agent Context Pack，但保留历史引用。
