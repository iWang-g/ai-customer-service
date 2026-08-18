# Windows 客户端发布

第一版发布物是一个 Windows NSIS 安装包，包含 Electron 桌面端和独立的
`rpa-agent.exe`。目标电脑不需要安装 Node.js、pnpm 或 Python。

## 发布环境要求

- Windows 10/11；
- Node.js 和 pnpm，依赖已通过根目录 `pnpm install` 安装；
- Python 3.12 或更高版本；
- PyInstaller 6.16.0：`python -m pip install pyinstaller==6.16.0`。

这些要求只适用于构建电脑，不适用于安装包用户。

## 服务地址

发布前检查 `config/release.json`。第一版当前使用：

- Business API：`http://43.139.142.142/api/v1`；
- Knowledge Base：`http://43.139.142.142/kb-api/api/v1`；
- WebSocket：`ws://43.139.142.142`。

配置会作为 `runtime-config.json` 写入安装目录。Electron 渲染进程、拼多多工作区
和本机 RPA 共用该配置。校验器会拒绝把正式安装包指向 `127.0.0.1`、`localhost`
或 `::1`。

切换服务器、域名或 HTTPS 时，修改这一份文件后重新构建即可。配置中不能放 JWT
密钥、AI Key、服务器密码或其他秘密。

## 构建命令

从仓库根目录执行：

```powershell
pnpm dist
```

完整命令会依次校验发布配置、生成多尺寸 Windows 图标、构建 RPA 单文件程序、构建
Vite 资源并生成 NSIS 安装包。仅构建图标、RPA 或仅校验配置可执行：

```powershell
pnpm --dir apps/desktop build:rpa
pnpm --dir apps/desktop build:icon
pnpm --dir apps/desktop validate:release
```

每次构建写入独立的 `apps/desktop/release-windows/<构建时间>/` 子目录，避免 Windows
实时防护锁住上一轮 `win-unpacked` 时影响后续发布。命令结束时会打印本次完整输出路径。
RPA 中间产物输出到 `agents/rpa/dist/`。这些产物都不会提交到 Git。

当前安装包尚未配置 Authenticode 代码签名证书。首次下载和安装时，Windows 可能显示
“未知发布者”或 SmartScreen 提示；小范围试用时应提前向用户说明，并只通过可信渠道
传输安装包及核对 SHA-256。扩大分发范围前应购买代码签名证书并接入发布流程。

## 版本与安装行为

- 版本号来自 `apps/desktop/package.json`；每次对外发布前递增；
- 安装包名称为 `AI智能客服-拼多多试用版-<版本>-Setup.exe`；
- 默认按当前 Windows 用户安装，可选择安装目录；
- 创建开始菜单和桌面快捷方式；
- 覆盖安装不删除 Electron `userData`，因此店铺分区、登录状态、RPA 离线队列和
  诊断日志能够保留；卸载前仍需在干净电脑上确认实际行为。

当前首版图标复用项目内已有的客服耳麦矢量资产，并生成包含 16、24、32、48、64、
128 和 256 像素图层的 Windows `.ico`。后续若确定正式品牌视觉，可替换
`build/app-icon.svg` 和 `build/app-icon.ico`，文件名无需改变。
