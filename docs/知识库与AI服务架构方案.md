# 知识库与 AI 服务架构方案

## 1. 文档信息

- 项目：`D:\project-electron\ai-customer-service`
- 文档性质：后续实现方案，不代表当前代码已经完成
- 编写日期：2026-07-29
- 相关旧项目：`D:\ai-customer-service`

本文以当前仓库实际代码为准，结合旧项目中已有的知识库和 AI 相关逻辑，记录可独立部署、可替换实现的知识库服务和 AI 回复服务方案，以及当前本地 MVP 的落地状态。

## 1.1 开发策略：本地优先

当前阶段以本地开发和联调为第一目标，不要求一开始就达到完整的生产级部署标准。优先保证基础功能可以在开发机上跑通：

- Electron 桌面端、business-api、knowledge-base、ai-reply 和本机 RPA 都允许在本地启动。
- 默认优先使用本地 SQLite、文件目录和轻量任务执行方式，降低开发环境依赖。
- 先完成登录、知识库 CRUD、QA 匹配、产品检索、AI 建议回复和 RPA 发送等最小闭环。
- 暂不强制引入 Kubernetes、复杂服务网格、分布式向量数据库或完整云端监控体系。
- 接口、数据归属和服务边界从一开始保持独立部署能力，但内部实现可以先采用简单方案。
- 后续再将本地服务迁移到 Linux 云服务器，替换数据库、对象存储、队列、向量检索和模型供应商配置。

本地开发阶段可以采用以下运行方式：

```text
Electron + business-api + knowledge-base + ai-reply + RPA
                         全部运行在本机
```

正式部署阶段再演进为：

```text
Windows：Electron + 本机 RPA
Linux 云端：business-api + knowledge-base + ai-reply + 数据库 + 队列
```

本地实现不应以牺牲接口稳定性为代价。即使暂时使用 SQLite 或进程内任务队列，也应通过服务接口访问，不能让桌面端直接依赖知识库或 AI 服务的内部文件和数据库。

## 2. 当前实现基线

当前项目已经完成的核心链路：

```text
Electron 消息中心
  -> FastAPI business-api
  -> 会话、消息、平台账号、RPA 任务持久化
  -> 本机 Python RPA 节点
  -> 拼多多工作区页面采集或发送
```

当前目录职责如下：

```text
apps/desktop/                         Electron + React 桌面端
apps/desktop/electron/platform-workspace/pinduoduo/
                                      拼多多 DOM 读取、会话切换和平台发送
services/business-api/                用户、会话、消息、平台账号、RPA 任务
agents/rpa/                           本机 RPA 节点注册、心跳、事件队列和通信
services/knowledge-base/              当前为空，预留知识库服务
services/ai-reply/                    当前为空，预留 AI 回复服务
contracts/                            当前尚未形成正式跨服务契约
```

当前 `business-api` 的 `POST /api/v1/rpa/events` 会同步完成事件幂等、会话更新和消息入库，但尚未触发知识库匹配或 AI 回复。当前 `POST /api/v1/messages/send` 会创建 RPA 发送任务，最后仍由本机 RPA 在平台页面执行。

管理后台中的 QA、产品、语气知识库和机器人配置目前主要是 React 本地状态，尚未接入真实后端。

## 3. 总体目标

后续形成以下职责边界：

| 模块 | 职责 |
|---|---|
| Electron 桌面端 | 登录、消息展示、管理后台交互、RPA 工作区入口 |
| business-api | 用户、权限、租户、会话、消息、机器人配置、任务编排和审计 |
| knowledge-base | 知识库 CRUD、文档处理、QA 匹配、文档检索、语气人设和媒体资产 |
| ai-reply | 规则编排、意图识别、知识库调用、Prompt 组装、大模型调用和回复决策 |
| agents/rpa | 本机平台采集、平台会话切换、文本/图片发送、离线补偿 |

核心原则：

1. 知识库服务负责“存和查”，不负责平台店铺绑定。
2. AI 服务负责“判断和生成”，不直接访问知识库底层数据库。
3. business-api 负责机器人与知识库、平台和店铺的关联。
4. RPA 只负责平台自动化执行，不参与知识库检索和 AI 决策。
5. 所有跨服务调用使用稳定的版本化接口，不依赖对方内部数据库结构。

