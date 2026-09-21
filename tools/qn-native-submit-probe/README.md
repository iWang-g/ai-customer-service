# Qianniu native submit probe

This is an isolated research probe. It is not referenced by the auto-reply
daemon or the Win32 Enter helper. Discovery and CBT watch modes are read-only;
draft, submit, cleanup, and CBT suppression modes require their documented
guards and remain experimental.

### Real Completion Snapshot

The 2026-09-07 V3 one-shot observation captured a real successful completion;
native messageId/clientId exactly match the account/cid/text-bound business
receipt. Hardware registers were restored and recovery records retired. DLLs
and narrow VEH registrations remain pinned until Qianniu exits. This was a
native UI OnClick send, not the still-disabled direct-send path. See
[LIVE_COMPLETION_RESULTS.md](LIVE_COMPLETION_RESULTS.md).

```powershell
.\build\qn_completion_once_probe_v3.exe --status
node check-completion-evidence.cjs
```

Older status executables may now refuse the newer resident modules under their
original allowlists. Do not rebuild/overwrite loaded module binaries in place.

### Real No-Send Installation

The dedicated `qn_live_nosend.dll` was installed into real Qianniu on 2026-09-07.
A new-controller status query passed; temporary transport hooks were removed.
The inert DLL remains until client exit, with `protection_ready=0`, no SDK and
no send. Do not rebuild/overwrite that resident DLL in place.

```powershell
.\build\qn_live_nosend_probe.exe --status
```

This command uses a brief GUI-thread hook for a fresh status response. It is
not a passive memory-only read. A new install requires the explicit
`--install QN_NO_SEND_INSTALL_ONCE` command and refuses existing state. See
[LIVE_NOSEND_INSTALL_RESULTS.md](LIVE_NOSEND_INSTALL_RESULTS.md).

The original strict `qn_live_admission --scan-window` now refuses the known
resident research module by design; use the dedicated status command instead.

### Disposable No-Send Installation Transport

```powershell
.\build\qn_install_transport_lab.exe --self-test
```

This separate fixture creates its own child processes only; it cannot select
an existing client PID. Fifteen cases verify GUI-thread hook transport,
identity refusals, duplicate refusal and pinned lifetime after timeout/unhook.
It does not install a real guard or call any Qianniu SDK. In particular, a
timeout can leave the module resident, so it must not imply a safe retry. See
[INSTALL_TRANSPORT_RESULTS.md](INSTALL_TRANSPORT_RESULTS.md). Never load its
test-gate DLL into Qianniu. The production auto-reply path is unchanged.

```powershell
.\build\qn_install_transport_lab.exe --controller-loss
```

The separate supervisor forcibly terminates disposable installation controllers
at six checkpoints. Five cases verify target survival and one verifies nested
Job cleanup by intentionally terminating its fixture target. An exit code of
zero is not proof of survival or a completed receipt. See
[INSTALL_CONTROLLER_LOSS_RESULTS.md](INSTALL_CONTROLLER_LOSS_RESULTS.md).

### Existing Probe Modes

`--enumerate-aim` is a read-only, version-gated inspection of the AIM engine's
existing account-manager tree. It prints each `AIMUserIdWithAppkey`, verifies
that the tree key matches the account identity stored in `AIMManagerImpl`, and
reports the account-bound message-service implementation pointer. It does not
construct a message or invoke any send method.

```powershell
.\build\qn_native_submit_probe.exe --enumerate-aim
```

`--enumerate-app-message-services` performs a read-only scan of committed
private memory for the version-gated `CAppMessageService` and identifier
vtables. It reports each live service's `targetId`, `targetType`, and
`CMessageBiz` pointer without invoking the service registry or a send method.

```powershell
.\build\qn_native_submit_probe.exe --enumerate-app-message-services
```

`--locate-app-message-service` applies the same read-only object and vtable
validation but requires exactly one ready `targetType=2` service for a supplied
`3#UID`. It returns the account-bound `CAppMessageService` and `CMessageBiz`
pointers without calling the service registry or a send method.

```powershell
.\build\qn_native_submit_probe.exe --locate-app-message-service '3#2222303856223'
```

