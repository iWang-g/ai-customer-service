# Isolated Debugger Lifecycle Results, 2026-09-07

**Live Qianniu gate: NOT PASSED. Do not attach this lab to Qianniu.**

Follow-up: `--guarded` now uses a narrow target-side fixture handler to recover
the pending exception, passing eight scenarios in three repeated runs. This
file preserves the original unguarded failure and its limits. See
[DEBUGGER_GUARD_RESULTS.md](DEBUGGER_GUARD_RESULTS.md) for the fix, negative
controls and remaining real-client integration gates.

The executable has only self-contained fixture/observer roles and no arbitrary
PID option. It launches its own copies inside a kill-on-close job owned by the
supervisor. It loads no Qianniu SDK DLL and invokes no real send function.
Fixture code models three Win64 callback arguments and synthetic MsgCode data.

## Implementation

`debugger_lifecycle_lab.cpp` builds `qn_debugger_lifecycle_lab.exe`.

- Supervisor creates a unique shared-memory journal and two hidden child
  processes: fixture and observer. Only those children are assigned to its job.
  Emergency job cleanup intentionally terminates disposable children if the
  supervisor exits; that is not a viable cleanup policy for a real client.
- Observer checks the child image path/start time and debugger presence, uses
  DebugActiveProcess, then DebugSetProcessKillOnExit(FALSE). It journals the
  original debug registers and thread creation time before installing DR0.
- A fixture-only readiness marker provides the callback address/entry bytes.
  These are consistency checks supplied by our own fixture, not independent
  version/hash/module-range admission gates for an untrusted target.
- Existing threads and CREATE_THREAD events receive one-shot hardware execution
  breakpoints. The handler checks RIP, exception address and DR6, reads RCX/RDX/R8
  through ReadProcessMemory and the bounded snapshot reader, restores debug
  registers and continues the event. No instruction bytes are patched.
- The target executes each callback twice; only the first call per covered
  thread is observed. The second proves execution can continue after removal.
- An unrelated fixture exception is returned as DBG_EXCEPTION_NOT_HANDLED and
  handled by the target's vectored handler. This tests one controlled exception,
  not arbitrary faults or all Windows debugging exceptions.
- Normal observation lasts 1800ms. External observer watchdog is 5000ms;
  target gates and process joins also have explicit timeouts. The fixture gates
  constrain thread creation during cleanup, so this is not a proof of handling
  unrestricted target thread churn during detach.

## Seven Scenarios

| Mode | Scenario | Result |
| --- | --- | --- |
| 0 | Main-thread and newly created-thread callback | PASS: 2 hits, 4 completed callbacks, IDs copied exactly |
| 1 | No callback before observation timeout | PASS: detach/restore, then 4 callbacks execute normally |
| 2 | Observer exits with code 73 while stopped on readiness debug-string event | PASS: target survives, supervisor restores journaled registers |
| 3 | Observer stalls at readiness event, watchdog terminates observer | PASS: target survives and runs after cleanup |
| 4 | Target exits with fixture code 29 | PASS: exit event handled, no attempt to restore dead threads |
| 5 | Observer exits with code 75 at pending hardware callback breakpoint | **FAIL SAFETY: target exits 0x80000004, zero callbacks complete** |
| 6 | Callback snapshot contains invalid client ID | PASS: 2 snapshots rejected, no partial IDs, 4 callbacks complete |

The overall test intentionally exits **1** and reports
`debugger_lifecycle_safety_failed`, `unsafeOutcomes=1`, `live_target_ready=0`.
This is a retained failing safety gate, not a passing test disguised by
accepting the crash. Invalid-snapshot and later scenarios still run to report
independent results. `qianniu_attached=0 send_invoked=0` throughout.

## Critical Failure

`0x80000004` is STATUS_SINGLE_STEP. At the moment of forced observer exit, the
hardware breakpoint exception has not been continued by its debugger owner.
Disabling debugger-exit process killing does not make that pending exception
safe. External register restoration alone cannot supply the missing successful
debug-event continuation after its owner has died. The fixture exits even in
runs where the supervisor reports all journaled registers restored.

This observation distinguishes two cases that must not be conflated:

1. Observer dies before a hardware exception is pending: cleanup can work in
   the controlled/gated fixture.
2. Observer dies with the hardware exception pending: target termination was
   reproduced. No claim of general crash-safe observation is justified.

The parent watchdog has only been tested with a readiness debug-string stall;
terminating an observer stalled inside a hardware exception could reproduce
the same unsafe outcome. Do not advertise watchdog termination as a general
recovery mechanism.

## Other Findings

The first attempt reached the callback but failed restoration validation:
Windows/hardware reported DR7=0x401 although the requested value was 1, and
DR6=0xffff0ff1 on hit. Validation now ignores DR7 reserved bit 10 and compares
the supported status bits of DR6, retaining exact address and meaningful
control-bit checks. Unused breakpoint availability has predicate checks with
occupied registers; full live occupied-register refusal was not separately
exercised. Existing-debugger refusal is implemented but not a separate scenario.

Another run found an already-exited debug helper thread. OpenThread failure is
not treated as absence: ERROR_INVALID_PARAMETER plus a successful complete
thread enumeration must confirm it is gone. Opened threads are checked for
target ownership and creation time before restoring journaled registers.

## Next Decision

Do not schedule the real-client send test yet. First separate normal controller
cancellation from debugger failure. A dedicated, minimal debugging broker can
retain ownership of pending events while a UI/controller disconnects and can
perform acknowledged continuation/restoration/detach on normal cancellation.
That still does not solve the broker's own crash; do not rename it as a fix.

Possible further research: a carefully reviewed target-side exception guard,
or a non-debugger completion observation mechanism using a process-lifetime
module. Both modify target behavior and introduce different lifetime and
exception risks. Neither is implemented or approved by these results. Reject
the shortcut of a global handler swallowing all single-step exceptions.

Before any real attachment also implement version/hash/entry admission,
existing debugger/register conflict tests, unconstrained thread churn, safe
detach under event races, and cleanup fault injection. Current synthetic
callback snapshots do not validate real ResultCode/AppMessage memory or bind
a future send request to a clientId.

## Reproduction

```powershell
cmake --build build --parallel
.\build\qn_debugger_lifecycle_lab.exe
```

Expected current exit code is 1 due to mode 5. Evidence under
`.tmp/qn-native-submit-probe/`:

- `debugger-lifecycle-lab-20260907.log`
- `debugger-lifecycle-repeat-1-20260907.log`
- `debugger-lifecycle-repeat-2-20260907.log`
- `debugger-lifecycle-repeat-3-20260907.log`
