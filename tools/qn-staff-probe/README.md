# 千牛客服列表与状态独立只读探针

仅用于 `有求必应羊羊:王刚`，子账号 `2222303856223`，主账号 `2216058631944`。
不包含转接、发送、切换会话或输入框操作，不修改正式模块。

```powershell
node tools/qn-staff-probe/cli.cjs prepare
pwsh -File tools/qn-staff-probe/install.ps1
node tools/qn-staff-probe/cli.cjs serve
# 千牛重启加载页面并报告就绪后：
node tools/qn-staff-probe/cli.cjs status
node tools/qn-staff-probe/cli.cjs run
```

接收器仅监听 `127.0.0.1:18091`，带本地令牌和 Origin 校验。V2 页面最多轮询 30 分钟，完成后停止；每次接收器生命周期仅允许一个测试。`mtop.taobao.mmp.subuser.page.get` 从第 1 页开始，每页 5 条，直到返回少于 5 条；最多 20 页，达到上限但未结束则报错，不输出完整名单。随后执行一次 `mtop.taobao.qianniu.cloudkefu.accountstatus.getbyid`，版本均为 1.0。旧版页面不会收到 V2 任务。

已静态确认千牛原生列表从第 1 页开始，原生默认页长 200；首轮已实测页长 5 和当前子账号昵称可用。列表 nick 使用登录子账号昵称，状态使用已核对主账号 UID。若接口拒绝，不自动尝试其他账号或扩大范围。

请求前后及各页之间校验子账号 UID、主账号 UID、昵称、当前 CID。逐请求结果落在 `.tmp/qn-staff-probe/run-*.ndjson`，完成后合并为同名 `.json`。仅保留身份/组织/状态/分页白名单字段与结构摘要，不保存原始回包、认证数据、电话邮箱。按实际响应结构校验业务错误、账号归属、ID 唯一性和字段类型，保留 `pcOnline/mobileOnline`、`suspend` 及原生状态枚举；手机号仍不保留。

所有请求串行；上传重试不重复原生调用，服务端结果 ID 去重。失败、跨页重复 ID、超时或账号/会话变化均停止，不自动补发查询。迟到回调由小型 SID 过滤器隔离，保留到页面自然卸载。

名单与状态按账号 ID 合并。电脑或手机在线布尔值任一为真则在线；两者都为假才判离线，否则未知。在线候选必须在子账号名单中，排除主账号、当前源账号及离线/未知账号。`onlineCandidate` 只是在线候选，`transferEligible` 保持 null：本阶段未验证权限、暂停接待语义或实际转接。完整名单数、状态账号数、并集数、在线总人数、在线子账号数分别统计，不能直接把 UI 的 `3/14` 当作三个可转接子账号。将来真正转接前必须刷新状态，不能使用研究快照直接操作。

安装前备份并核对 ZIP 全部条目，只允许 `web_chat-packer/recent.html` 改变。清理磁盘模块用 `pwsh -File tools/qn-staff-probe/install.ps1 -Remove`；已加载脚本自然停止，不需要立刻重启。令牌配置和结果均为本地研究文件，不应公开分享。

验证：`node --test tools/qn-staff-probe/probe.test.cjs`。

2026-09-14 首轮实测已完成：列表第一页 5 条，状态 13 条（主账号 1、子账号 12），上下文未变化。旧版接收器遗漏在线字段，列表昵称已从同次完整日志离线补回，在线字段仍标为未知。修正版按实际字段保存在线值并校验业务结果及账号归属，6 项测试通过；尚未完成修正版真实状态回读。详见 `qianniu-test/staff-readonly-20260914.json` 和 `qianniu-test/transfer-research-20260914.md` 第 8 节。临时模块及接收器已清理；再次测试需显式准备加载，不自动重复请求。