## 4. 知识库服务设计

### 4.1 知识库类型

初期支持三类知识库：

- QA 问答知识库
- 产品知识库
- 语气知识库

后续可以增加售后规则、物流规则、活动规则和风险词知识库，但不改变基础接口模型。

### 4.2 旧逻辑的迁移与复用

旧项目 `python/service/knowledge_store.py` 已有以下可复用能力：

- TXT、Markdown、DOCX、PDF、XLSX 文档解析
- 文档分块和相邻片段合并
- SQLite FTS5 全文检索
- 关键词、向量和混合检索
- 本地 hash embedding
- Sentence Transformer embedding
- 图片资产分析、OCR 信息、风险标签和图片检索
- QA 知识库和语气知识库基础 CRUD

迁移时不能直接把旧表结构当成新服务的公开协议。旧 QA 条目目前主要包含问题、答案和图片字段，缺少当前产品要求的关键词、权重、调用次数、启用状态；旧普通知识库还包含平台、店铺和机器人字段，也不符合现在由机器人统一绑定的设计。

迁移原则：

- 复用解析、分块、匹配和排序算法。
- 重新设计服务内部数据模型。
- 将平台和店铺关联字段从知识库主模型中移除或仅作为兼容字段。
- 为 QA 条目补充 `keywords`、`weight`、`enabled`、`call_count` 等业务字段。
- 服务端返回资源 ID 或受控 URL，不把底层文件路径暴露给调用方。

### 4.3 对外接口建议

```text
GET    /api/v1/knowledge-bases
POST   /api/v1/knowledge-bases
PATCH  /api/v1/knowledge-bases/{id}
DELETE /api/v1/knowledge-bases/{id}

GET    /api/v1/qa-bases/{id}/entries
POST   /api/v1/qa-bases/{id}/entries
PATCH  /api/v1/qa-entries/{id}
DELETE /api/v1/qa-entries/{id}
POST   /api/v1/qa/match

POST   /api/v1/documents/import
GET    /api/v1/documents/import-tasks/{id}
POST   /api/v1/documents/search

GET    /api/v1/tone-bases
POST   /api/v1/tone-bases
PATCH  /api/v1/tone-bases/{id}
DELETE /api/v1/tone-bases/{id}
GET    /api/v1/tone-bases/{id}
```

`POST /api/v1/qa/match` 至少支持：

1. 问题规范化后的精确匹配。
2. 关键词精确或模糊匹配。
3. 问题和关键词的模糊匹配。
4. 权重、启用状态和匹配分数排序。
5. 返回文本回答和可选图片资源。

建议响应结构：

```json
{
  "matched": true,
  "match_type": "exact|keyword|fuzzy",
  "score": 0.98,
  "knowledge_base_id": "qakb-001",
  "entry_id": "qa-001",
  "answer": "文本回答",
  "media": [
    {"type": "image", "asset_id": "asset-001", "url": "..."}
  ]
}
```

### 4.4 可替换实现

business-api 和 ai-reply 不应直接依赖某一种向量数据库或搜索引擎。建议定义统一客户端：

```text
KnowledgeBaseClient
  -> LocalKnowledgeBaseAdapter
  -> RemoteKnowledgeBaseAdapter
```

通过配置切换实现：

```text
KNOWLEDGE_BASE_BASE_URL
KNOWLEDGE_BASE_API_KEY
KNOWLEDGE_BASE_API_VERSION
```

以后接入第三方知识库，只需要实现相同的查询、匹配和资源返回契约，不需要了解其内部数据库、索引和模型实现。

### 4.5 部署建议

- 开发阶段：知识库服务可以直接作为本地 Python 服务运行，优先使用 SQLite、项目内文件目录和本地 embedding 模型。
- Windows：支持独立运行，适合开发和轻量单机部署。
- Linux：作为正式服务部署目标。
- 元数据：PostgreSQL。
- 文档和图片：对象存储或独立文件存储。
- 检索：可从 PostgreSQL + pgvector 起步，规模增加后再替换专业向量库或搜索引擎。
- SQLite：保留为开发、测试或单机模式，不作为多用户生产默认方案。

