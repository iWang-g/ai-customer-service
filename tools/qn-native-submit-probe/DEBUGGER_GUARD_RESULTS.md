# Narrow Exception Guard Results, 2026-09-07

The previously reproduced pending-breakpoint crash is recovered in the guarded
disposable fixture. Three full guarded runs pass all eight scenarios. The
unguarded control still fails with STATUS_SINGLE_STEP. This is a controlled
fault-recovery result, not permission to attach the current lab to Qianniu.

Follow-up: independent pinned fixture DLLs now pass module-lifetime and
controlled concurrent-close tests. See
[DEBUGGER_MODULE_GUARD_RESULTS.md](DEBUGGER_MODULE_GUARD_RESULTS.md).
The remaining integration gates are narrowed there; the original inline
fixture results below remain historical evidence.

## Change in Protection Model

The target installs a vectored exception handler before the observer attaches.
The observer waits for guard readiness before DebugActiveProcess and publishes
original registers/thread creation identity before arming each breakpoint.
The target holds a SYNCHRONIZE handle to the exact observer process object.

The handler only considers a continuable EXCEPTION_SINGLE_STEP with no extra
exception parameters. All of these must match:

- Target reports no debugger attached; while attached, never take the event
  away from the debugger.
- ExceptionAddress and RIP equal the registered fixture callback entry.
- DR6 indicates only the owned DR0 execution breakpoint, not other slots,
  single-step TF, or other debug causes.
- DR0 and DR7 equal the owned breakpoint configuration; DR1/2/3 remain equal
  to the saved originals, and EFlags does not enable TF.
- Current thread ID and creation time match a still-dirty journal record.
- The record has not already consumed a recovery. An interlocked one-shot
  transition prevents repeated recovery using the same record.

It restores debug registers in the supplied exception CONTEXT and returns
EXCEPTION_CONTINUE_EXECUTION. It does not skip instructions, invoke the
callback, read message contents, allocate, log to disk, wait, or call an SDK.
Anything outside that narrow predicate returns EXCEPTION_CONTINUE_SEARCH.
Shared fixed-size diagnostic fields record the exception without formatting
inside the handler. Predicate checks are not authentication of untrusted shared
memory: all roles and records are trusted lab processes here.

## Important Windows Ordering

The first guarded attempt still failed because it required the observer process
handle to be signaled before recovery. Diagnostics showed the target already
receiving the orphaned exception while WaitForSingleObject(observer, 0) returned
258 (WAIT_TIMEOUT). The debugger was in its exit path, but its process object
had not yet become signaled.

The operative condition is now **debugger detached**, checked in the target,
not timing of observer process signaling. The process handle is still retained
for identity/lifetime diagnostics and WAIT_FAILED causes rejection. A clean
detach accidentally leaving the exact registered hardware exception could also
meet this predicate; it is deliberately not claimed to prove process death.

## Results

With `--guarded`, all eight modes pass:

| Mode | Case | Guard Recoveries | Target Result |
| --- | --- | --- | --- |
| 0 | Normal main/new-thread observation | 0 | 2 observed hits, 4 callbacks, exit 0 |
| 1 | Observation timeout | 0 | 4 callbacks after cleanup, exit 0 |
| 2 | Observer exit at readiness event | 0 | 4 callbacks, exit 0 |
| 3 | Watchdog terminates stalled readiness observer | 0 | 4 callbacks, exit 0 |
| 4 | Intentional target exit | 0 | Expected fixture exit 29 |
| 5 | Observer exits with callback exception pending | 1 | 4 callbacks, exit 0 |
| 6 | Invalid callback identity snapshot | 0 | 2 rejections, 4 callbacks, exit 0 |
| 7 | Watchdog kills observer stalled at callback exception | 1 | 4 callbacks, exit 0 |

Both repaired pending-event cases require exactly one recovery and successful
target completion. The supervisor waits for that recovery acknowledgment before
cleaning remaining thread registers. Acknowledgment is not evidence of handler
code quiescence; the handler remains compiled into the target executable.

Non-exit modes remove the handler after callbacks/workers finish and after
debugger detach. Mode 4 intentionally exits the whole process, so no handler
removal acknowledgment is expected. No target-side DLL unload is tested.

One positive and 15 negative predicate cases verify rejection of wrong code,
noncontinuable exception, wrong address/RIP/DR0, other DR6 causes, other enabled
breakpoints, TF, wrong thread ID/creation time, inactive or consumed record,
extra exception parameters and an attached debugger. A real fixture-generated
unrelated single-step exception carries a unique test token and is handled by
the preexisting fixture handler, not the new guard. The fixture handler does
not recognize tokenless hardware exceptions, so it cannot mask failure of the
new recovery path.

Three repeated guarded runs all ended with:

```text
result=debugger_guarded_lab_ok
unsafeOutcomes=0
qianniu_attached=0
send_invoked=0
real_sdk_callback_validated=0
live_target_ready=0
```

The default unguarded run remains a failing negative control (exit 1) with
`targetExit=0x80000004`. Do not remove the control or relabel its crash as success.

## Before a Real Test

This changes the architecture: real deployment would need target-side code,
not only a read-only external debugger. Do not transfer fixture assumptions
directly to a long-running client.

1. Extract and review a minimal versioned protection module with process-lifetime
   code/storage retention. Install and acknowledge it before any breakpoint is
   armed. Never unload on a counter/notification alone; first validate lifetime
   behavior in a disposable process.
2. Establish immutable session/process/thread ownership and bounded record
   publication/revocation, including ordinary-thread cleanup racing exception
   delivery, entry-address reuse, controller disconnect, and thread churn.
   The current trusted journal and gated fixture do not prove these cases.
3. Add native module hash/range/entry gates and real tests of debugger/register
   conflict refusal. Define safe cancellation while the observer is alive;
   the exceptional guard is not a substitute for normal event continuation.
4. Validate installation and cleanup with no live send first. Then arrange a
   single user-controlled Qianniu UI send, compare callback IDs to final logs,
   and require all cleanup receipts. No live request or target attach exists
   in the current executable.

Source: `debugger_lifecycle_lab.cpp`. Evidence under
`.tmp/qn-native-submit-probe/`: `debugger-guarded-repeat-{1,2,3}-20260907.log`
and `debugger-unguarded-control-20260907.log` (final binary); the earlier
`debugger-guarded-lab-20260907.log` predates the extra predicate/foreign-step tests.

```powershell
cmake --build build --parallel
.\build\qn_debugger_lifecycle_lab.exe --guarded
# Negative control: expected exit 1, disposable target intentionally faults.
.\build\qn_debugger_lifecycle_lab.exe
```
