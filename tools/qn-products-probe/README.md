# 千牛店铺商品只读探针

独立研究工具，不接入正式 worker、数据库或 AI。使用已在目标店铺 Chromium 缓存观察到的 `mtop.taobao.qianniu.cs.item.onsale.query / 1.0`，固定查询第 1、2 页，每页 5 条。

当前限定目标 `有求必应羊羊:王刚`（子账号 `2222303856223`，主账号 `2216058631944`），请求附带已有测试会话 CID。该参数来自真实请求形态，尚未证明可以省略；它不表示探针会打开该会话。页面调用仅包含固定 MTOP 只读查询，不调用打开会话、输入框或发送能力。

```powershell
node tools/qn-products-probe/cli.cjs prepare
powershell -NoProfile -ExecutionPolicy Bypass -File tools/qn-products-probe/install.ps1
node tools/qn-products-probe/cli.cjs serve
```

安装器从实际运行进程的 `AppFramework.dll` 识别版本，只修改 `qn-products-probe` 标记块并保存整个 ZIP 备份。千牛需要重启加载。接收器绑定 `127.0.0.1:18088`，随机令牌持久化在 `.tmp/qn-products-probe/config.json`，页面来源限定 `https://alires-webui`，启动时查询关闭。

确认页面已加载后，在另一个终端执行：

```powershell
node tools/qn-products-probe/cli.cjs status
node tools/qn-products-probe/cli.cjs run
node tools/qn-products-probe/cli.cjs status
```

`run` 要求恰好一个新鲜目标页面，每次接收器运行只允许一轮两页查询。结果保存到 `.tmp/qn-products-probe/results.ndjson`，不保存完整原生回包、签名或 Cookie。超时、错误和上下文变化不自动重试。核验 `contextUnchanged`、`targetSelected`、两页总数及去重数量后，才能判断当前样本是否完成，不把缓存样本当作本次查询结果。

字段：商品 ID、标题、主图、清理后的商品链接、十进制价格字符串、原始 `quantity`、`soldQuantity`、类目 ID。未知数值保留 null，不补零；数量/销量的具体业务口径仍待确认。不包含 SKU、仓库/下架商品、商品编辑或向客户发送商品卡。

历史缓存离线分析（目标账号固定，输出文件必须不存在）：

```powershell
node tools/qn-products-probe/cache-sample.cjs .tmp/qn-products-probe/cache-evidence.json
node --test tools/qn-products-probe/probe.test.cjs
```

缓存读取仅支持本机已观察到的 Chromium blockfile 格式，跳过不完整或不支持的条目。JSONP 仅解析包裹中的 JSON，不执行脚本。分别取两页最新缓存也不保证它们属于同一时刻的快照。

清理：停止接收器进程；执行 `install.ps1 -Remove` 仅删除此探针资源标记块，下次重启千牛后完全卸载。不要用旧 ZIP 覆盖后续更新的其他模块。正常结束后页面停止轮询；其回调包装继续吞掉自身迟到响应，并将其他 sequence 回调交回原处理器。

## 商品详情模式

使用单独的 `.tmp/qn-product-details-probe`、18090 端口和 `qn-product-details-probe` 资源标记块，与商品列表研究及正式模块隔离。固定只读接口 `mtop.taobao.qianniu.cs.item.detail.query / 1.0`，固定三件商品：730328029364、835010203895、730114688994。

```powershell
node tools/qn-products-probe/detail-cache.cjs qianniu-test/new-detail-cache.json
node tools/qn-products-probe/cli.cjs detail-prepare
powershell -NoProfile -ExecutionPolicy Bypass -File tools/qn-products-probe/install.ps1 -Detail
node tools/qn-products-probe/cli.cjs detail-serve
# 手动重启千牛加载后：
node tools/qn-products-probe/cli.cjs detail-status
node tools/qn-products-probe/cli.cjs detail-run
```

请求参数为 `itemId,encryptId,isNewCustomer,_message_cid`。买家安全标识仅在目标账号缓存的精确 API/CID 匹配且唯一时在内存提取，不输出或写入结果。缓存中的 `isNewCustomer=true` 只是本次固定参数依据，不将其视为买家业务身份判断。未证明可以省略买家参数，也不尝试任意接口。安全标识失效或回包失败时终止本轮，不自动重试。

每轮仅三次顺序查询，调用前后复核登录身份及当前 CID，不切店铺/会话。结果投影到白名单 SKU、属性、服务字段，保留原始属性字符串及未识别格式，忽略原生按钮/动作、买家地区和配送信息。服务条款为资料，不能视为代码或操作指令。

清理详情模式使用 `install.ps1 -Detail -Remove`，并停止此模式接收器。正式模块不需要卸载。
