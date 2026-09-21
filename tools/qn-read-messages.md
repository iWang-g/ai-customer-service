# Read Messages by Shop and CID

Minimal verified path: shop UID -> that shop's loaded bridge page ->
`im.singlemsg.GetLocalHisMsg` with an explicit CID. It does not open the target
conversation, render returned messages in the UI, send text or invoke Enter.
This is a JS bridge reader, not the native CAppMessageService send probe.

## Use

Qianniu must be logged into the shop and have loaded the V8 hook. The local
receiver must be running; this session leaves it running at `127.0.0.1:18082`.

```powershell
node .\qn-im-bridge-hook-server.js
```

Do not start a second receiver while one is already listening. Read the latest
20 local messages from the workspace root:

```powershell
node .\tools\qn-read-messages.cjs "2222303856223" "2214525969878.1-2216058631944.1#11001@cntaobao"
```

An optional third argument writes the result to a new JSON file without
overwriting an existing file. Programmatic usage:

```javascript
const { readMessages } = require('./tools/qn-read-messages.cjs');
const result = await readMessages(
  '2222303856223',
  '2214525969878.1-2216058631944.1#11001@cntaobao',
  { count: 20 }
);
```

The result includes `shopUid`, `cid`, `messages`, `count`, `hasMore`, read time
and current CID before/after. Each message has text, direction, sender/receiver,
send time and string `clientId`/`messageId`. Empty server IDs remain empty;
unknown pagination information remains null. The native message order is kept.

Count is limited to 1-20. Only the observed single Taobao CID format is enabled.
The page checks its logged-in subaccount and the CID's main-account participant
before calling the history primitive, and rechecks the account after completion.
Cross-CID results, lossy numeric IDs, native errors and oversized pages are errors,
not successful truncated data. Browser-Origin requests for this new read command
or its results are denied; this is a local Node interface, not an authenticated
production service. Keep the receiver bound to loopback.

## Verified on 2026-09-07

The target shop stayed on `tb810776366`. Reading CID for `tb4947894539` returned
20 messages (18 outgoing, 2 incoming), all with text. Before/after selected CID
remained `2207408968472.1-2216058631944.1#11001@cntaobao`.

Both previous direct-send test messages were present; their exact text and both
IDs matched the independently confirmed send receipts. The other logged-in shop
also returned two messages in a separate read. No new message was sent.

Evidence: `.tmp/qn-native-submit-probe/read-v1-target.json` and
`read-v1-mengdong.json`. Seven focused tests pass:

```powershell
node --test tools/qn-read-messages.test.cjs tools/qn-read-messages-server.test.cjs
```

Remote-history fallback, pagination, new-message polling and production-daemon
integration are deliberately deferred. The reader still needs a loaded shop
page; it is not a no-WebView native history API.

## Installation

`tools/install-qn-bridge-hook.ps1` embeds `qn-read-messages-page.js` into the V8
hook. The receiver advertises `readMessagesVersion=1` for updated pages and
rejects old pages. The real 9.97.80N resource was backed up to
`D:\packet-capture\qianniu-bridge-hook-backup-20260907-145857` before installation.
Loading a new hook requires restarting/reloading the client page. Restoring the
backup uses the existing install script's explicit `-Mode restore -BackupDir ...`
and the correct version directory; do not choose an arbitrary older backup.
