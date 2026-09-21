# Real Qianniu No-Send Installation, 2026-09-07

Status: **actual-client installation and a new-controller status query passed**.
The inert module is still resident in Qianniu until process exit. Temporary
transport hooks were removed. No debugger, VEH, SDK callback, editor operation
or send was enabled. `protection_ready=0` is intentional.

Later follow-up: separate one-shot observer modules captured a real normal-UI
completion with both IDs matching its receipt. The no-send module itself is
unchanged; see [LIVE_COMPLETION_RESULTS.md](LIVE_COMPLETION_RESULTS.md).

## What Changed

Added a dedicated `qn_live_nosend.dll` and `qn_live_nosend_probe.exe`, not a copy
of the test-gate DLL or a dispatch path through the original SDK/send probe.
The only operations are install an inert resident state and query that state.
There are no fixture delay gates, kill-target Jobs or send operations.

The existing PE/hash/entry checks are reused through `live_admission_api.h` and
a static admission-core build of `live_admission.cpp`. The original CLI retains
its strict refusal of any `qn_` module. Only the new API's explicit allowed
module path permits the dedicated DLL during its own install/status checks;
other research DLLs still cause refusal.

The controller selects the unique visible reception window and binds PID/TID,
creation times, session, HWND and AppBiz base/size. It retains process/thread
handles plus read-open AppBiz and new-module files (deny new writes/deletes)
through the operation. It repeats admission immediately before hook transport
and after completion, including both 32-byte native entry comparisons.

The GUI hook checks request magic/version/size/token and current process,
thread, creation times and window identity. After these cheap checks, it pins
itself and retains the state mapping before doing the more expensive live
module/file validation. If that check fails, the inert module can be resident
but rejected; residency does not imply readiness. C++ errors in that validation
are caught before returning through the native GUI stack.

The new DLL statically links the GCC/C++ runtimes. Its import inventory contains
only Windows/UCRT/bcrypt/user32 dependencies, avoiding additional dynamically
loaded GCC runtime DLLs inside the client. No original DLL or daemon was edited.

## Actual Measurements

| Field | Value |
| --- | --- |
| Process | `D:\qianniu\AliWorkbench.exe`, PID `36124` |
| GUI thread/window/session | TID `29752`, HWND `0xaa0a4c`, session `1` |
| Process start | 2026-09-05 17:05:29, unchanged |
| Process creation FILETIME | `134330727293831632` |
| AppBiz | `D:\qianniu\9.97.80N\AppBiz.dll` |
| AppBiz base | `0x7ffbb21c0000` |
| Resident DLL | `D:\project-electron\ai-customer-service\tools\qn-native-submit-probe\build\qn_live_nosend.dll` |
| Resident DLL base/size | `0x7ffc175c0000`, `335872` bytes |
| Resident DLL SHA256 | `5DFF66B7AA5E865C815C20EEA3764CB6D85A59704848030E156686B0310E74F2` |

The actual install returned exit 0:

```text
mode=install transport=1 transport_error=0 unhooked=1 unhook_error=0
phase=3 resident=1 admitted=1 receipt_complete=1 result=0
alive=1 identity_rechecked=1 window_endpoints_unchanged=1
protection_ready=0 sdk_calls=0 send=0 retry=0
```

After that controller exited, a separate invocation of `--status` reopened the
existing mapping. It required the same process/thread identity, DLL disk hash
and enumerated loaded module base/path. A short temporary hook dispatched only
a status query on the original GUI thread, then was removed again:

```text
mode=status transport=1 unhooked=1 phase=3 resident=1 admitted=1
receipt_complete=1 result=0 query_sequence=1 query_ok=1
alive=1 identity_rechecked=1 window_endpoints_unchanged=1
protection_ready=0 sdk_calls=0 send=0 retry=0
```

The query required a newly incremented sequence plus matching native PID/TID,
token, resident and admitted fields. It was not satisfied solely by rereading
the old installation receipt. Status uses hook transport and writes diagnostic
state, so it is not an entirely passive external read.

A duplicate install was refused with ERROR_ALREADY_EXISTS (183), exit 4,
before loading a local hook module or installing another hook. No retry was
made after an ambiguous result. A separate module enumeration confirmed only
`qn_live_nosend.dll` among `qn_` modules in the reception process. Both running
AliWorkbench processes remained responsive with their original start times.

Foreground HWND and target minimized state matched at the before/after
endpoints. There is no activation API in this path, but these endpoint checks
are not continuous visibility monitoring. No shop/cid identity was measured.

## Commands And Evidence

Commands from the probe directory:

```powershell
# This loads a module that stays until Qianniu exits. Already executed once.
.\build\qn_live_nosend_probe.exe --install QN_NO_SEND_INSTALL_ONCE
# New-controller status query, not another installation:
.\build\qn_live_nosend_probe.exe --status
```

Evidence under `.tmp/qn-native-submit-probe/`:

```text
live-nosend-install-20260907.log
live-nosend-status-reconnect-20260907.log
live-nosend-duplicate-refusal-20260907.log
live-nosend-admission-regression-20260907.log
live-nosend-strict-scan-refusal-20260907.log
```

Build and the original admission pure tests passed. Before installation, the
strict live window scan passed and `--status` correctly reported no mapping.
After installation, strict `qn_live_admission --scan-window` correctly refuses
PID 36124 because a research DLL is present (exit 3). This is the preserved
old policy, not a new client failure; use the dedicated `--status` command to
query this known resident module. Do not broaden that policy to all research
DLLs merely to make the old scan pass.

No scheduled task was needed: direct execution was in session 1 and the
thread-specific hook worked. All controller processes exited; the new DLL and
its mapping intentionally remain until client exit. They were not "cleaned
up" or unloaded. Do not overwrite/rebuild this resident DLL in place or try to
FreeLibrary it from another process. A future module change needs explicit
versioning/admission or an arranged client restart.

## Limits And Next Milestone

- This proves a real GUI-thread install/status round trip and a resident
  diagnostic state. It does not install exception recovery or make the direct
  send callback safe. `admitted=1` is the version/identity check, not SDK readiness.
- The shared mapping uses default security and trusted same-user writers. The
  random token is correlation, not a production authentication boundary.
- Admission/file/module checks are bounded snapshots, not a fully atomic
  transaction or full-section integrity proof. AppBiz itself is not pinned.
- Query reports the stored admission result while the controller separately
  reruns live identity checks. It does not silently initialize missing state.
- Partial-install/crash gaps, real-client controller termination, integrity
  boundaries and arbitrary native faults were not exercised on Qianniu. The
  previous controller-death results remain disposable-process evidence only.

Next concentrate on a real normal-send completion callback observation and
its messageId/clientId fields, adding only the protection and read-only
observer support required for that bounded experiment. The inert module is
not that protection. Do not expand generic fixture matrices as a substitute
for this client-facing milestone. Native direct-send remains disabled; the
existing Ability + Win32 Enter auto-reply chain stays usable.
