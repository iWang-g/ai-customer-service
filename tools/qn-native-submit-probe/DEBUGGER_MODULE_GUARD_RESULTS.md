# Independent Guard Lifetime Results, 2026-09-07

Status: disposable-process module lifetime tests pass. No Qianniu attachment,
injection, SDK send, or production daemon change. Direct-send remains disabled.

Follow-up: the record-revocation race has now been reproduced with the old
predicate and repaired in a separate fixture arbitration mode. See
[DEBUGGER_RECORD_ARBITRATION_RESULTS.md](DEBUGGER_RECORD_ARBITRATION_RESULTS.md)
for measured orderings and narrower remaining gates. This file records the
preceding lifetime-only milestone, not the current arbitration protocol.

## Lifetime Contract

`debugger_guard_lab.cpp` builds two independent fixture DLLs:

- `qn_debugger_guard_lab_v1.dll`: narrow exception recovery without a pause.
- `qn_debugger_guard_delay_lab_v1.dll`: same code, with a compile-time-only,
  four-second maximum fault-injection pause after recovery acknowledgment.
  The controller must release this pause; timeout fails the test. This binary
  is not a candidate for client deployment.

The EXE loads its sibling DLL only into its own fixture child. There is no
remote loader, arbitrary PID switch or real-client observer. Installation
validates API/layout version, mapping size, fixture process ID and creation
time, empty initial journal, no attached debugger and a published entry.
The normal debugger still validates child executable path and creation time.
These are cooperative lab gates, not authentication of arbitrary shared memory.

Before acknowledging readiness, the DLL pins itself using
`GET_MODULE_HANDLE_EX_FLAG_PIN`, maps its own view of the journal and opens its
own observer process handle. Entry address is copied into module-private state.
The observer cannot attach before readiness. The narrow recovery predicate is
shared with the previous inline fixture to avoid divergent ownership checks.

`QnDebuggerGuardCloseV1` is an idempotent, terminal **logical close**, not detach,
breakpoint removal, VEH removal, storage release or DLL unload. It closes the
admission word atomically. Preexisting publication reservations may finish;
later reservations are rejected. The caller must not equate close success with
publishers drained. Installed recovery remains valid for prior dirty records.
There is no reopen, record reuse or second installed session in this process.

The DLL, its VEH, mapping/view and observer handle are retained until process
exit. This intentionally avoids reclamation, including the interval after the
active counter reaches zero but before the handler's return instruction. The
fixed 32-record journal bounds this one-shot experiment. Holding resources is a
deliberate restriction, not proof that unloading a VEH would be safe.

## Tests

Both final DLL variants passed all nine scenarios in three full repeated runs:

| Mode | Scenario | Result |
| --- | --- | --- |
| 0 | Normal main/new-thread observation | 2 hits, 4 completed callbacks, exit 0 |
| 1 | Observation timeout | 4 callbacks after cleanup, exit 0 |
| 2 | Observer exit at readiness event | Target survives, exit 0 |
| 3 | Watchdog terminates observer at readiness | Target survives, exit 0 |
| 4 | Intentional fixture process exit | Expected exit 29 |
| 5 | Observer exit at pending callback exception | Exactly 1 recovery, 4 callbacks, exit 0 |
| 6 | Invalid identity snapshot | 2 rejections, 4 callbacks, exit 0 |
| 7 | Watchdog termination at pending callback | Exactly 1 recovery, 4 callbacks, exit 0 |
| 8 | Logical close before callback exception | Exactly 1 recovery after close, 4 callbacks, exit 0 |

In modes 5, 7 and 8, the delay DLL stops inside the real hardware exception
handler after `guardHandled=1`. Another target thread verifies `active=1`,
closes twice, verifies publication refusal, releases the caller's DLL reference
with FreeLibrary, and calls the exported query again while the handler is still
paused. Only then does it release the pause. All three modes report
`concurrentCleanup=1`, `gateTimeout=0`. A timeout cannot masquerade as success.

Every surviving module fixture later drops its own mapping view/handle and any
remaining caller DLL reference. Query still works through the pinned module.
A fresh unrelated exception then actually traverses the retained VEH and is
forwarded to a separate fixture sink. This tests retained code AND the module's
independent data view, rather than just checking a module handle.

Additional tests cover duplicate installation, API version refusal, close
before installation, no reopen after close, one positive/15 negative recovery
predicates, and foreign single-step forwarding. Admission tests include 16
controlled two-thread races per invocation: a publisher reserves, close wins,
new publication is refused, then the existing publisher drains without
reopening the session. These test reservation ordering, not an actual debugger
crash midway through register publication.

The previous inline `--guarded` eight-scenario mode is retained as a regression.
Default unguarded mode remains the expected-failing negative control; do not
change its `0x80000004` crash into a success assertion. Snapshot and offline
receipt tests remain separate from real SDK validation.

## Still Not Proven

- The external restorer can race exception delivery in an arbitrary target.
  The lab waits for recovery acknowledgment in known pending-crash cases and
  keeps all storage alive. Logical close never clears a dirty record. A future
  real observer needs a distinct recovery/retirement ownership protocol before
  it may clear records whose exceptions could still be pending.
- Records are still written by trusted cooperative lab processes. Process
  identity is checked, but mutable shared memory is not an immutable,
  authenticated session ledger. Entry-module unload/address reuse, arbitrary
  thread churn, controller reconnect and session reuse are not supported.
- A publisher dying with a reservation is not dynamically covered. The design
  must leave such a session closed/quarantined, not reset counters or free
  memory on a timeout. A nonzero publisher count is not a cleanup receipt.
- Real AppBiz hash/range/entry admission and dynamic refusal tests for an
  existing debugger or conflicting hardware registers still need work.
- The observer and target are in one supervisor-owned kill-on-close Job.
  Supervisor death intentionally ends its disposable children; this does not
  prove real-client survival of supervisor loss.
- Permanent module retention changes target state until restart. There is no
  safe physical unload result, and no reason to call this purely read-only
  external observation. A real-client no-send install test must disclose this.

## Next Gate

First validate recovery/retirement arbitration, cancellation with a live event
owner and refusal of debugger/register conflicts in owned fixtures. Integrate
the versioned no-send real observer only after those gates, with explicit
module/address identity and bounded one-shot admission. Then test installation
without breakpoints or sending before asking for one user-driven Qianniu send.
Do not load the delay DLL into Qianniu or enable direct-send.

## Evidence

Final-binary logs under `.tmp/qn-native-submit-probe/`:

```text
debugger-module-guard-repeat-{1,2,3}-20260907.log
debugger-module-guard-delay-repeat-{1,2,3}-20260907.log
debugger-inline-guard-regression-20260907.log
debugger-module-unguarded-control-20260907.log
```

Initial `debugger-module-guard[-delay]-20260907.log` files predate the added
16-round admission concurrency test; the repeat files contain the final build.

```powershell
cmake --build build --parallel
.\build\qn_debugger_lifecycle_lab.exe --module-guard
.\build\qn_debugger_lifecycle_lab.exe --module-guard-delay
.\build\qn_debugger_lifecycle_lab.exe --guarded
# Expected exit 1, owned fixture intentionally faults:
.\build\qn_debugger_lifecycle_lab.exe
```