`--dry-run-send-arguments` validates the analyzed AppBiz ABI without resolving
or invoking a send function. On the Qianniu GUI thread it constructs three
MSVC `std::string` objects, an empty 64-byte extensions map, and an empty
64-byte `std::function`, verifies their expected layout, then destroys all
objects that own memory. The fixed strings are never passed to a message
service.

```powershell
.\build\qn_native_submit_probe.exe --dry-run-send-arguments
```

When Qianniu runs above the caller's integrity level,
`run-send-argument-dry-run-task.ps1` is the fixed no-send entry for a temporary
highest-privilege interactive scheduled task. It runs the argument dry-run and
then the read-only app-message-service enumeration, writing one bounded log.

`--observe-aim-send` temporarily replaces the version-gated
`CAppMessageService::SendTextMsg` and `AIMMsgServiceEx::SendMessage` vtable
slots. The observer records the high-level `cid`, text, source location,
`CAppMessageService`/`CMessageBiz` pointers, and the lower-level account-bound
service implementation, `AIMSendMessage`, and extension map. Every call is
forwarded unchanged to the original function. At the end of the bounded window
both original vtable slots are restored before the hook DLL is unloaded. The
observer does not construct, modify, replay, or initiate a message.

```powershell
.\build\qn_native_submit_probe.exe --observe-aim-send 10000
```

When desktop-session isolation applies, run `run-aim-observe-task.ps1` through
a temporary interactive scheduled task and read its output file after the task
finishes.

The base `--discover` mode:

1. Requires exactly one visible `Qt5152QWindowIcon / 千牛接待台` window owned
   by `AliWorkbench.exe`.
2. Verifies the loaded `AppBiz.dll` SHA-256 matches the analyzed 9.97.80N build.
3. Installs a temporary thread-specific `WH_CALLWNDPROC` hook so discovery runs
   on that window's Qt GUI thread.
4. Reads `QApplication::focusWidget()` and walks its QObject parent chain.
5. Requires exactly one `ChatContentView` ancestor.
6. Resolves `OnClick(int)` through that object's dynamic `QMetaObject`.
7. Reports the result and removes the hook.

The discovery modes do not send keys, write text, or invoke `OnClick`.

`--discover-minimized` requires the validated Qianniu window to already be
minimized. It does not restore or activate the window. Inside the Qt GUI thread
it resolves the top-level widget with `QWidget::find(HWND)`, reads that
window's last focused child with `QWidget::focusWidget()`, and performs the same
read-only parent-chain and meta-method discovery. The probe records Win32 and
Qt minimized state and fails if the window is restored or activated.

`--discover-activate` is the same read-only probe except that it first restores
and activates the validated Qianniu top-level window, allowing Qt to restore
its last focused widget. It still does not send keys, click, write text, or
invoke `OnClick`.

The experimental submit mode is intentionally separate from the daemon and
requires the exact confirmation token shown below. After the same process,
version, focus-chain, and meta-method checks, it additionally requires the
focused widget to inherit `QTextEdit` and both the editor and
`ChatContentView` to be visible and enabled. It then invokes the dynamically
resolved `OnClick(int)` once with value `0` via `QMetaObject::metacall` on the
window's GUI thread.

```powershell
.\build\qn_native_submit_probe.exe --submit-onclick --confirm QN_NATIVE_SUBMIT_ONCE
```

The caller must validate the target shop, conversation, `cid`, draft state,
and send receipt. This mode must not be connected to the production daemon
until repeated controlled tests succeed.

The isolated minimized submit variant uses the window-level last focused
widget and refuses to run unless the validated window is minimized both before
and after the call:

```powershell
.\build\qn_native_submit_probe.exe --submit-onclick-minimized --confirm QN_NATIVE_SUBMIT_MINIMIZED_ONCE
```

`run-submit-task.ps1` selects this mode only when its guarded request contains
`requireMinimized: true`; existing callers retain the activated submit mode.

The minimized draft mode writes one guarded plain-text draft directly through
the exported Qt API and never invokes `OnClick`. It refuses to run unless the
validated window is minimized, the last focused widget inherits `QTextEdit`,
the editor is enabled and writable, and its `QTextDocument` is empty:

```powershell
.\build\qn_native_submit_probe.exe --write-draft-minimized `
  --text "unique test draft" `
  --confirm QN_NATIVE_DRAFT_MINIMIZED_ONCE
```

