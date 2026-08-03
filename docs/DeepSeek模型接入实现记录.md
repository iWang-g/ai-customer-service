# DeepSeek 模型接入实现记录

## 实现范围

- 管理后台“API 配置”页面支持 DeepSeek 配置：API Key、Base URL、模型、Temperature、启用状态。
- business-api 增加用户级 AI 配置接口：
  - `GET /api/v1/ai-config`
  - `PUT /api/v1/ai-config`
  - `POST /api/v1/ai-config/test`
  - `POST /api/v1/ai-config/test-saved`
- AI 配置保存在 business-api 的 SQLite 数据库中，查询接口只返回掩码后的 API Key。
- business-api 调用 ai-reply 时携带当前用户配置；ai-reply 仍保留通用 OpenAI 兼容 Provider 和本地 fallback。

## 默认参数

- Provider：`deepseek`
- Base URL：`https://api.deepseek.com`
- 模型：`deepseek-chat`
- 可选模型：`deepseek-reasoner`
- 默认 Temperature：`0.2`

`deepseek-reasoner` 请求不会发送 `temperature` 参数。未启用 AI、未配置密钥或第三方服务不可用时，回复服务继续使用本地规则和 fallback，不影响本地开发启动。

## 本地使用

1. 启动 `pnpm dev`，确保 business-api、ai-reply 和桌面端均运行。
2. 登录桌面端，进入“AI 客服后台” -> “API 配置”。
3. 填写 DeepSeek API Key，必要时选择模型，点击“测试连接”，成功后点击“保存配置”。
4. 机器人配置启用自动回复后，入站消息会按 QA 匹配、知识库检索和模型生成链路处理，最终仍通过现有 RPA 任务发送。

API Key 不会写入 React 构建产物、Electron preload 或第三方平台页面；生产部署前应将 SQLite 中的密钥改为加密存储并使用独立密钥管理服务。
