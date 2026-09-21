# Completion Identity Research, 2026-09-07

Latest result: a real one-shot GUI-thread completion snapshot now matches both
messageId and clientId from a confirmed authorized UI send. This uses a narrow
target-side VEH without a process debugger; see
[LIVE_COMPLETION_RESULTS.md](LIVE_COMPLETION_RESULTS.md). The historical
milestones below remain as chronology. Native direct-send is still disabled.

Status: static evidence and synthetic snapshot tests only. No completion
observer is attached or implemented by this document. Direct-send is disabled.

Update: an isolated self-process debugger lab is now implemented. It reads the
synthetic callback through hardware breakpoints but **fails the observer-crash
safety gate**: exiting at a pending callback exception terminates the fixture
with STATUS_SINGLE_STEP (0x80000004). No real-target observer is implemented or
approved. See [DEBUGGER_LIFECYCLE_RESULTS.md](DEBUGGER_LIFECYCLE_RESULTS.md).

Follow-up: the guarded fixture recovers this crash with a strictly scoped,
preinstalled target-side exception handler. Three complete guarded runs pass;
the unguarded negative control still crashes. This has not been packaged or
validated as a Qianniu protection module. See
[DEBUGGER_GUARD_RESULTS.md](DEBUGGER_GUARD_RESULTS.md).

Further follow-up: independent pinned fixture DLLs pass nine scenarios in
three runs each, including releasing caller resources while a handler remains
active and recovery after logical close. Code/data/VEH are retained until
process exit, not physically unloaded. Recovery/retirement arbitration and
real-target admission remain pending. See
[DEBUGGER_MODULE_GUARD_RESULTS.md](DEBUGGER_MODULE_GUARD_RESULTS.md).

Record arbitration follow-up: register cleanup no longer revokes one-shot
exception recovery eligibility in the new disposable experiment. Fifteen modes
pass repeatedly, with deterministic pre/post-claim cleanup races and an old-rule
crashing control. Original hardware predicates remain strict. Real-target
admission is still pending. See
[DEBUGGER_RECORD_ARBITRATION_RESULTS.md](DEBUGGER_RECORD_ARBITRATION_RESULTS.md).

Conflict-refusal follow-up: eight dynamic cases pass repeatedly. Expected
conflicts return a refusal rather than abruptly abandoning partially armed
threads. Incumbents and externally seeded register/TF values remain intact.
Running-module admission and no-send real installation are still pending. See
[DEBUGGER_CONFLICT_REFUSAL_RESULTS.md](DEBUGGER_CONFLICT_REFUSAL_RESULTS.md).

Live read-only follow-up: two AppBiz entries match the analyzed file in both
running processes. The unique reception window selects PID 36124, but shop
binding and the no-send installation transaction are not implemented. See
[LIVE_ADMISSION_RESULTS.md](LIVE_ADMISSION_RESULTS.md).

Installation-transport follow-up: fifteen disposable-process cases pass in
three runs, including an in-flight hook surviving unhook/local DLL release.
An installation timeout may still leave a pinned module. This is not a real
guard or actual-client installation; see
[INSTALL_TRANSPORT_RESULTS.md](INSTALL_TRANSPORT_RESULTS.md).

Controller-loss follow-up: a separate supervisor forcibly terminates the
installation controller in six disposable cases, repeated three times. Live
target queries survive the five non-kill-Job cases; the Job-owner control
intentionally terminates its target. No real guard/SDK installation occurred.
See [INSTALL_CONTROLLER_LOSS_RESULTS.md](INSTALL_CONTROLLER_LOSS_RESULTS.md).

Actual-client milestone: a dedicated inert no-send module installed on real
Qianniu's GUI thread, then responded to a fresh status query from another
controller process. Temporary hooks were removed; the module remains resident.
Protection and callback observation are still disabled. See
[LIVE_NOSEND_INSTALL_RESULTS.md](LIVE_NOSEND_INSTALL_RESULTS.md).

## Version and Evidence

AppBiz 9.97.80N SHA256:
`565AB778C7A5829B080E17551308254C0B9D7F1F4A2859782ADAC500C055E41C`.
Offsets below are version-specific, not a supported public SDK ABI.

1. AppBiz+0x24e700 initializes a messagesdk::Message with MsgCode vptr at
   +0x28 and two MSVC string descriptors at +0x30 and +0x50.
2. AppBiz+0x24f840 copies these offsets unchanged during SDK-to-AppMessage
   conversion called by +0xa69e40. AppBiz+0x857a20 moves both descriptors
   unchanged into the temporary AppMessage in completion adapter +0xa65140.
