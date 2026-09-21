# Independent Buyer Order Identity Probe

Fixed target: `欧金金赛高:忘念 / tb3611370423`. This probe does not send
messages, transfer contacts, select a shop/conversation, or use the input box.
It does not modify the production order reader or save an order snapshot to the
business database.

The native log shows `mtop.taobao.yungw.security.userinfo.transfrom / 1.0`
accepting `userSecurityQueryListStr`, with `decryptUserId -> internal` conversion
for application `23436601`, and the reverse direction. Independent invocation
through `invokeMTopChannelService` and compatibility with `cs.trade.query`
were verified for the fixed target on 2026-09-15 at 17:10. The four-stage run
returned one order with product/SKU details while the selected conversation
remained `pzc1987`. Evidence: `qianniu-test/order-identity-live-1789463411334.json`.
Other accounts remain unverified; the production reader still uses its existing
identity resolver.

Sequence:

1. Verify the logged-in subaccount and main account via `getLoginuser`.
2. Query the fixed buyer's order summary. An explicitly empty summary stops here.
3. Convert the buyer UID to the fixed application's security identifier.
4. Convert the result back and require an exact buyer UID match.
5. Query order details and require their order IDs to belong to the summary.

The receiver binds to loopback `18094`, uses a generated local token, permits one
fresh target page and one run, and checks that the selected CID is unchanged
throughout. Page commands are fixed and each stage executes at most once. The
security identifier stays in memory; reports include its SHA-256 fingerprint
and normalized order fields, not raw responses or cookies. Reports are created
as `qianniu-test/order-identity-live-<timestamp>.json`.

```powershell
node --test tools/qn-order-identity-probe/probe.test.cjs
node tools/qn-order-identity-probe/cli.cjs prepare
pwsh -NoProfile -File tools/qn-order-identity-probe/install.ps1
# Manually restart Qianniu to load the installed page.
node tools/qn-order-identity-probe/cli.cjs serve
# In another terminal:
node tools/qn-order-identity-probe/cli.cjs status
node tools/qn-order-identity-probe/cli.cjs run
node tools/qn-order-identity-probe/cli.cjs status
```

`serve` never starts queries automatically. A second run is refused within the
same receiver lifetime. If a stage fails, inspect the report before restarting
the receiver/page; do not treat a successful MTOP envelope as verified identity.
The installer backs up `webui.zip`, checks entry hashes and concurrent changes,
and updates only `web_chat-packer/recent.html`. Remove with `install.ps1 -Remove`
and reload the page. Stop the dedicated receiver process when research ends.
