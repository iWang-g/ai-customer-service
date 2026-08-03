# business-api

AI 智能客服的业务服务端。

## 本地启动

```powershell
cd D:\project-electron\ai-customer-service\services\business-api
python -m pip install -e .
python -m uvicorn app.main:app --host 127.0.0.1 --port 8001
```

桌面项目根目录也提供了 `pnpm dev:api`，数据库固定存放在 `services/business-api/data/business-api.db`。

## 默认开发账号

如果数据库为空，启动时会自动创建默认管理员账号：

- 用户名：`admin`
- 密码：`admin123`

开发环境默认会初始化示例会话和消息。注册接口为 `POST /api/v1/auth/register`，注册成功后直接返回 access token、refresh token 和用户信息。

可通过环境变量覆盖：

- `DEFAULT_ADMIN_USERNAME`
- `DEFAULT_ADMIN_PASSWORD`

完整的前后端接入范围和实测记录见仓库文档：`docs/前后端联调实现记录.md`。