## 5. AI 回复服务设计

### 5.1 服务职责

AI 服务负责：

- 关键词策略编排
- 客户意图识别
- 知识库检索调用
- Prompt 组装
- 大模型调用
- 语气人设应用
- 敏感信息和风险检查
- 置信度判断
- 自动发送、建议回复或人工接管决策

旧项目的 `ai_suggestion.py` 目前只是模板回复 fallback，不是真正的大模型调用实现。旧项目中可迁移的主要是 OpenAI 兼容请求、embedding provider、图片分析和 RAGFlow 客户端示例，正式 AI 服务仍需重新封装。

开发阶段允许 AI 服务先使用以下简化方式：

- 本地配置一个模型供应商或兼容 OpenAI API 的服务。
- 暂时使用进程内后台任务，不要求立即引入 Redis/Celery。
- 模型不可用时返回明确的 fallback 或 `needs_human`，不阻塞消息入库。
- 先实现建议回复和人工确认，再逐步开启自动发送。

### 5.2 模型供应商抽象

建议统一为 Provider 接口：

```text
ModelProvider
  - OpenAIProvider
  - GeminiProvider
  - ArkProvider
  - DeepSeekProvider
  - CustomCompatibleProvider
```

AI 业务编排只依赖统一的聊天和结构化输出接口，不直接写死具体供应商 SDK。模型、密钥、超时、重试和限流全部由服务端配置管理，不能下发到桌面端或平台网页。

### 5.3 两轮 AI 链路

第一轮是意图识别，要求模型只返回结构化结果：

```json
{
  "intent": "物流查询",
  "need_retrieval": true,
  "confidence": 0.91,
  "risk_level": "low"
}
```

第二轮是回复生成，将以下内容组合进 Prompt：

- 当前客户消息
- 最近若干轮会话上下文
- 意图识别结果
- 产品知识库召回片段
- 机器人关联的语气人设
- 平台和店铺上下文
- 回复格式和风控约束

输出不应只有字符串，建议包含：

```json
{
  "decision": "auto_send|suggest|needs_human|no_reply",
  "text": "回复文本",
  "media": [],
  "intent": "物流查询",
  "confidence": 0.88,
  "risk_flags": [],
  "trace_id": "..."
}
```

## 6. 入站消息自动处理流程

以拼多多为例：

```text
拼多多 RPA 读取王刚小店:泽锋 / 念**的新消息
  -> business-api 幂等入库
  -> 生成 inbound_message 事件
  -> AI worker 消费事件
  -> 查询机器人及其知识库、平台和店铺配置
  -> QA 精确匹配
       命中：生成文本和图片回复任务
       未命中：进入意图识别
  -> 产品知识库检索
  -> 第二轮大模型生成回复
  -> 风控和置信度判断
  -> 自动发送或标记人工处理
  -> business-api 创建 RPA 任务
  -> RPA 切换拼多多店铺和目标会话
  -> 发送文本、再发送图片
  -> 回传发送结果
```

不建议在 `/rpa/events` 请求中同步等待大模型。应采用事件队列或后台 worker，以便支持重试、超时、限流、服务重启恢复和并发控制。

自动转接暂时不实现，AI 服务只返回 `needs_human` 或记录人工处理建议。

## 7. 机器人与知识库关系

机器人配置由 business-api 管理，关系应为：

```text
Robot
  -> 多个 QA 知识库
  -> 多个产品知识库
  -> 一个语气知识库
  -> 多个平台和店铺范围
```

建议的数据关系：

```text
robots
robot_qa_knowledge_bases
robot_product_knowledge_bases
robot_tone_knowledge_base
robot_platform_scopes
robot_runtime_configs
```

知识库服务不保存机器人店铺绑定关系，只保存知识资产及其索引。

## 8. 需要补充的消息和任务能力

当前消息和 RPA 任务以文本为主。为了支持“文本后发图片”，建议统一使用有序回复片段：

```json
[
  {"type": "text", "content": "..."},
  {"type": "image", "asset_id": "asset-001"}
]
```

