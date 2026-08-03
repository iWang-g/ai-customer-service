# 拼多多平台账号与 RPA 节点实现记录

## 1. 文档信息

- 实现日期：2026-07-28
- 对应方案：[拼多多 RPA 与多账号工作区方案](./拼多多RPA与多账号工作区方案.md)
- 对应阶段：阶段 B，平台账号与 RPA 节点
- 前置验收：用户已使用两个真实拼多多店铺确认登录态隔离和重启恢复正常
- 当前状态：已实现并通过自动化端到端测试

---

## 2. 本阶段结果

当前闭环如下：

```text
桌面用户登录
  -> Electron 启动本机 Python RPA
  -> RPA 使用桌面访问令牌注册节点
  -> 服务端签发独立节点令牌
  -> Electron 同步当前用户的本地店铺注册表
  -> RPA 创建或更新 platform_accounts
  -> RPA 持续上报心跳
  -> 页面事件先写入本机 SQLite 队列
  -> 服务恢复后批量补传未同步事件
  -> 用户退出时停止 RPA 并标记节点离线
```

拼多多网页仍然没有获得 Node.js、Electron IPC、业务 JWT 或 RPA 节点令牌。

---

## 3. 服务端实现

新增平台账号接口：

```text
GET    /api/v1/platform-accounts
POST   /api/v1/platform-accounts
GET    /api/v1/platform-accounts/{account_id}
PATCH  /api/v1/platform-accounts/{account_id}
DELETE /api/v1/platform-accounts/{account_id}
```

`POST` 按当前用户、平台和本地账号 ID 幂等创建或更新。所有查询和修改都校验当前登录用户，其他用户无法读取店铺。

新增或补齐的数据字段：

- `platform_accounts.local_account_id`
- `platform_accounts.external_account_id`
- `platform_accounts.login_status`
- `platform_accounts.last_seen_at`
- `platform_accounts.last_rpa_node_id`
- `rpa_events.platform_account_id`
- `rpa_tasks.platform_account_id`

启动时的兼容迁移只给现有 SQLite 表补列和索引，不删除或重建已有用户、会话、消息和平台账号数据。全新数据库直接按最新模型建表。

RPA 接口在原有注册、心跳、事件和任务基础上新增当前用户的节点列表：

```text
GET /api/v1/rpa/nodes
```

会话事件查找已经包含 `platform_account_id`，发送任务也会继承会话的平台账号 ID，为后续避免跨店铺合并或误发提供数据边界。

主要文件：

```text
services/business-api/app/api/routes/platform_accounts.py
services/business-api/app/schemas/platform_account.py
services/business-api/app/services/platform_account_service.py
services/business-api/app/db/migrations.py
services/business-api/app/models/entities.py
services/business-api/app/services/rpa_service.py
```

---

## 4. 本机 Python RPA

新增：

```text
agents/rpa/agent.py
```

当前节点具备：

- 节点注册和独立节点令牌
- 心跳、离线状态和自动重连
- 本地店铺与服务端平台账号同步
- 本地账号 ID 与服务端平台账号 ID 绑定结果回传
- SQLite 事件队列
- 事件幂等入队和批量补传
- 退出时节点离线通知

Electron 与 Python 使用标准输入/输出上的 JSON Lines 协议。每次启动生成 256 位随机桥接密钥，所有后续命令和节点消息都必须携带该密钥。业务访问令牌通过标准输入发送，不放入进程命令行，也不写日志。

业务访问令牌只用于首次节点注册；注册成功后的店铺同步、心跳和事件上传均使用节点令牌，因此桌面访问令牌过期不会中断长时间运行的店铺同步。

使用 JSON Lines 而不是本地 WebSocket，是方案中预留的轻量降级路径。当前只有 Electron 主进程和一个受管子进程通信，不需要开放本机监听端口。

事件数据库位置：

```text
<Electron userData>/rpa/<业务用户ID摘要>/events.db
```

Cookie、LocalStorage、IndexedDB 等拼多多登录资料仍只存在各店铺 Electron partition，不进入 RPA 数据库或业务服务端。

---

## 5. Electron 集成

新增：

```text
apps/desktop/electron/rpa/process-manager.js
```

登录成功后，可信消息中心通过 preload 请求主进程启动 RPA。主进程负责：

- 定位和启动 Python 节点
- 生成本地桥接密钥
- 在同一用户重复登录时刷新访问令牌
- 节点异常退出后延迟重启
- 将本地店铺列表和状态同步给 RPA
- 接收平台账号绑定结果并写回本地账号注册表
- 退出登录或应用退出时停止节点

本地账号注册表版本升级到 v2，新增：

- `platformAccountId`
- `loginStatus`

旧版注册表读取时自动补默认值，不改变原有账号 ID 和 partition，因此不会丢失已经验收的两个店铺登录态。

工作区顶部增加 RPA 状态：

- RPA 未启动
- RPA 启动中
- RPA 在线
- RPA 离线
- RPA 异常

页面进入 `/login` 时同步为 `login_required`，进入 `/chat-windows` 时同步为 `online`。这只是阶段 B 的 URL 级状态判断，DOM 级登录失效和风控识别属于阶段 C。

打包配置已把 `agents/rpa/agent.py` 放入应用资源。阶段 B 开发环境仍要求系统安装 Python 3.12；将 Python 运行时打进安装包属于阶段 E。

---

## 6. 自动化验收

新增命令：

```powershell
pnpm smoke:phase-b
```

测试使用独立临时数据库和虚拟店铺，不读取或修改真实 Electron `userData`。已验证：

1. 注册业务用户和 RPA 节点。
2. 两个本地店铺生成两个服务端平台账号。
3. 平台账号带有各自的本地账号 ID、登录状态和最后 RPA 节点 ID。
4. 第二个业务用户看不到第一个用户的店铺。
5. API 停止期间事件保留在 RPA SQLite 队列。
6. API 恢复后事件自动补传并在服务端幂等入库。
7. RPA 正常退出后节点状态变为 `offline`。

本次结果：

```json
{"status":"passed","platform_accounts":2,"rpa_nodes":1,"offline_events_replayed":1}
```

同时通过：

```powershell
pnpm lint
pnpm build
pnpm --dir apps/desktop smoke:pdd-workspace
```

生产构建仍有原项目已有的 JavaScript chunk 大于 500 kB 提示，不影响本阶段功能。

---

## 7. 后续阶段

阶段 C 已完成，详细记录见[拼多多会话与消息采集实现记录](./拼多多会话与消息采集实现记录.md)。

阶段 B 完成时约定的阶段 C 边界如下：

阶段 C 需要实现：

- 拼多多页面专用 Detector、Reader 和 Runtime
- 店铺外部 ID、店铺正式名称及 DOM 级登录状态识别
- 会话列表和消息读取
- 文本、图片、商品或订单卡片等消息标准化
- 采集事件接入现有 SQLite 队列
- 服务端按 `platform_account_id` 创建会话和消息
- 消息中心实时刷新和重复扫描幂等验证

本阶段没有实现 DOM 消息采集，也没有实现自动发送。验证码、扫码、短信和平台风险确认继续由用户手动处理。
