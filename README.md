# AI 智能客服桌面端

面向电商客服场景的本地优先桌面应用。项目将消息中心、拼多多多店铺工作区、AI 客服管理后台和本机 RPA 组合在一个 Electron 应用中，并由三个 FastAPI 服务提供业务、知识库和 AI 回复能力。

当前代码以 Windows 本地开发和拼多多接入为主，数据默认写入本机 SQLite。未配置模型时 AI 回复服务使用本地规则与兜底逻辑，不会调用外部大模型。

## 已实现能力

- **账号与消息中心**：客服注册、登录、令牌刷新，会话与消息分页，WebSocket 实时事件，人工发送文本和图片。
- **拼多多工作区**：多店铺添加、切换、重命名、暂停、移除与恢复；内嵌原平台页面并采集会话、消息和客户订单。
- **本机 RPA**：由 Electron 管理 Python 子进程，完成节点注册、心跳、店铺同步、任务拉取、消息发送和本地失败重试。
- **AI 自动回复**：QA 优先匹配、产品知识检索、语气约束、上下文配置、兜底回复、超时安抚及人工接管。
- **安全与运营策略**：入站敏感词拦截、出站违禁词替换、待人工状态、购买意向跟进和签收关怀。
- **管理后台**：机器人和店铺范围配置，QA/产品/语气知识库，模型配置与连通性测试，邮件模板，运行概览、日志和事件。

部分界面仍保留“开发中”标记，例如链接/表情发送、部分 Agent 策略、完整统计报告和助手设置；这些入口不应视为已交付功能。

## 技术架构

| 模块 | 技术与职责 | 默认地址/存储 |
| --- | --- | --- |
| `apps/desktop` | Electron 37、React 19、Vite 6；消息中心、管理后台和拼多多工作区 | `http://127.0.0.1:9527` |
| `services/business-api` | FastAPI、SQLAlchemy；认证、会话、RPA、自动化、订单和监控 | `http://127.0.0.1:8001`，SQLite |
| `services/knowledge-base` | FastAPI；QA、产品文档、语气知识库和本地检索 | `http://127.0.0.1:8010`，SQLite + 本地资源 |
| `services/ai-reply` | FastAPI；意图判断、知识检索和回复编排 | `http://127.0.0.1:8020` |
| `agents/rpa` | Python 标准库实现的本机 RPA 节点 | Electron 用户数据目录 |

业务 API 文档启动后位于 `http://127.0.0.1:8001/docs`，三个服务均提供 `/healthz` 健康检查。

## 环境要求

- Windows 10/11（当前打包目标为 NSIS）
- Node.js 与 pnpm（依赖版本以 `pnpm-lock.yaml` 为准）
- Python 3.12+

## 本地运行

首次运行安装前端和三个 Python 服务的依赖：

```powershell
pnpm install
python -m pip install -e services/business-api
python -m pip install -e services/knowledge-base
python -m pip install -e services/ai-reply
```

启动完整开发环境：

```powershell
pnpm dev
```

该命令同时启动 business-api、knowledge-base、ai-reply、Vite 和 Electron。也可以按需单独启动：

```powershell
pnpm dev:api
pnpm dev:kb
pnpm dev:ai
pnpm dev:desktop
```

开发数据库为空时会自动创建管理员：

- 用户名：`admin`
- 密码：`admin123`

登录页也可以注册普通客服账号。开发环境默认给新账号初始化示例会话，设置 `SEED_DEMO_DATA=false` 可关闭。默认凭据和 JWT 密钥仅用于本地开发，部署前必须覆盖。

### 启用拼多多消息写入

拼多多有序消息快照的正式写入开关默认关闭。需要联调真实会话采集和自动回复时，在启动前设置：

```powershell
$env:PDD_MESSAGE_SNAPSHOT_WRITE_ENABLED = "true"
pnpm dev
```

自动回复总开关及单个机器人的“启用 AI 自动回复”默认也应由管理员确认后再开启，避免联调期间向真实客户自动发送消息。

### 配置大模型

未配置模型凭据时服务保持可启动，并使用本地 fallback。可在管理后台的“API 配置”中保存并测试 OpenAI 兼容模型；AI 回复服务也支持以下环境变量：

```powershell
$env:AI_PROVIDER = "openai_compatible"
$env:AI_PROVIDER_BASE_URL = "https://api.deepseek.com"
$env:AI_PROVIDER_API_KEY = "<your-api-key>"
$env:AI_MODEL = "deepseek-chat"
pnpm dev
```

不要把 API Key、生产 JWT 密钥或平台凭据提交到仓库。

## 常用命令

```powershell
# TypeScript 类型检查
pnpm lint

# 构建桌面端前端
pnpm build

# 构建 Windows NSIS 安装包
pnpm dist

# 业务 API 与 RPA 冒烟测试
pnpm smoke:phase-b
pnpm smoke:phase-c

# 拼多多适配器及本地状态测试
pnpm --dir apps/desktop smoke:pdd-adapter
pnpm --dir apps/desktop test:pdd-collector
pnpm --dir apps/desktop test:store-actor
```

`pnpm build` 输出到 `apps/desktop/dist/`，`pnpm dist` 输出到 `apps/desktop/release/`。

三个 Python 服务的单元测试可分别运行，避免它们同名的 `app` 包互相影响：

```powershell
Push-Location services/business-api; python -m unittest discover -s tests; Pop-Location
Push-Location services/knowledge-base; python -m unittest discover -s tests; Pop-Location
Push-Location services/ai-reply; python -m unittest discover -s tests; Pop-Location
```

## 数据与日志

- 业务数据库：`services/business-api/data/business-api.db`
- 知识库数据库与资源：通过根目录 `pnpm dev` 启动时位于 `data/`；在服务目录独立启动时默认位于 `services/knowledge-base/data/`
- 开发诊断日志：`logs/`
- 打包应用的店铺、RPA 和日志数据：Electron `userData` 目录

以上运行数据均已通过 `.gitignore` 排除。删除数据库或 Electron 用户数据会清空对应的本地账号、配置及采集状态。

## 相关文档

- [项目架构设计](docs/项目架构设计.md)
- [前后端联调实现记录](docs/前后端联调实现记录.md)
- [自动回复流程设计与实现方案](docs/自动回复流程设计与实现方案.md)
- [拼多多多账号工作区 MVP 实现记录](docs/拼多多多账号工作区MVP实现记录.md)
- [拼多多会话与消息采集实现记录](docs/拼多多会话与消息采集实现记录.md)
- [知识库与 AI 服务架构方案](docs/知识库与AI服务架构方案.md)
