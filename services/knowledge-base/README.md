# knowledge-base

本地优先的知识库服务，默认使用 `services/knowledge-base/data/knowledge-base.db`。

```powershell
python -m pip install -e services/knowledge-base
python -m uvicorn app.main:app --app-dir services/knowledge-base --host 127.0.0.1 --port 8010
```

健康检查：`GET http://127.0.0.1:8010/healthz`

当前提供：知识库 CRUD、QA 条目 CRUD、QA 精确/关键词/模糊匹配、产品文档写入和关键词检索。当前是本地 MVP，后续可替换存储和检索实现，只要保持 HTTP 契约不变。
