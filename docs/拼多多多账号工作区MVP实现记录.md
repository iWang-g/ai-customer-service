# 拼多多多账号工作区 MVP 实现记录

## 1. 文档信息

- 实现日期：2026-07-28
- 项目目录：`D:\project-electron\ai-customer-service`
- 对应方案：[拼多多 RPA 与多账号工作区方案](./拼多多RPA与多账号工作区方案.md)
- 对应阶段：阶段 A，多账号工作区 MVP
- 当前状态：已实现并通过自动化冒烟测试及两个真实店铺的用户验收

---

## 2. 本阶段结果

本阶段已经实现以下桌面端流程：

```text
登录桌面应用
  -> 进入消息中心
  -> 右键左侧“拼多多”按钮
  -> 点击“打开原平台工作区”
  -> 打开独立、非模态的拼多多工作区窗口
  -> 添加多个拼多多店铺
  -> 每个店铺加载独立的拼多多商家后台页面
  -> 店铺之间的 Cookie、缓存和其他浏览器存储互相隔离
  -> 切换、重命名、暂停、恢复或移除店铺
  -> 桌面应用重启后恢复本地店铺注册信息和浏览器登录态
```

当前工作区使用 Electron 原生 `WebContentsView`，没有使用已废弃的 `BrowserView`，也没有使用 `<webview>` 标签。

---

## 3. 用户界面实现

### 3.1 消息中心入口

修改：

```text
apps/desktop/src/message-center/components/PlatformRail.tsx
```

拼多多按钮现在支持两种操作：

- 左键：继续执行原有的拼多多会话筛选
- 右键：阻止浏览器默认菜单，通过安全 IPC 请求 Electron 原生菜单

原生菜单第一期只包含：

```text
打开原平台工作区
```

菜单由 Electron 主进程创建，点击后创建或聚焦拼多多工作区窗口。

### 3.2 独立工作区窗口

新增工作区界面：

```text
apps/desktop/src/platform-workspace/App.tsx
```

工作区窗口具备：

- 店铺标签栏
- 店铺运行状态指示
- 添加店铺
- 恢复已移除的店铺
- 重命名店铺
- 暂停和恢复店铺
- 移除店铺
- 浏览器后退、前进和刷新
- 空状态
- 操作错误提示

工作区窗口是独立、非模态窗口。消息中心与工作区可以同时操作，不互相阻塞。

同一业务用户只保留一个拼多多工作区窗口。重复选择“打开原平台工作区”时会显示并聚焦已有窗口。

### 3.3 弹层与原生网页视图

`WebContentsView` 是原生视图，层级高于普通 React DOM。为避免店铺网页遮挡添加、重命名和删除弹窗，工作区打开弹层时会通知主进程暂时隐藏当前店铺视图；弹层关闭后恢复显示。

---

## 4. 多账号隔离实现

### 4.1 账号注册表

新增：

```text
apps/desktop/electron/platform-workspace/account-registry.js
```

账号注册表保存在 Electron `userData` 目录下：

```text
<userData>/platform-workspaces/pinduoduo-accounts.json
```

每个本地店铺记录包含：

- 本地账号 ID
- 所属业务用户 ID
- 店铺别名
- Electron partition 名称
- 暂停状态
- 移除时间
- 创建和更新时间
- 最近打开时间

注册表损坏或无法解析时，原文件会先复制为带时间戳的备份，再使用空注册表启动，避免应用完全无法打开。

### 4.2 Partition 命名

每个店铺创建独立的持久化 partition：

```text
persist:pdd-<业务用户ID摘要>-<本地账号UUID>
```

业务用户 ID 先经过 SHA-256 摘要并截断，不直接进入 partition 名称。

账号 UUID 使用 `crypto.randomUUID()` 生成。不同用户、不同店铺不会得到相同 partition。

### 4.3 隔离范围

Electron 按 partition 隔离并持久化：

- Cookie
- LocalStorage
- SessionStorage
- IndexedDB
- CacheStorage
- Service Worker
- HTTP 缓存
- 其他 Chromium 会话数据

同一个店铺暂停或关闭视图后，partition 不会被删除。恢复店铺或重启应用时使用原 partition，因此可以继续使用原有登录态。

正常退出程序或退出当前业务账号前，主进程会显式调用 Electron session 的 `flushStorageData()`，将各店铺 partition 的待写入浏览器资料刷新到本机磁盘。拼多多主动使凭证过期或触发风控时仍需要用户重新验证。

用户可从店铺菜单显式设置账号密码。账号密码保存在独立的本地凭据库中，使用 Electron `safeStorage` 加密，不写入账号注册表、不上传服务端，也不记录到诊断日志。系统安全加密不可用时拒绝保存，不降级为明文。

### 4.4 移除与清理

移除店铺时提供明确选择：

1. 不清除浏览器资料：账号进入本地归档列表，可以从“添加店铺”窗口恢复。
2. 同时清除浏览器资料：删除账号注册信息，并调用 Electron session API 清除 Cookie、缓存、LocalStorage、IndexedDB、Service Worker 等数据。

