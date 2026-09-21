# Record Arbitration Results, 2026-09-07

Status: the dirty-flag revocation race is fixed in the disposable fixture's
new arbitration mode. This is not a real-client observer or a send feature.
No Qianniu attachment, injection, scheduled task or daemon change occurred.

Follow-up: the same observer now passes eight dynamic conflict-refusal cases
in three runs, including attach races and partial/new-thread rollback. See
[DEBUGGER_CONFLICT_REFUSAL_RESULTS.md](DEBUGGER_CONFLICT_REFUSAL_RESULTS.md).
The remaining gates below describe the preceding arbitration milestone.

## Reproduced Fault

`dirty` previously represented both outstanding register work and eligibility
to recover an orphaned exception. Those are different lifetimes. A test-only
DLL pauses before checking the recovery predicate, while a supervisor restores
that same thread's live debug registers and clears `dirty`. With the old
predicate, the delivered exception is rejected and the target exits with
`0x80000004`, even though register restoration was verified successful.

`--record-race-control` intentionally preserves this old predicate and expected
exit 1. The new mode runs the same ordered race with the same strict hardware
predicate, but no longer treats register cleanup as exception revocation.

## Monotonic Record Protocol

One immutable undo payload (thread ID, creation time, original registers) is
published per slot before arming. Slots are never reused in the process.
An interlocked state word records facts without erasing other actors' progress:

| Bit | Meaning |
| --- | --- |
| Published | Immutable undo payload has been published |
| PendingOwned | Debug-event owner has validated an owned callback event |
| RestoreIntent | Restorer is about to change live debug registers |
| ExternalRestored | Set/GetThreadContext restoration was verified |
| RecoveryClaimed | Target handler claimed this exception recovery once |
| RecoveryDone | Handler wrote original registers into the exception CONTEXT |
| EventContinued | Debug owner successfully continued the handled event |
| ThreadEnded | Thread/process exit was actually observed |

External cleanup may clear `dirty` as work accounting but cannot revoke the
published undo or set a terminal event bit. `ClaimRecovery` validates the
unchanged exception/address/register/thread predicates, then CASes the claim
bit into the current state. A concurrent cleanup OR cannot erase that claim;
if state changed, the CAS loop reevaluates all eligibility conditions.
Claimed, successfully continued, or exited records reject a new recovery.

Cleanup and the handler do not take a blocking mutual-exclusion lock. An
external thread can suspend the target handler, so waiting for that same
handler while holding a restore lock could deadlock. Instead they perform
idempotent restoration from the same immutable payload into different
contexts: live thread registers versus the exception's saved CONTEXT.
Code, VEH and storage still remain pinned/retained until process exit.

`RecoveryDone`, `dirty=0`, and a recovery count do not prove the handler has
returned or authorize physical unloading. The fixture verifies actual callback
completion and target termination separately.

## Hardware Evidence Was Not Relaxed

In measured races, Windows still supplies the original hardware breakpoint
CONTEXT to the target handler even after external SetThreadContext restores
live registers. This also held when the observer itself restored registers
and exited before ContinueDebugEvent, including before its restore receipt.

The final code therefore requires the original owned DR0/DR6/DR7 fingerprint
and exact exception address/RIP/thread creation identity. Clean-register
contexts remain rejected, even if lifecycle flags say an event was pending.
An initial experimental fallback for clean contexts was removed because real
tests did not require it. Do not use the initial log to claim that fallback
was dynamically validated. `cleanContext=0` is asserted on the final runs.

`PendingOwned` is a progress marker, never a substitute for hardware evidence.
The handler cannot recover while a debugger is still attached, and it never
calls the SDK, parses messages, changes RIP, or swallows arbitrary exceptions.

## Verification

The final `--record-race` suite passes all 15 modes in three complete runs:

