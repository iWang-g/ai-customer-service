# Conflict Refusal Results, 2026-09-07

Status: eight disposable-process conflict tests pass in three complete runs.
No Qianniu debug attach, guard installation, SDK call, send or daemon change.
This is a refusal/rollback milestone, not real-client installation approval.

Follow-up: actual-client read-only module/entry checks now pass, and a unique
reception window binds to PID 36124 in repeated snapshots. No module has been
installed. See [LIVE_ADMISSION_RESULTS.md](LIVE_ADMISSION_RESULTS.md).

## Observer Changes

Expected conflicts no longer call the generic fatal Check path. The observer
returns a distinct refusal reason and exit code 42. The test supervisor exits
zero only when refusal, ownership preservation, rollback and target health
are all verified. Refusal is not success for an observation or send request.

Before attach, CheckRemoteDebuggerPresent failure or a present debugger refuses
without calling DebugActiveProcessStop. A failed DebugActiveProcess is also
terminal: the observer does not retry, terminate the incumbent or force detach.
This covers another debugger winning after preflight. On this machine that
race returned Win32 87, not an assumed ERROR_ACCESS_DENIED.

At the ready debug event, all known threads are checked before any breakpoint
is armed. Every actual arm rechecks availability. Later CREATE_THREAD events
use the same check. If a conflict is found after partial arming, admission is
closed, its pending publisher reservation is released, and only this observer's
journaled registers are restored while the current debug event still stops
the target. The event is continued normally, then this observer detaches.
No foreign register/TF state is cleared in the refusal path.

The existing identity checks remain: only the lab's self-created executable
with matching process creation time may be attached. No arbitrary PID option,
remote Qianniu loader, task scheduler entry or production integration exists.

## Independent Owners

The existing-debugger cases use a separate `--incumbent` child of the same
disposable lab. It really attaches to the target, processes debug events and
continues a subsequent fixture exception after the candidate observer refuses.
The candidate never detaches it; the incumbent later exits voluntarily.

Register conflicts are written by the supervisor at bounded injection gates,
using real SuspendThread/GetThreadContext/SetThreadContext. The seed owner keeps
exactly one suspension across refusal. After the observer exits, this owner
independently reads the same thread (ID plus creation time) and verifies all
debug-register values and TF match its seed. Only the seed owner removes that
foreign state and releases its own suspension. Target callbacks then complete.

The gates are only enabled by `--conflict-refusal`; ordinary lab runs do not
pause for a seed actor. TF preservation is tested while the fixture thread is
suspended. The experiment does not execute an unowned TF trap or claim that an
unrelated external debugger's single-step policy has been validated.

## Results

All eight final scenarios passed three times:

| Case | Conflict | Candidate Result |
| --- | --- | --- |
| 1 | Incumbent already attached | Present-debugger refusal; 0 attach attempts, 0 detach calls |
| 2 | Incumbent wins after absent-debugger preflight | Attach failure, Win32 87; 1 attempt, 0 detach calls |
| 3 | Disabled nonzero DR0 plus enabled DR2 | Register refusal before arming; seeded state preserved |
| 4 | Enabled DR1 execution breakpoint | Register refusal before arming; seeded state preserved |
| 5 | DR7 enable bit with zero address | Register refusal before arming; seeded state preserved |
| 6 | Conflict introduced after one successful arm | Exactly 1 own arm restored; foreign state preserved |
| 7 | Conflict in a newly created thread | Existing own arms restored (4 in these runs); foreign state preserved |
| 8 | TF set in EFlags | Trap-flag refusal before arming; TF preserved until seed-owner cleanup |

Every candidate returned 42 with its specific refusal reason. Register cases
made exactly one detach call. Initial conflicts armed zero threads; partial
cases restored every own arm. The closed admission word contained no leftover
publisher count. There were no callback breakpoint hits or guard recoveries
used to conceal failure. All targets subsequently completed four callbacks,
forwarded unrelated exceptions, and exited zero. Incumbent cases each processed
one subsequent real fixture exception after candidate refusal.

### Disabled-Only Seed Limitation

The first attempt to seed only a disabled DR0 failed the fixture's readback:

```text
expected dr0=12345000 dr7=0
actual   dr0=0        dr7=0
```

SetThreadContext reported success, but GetThreadContext did not expose the
nonzero address when all enable bits were zero on this Windows build. The
test did not relabel this as a successful conflict. The final mixed-state
case enables independent DR2 while keeping DR0 disabled; both values are
actually read back and must remain unchanged across refusal. A purely
disabled-nonzero address remains predicate-test coverage, not independent
dynamic proof. No inference about hidden hardware state is made from the API.

## Regression And Real-Version Check

The changed observer was also run through the 15-mode arbitration suite,
32-round ungated race test, ordinary module's 9 modes, delayed module's 9 modes,
and inline guard's 8 modes. The old dirty-rule and unguarded negative controls
remain expected failures with STATUS_SINGLE_STEP. Snapshot (8 groups) and
offline receipt correlation (23 tests) are separate regressions.

The disk-only `--check-appbiz D:\qianniu\9.97.80N\AppBiz.dll` check passed:

```text
sha256=565AB778C7A5829B080E17551308254C0B9D7F1F4A2859782ADAC500C055E41C
result=analyzed_appbiz
```

This confirms the file version only, not the running process's module identity,
entry bytes, account context, or permission to install the fixture module.

## Next Installation Gate

The measured debugger/register conflict refusal gates now pass. The next
concrete task is real-target admission and a separate no-send installation
path: validate process creation identity, bitness, running module path/range,
disk hash and runtime entry bytes, and bind one immutable session. Do not reuse
the fixture-name/path gates as a real-client admission policy.

Initial real installation must be a distinct mode with no DebugActiveProcess,
no breakpoints, no SDK callback invocation and no send. A retained module
changes the process until restart, so installation and its lifecycle receipt
must be explicit. None of the delay/race test DLLs should be loaded into Qianniu.

Still not covered: generic Win32 failures during partial setup, a foreign
actor overwriting an already-owned slot, seed/restorer death while holding a
suspension, publisher death, module-address reuse and full controller loss.
The shared fixture state is trusted, and kill-on-close Job cleanup proves only
disposable-child termination. These limits remain relevant before real debug
observation; no real send has been authorized by this test outcome.

## Evidence

Final logs in `.tmp/qn-native-submit-probe/`:

```text
debugger-conflict-refusal-repeat-{1,2,3}-20260907.log
debugger-conflict-regression-record-race-20260907.log
debugger-conflict-regression-record-race-stress-20260907.log
debugger-conflict-regression-{module-guard,module-guard-delay,guarded}-20260907.log
debugger-conflict-record-control-20260907.log
debugger-conflict-unguarded-control-20260907.log
```

`debugger-conflict-refusal-initial-20260907.log` and
`debugger-conflict-refusal-seed-diagnostic-20260907.log` retain the unsuccessful
disabled-only seed attempt. The diagnostic failure is not a refusal success.

```powershell
cmake --build build --parallel
.\build\qn_debugger_lifecycle_lab.exe --conflict-refusal
```