执行清理前先销毁对应 `WebContentsView`，避免 Windows 文件句柄占用导致清理失败。

实现没有直接删除 Chromium partition 物理目录，避免运行期出现锁文件和句柄竞态。

---

## 5. Electron 主进程实现

### 5.1 工作区管理器

新增：

```text
apps/desktop/electron/platform-workspace/workspace-manager.js
```

`PddWorkspaceManager` 负责：

- 创建、显示和聚焦工作区窗口
- 按业务用户切换工作区上下文
- 创建和销毁店铺 `WebContentsView`
- 为视图分配独立 partition
- 维护当前激活店铺
- 控制视图显示、隐藏和尺寸
- 管理暂停、恢复、移除和浏览器资料清理
- 发布工作区状态事件
- 控制前进、后退和刷新
- 应用退出时释放所有视图

工作区顶部工具栏高度固定为 72 像素，店铺网页视图始终从工具栏下方开始布局。窗口调整大小时会同步更新所有店铺视图边界。

### 5.2 视图生命周期

新增店铺时：

1. 创建本地账号记录。
2. 创建 `WebContentsView`。
3. 使用账号自己的 partition。
4. 打开拼多多客服接待页 `https://mms.pinduoduo.com/chat-windows/index.html`。
5. 将新店铺设为当前激活店铺。

未登录时由拼多多跳转到登录页，并在登录完成后返回客服接待页；已有有效登录态时直接进入客服接待页面。

切换店铺时只切换视图可见性，不销毁其他运行中的店铺视图。后台视图设置 `backgroundThrottling = false`，为后续持续消息采集保留运行条件。

再次启动程序并打开工作区时，最近打开的未暂停店铺会优先显示，其余未暂停店铺进入后台串行加载队列。队列逐个复用原有持久化 partition 创建页面，单个店铺加载失败或超时不会阻塞后续店铺；用户点击仍在排队的店铺时会立即创建并显示该页面。

店铺进入登录页且配置了有效凭据时，会进入全局串行自动登录队列。用户在未登录页面新保存或修改凭据后，必须先在可信工作区确认“是否自动登录”，确认前不会点击或填写拼多多页面；应用重启后的已授权凭据可按队列自动恢复。适配器固定等待约 1 秒后切换到账号登录，以保守的固定间隔逐字填写账号和密码，填写完成后再等待约 2 秒并只提交一次；明确提示账号或密码错误时锁止当前凭据版本，只有用户修改账号密码后才会重新尝试。验证码、短信验证、账号异常、盗号风险和其他风控页面会在任何点击或填写前停止并交由用户处理，不做随机化伪装或风控绕过。已有店铺登录成功后必须校验外部店铺身份，身份不一致时保留原绑定并停止采集、发送与自动回复。

暂停店铺时销毁对应视图但保留 partition；恢复时重新创建视图并继续使用原 partition。

### 5.3 页面状态

当前运行状态包括：

- `idle`：账号存在，页面尚未创建
- `queued`：页面正在等待后台串行加载
- `loading`：主页面加载中
- `ready`：主页面加载完成
- `error`：主框架加载失败或渲染进程退出
- `paused`：店铺已暂停

自动登录状态另外包括排队中、登录中、成功、账号或密码错误、需要人工验证和本次失败。

加载状态机区分主框架失败和正常停止加载，避免 `did-stop-loading` 把真实加载错误错误覆盖为 `ready`。

---

## 6. IPC 与 preload

### 6.1 安全 preload

新增：

```text
apps/desktop/electron/preload.cjs
```

主窗口和工作区可信外壳通过 `contextBridge` 获得受限 API，没有暴露原始 `ipcRenderer`。

桌面入口能力：

- `showPlatformContextMenu`
- `closePlatformWorkspaces`

工作区能力：

- `getState`
- `addAccount`
- `selectAccount`
- `renameAccount`
- `setAccountPaused`
- `removeAccount`
- `restoreAccount`
- `setOverlayOpen`
- `goBack`
- `goForward`
- `reload`
- `onStateChanged`

类型声明位于：

```text
apps/desktop/src/vite-env.d.ts
```

### 6.2 主进程参数校验

`apps/desktop/electron/main.js` 注册 IPC handler，并校验：

- 平台代码必须为 `pinduoduo`
- 业务用户 ID 必须是合理长度的非空字符串
- 店铺账号 ID 必须符合 UUID 格式
- 暂停和清理标志必须是布尔值
- 店铺别名不能为空且不能超过 64 个字符

用户退出桌面端登录时，渲染进程会通知主进程关闭平台工作区并销毁浏览器视图，防止下一个业务用户看到前一个用户的工作区内容。

---

## 7. 第三方页面安全边界

所有可信窗口使用：

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