business-api 需要保证：

- 每个回复片段有独立任务状态。
- 文本和图片按顺序发送。
- 任务幂等，失败可重试。
- 图片资源可由 RPA 安全获取。
- 发送结果可追溯到 AI trace、消息和平台会话。

还需要支持会话级并发控制，避免人工客服和 AI 同时发送：

- 人工输入或接管后暂停 AI。
- 同一会话内 AI 回复串行处理。
- AI 回复过期后不再发送。
- 平台切换或登录失效时任务进入可重试状态。

## 9. 服务认证与可观测性

知识库服务和 AI 服务均应独立部署，但不能裸奔暴露接口。建议：

- 服务间使用 API key、JWT service token 或 mTLS。
- 每个请求带 `tenant_id`、`request_id`、`trace_id`。
- 记录模型调用耗时、模型名、token 用量、检索耗时和决策结果。
- 日志中不记录 Cookie、Token 和完整聊天正文。
- 对入站消息、QA 命中、检索结果和 AI 决策设置幂等键。

## 10. 推荐落地顺序

1. 在 `contracts/` 中先确定知识库、AI、机器人配置和回复任务协议。
2. 在本地启动 knowledge-base，先实现知识库 CRUD 和 QA 精确/关键词匹配。
3. 在本地实现产品文档导入和基础混合检索。
4. 将管理后台当前本地状态接入 business-api。
5. 实现机器人与知识库、平台店铺的真实多对多关系。
6. 在本地启动 ai-reply，先实现意图识别、检索和建议回复。
7. 建立入站事件到 AI worker 的本地异步链路。
8. 联通现有 RPA 发送任务，先完成人工确认后的真实发送。
9. 再开启自动发送和失败重试。
10. 基础闭环稳定后，再迁移到 Linux 云端并替换生产级基础设施。
11. 最后评估自动转接和更复杂的策略编排。

## 11. 当前 MVP 实现状态

2026-07-29 已完成第一轮本地 MVP：

- 新增 `services/knowledge-base` 独立 FastAPI 服务，默认端口 `8010`。
- 新增本地 SQLite 知识库存储，支持 QA、产品、语气知识库基础 CRUD。
- QA 支持问题精确匹配、问题/关键词模糊匹配、权重、启用状态和图片 URL 返回。
- 产品知识库支持文档写入和关键词检索，后续再替换为完整文档解析和向量检索。
- 新增 `services/ai-reply` 独立 FastAPI 服务，默认端口 `8020`。
- AI 服务支持本地意图识别、QA 优先匹配、产品检索、fallback 回复和可选 OpenAI 兼容模型调用。
- `business-api` 新增机器人 CRUD，机器人配置使用 `config_json` 保存知识库 ID 和自动发送开关。
- `business-api` 已新增机器人与 QA 知识库、产品知识库、语气知识库、平台店铺范围的正式关系表；QA 和产品支持多选，语气只允许单选，平台店铺支持按平台全部店铺或指定店铺关联。
- 管理后台“店铺机器人配置”已经从 React mock 数据切换到真实机器人 CRUD，知识库选项读取 knowledge-base，拼多多店铺选项读取 business-api 的真实平台账号。
- AI 回复运行时从正式关系表读取机器人关联的知识库，并按会话平台和店铺范围选择已上线机器人；`config_json` 仅继续保存模型、应答风格和兼容字段。
- `business-api` 新增 `POST /api/v1/automation/reply`，可对指定会话调用 AI 服务。
- 管理后台通用设置开启自动回复总开关时，RPA 客户入站事件会异步触发已启用机器人；判定为 `auto_send` 后复用现有 RPA 发送任务。
- 根目录 `pnpm dev` 现在会同时启动业务 API、知识库服务、AI 服务、Vite 和 Electron。

当前 MVP 的明确限制：

