# Disposable Installation Transport, 2026-09-07

Status: the isolated no-SDK installation transport passes. No module was loaded
into Qianniu, no protection handler was installed, and direct-send remains disabled.

Follow-up: six forced-controller-death cases now pass in three runs, with
reconnected live status queries and a separate target-killing Job control.
See [INSTALL_CONTROLLER_LOSS_RESULTS.md](INSTALL_CONTROLLER_LOSS_RESULTS.md).
The remaining-boundaries list below describes the original transport round.

## Scope And Implementation

`qn_install_transport_lab.exe --self-test` creates only its own suspended child
executables. Each child is assigned to a kill-on-close Job before resuming and
creates a message-only window. The controller retains process/thread handles
and checks their creation times and the window's PID/TID before installing a
thread-specific `WH_CALLWNDPROC` hook. There is no existing-PID target option.

`qn_install_transport_fixture.dll` is a new independent fixture, not the SDK
probe or any debugger guard DLL. It refuses to process requests in an executable
whose basename is not `qn_install_transport_lab.exe`. It registers no VEH,
sets no breakpoint, and contains no SDK, editor or send operation. Its only
operation is to pin itself and retain a small receipt mapping until process exit.

The fixed request has magic, size, version, operation, a random nonzero 64-bit
token, process/thread creation times, PID/TID and HWND. The GUI-thread callback
validates these against its own process/thread and the receiving window before
pinning. The controller publishes `Pending` once; the hook claims it with
InterlockedCompareExchange, snapshots the request, then publishes `Complete`
after writing a PID/TID/token/result receipt. The controller never modifies an
in-flight request. A second installation is refused without an additional pin.

The mapping/token/executable-name checks are trusted-fixture checks, **not**
authentication against a hostile same-user process. The named mapping uses the
default security descriptor, and the basename check is not code signing or an
executable hash. This must not be exposed as a production installation protocol.

## Lifetime And Timeout Findings

On valid admission, the DLL pins itself with FROM_ADDRESS | PIN and retains
its own mapping handle/view. Removing the hook and freeing the controller's
local DLL reference do not physically unload the target's pinned module.

Two fixture-only delay cases pause after pinning. The controller's
SendMessageTimeout expires at 250 ms while the callback is active, then the
controller unhooks and drops its local DLL reference. In one case it releases
the gate; in the other, the gate expires at 3 seconds without release. Both
children stay alive, complete the hook, and execute a subsequent GUI-thread
query through GetModuleHandle/GetProcAddress, with no additional LoadLibrary.
The query reports installed=1, active=0 and pinCount=1. This same-thread query
also establishes that the original callback stack returned before the query.

The unreleased gate reports ERROR_TIMEOUT (1460) **and installed=1**. A timeout
does not imply rollback, absence of installation, or permission to retry. A
future real controller needs an independent status query and an explicit
unknown/retained state; it must never blindly reinstall on transport timeout.

The DLL is intentionally retained until child exit. The test does not try to
unload code when an active counter reaches zero, nor claim that logical
completion establishes unload safety. OS process exit reclaims the resources.

## Verification

Build passed with -Wall -Wextra -Wpedantic -Werror. Fifteen cases passed in
three consecutive full runs, each using a fresh child (45 clean child exits):

| Case | Expected Result |
| --- | --- |
| Normal | Success; retained query after unhook |
| Version, magic, size | ERROR_REVISION_MISMATCH; no pin |
| Token, PID, TID, process time, thread time, HWND | ERROR_INVALID_DATA; no pin |
| Operation, invalid delay | ERROR_INVALID_FUNCTION; no pin |
| Duplicate | First succeeds, second ERROR_ALREADY_INITIALIZED; one pin |
| Timeout with release | Transport times out, receipt later succeeds; one pin |
| Timeout without release | Receipt ERROR_TIMEOUT; still retained; one pin |

Each case also verifies that triggering the registered message without a
published request has no installation effect. Rejected requests leave the
child alive, and all children exit normally with code 0.

`--pid 36124` is rejected at CLI parsing with exit 2, without selecting or
accessing that process. The separate `qn_live_admission --self-test` regression
passed with target_access=0. This round did not rerun live admission scans.

Commands from the probe directory:

```powershell
cmake --build build --parallel
.\build\qn_install_transport_lab.exe --self-test
.\build\qn_live_admission.exe --self-test
```

Logs under `.tmp/qn-native-submit-probe/`:

```text
install-transport-initial-20260907.log
install-transport-repeat-{1,2,3}-20260907.log
install-transport-cli-refusal-20260907.log
```

The initial log contains the earlier 12-case suite. The three repeat logs are
the final 15-case suite. The first build caught a volatile-address cast error;
the final build uses the address of a non-volatile module global for pinning.

## Remaining Boundaries

- This is transport and retained-state validation, not a real exception guard,
  real callback layout test, account binding or message-send test.
- The gate is test-only and must never ship in a client-side module. Mapping
  and DLL code remain until exit; a real installation changes client state until
  restart and must report that fact explicitly.
- Actual controller termination, default Job cleanup on such termination,
  injected Win32 allocation/hook failures, a hung GUI and concurrent competing
  controllers were not fault-injected in this suite. Unhook/local FreeLibrary
  with an in-flight callback is not equivalent to full controller death.
- Fixture parent/child share a desktop and integrity level. UIPI, a different
  interactive session and Qianniu's actual module-load behavior remain untested.
- Real admission still needs installation-boundary module/hash/byte and retained
  identity checks. The read-only snapshot from the prior round is not reusable
  installation authority. These fixture binaries must not be loaded into Qianniu.

Next: design a gate-free dedicated real no-send module and status protocol,
integrate retained identity/revalidation, and cover controller-loss behavior in
isolation before actual-client installation. No debug attachment or native send
is enabled by this milestone. The current Ability + Win32 Enter chain is unchanged.
