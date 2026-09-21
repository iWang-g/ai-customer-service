# Native send version compatibility

## Runtime selection

The production general-send probe discovers the loaded `AppBiz.dll` and
`prgbase.dll` paths from each candidate AliWorkbench process. Both must be unique,
in the same directory below that process's installation root, and match one
verified binary pair. The newest installed directory is never assumed active.

`native_layout.h` maps binary fingerprints to the five native entry RVAs and
two CAppMessageService vtables. An unknown or mixed pair is rejected before
service scanning or hook installation. File hashes, runtime PE headers, entry
bytes, process creation, GUI thread, account and service readiness remain checked.
The hook independently resolves and validates the layout in the target process.

This changes the production `QN_DIRECT_GENERAL` build. Older research admission
tools retain their original defaults. A future folder name can reuse a profile
when the two binary fingerprints are unchanged; an unrecognized binary revision
requires verification even when its marketing version number looks similar.

## 9.97.80N to 9.97.81N evidence, 2026-09-09

All PRGBASE PE sections are byte-identical; the complete file hash differs.
AppBiz code and data locations changed. Therefore changing directory strings
alone would not restore native sending.

| Role | 9.97.80N RVA | 9.97.81N RVA |
| --- | --- | --- |
| Service send, vtable slot 18 | `a73a40` | `a85840` |
| String assign | `17ccd0` | `17d2e0` |
| String destructor | `14e2c0` | `14e8d0` |
| Extension map constructor | `24dca0` | `24e2b0` |
| Extension map destructor | `24ea10` | `24f020` |
| Primary service vtable | `18afda8` | `18c4c78` |
| Identity interface vtable, offset 0x378 | `18aff20` | `18c4df0` |
| Additional admission entry | `4f0380` | `4f0990` |

The five complete function bodies retain instruction structure after masking
branch/call and RIP-relative address operands. The send body is 805 bytes in
both versions. RTTI identifies CAppMessageService and independently resolves
slot 18, disambiguating two structurally matching send routines. The new type
also has a separate interface table at offset 0x368; it is not the 0x378 identity
interface. Field offsets 0x378/0x3d0/0x3f0/0x578 were retained and checked live.

Offline evidence: `.tmp/compare-qn-send.py`, `.tmp/qn-send-version-map.json`.
These comparisons support the explicit 81 profile, not a universal signature
scanner or proof that all downstream behavior is identical.

## Live validation

The no-send preflight found account `3#2222303856223` in PID 37768, GUI TID 38172,
using the actual 9.97.81N paths. It reported `passed=1 hook=0 sdk_send=0`.
The reception window was minimized before and after the single authorized send.

One direct-service call sent a version-test message to the authorized test buyer
tb4947894539, CID `2214525969878.1-2216058631944.1#11001@cntaobao`:

- Duration: 1439 ms, including business receipt confirmation.
- Message ID: `4297905265629.PNM`.
- Callback client ID: `7503393352012791861`.
- Callback: entered/returned/callbacks/destroyed all 1; result 0; invalid/conflicts 0.
- Business correlator: confirmed, sendStatus 0, progress 100, one candidate;
  two log notifications refer to the same send.
- No shop/chat switch, input edit, foreground activation or Enter call is used.
- Both preflights reported minimized=1 and the same foreground HWND. Fresh bridge
  context was unavailable in this run, so no independent before/after CID claim
  is made. Endpoint observations are not continuous window monitoring.

Raw result: `.tmp/qn-native-submit-probe/layout81-live-result.json`.
The legacy native `timed_out=1` field in that result comes from reusing command 3
for cleanup after destruction; the business correlator reports timedOut=false.
No timeout-triggered resend was performed.

## Build and rollback

Run `build-direct-general.cmd` in a VS2022 C++ build environment. It builds into
`build/staged` and runs the native profile test. Install the two general-send
binaries only after confirming no old general DLL is loaded in the client.
The installed pair was backed up under
`.tmp/qn-native-submit-probe/backup-layout-20260909-180557`.
Once the hook has been pinned in Qianniu, replacing its DLL requires restarting
Qianniu; do not overwrite a loaded module or unload outstanding callbacks.

The Node wrapper now retains bounded refusal/selection/result diagnostics and
the exit code while omitting command-line message text. Unknown outcomes still
forbid automatic retry. Native profile tests, 26 Node service/receipt tests and
the desktop Qianniu adapter suite passed. No new frontend behavior was changed.