`run-write-draft-task.ps1` is the fixed no-argument interactive task entry. It
reads `.tmp/qn-native-submit-probe/draft-request.json`, verifies the bridge
shop, conversation, `cid`, and empty-input state, then writes
`.tmp/qn-native-submit-probe/draft.log`. The caller must remove the draft after
validation; this mode does not submit or clear it.

The matching cleanup mode requires the same minimized and editor guards but
also requires the document to be non-empty. It calls exported
`QTextEdit::clear()` and verifies the document is empty afterward; it never
invokes `OnClick`:

```powershell
.\build\qn_native_submit_probe.exe --clear-draft-minimized `
  --confirm QN_NATIVE_CLEAR_DRAFT_MINIMIZED_ONCE
```

`run-clear-draft-task.ps1` reuses the guarded draft request and writes
`.tmp/qn-native-submit-probe/clear-draft.log`.

`run-submit-task.ps1` is the fixed no-argument interactive task entry. It reads
`.tmp/qn-native-submit-probe/submit-request.json`, repeats the bridge context
and non-empty-draft checks inside the interactive task, and writes
`.tmp/qn-native-submit-probe/submit.log`.

Build with the installed MinGW toolchain:

```powershell
cmake -S . -B build -G "MinGW Makefiles"
cmake --build build
```

Run only after Qianniu is visible and its chat editor has focus:

```powershell
.\build\qn_native_submit_probe.exe --discover-activate
```

For read-only discovery while Qianniu is already minimized:

```powershell
.\build\qn_native_submit_probe.exe --discover-minimized
```

If the minimized window's last focused child is no longer the editor, the
read-only focus-chain mode enumerates the top-level widget's focus cycle and
requires exactly one visible, enabled `QTextEdit` beneath a
`ChatContentView`:

```powershell
.\build\qn_native_submit_probe.exe --discover-focus-chain-minimized
```

After a CBT-suppressed `openChat`, Win32 can remain iconic while Qt has already
cleared its internal minimized flag. The guarded reconcile mode runs on the Qt
GUI thread, resolves `QWidget::showMinimized()` by export name, and requires the
window to stay iconic and outside the foreground before and after the call:

```powershell
.\build\qn_native_submit_probe.exe --reconcile-minimized `
  --confirm QN_NATIVE_RECONCILE_MINIMIZED_ONCE
```

The focus-chain draft variants apply the same write/clear guards after finding
exactly one visible and enabled `QTextEdit` below one `ChatContentView`. They
are intended only for the post-`openChat` case where the last-focused widget
is no longer the editor:

```powershell
.\build\qn_native_submit_probe.exe --write-draft-focus-chain-minimized `
  --text "unique test draft" `
  --confirm QN_NATIVE_DRAFT_FOCUS_CHAIN_MINIMIZED_ONCE
.\build\qn_native_submit_probe.exe --clear-draft-focus-chain-minimized `
  --confirm QN_NATIVE_CLEAR_DRAFT_FOCUS_CHAIN_MINIMIZED_ONCE
```

The matching submit variant invokes `OnClick(0)` only after the same unique
focus-chain editor and `ChatContentView` guards pass:

```powershell
.\build\qn_native_submit_probe.exe --submit-onclick-focus-chain-minimized `
  --confirm QN_NATIVE_SUBMIT_FOCUS_CHAIN_MINIMIZED_ONCE
```

It does not replace caller-side validation. The caller must still confirm the
shop, target, `cid`, non-empty input, and a matching `sendStatus=0` receipt.

`run-cross-shop-draft-task.ps1` combines two bounded suppressed `openChat`
calls, state reconciliation, unique focus-chain draft write, bridge
verification, and draft cleanup. A 20 ms state watcher covers the whole run.
It never invokes `OnClick` and refuses non-empty source or target drafts.

`run-cross-shop-native-send-task.ps1` is a separate, higher-risk one-shot
entry. It requires `QN_CROSS_SHOP_NATIVE_SEND_ONCE` in its request, writes via
the unique focus-chain editor, invokes the focus-chain `OnClick(0)` mode, and
accepts success only after a matching `sendStatus=0`, `progress=100` app-log
receipt and an empty target input. The production daemon does not reference it.