3. Independent JSON mapping functions +0x5d8b60 and +0x5dd390 explicitly name
   MsgCode+8 `messageId` and MsgCode+0x28 `clientId`.
4. Therefore, for the borrowed message at this completion boundary:
   `messageId` descriptor = message+0x30;
   `clientId` descriptor = message+0x50.
5. The completion adapter converts the message only if ResultCode+8 is zero.
   Nonzero-result paths may contain an empty/default message. Do not require or
   extract message identity on those paths.

The MsgCode vtable at +0x1846e30 has a destructor and a string-combining method
at +0x185bc0; that method alone does not establish field names. JSON mapping
was required to distinguish the two IDs, rather than guessing from their order.

## Normal UI Callback Entry

Prior real entry observation recorded callback invoke at AppBiz+0x4f0380
(module base 0x7ffbb21c0000, invoke 0x7ffbb26b0380). This is prior evidence of
the pointer value, not a new observation of a completion invocation.

Decompiler and instructions agree at entry:

```text
RCX = original native bind-state
RDX = const ResultCode&
R8  = const AppMessage&
```

The prologue saves RCX to RBP, RDX to R14, and R8 to R15. It checks the captured
WeakReference at bind-state+0x698 and Presenter pointer at +0x6a0 before
calling the member function described by captured data at +0x20. Thus it
depends on UI lifetime. Never reuse this bind-state as the probe's callback,
alter its weak reference, or manually invoke it.

## Bounded Snapshot Implementation

`message_identity_snapshot.h` accepts an explicit read-provider function and
64-bit addresses; it does not dereference them itself or open a process.
`qn_message_identity_snapshot_test` uses only a synthetic memory array.

The reader first copies ResultCode+8, exits on nonzero result, then copies the
two MSVC descriptors. It handles inline and heap strings with bounds, explicit
NUL termination, exact decimal clientId bytes and conservative ASCII messageId
syntax. Unknown formats are rejected, never normalized or truncated. The 256
byte length and 4096 capacity bounds are laboratory limits, not SDK guarantees.
All identity bytes are published together only after successful rereading of
descriptors, content and result. Failures publish no partial IDs.

Rereading detects some changes, but cannot prove a concurrent snapshot is
atomic or prevent ABA changes. Real use requires stopped target execution or
a known valid/stable borrowed reference lifetime. The function itself does
not verify module hashes, call provenance or account ownership; callers must.
Successful parsing does not create independent request binding automatically.

Eight test groups passed: heap strings/exact IDs/owned copy, inline/max-length,
nonzero result skips message, invalid lengths/capacities, null/unmapped/overflow
addresses, invalid characters/terminators, changing descriptors/content/result,
and missing provider. This is not dynamic validation of real private layouts.

## Proposed Dynamic Observation

Prefer a reviewed, bounded debugger observation at the existing UI invoke
entry over wrapping or replacing native callbacks. It must not construct or
initiate a send. It still changes debugging state and pauses execution, so it
must not be described as zero-impact merely because it reads message data.

Before live use, implement and test on a disposable process:

- Version/hash/module-range/entry-byte gates and exact process-start identity.
- Refuse an existing debugger or occupied debug-register slots; do not replace
  another debugger's state. Hardware execution breakpoint avoids code-byte
  patching but requires correct handling of relevant and newly created threads.
- Bounded attach/detach and exception handling, no swallowing unrelated target
  faults; watchdog and tested cleanup on timeout/controller failure.
- At entry, record bind-state, thread and borrowed IDs promptly, then resume.
  No original callback replacement, no callback execution by the controller,
  no snapshots read after continuing past their lifetime.
- Validate captured IDs against the exact account/cid and final native logs.
  A normal UI callback observation validates layout and behavior, not a future
  probe request's origin. Future probe binding must use its own callback state
  with a request identity and the reviewed lifetime policy.

No dynamic observer should run until its failure/cleanup behavior is verified.
Another successful manual log-only send would not close this memory-layout gate.

## Evidence Files

Under `.tmp/qn-native-submit-probe/`:

- `message-layout-bodies-20260907.log`: constructor/copy/move/destructor bodies
- `msgcode-symbols-invoke-20260907.log`: MsgCode symbols and callback invoke body
- `msgcode-vtable-20260907.log`: MsgCode vtable slots
- `msgcode-serializer-20260907.log`: string-combining virtual method, not JSON
- `message-id-json-xrefs-20260907.log`: named JSON mappings and references
- `completion-entry-instructions-20260907.log`: callback and mapping instructions
- `identity-snapshot-tests-20260907.log`: synthetic test results
