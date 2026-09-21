# Owned Callback Direct Send, 2026-09-07

Follow-up: the separate V2 probe has now verified one send with the target
conversation unselected and the reception window minimized. See
[LIVE_DIRECT_UNSELECTED_RESULTS.md](LIVE_DIRECT_UNSELECTED_RESULTS.md).
The results and limitations below describe the earlier V1 sample.

## Verified Milestone

One real direct send succeeded at approximately 14:18:50 China time. The new
probe called the outer CAppMessageService at AppBiz RVA `0xa73a40`, slot 18,
with native cid/text/source strings, an empty native extensions map, and our
own eight-byte CallbackBaseCopyable. It did not call CMessageBiz directly.

Destination: `3#2222303856223`, customer `tb4947894539`, cid
`2214525969878.1-2216058631944.1#11001@cntaobao`.

```text
text=CodexDirectSend-20260907061849914
messageId=4288476945628.PNM
clientId=7502611323700641889
entered=1 returned=1 callbacks=1 before_return=0 destroyed=1
invalid=0 conflicts=0 snapshot_status=0 result=0 callback_tid=29752
business status=confirmed candidates=1 issues=[] retryAllowed=false
sendStatus=0 progress=100
```

The two business records are duplicate notifications of one message, not two
sends. The clientId binding came from our callback, not from selecting the first
matching log. After the first controller exited, a new `--status` query returned
the same snapshot and destruction count. Both client processes remained responsive
with unchanged start times. This is a server-success receipt, not a recipient-read
acknowledgement.

## Implementation and Guards

- `direct_receipt.h`: process-owned single-use slot; native constructor/adopt/copy/
  destructor exports; callback copies ResultCode and both message IDs while borrowed
  references are valid. SRWLOCK protects publication; invalid/conflicting notifications
  remain visible. Final native destruction frees only the small bind-state.
- `direct_once_hook.cpp`: dedicated pinned DLL and retained PRGBASE dependency;
  GUI-thread execution via temporary WH_CALLWNDPROC, immutable request copy, version/
  process/account/service revalidation, native argument roundtrip and refcount
  `1 -> 2 -> 1` checks before one outer-service invocation.
- `direct_once.cpp`: read-only service scan outside the GUI thread; retained process,
  thread and image file handles; flushed CREATE_NEW consumed-intent journal before
  dispatch; per-process-creation mapping and one invocation per module epoch.
- `direct-send-once.cjs`: research `sendText(shopUid, cid, text)` orchestration with
  a strict test-destination/text allowlist, read-only account/recipient checks,
  durable intent, log identity/cursor capture, callback-to-business correlation.
- `live_admission.cpp`: optional fifth exact research-module path, defaults unchanged;
  added structured file-hash/PE/entry-byte checks used for all five native helper
  RVAs and five PRGBASE callback exports. No blanket `qn_*` allowance.

AppBiz/PRGBASE retain their previously verified hashes. The live identities were
PID 36124, creation FILETIME 134330727293831632, GUI TID 29752, HWND 0xaa0a4c;
AppBiz base 0x7ffbb21c0000, PRGBASE base 0x7ffc18950000. Freshly located service
0x2b96f975ba0 and readiness pointer 0x2b9754623a0 are evidence only, never constants
for future requests.

## UI Independence and Limits

No openChat, input insertion, activation, UIA, Enter, hardware breakpoint,
vtable patch, process-wide debugger or scheduled task was used for this send.
Foreground/minimized endpoints and target-page shop/cid endpoints were unchanged.
The bridge server was used only for read-only identity/context evidence.

This is NOT yet a generalized daemon API. The target shop page already held the
authorized target conversation. The script deliberately checks that existing
context; inactive-conversation routing, another visibly selected shop, minimized
operation, arbitrary text, multiple successive requests, logout/restart and other
versions have not been established by this one sample. Endpoint checks are not
continuous monitoring of transient foreground changes. The new private entry
remains version-specific and still runs in an interactive GUI process.

The mapping/token prevents accidental cross-request dispatch, not malicious
same-user tampering. Version checks and guarded memory reads do not prove that
all private ABI/concurrent logout/SEH failure cases are safe. Controller timeout
or death leaves delivery unknown and state retained; no retry or Enter fallback
is allowed. The experiment is bounded to one consumed epoch, not a reusable
production queue or a restart-safe exactly-once delivery service.

## Tests and Evidence

New callback fixture passed real PRGBASE asynchronous copy/release with late ID
copy, synchronous failure with no AppMessage, 400 concurrent identical callbacks
plus one conflict, null-result and missing-callback scenarios, and slot-reuse
refusal. This fixture loads no AppBiz and sends nothing. Eight existing identity
reader groups and 23 receipt-correlator tests passed. Admission parser/window
self-tests passed after the optional allowlist extension.
Four new orchestrator tests also passed, covering independent receipt binding,
callback anomalies/ID conflicts, incomplete lines and pre-I/O destination refusal.
The temporary bridge server PID 40824 was stopped after verification. No controller
process remains; only the intentionally pinned in-client module/state remains.

Evidence under `.tmp/qn-native-submit-probe/`:

```text
direct-v1-intent.json
direct-v1-consumed-36124-134330727293831632.bin
direct-v1-controller.log
direct-v1-appended.log
direct-v1-result.json
```

Keep these intents; do not delete them to force another send.

```powershell
.\tools\qn-native-submit-probe\build\qn_direct_once_probe_v1.exe --status
```

The new module `qn_direct_once_v1.dll` remains pinned until Qianniu exits, even
though callback bind-state destruction is complete. Temporary hooks are removed.
Old no-send and V1/V2/V3 observer modules also remain loaded; do not rebuild loaded
DLL targets or claim full physical unload. Use the new status tool, since old
admission tools may reject the additional resident module. Production daemon and
the old disabled lower-level direct-send entry are unchanged.

```text
DLL SHA256 6B226D5DAAB56C9F1412788C828BAA7C34320622DD0925FB88CC799D494623B1
EXE SHA256 AEFE910F61E0444288046A5A95921AE604B81AB1F8F65A26DF6295A754DE9343
```

Next: use read-only account/conversation mapping independent of the current page,
then separately verify one send to this same authorized conversation while its
shop/conversation is not selected. Only after that and minimized/repeat-request
coverage should the one-shot slot become a serialized request service. Keep the
working production chain available throughout.