The direct-send experiment bypassed `openChat`, the editor, and `OnClick`. It
located exactly one ready `targetType=2` `CAppMessageService` for the supplied
`3#UID`, then invoked the version-gated `CMessageBiz::SendTextMsg` entry once.
The executable entry is now disabled. The first controlled run reached
`/r/MessageSend/sendByReceiverScope`, but the later completion path invoked the
empty callback and terminated Qianniu with `std::bad_function_call` at
`AppBiz+0xa5a495`. Do not use this command until a version-gated, owned callback
object has been implemented and independently validated.

The callback ABI can be validated without opening or injecting into Qianniu:

```powershell
.\build\qn_native_submit_probe.exe `
  --dry-run-callback-abi D:\qianniu\9.97.80N\prgbase.dll
```

This version-gated mode loads only the analyzed `prgbase.dll` into the probe
process. It constructs a 32-byte `base::internal::BindStateBase`, adopts it
into an 8-byte `CallbackBaseCopyable`, copy-constructs a second callback,
invokes a probe-owned no-op callback with synthetic pointers, and destroys
both callback copies. It requires the reference-count sequence
`1 -> 1 -> 2 -> 1 -> 0` and exactly one final bind-state destruction. It does
not find a Qianniu process, install a hook, resolve a send address, or send a
message.

This dry-run validates the object ABI and synchronous ownership rules only.
A real asynchronous callback would point into the hook DLL, so that DLL must
remain loaded until every callback copy has been released. The transient
Windows-hook lifetime used by the current probe does not meet that condition.
The matching module-lifetime dry-run validates a bounded self-reference without
opening or injecting into Qianniu:

```powershell
.\build\qn_native_submit_probe.exe `
  --dry-run-callback-module-lifecycle D:\qianniu\9.97.80N\prgbase.dll
```

It releases the caller's initial hook-DLL reference before a worker thread
invokes and destroys the callback. The DLL must remain loaded through that
asynchronous completion. A second controlled module reference then releases
the retained reference, after which the DLL must unload. Direct send remains
disabled while the same lifecycle is validated in the target process and then
integrated into a separately guarded direct-send probe.

The target-process lifecycle dry-run applies the same ownership test inside the
running, version-gated Qianniu process without resolving or calling any send
address:

```powershell
.\build\qn_native_submit_probe.exe --dry-run-callback-target-lifecycle
```

The first thread hook constructs and copies the callback on Qianniu's Qt GUI
thread, then returns. The controller removes that initial hook reference before
allowing a worker thread to invoke and destroy the copied callback. A second
short-lived hook releases the callback DLL's retained module reference. Success
requires `1 -> 1 -> 2 -> 1 -> 0` reference counts, one cancellation check, one
invoke, one final destroy, module presence after the initial unhook, and module
absence after controlled release. `run-callback-lifecycle-task.ps1` is the
fixed, no-send interactive-desktop wrapper for this test.

The 2026-09-07 review found that `workerCompleted` could be set before the
worker returned. Lifecycle cleanup now owns and checks the thread handle,
returns `ERROR_BUSY` until it is signaled, and reports `workerExitConfirmed=1`
before releasing IPC or its retained DLL reference. Timing uses an absolute
`GetTickCount64` deadline. Module enumeration failure is not considered proof
that the target DLL has unloaded. The old direct-send operation is also
disabled inside the hook, not only in the CLI.

Additional process-external regressions:

```powershell
.\build\qn_native_submit_probe.exe --dry-run-callback-release-race D:\qianniu\9.97.80N\prgbase.dll
.\build\qn_native_submit_probe.exe --dry-run-callback-unhook-timeout D:\qianniu\9.97.80N\prgbase.dll
```

The first holds the worker after its completion notification and requires
premature release to fail without unloading. The second withholds initial
unhook acknowledgment and requires timeout cleanup with no invocation. These
tests do not open Qianniu or resolve send addresses. See
[DIRECT_SEND_DESIGN.md](DIRECT_SEND_DESIGN.md) for the outer-service entry,
receipt requirements, and remaining real-SDK lifetime review gates.

### Isolated Receipt Lab (No Send)

```powershell
cmake --build build --parallel
.\build\qn_receipt_lab_test.exe D:\qianniu\9.97.80N\prgbase.dll
```

