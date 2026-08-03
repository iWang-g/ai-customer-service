# AI智能客服桌面端

该项目将“消息中心”和“AI 客服管理后台”整合为一个 Electron 桌面应用，并通过 FastAPI 业务服务提供注册、登录、会话和消息接口。

当前落地范围、接口清单和联调结果见：[`docs/前后端联调实现记录.md`](docs/前后端联调实现记录.md)。

拼多多多账号工作区和本机 RPA 当前进度见：[`docs/拼多多会话与消息采集实现记录.md`](docs/拼多多会话与消息采集实现记录.md)。

## 运行

```powershell
pnpm install
pnpm dev
```

`pnpm dev` 会同时启动：

- 业务 API：`http://127.0.0.1:8001/`
- 知识库服务：`http://127.0.0.1:8010/`
- AI 回复服务：`http://127.0.0.1:8020/`
- API 文档：`http://127.0.0.1:8001/docs`
- 桌面端开发页面：`http://127.0.0.1:9527/`
- Electron 桌面窗口

当前本地开发会同时启动 business-api、knowledge-base、ai-reply、Vite 和 Electron。知识库和 AI 服务默认使用本地存储及 fallback，不要求云端账号或模型 API key；配置模型供应商后再启用真实大模型调用。

开发管理员账号：`admin`  
开发管理员密码：`admin123`

也可以在登录界面点击“立即注册”创建普通客服账号。开发环境会为新账号初始化两组示例会话和消息，设置 `SEED_DEMO_DATA=false` 可关闭。

登录后默认进入消息中心。点击左下角“管理后台”按钮进入 AI 客服管理后台，点击后台侧栏底部“返回消息中心”即可返回。

首次运行前需要安装 Python 3.12+ 业务服务依赖：

```powershell
python -m pip install -e services/business-api
python -m pip install -e services/knowledge-base
python -m pip install -e services/ai-reply
```

需要分别启动时可使用 `pnpm dev:api` 和 `pnpm dev:desktop`。

## 构建

```powershell
pnpm lint
pnpm build
pnpm dist
pnpm smoke:phase-b
pnpm smoke:phase-c
pnpm --dir apps/desktop smoke:pdd-adapter
```

- `pnpm build` 生成前端生产文件到 `dist/`。
- `pnpm dist` 生成 Windows 安装包到 `release/`。
