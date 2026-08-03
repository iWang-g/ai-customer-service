# ai-reply

本地优先的 AI 回复编排服务，默认连接 `http://127.0.0.1:8010` 的 knowledge-base。

```powershell
python -m pip install -e services/ai-reply
python -m uvicorn app.main:app --app-dir services/ai-reply --host 127.0.0.1 --port 8020
```

健康检查：`GET http://127.0.0.1:8020/healthz`

回复接口：`POST /api/v1/replies/preview` 或 `POST /api/v1/replies/decide`。默认使用本地规则和 fallback；配置 `AI_PROVIDER_BASE_URL`、`AI_PROVIDER_API_KEY` 和 `AI_MODEL` 后，可调用 OpenAI 兼容模型服务。
