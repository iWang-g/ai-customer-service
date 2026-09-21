# Installation Controller Loss, 2026-09-07

Status: six forced-controller-termination cases pass in three full runs. This
is a disposable-process transport test, not a real Qianniu installation,
exception-guard test, SDK callback observation or send test.

Follow-up: the dedicated no-send module has now been installed in real Qianniu
and queried by a new controller. It does not enable protection or sends; see
[LIVE_NOSEND_INSTALL_RESULTS.md](LIVE_NOSEND_INSTALL_RESULTS.md).

## Separation Of Roles

`qn_install_transport_lab.exe --controller-loss` is the supervisor. It creates
two fresh instances of its own executable: a message-only-window target and a
separate installation controller. Both are suspended until assigned to the
supervisor's kill-on-close cleanup Job. The supervisor retains their original
process/thread handles. No existing client PID can be selected.

The internal controller role requires a supervisor-created bootstrap mapping
named for that controller's fresh PID. It validates the bootstrap, supervisor
image/creation time/liveness, exact target image, PID/TID creation times,
thread ownership, HWND and target token before using the same fixture hook.
The standalone internal role refuses to run without that bootstrap. These
default-security mappings and identity checks remain a trusted-fixture
protocol, not authentication against a hostile same-user process.

The controller installs the thread-specific hook and publishes the request.
The supervisor then calls TerminateProcess on its retained **controller**
handle at a measured checkpoint and waits for exit code `0x514e4b01`. This
cannot be mistaken for graceful unhook/FreeLibrary or normal controller exit.
No other process is terminated by that call.

For survivor cases, the supervisor also closes its old target mapping view and
handle, reopens the existing mapping, checks its original identity/token, and
queries the module on the live target GUI thread. It neither reinstalls the
hook nor loads the DLL into the target for that query. The target window and
the pinned module also own mapping references, so this proves reconnectability
after controller loss, not exclusive ownership by the DLL.

The fixture DLL and its three-second bounded post-pin delay gate were not
changed in this round. Only the test executable was extended.

## Cases And Results

| Controller Termination Checkpoint | Expected/Observed Target Outcome |
| --- | --- |
| Hook installed, request not published | Alive; Idle, no installation or pin |
| Inside pinned hook, supervisor later releases gate | Alive; Complete, result 0, installed=1 |
| Inside pinned hook, nobody releases gate | Alive; Complete after bounded wait, result 1460, installed=1 |
| Receipt complete, hook still owned by controller | Alive; retained query succeeds |
| Controller explicitly unhooked and freed its DLL first | Alive; retained query succeeds |
| Inside pinned hook, controller owns target's nested cleanup Job | Target intentionally terminated by Job cleanup |

In each active-hook case the supervisor first observes `stage=2`, `gate=1`,
`active=1`, `state=Processing` and `installed=1`, then kills the controller.
For completed installations, the reconnected receipt matches the original
PID/TID/token. Query output is poisoned before a new GUI-thread query; the
query must replace it with installed=1, active=0, pinCount=1. Surviving targets
are then closed through WM_CLOSE and exit normally with code 0.

The Job control case is deliberately different: only the controller holds the
handle of an additional nested kill-on-close Job containing the target. Killing
that controller closes the last Job handle and terminates the target. The
supervisor still owns the outer cleanup Job, so it can inspect the outcome.

**The killed target's observed exit code was also 0.** Its shared request was
still Processing and there was no completion receipt. This is expected Job
cleanup, not graceful target completion or a safety success for a real client.
Final logs use `receipt_complete=0 result=unpublished` for incomplete requests;
a zero-initialized result field is never accepted as a success receipt.

Never put a real Qianniu client into the controller's kill-on-close Job. That
policy exists only to contain these disposable fixtures. Client survival and
test cleanup are separate properties.

## Verification And Cleanup

Build passes with -Wall -Wextra -Wpedantic -Werror. Three final six-case runs
passed: 18 controllers were intentionally terminated, 15 targets survived and
exited normally, and three target deaths were expected Job controls. Each case
waits for both processes to exit and checks outer Job ActiveProcesses=0.

The original 15-case `--self-test` transport regression and the pure
`qn_live_admission --self-test` regression also passed. CLI `--pid 36124` was
refused before target selection (exit 2). Standalone `--loss-controller` without
a bootstrap was refused (exit 1); its `FAIL ... bootstrap win32=2` diagnostic
is the expected negative-control result, not a failed six-case suite.

Commands from the probe directory:

```powershell
cmake --build build --parallel
.\build\qn_install_transport_lab.exe --controller-loss
.\build\qn_install_transport_lab.exe --self-test
.\build\qn_live_admission.exe --self-test
```

Evidence under `.tmp/qn-native-submit-probe/`:

```text
install-controller-loss-initial-20260907.log
install-controller-loss-repeat-{1,2,3}-20260907.log
install-controller-loss-regression-transport-20260907.log
install-controller-loss-regression-admission-20260907.log
install-controller-loss-orphan-refusal-20260907.log
install-controller-loss-cli-refusal-20260907.log
```

The initial run predates the `receipt_complete`/`unpublished` logging fix.
Its incomplete rows printed a default result=0, which was not a published
receipt. All three final runs use the explicit completion label.

## Limits And Next Step

Forced death is tested at the listed checkpoints, not at every instruction.
This does not cover death inside the pre-pin validation/publication gap,
mapping allocation failures, hook API failures, arbitrary GUI hangs, concurrent
controllers, hostile mapping writers or supervisor death itself. The nested
Job-owner death control tests the last-handle cleanup mechanism; it does not
claim that killing the supervisor was separately exercised.

No VEH/debug-register/SDK callback was active, so these tests do not establish
exception recovery after debugger death or real callback ABI safety. The
parent/child desktop and integrity match; real interactive-session/UIPI and
client module-loading behavior remain untested.

Next integrate a gate-free dedicated no-send installation/status protocol with
retained process/thread identity and installation-boundary module/hash/entry
revalidation. It needs explicit unknown/retained/ready states and reconnection
without blind retries, and must not inherit the fixture's kill-target Job
policy. Actual-client installation remains a separate validation step. Current
Ability + Win32 Enter auto-reply code is unchanged; direct-send stays disabled.