- 管理后台 QA 问答知识库已经接入真实 knowledge-base API：问答库及问答项支持增删改、启用状态、权重排序、图片上传和图片查看；导入导出入口暂保留但未实现。语气知识库页面仍有部分本地 React 状态，产品知识库文档配置页已经接入真实 API。
- QA 匹配规则：只处理启用的问答项和启用的问答库；先按权重降序进行“问题”规范化精确匹配，再按权重降序判断客户消息是否包含任一“关键词”。分类仅作为备注展示，不参与匹配；命中后调用次数加一并返回答案和可选图片 URL。
- QA 图片保存于 knowledge-base 的本地资产目录，通过 `/api/v1/qa-assets` 上传、`/api/v1/qa-assets/{asset_name}` 查看；图片与答案绑定，未配置图片时回复链路不产生媒体项。
- 产品文档已支持 TXT、Markdown、CSV、JSON、HTML、PDF、DOCX、XLSX/XLSM 解析、内容去重、段落切片和 SQLite 持久化；当前检索仍是关键词片段检索，向量索引和图片资产处理后置。
- 无外部模型配置时使用本地规则和 fallback，不代表已经接入真实大模型。
- 自动回复默认关闭，需要在管理后台“通用设置”手动开启总开关，并在机器人配置中开启 `allow_auto_send`。
- QA 命中图片时，自动发送采用有序任务：先创建并执行 `send_message` 文本任务，文本任务完成后由 business-api 创建 `send_image` 图片任务；本地 Electron RPA 下载图片到内存、写入系统剪贴板，在拼多多输入框执行 Ctrl+V 后按 Enter 发送。图片任务失败不会重复发送文本，后续可在任务层增加重试和人工告警。
- 机器人核心配置现保存 `model`、`temperature`（模型发散度）和 `allow_auto_send`（启用 AI 自动回复）；AI 模型配置页保留供应商、API Key、Base URL 等账号级配置。旧的用户级 `enabled` 与 `temperature` 字段暂保留用于兼容，不再作为机器人运行时开关和优先温度。
- 机器人“测试回复”已提供多轮测试沙盒，调用 `POST /api/v1/automation/test-reply`。该接口复用 QA 匹配、产品检索、语气和模型决策链路，支持返回文本及 QA 绑定图片，但强制关闭自动发送、不写入正式会话，也不会创建 RPA 任务。
- QA 图片地址已统一补齐 knowledge-base 的 `/api/v1` 前缀；管理后台 QA 列表和测试回复均使用应用内缩略图/大图预览，不再通过浏览器新窗口打开图片。
- 自动回复阶段 B 已落地：QA 未命中后先通过 DeepSeek JSON 模式完成结构化意图识别，再由程序生成 Action Plan；仅普通咨询检索机器人关联的产品文档库并进行第二轮回复生成。邮件、无需回复和人工处理意图不会误入文档检索与第二轮生成。
- 机器人测试回复已增加决策链路调试信息，可查看意图、Action Plan、两轮 Provider、召回片段和 Trace ID；QA 命中仍保持零模型调用。
- 邮件服务阶段 C 已落地到 `business-api`：用户级 SMTP 配置和邮件模板使用正式 SQLite 关系表，支持 QQ 邮箱、Gmail、自定义 SMTP、SSL/STARTTLS、授权码加密存储、脱敏读取、显式测试发送和模板 CRUD。管理后台已新增“邮件服务”页面；客户会话自动邮件工作流仍留到阶段 D。

已完成的本地验证：

```text
knowledge-base healthz                       通过
ai-reply healthz                             通过
QA 创建 -> QA 命中 -> AI 返回 qa-rule         通过
business-api 机器人创建                      通过
business-api automation/reply                 通过
AI auto_send -> RpaTask 创建                  通过
Python compileall                             通过
pnpm lint                                     通过
pnpm build                                    通过
```

## 12. 结论

知识库服务和 AI 服务应作为独立服务建设，并通过稳定接口替换内部实现。旧项目的知识库逻辑值得迁移，特别是文档解析、分块、QA 匹配和混合检索；旧项目的 AI 部分只能作为模型调用和 fallback 参考，不能视为已经完成的大模型回复链路。

最终目标链路是：

```text
RPA 入站
  -> business-api 统一入库
  -> AI 服务编排
  -> knowledge-base 检索
  -> AI 模型生成
  -> business-api 创建发送任务
  -> RPA 负责平台执行
```
