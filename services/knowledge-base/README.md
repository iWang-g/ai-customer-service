# knowledge-base

本地优先的知识库服务，默认使用 `services/knowledge-base/data/knowledge-base.db`。

```powershell
python -m pip install -e services/knowledge-base
python -m uvicorn app.main:app --app-dir services/knowledge-base --host 127.0.0.1 --port 8010
```

健康检查：`GET http://127.0.0.1:8010/healthz`

当前提供：知识库 CRUD、QA 条目 CRUD、QA 精确/关键词匹配、产品文档写入、SQLite FTS5/BM25 检索，以及可选的本地 embedding 语义检索。当前是本地 MVP，后续可替换存储和检索实现，只要保持 HTTP 契约不变。

产品文档语义检索默认使用 `fastembed` 和 `BAAI/bge-small-zh-v1.5`。服务会从 `KB_EMBEDDING_CACHE_PATH` 加载模型，默认 `KB_EMBEDDING_LOCAL_FILES_ONLY=true`，模型不存在或加载失败时自动降级到 FTS5/BM25 或关键词检索，不阻断服务启动和自动回复链路。

除 `/healthz` 外，所有接口都要求携带 Business API 签发的 Bearer access token。Knowledge Base 的 `JWT_SECRET_KEY` 必须与 Business API 保持一致，所有知识库、QA、文档、分块和图片资源均按 token 中的 `sub` 用户 ID 隔离。

升级已有数据库前，必须设置 `KB_LEGACY_OWNER_USER_ID`，将历史知识库明确归属到一个 Business API 用户。可先在业务数据库中查询目标用户 ID：

```sql
SELECT id, username, role FROM users ORDER BY created_at;
```

未设置历史数据所有者时，存在无归属知识库的数据库会拒绝启动，避免历史数据被错误分配或暴露。