| Modes | Scenario | Result |
| --- | --- | --- |
| 0-8 | Previous normal, timeout, crash/watchdog, exit, invalid snapshot and close cases | All pass with new state protocol |
| 9 | External cleanup completes before handler claims exception | 1 recovery after dirty=0, 4 callbacks, exit 0 |
| 10 | Handler claims; external cleanup completes before handler restores CONTEXT | Claim preserved, 1 recovery after dirty=0, exit 0 |
| 11 | Observer restores/receipts registers, exits before event continuation | 1 recovery, 4 callbacks, exit 0 |
| 12 | Observer restores and successfully continues events | 2 normal continuations, no guard recovery, exit 0 |
| 13 | Observer exits after SetThreadContext, before verify/receipt/dirty clear | 1 recovery, 4 callbacks, exit 0 |
| 14 | External cleanup does not wait for recovery acknowledgment | 1 recovery, 4 callbacks, exit 0 |

Modes 9 and 10 pause inside the handler at a precise pre/post-claim point.
The supervisor must restore the same recorded thread, verify `dirty=0` and
`guardHandled=0`, and explicitly release the gate. Timeouts fail the test.
This is a genuine hardware exception with real external SetThreadContext,
not a simulated exception or state-only test.

An additional 32-round `--record-race-stress` run passes without pre/post-claim
pauses or a pre-cleanup recovery wait. Natural timing does not guarantee both
orders: all 32 measured runs recovered before external cleanup completed.
Deterministic modes 9/10 provide the ordering proof; the stress count alone
does not establish cleanup-first coverage.

Each protected fixture checks per-record terminal states against total
recoveries/continuations and rejects both completion owners on one record.
Two positive and 20 negative arbitration predicate cases verify continued,
exited, already claimed, wrong-thread, wrong-register, wrong-exception,
attached-debugger and clean-context rejection. Legacy 1-positive/15-negative
predicates, 16 admission concurrency rounds, and foreign-exception forwarding
are retained. Snapshot (8 groups) and offline receipt (23 tests) regressions
are separate from any actual SDK callback validation.

## Scope And Next Gate

This establishes the measured recovery/cleanup orderings, not every possible
Windows/debugger failure. In particular:

- Logical close still does not clear eligibility or unload code. A record
  whose normal ContinueDebugEvent succeeded but whose owner died before
  publishing EventContinued may be over-retained. Never reuse that slot,
  thread generation, or session to explain a later unrelated event.
- Only trusted, cooperative fixture actors publish state. Existing debugger
  and register conflicts still need separate dynamic refusal tests, as do
  publication death and broader thread churn. Flags are not authentication.
- Restorer death while holding a SuspendThread count is not covered. The
  supervisor's own kill-on-close Job ends its disposable children on exit;
  this is not proof of real-client survival of supervisor loss.
- The exact preserved exception context was observed on this machine. A
  different context is refused, not heuristically repaired. Entry-module
  lifetime, hash/range checks and safe real-client loader admission remain
  necessary. No test DLL is authorized for Qianniu loading.

Next implement and dynamically verify conflict refusal in disposable targets,
then integrate version/module identity and bounded no-send installation for
the real observer. Only after those checks should a single user-driven send
be arranged for actual callback/log identity comparison. Direct-send remains
disabled; the production Ability/Win32 Enter chain remains unchanged.

## Reproduction And Evidence

```powershell
cmake --build build --parallel
.\build\qn_debugger_lifecycle_lab.exe --record-race
.\build\qn_debugger_lifecycle_lab.exe --record-race-stress
# Expected exit 1: old dirty eligibility rule, controlled target crash.
.\build\qn_debugger_lifecycle_lab.exe --record-race-control
```

New arbitration runs use `qn_debugger_guard_race_lab_v1.dll`, which contains
bounded fixture-only race gates. The ordinary and original delay DLL modes
remain separate historical controls and do not opt into the new record
protocol. There is still no arbitrary PID or remote-loading CLI.

Final logs under `.tmp/qn-native-submit-probe/`:

```text
debugger-record-race-repeat-{1,2,3}-20260907.log
debugger-record-race-stress-20260907.log
debugger-record-race-regression-{module-guard,module-guard-delay,guarded}-20260907.log
debugger-record-race-final-control-20260907.log
debugger-record-race-unguarded-control-20260907.log
```

The initial seven-mode log predates removal of the unneeded clean-context
fallback, expansion to 15 modes, and final per-record state assertions.