This separate executable loads `qn_receipt_lab_v1.dll` only into its own
disposable process. It uses real PRGBASE callback ABI exports with synthetic
result bytes, never opens Qianniu, and has no send entry. The seven checks cover
synchronous/async callbacks, concurrent duplicates, timeout followed by a late
callback, missing/invalid results, and bounded slot retention. Expected final
line starts with `result=receipt_lab_no_send_ok` and explicitly reports
`real_resultcode_validated=0 business_delivery_confirmed=0`.

The lab DLL intentionally stays pinned until its test process exits, including
after the controller's loader references are released. Do not inject it into
Qianniu or treat it as an integrated receipt service. It has no production
version gate, persistent request journal, reconnect IPC or message-ID parser.
Tested PRGBASE SHA256:
`4D50ACBCCEE823D5FE01B1CE7082ED1FC97070930110727CCDBFDA628247F0FC`.

### Isolated Debugger Lifecycle Lab

```powershell
cmake --build build --parallel
.\build\qn_debugger_lifecycle_lab.exe
.\build\qn_debugger_lifecycle_lab.exe --guarded
```

**Default (unguarded) expected exit: 1. Not ready for Qianniu.**
The lab only debugs its own disposable child executable, with no arbitrary PID
option or SDK calls. Six scenarios pass, but observer exit during a pending
hardware callback breakpoint terminates the fixture with 0x80000004. The test
retains and reports that failure. It creates no visible command window or
scheduled task. See [DEBUGGER_LIFECYCLE_RESULTS.md](DEBUGGER_LIFECYCLE_RESULTS.md)
before interpreting any successful individual scenario.

The new `--guarded` mode expects exit 0: it installs a narrow handler in the
self-created target before attaching, recovering only owned orphaned hardware
exceptions. Eight scenarios passed in three repeated runs, including observer
exit/watchdog termination at a pending callback. Foreign single-step exceptions
are not swallowed. This is still fixture-only, not a Qianniu-ready DLL. See
[DEBUGGER_GUARD_RESULTS.md](DEBUGGER_GUARD_RESULTS.md) for evidence and remaining
lifetime/ownership/admission gates before real-client testing.

Independent fixture DLL lifetime modes now also expect exit 0:

```powershell
.\build\qn_debugger_lifecycle_lab.exe --module-guard
.\build\qn_debugger_lifecycle_lab.exe --module-guard-delay
```

Both passed nine scenarios in three runs each. The second loads a separate
fault-injection DLL that pauses a real exception handler while another thread
closes the session and releases the caller DLL reference. The normal DLL has
no such pause. Both pin code and retain their own journal view until process
exit; close never removes the VEH or invalidates existing undo records.
This tests retention, not safe unloading or arbitrary-target cleanup races.
See [DEBUGGER_MODULE_GUARD_RESULTS.md](DEBUGGER_MODULE_GUARD_RESULTS.md).

The next, separate record-arbitration experiment is:

```powershell
.\build\qn_debugger_lifecycle_lab.exe --record-race
.\build\qn_debugger_lifecycle_lab.exe --record-race-stress
# Expected exit 1: prior dirty-flag rule intentionally reproduced.
.\build\qn_debugger_lifecycle_lab.exe --record-race-control
```

The protected mode preserves one-shot recovery eligibility when live-register
cleanup has already cleared `dirty`; it does not relax the hardware exception
predicate. Fifteen modes pass in three runs plus 32 ungated repetitions. It
remains disposable-process-only. See
[DEBUGGER_RECORD_ARBITRATION_RESULTS.md](DEBUGGER_RECORD_ARBITRATION_RESULTS.md).

The same observer now has structured conflict refusal and rollback tests:

```powershell
.\build\qn_debugger_lifecycle_lab.exe --conflict-refusal
```

Eight cases pass in three runs: an incumbent debugger, attach race, occupied
registers/TF, partial arming and a new-thread conflict. Refusing child observers
exit 42; the supervisor expects verified refusal and target survival, not a
successful observation. Only own registers are rolled back. See
[DEBUGGER_CONFLICT_REFUSAL_RESULTS.md](DEBUGGER_CONFLICT_REFUSAL_RESULTS.md)
for actual seed limitations and the next real-target installation gate.

The independent real-client read-only admission tool is now available:

```powershell
.\build\qn_live_admission.exe --self-test
.\build\qn_live_admission.exe --scan-window
.\build\qn_live_admission.exe --scan
```