拼多多 `WebContentsView` 没有获得主窗口 preload，也没有任何 Electron、Node.js、业务 JWT 或文件系统能力。

当前安全策略：

- 只允许主视图导航到 HTTPS 拼多多域名
- 使用 `URL` 对象解析 hostname
- 允许 `pinduoduo.com` 及其子域名
- 非拼多多 HTTP/HTTPS 弹窗交给系统默认浏览器
- 其他协议直接拒绝
- 默认拒绝摄像头、麦克风、地理位置等网页权限
- 默认阻止网页下载
- 店铺页面不能执行任意 IPC

业务 JWT、RPA 节点令牌和平台 Cookie 不会注入第三方页面。

---

## 8. 应用入口与退出行为

修改：

```text
apps/desktop/src/main.tsx
```

应用根据查询参数选择渲染入口：

```text
普通入口                        -> 消息中心
?view=pinduoduo-workspace       -> 拼多多工作区外壳
```

工作区关闭按钮当前隐藏工作区窗口并保留浏览会话。关闭桌面应用主窗口时会正常退出整个应用，避免没有托盘入口时进程在后台不可见地继续运行。

应用完全退出前，工作区管理器会销毁全部店铺视图。

---

## 9. 自动化验证

### 9.1 类型检查

执行：

```powershell
pnpm lint
```

结果：通过。

### 9.2 生产构建

执行：

```powershell
pnpm build
```

结果：通过。

当前仍有原项目已有的非阻塞警告：主 JavaScript chunk 超过 500 kB。该警告不影响本阶段功能，后续可通过路由级动态导入和代码拆分处理。

### 9.3 Electron 工作区冒烟测试

新增：

```text
apps/desktop/scripts/smoke-pdd-workspace.mjs
```

运行：

```powershell
pnpm --dir apps/desktop smoke:pdd-workspace
```

测试使用临时 `userData` 目录和虚拟业务用户，不读取或修改真实用户的店铺资料。

已验证：

1. 创建两个店铺账号。
2. 创建两个真实 `WebContentsView`。
3. 两个店铺获得不同的持久化 partition。
4. 两个拼多多主页面均进入 `ready` 状态。
5. 暂停店铺会销毁对应视图。
6. 恢复店铺会重新创建视图并复用原 partition。
7. 移除但保留资料后，账号进入归档列表。
8. 归档账号可以恢复。
9. 重新实例化账号注册表后，两个店铺记录仍然存在。
10. 测试退出码为 `0`，无 IPC 错误。

测试生成的临时浏览器目录已在验证结束后清理。

### 9.4 界面检查

已检查：

- 工作区空状态
- 顶部店铺栏
- 导航按钮禁用状态
- 添加店铺弹窗
- 输入框焦点和按钮布局
- 弹窗遮罩和文本显示
- 浏览器控制台无错误

---

## 10. 用户实测步骤

从项目根目录启动：

```powershell
pnpm dev
```

操作步骤：

1. 登录桌面应用。
2. 在消息中心左侧右键“拼多多”。
3. 点击“打开原平台工作区”。
4. 点击“添加店铺”。
5. 输入店铺别名并点击“添加并打开”。
6. 在拼多多官方页面手动扫码或完成平台验证。
7. 再添加第二个店铺并使用另一个拼多多账号登录。
8. 来回切换两个店铺，确认各自登录态保持不变。
9. 重启桌面应用并再次打开工作区，确认登录态恢复。

验证码、二维码、短信和平台风险确认必须由用户手动处理。

---

## 11. 本阶段未完成内容

以下内容不属于多账号工作区 MVP；其中阶段 B 项目已在后续实现，详细状态见[拼多多平台账号与 RPA 节点实现记录](./拼多多平台账号与RPA节点实现记录.md)：

- 真实拼多多店铺的人工登录验收（已完成）
- 服务端平台账号 CRUD API（阶段 B 已完成）
- 本地店铺与服务端 `PlatformAccount` 绑定（阶段 B 已完成）
- Python RPA 进程（阶段 B 已完成）
- RPA 节点注册和心跳（阶段 B 已完成）
- 拼多多 DOM Detector、Reader、Sender 和 Runtime
- 会话和消息采集
- 发送任务执行
- 登录失效自动识别
- 店铺名称和外部账号 ID 自动识别
- 长时间运行与多店铺资源压力测试
- 安装包环境下的最终验收

自动化测试已经证明多个拼多多页面可在独立 partition 中加载，但真实店铺登录需要用户扫码或完成拼多多验证，因此不能由无账号冒烟测试代替。

---

## 12. 下一阶段建议

阶段 B 已完成，下一阶段进入方案中的阶段 C：会话和消息采集。

推荐顺序：

1. 调研并固化当前拼多多客服接待页的 DOM 结构。
2. 实现 Detector、Reader 和 Runtime。
3. 为两个真实店铺采集会话和消息，并携带 `platform_account_id` 上报。
4. 验证消息幂等、店铺隔离和桌面消息中心实时刷新。