It verifies loaded module headers and two 32-byte code entries against the
analyzed disk image. Process-only selection refuses the current two-PID
ambiguity; the window-bound policy selected reception PID 36124 in three
snapshots. It does not install a module, activate a window or send anything.
`install_ready=0` is deliberate. See [LIVE_ADMISSION_RESULTS.md](LIVE_ADMISSION_RESULTS.md).

### Synthetic Message Identity Snapshot

```powershell
cmake --build build --parallel
.\build\qn_message_identity_snapshot_test.exe
```

This executable tests bounded parsing of synthetic ResultCode and MSVC string
storage. It does not load Qianniu DLLs, attach to a process or send anything.
Expected result: `identity_snapshot_fixture_ok` with
`real_layout_dynamically_validated=0`. See
[COMPLETION_OBSERVER_DESIGN.md](COMPLETION_OBSERVER_DESIGN.md) for the new
static clientId/messageId evidence and remaining live-observer requirements.

### Offline Receipt Correlation

```powershell
node --test receipt-correlator.test.cjs
node receipt-correlator-replay.cjs <capture.log> <account> <cid> <exact-text>
```

The replay command requires the capture's adjacent `<capture.log>.json`
metadata, including complete status and matching byte offsets. It reads only
existing files and prints JSON; it cannot bind a request or send a message.
Exit zero means replay completed, not delivery succeeded. Check the returned
`status`. The two-send 2026-09-07 capture returns `ambiguous`, not `confirmed`.

The standalone correlator requires an independent clientId binding to confirm
a request. It rejects unsafe ID coercion, conflicting receipts, cursor/epoch
changes and incomplete evidence. A timeout never enables retries. See the
design for limits and caller responsibilities. No production integration exists.

### Disabled Direct Send

The following command remains rejected:

```powershell
.\build\qn_native_submit_probe.exe `
  --send-text-direct-minimized `
  --target-id '3#2222397351256' `
  --cid '2207408968472.1-2219349483741.1#11001@cntaobao' `
  --text 'unique controlled test message' `
  --confirm QN_DIRECT_SEND_TEXT_ONCE
```

A zero probe exit code meant only that the native function was invoked. The
fixed `run-direct-send-task.ps1` wrapper reads
`.tmp/qn-native-submit-probe/direct-send-request.json`, monitors the window for
restore or foreground activation, and accepts delivery only after app.log has
a matching `onMsgSendUpdate`, `sendStatus=0`, and `progress=100` receipt for
the exact `cid` and text. The wrapper cannot currently pass the disabled CLI
gate, and this experimental path is not referenced by the production daemon.

To observe Win32 visibility, minimized state, and foreground ownership without
changing the target window, use the bounded state watcher:

```powershell
.\build\qn_native_submit_probe.exe --watch-window-state 8000
```

The bounded CBT modes install a thread-specific hook only on the validated
Qianniu GUI thread. The watch mode records `HCBT_MINMAX` and `HCBT_ACTIVATE`.
The suppression mode returns nonzero only for those two events when their
target HWND is the validated Qianniu top-level window, then automatically
unhooks at the requested timeout:

```powershell
.\build\qn_native_submit_probe.exe --watch-cbt-minimized 30000
.\build\qn_native_submit_probe.exe --suppress-cbt-minimized 10000
```

`run-cbt-task.ps1` runs either mode on the interactive desktop and writes
`.tmp/qn-native-submit-probe/cbt.log`. These modes are research-only and are
not referenced by the auto-reply daemon.

`run-cbt-openchat-task.ps1` is the fixed, guarded experiment that starts the
suppression hook and invokes one same-context `openChat` while the hook is
known to be active. It reads `.tmp/qn-native-submit-probe/cbt-request.json`
and writes `.tmp/qn-native-submit-probe/cbt-openchat.log`.

The version gate can be checked without touching a running process:

```powershell
.\build\qn_native_submit_probe.exe --check-appbiz D:\qianniu\9.97.80N\AppBiz.dll
```

When the controlling shell is not attached to the interactive desktop,
`run-discover-task.ps1` is the fixed, no-argument task entry. It writes its
result to `.tmp/qn-native-submit-probe/discover.log`; a caller remains
responsible for creating, running, and deleting the temporary interactive
scheduled task.
