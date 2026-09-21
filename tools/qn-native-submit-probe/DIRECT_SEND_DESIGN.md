# Direct Send Probe Review, 2026-09-07

Current status (2026-09-07, 14:18 China time): the separate v1 one-shot probe
completed one real send with its own callback and matching business receipt.
See [LIVE_DIRECT_SEND_RESULTS.md](LIVE_DIRECT_SEND_RESULTS.md) for implementation,
evidence and remaining limits. The old executable/hook lower-level operation is
still disabled. The sections below preserve the historical review gates; statements
about pending dynamic identity extraction or no implementation are historical,
not the latest status. This is not yet a generalized production API.

Follow-up at 14:35: V2 also confirmed a single direct send to an unselected
conversation while minimized, with window observation and matching business IDs.
See [LIVE_DIRECT_UNSELECTED_RESULTS.md](LIVE_DIRECT_UNSELECTED_RESULTS.md).

Live parsing milestone: one real successful UI completion has now supplied
messageId/clientId matching the independent business receipt. See
[LIVE_COMPLETION_RESULTS.md](LIVE_COMPLETION_RESULTS.md). This validates the
borrowed-field reader on that sample, not our future callback's lifecycle or
the direct-send call. The observed UI bind-state must not be reused.

Latest safety milestone: independent fixture guard DLLs pass lifetime tests
with pinned code and process-retained data, including concurrent logical close
inside a pending exception recovery. This does not yet validate real-target
register restoration/exception delivery arbitration. See
[DEBUGGER_MODULE_GUARD_RESULTS.md](DEBUGGER_MODULE_GUARD_RESULTS.md).

Follow-up: measured recovery/cleanup interleavings now pass with monotonic
record state and no dirty-flag revocation. Existing-debugger/register conflict
refusal and real-target integration remain separate gates. See
[DEBUGGER_RECORD_ARBITRATION_RESULTS.md](DEBUGGER_RECORD_ARBITRATION_RESULTS.md).

Conflict-refusal follow-up: incumbent/attach-race and register/TF conflicts now
pass controlled refusal and rollback tests. This narrows the next gate to
real-target admission and a no-breakpoint/no-send installation path, not a
permission to enable direct-send. See
[DEBUGGER_CONFLICT_REFUSAL_RESULTS.md](DEBUGGER_CONFLICT_REFUSAL_RESULTS.md).

## Entry and Arguments

Use the unique, ready `targetType=2` CAppMessageService whose account key is
`3#<login UID>`. Revalidate the instance on the GUI thread immediately before
use. Never retain an instance address across a process restart or logout.

The version-specific candidate is AppBiz+0xa73a40, vtable slot 18:

```text
this = CAppMessageService for the selected account
cid, text, source = native MSVC std::string const&
extensions = native unordered_map const&
callback = 8-byte CallbackBaseCopyable const&
```

Use an explicit probe source such as `QnNativeSubmitProbe::DirectSendReview`.
Do not mislabel it as the normal UI call site. The outer service retains its
service context and converts the Chromium callback to the lower-level MSVC
callable before calling CMessageBiz. Do not reuse the old zeroed 64-byte
callback or call the lower layer directly.

## New Static Evidence

Read-only Ghidra output:
`.tmp/qn-native-submit-probe/receipt-bodies-20260907.log`.
The earlier `outer-callback-decompile-20260907.log` script log contains only
single-line metadata, not the multiline C bodies. The new evidence captures
headless stdout/stderr and includes all five requested function bodies.

- AppBiz+0xa73a40 checks the service pointer at +0x578. When absent, it can
  invoke the supplied callback synchronously before returning. All receipt
  storage must therefore exist before calling the service, even when guards
  normally reject an unready service.
- The failure branch builds a ResultCode with values 7 and 1 at +8 and +12.
  These are observed layout values, not a fully validated public error enum.
- AppBiz+0xa65140 checks the integer at ResultCode+8 against zero before
  converting the SDK message. It invokes the outer callback in either case.
- The AppMessage passed to that callback is temporary native storage and is
  destroyed after the callback returns. Never store the pointer for later
  parsing, copy its bytes as an owning object, or call its destructor ourselves.
- AppBiz+0x382c50 destroys three MSVC strings at ResultCode+0x10, +0x30 and
  +0x50. Together with the vptr and integers at +8/+12, this is consistent with
  0x70 bytes of storage. The synchronous failure branch places
  `m_convBiz is null` in the first string. This does not establish public field
  names or enum semantics. The lab copies only the 32-bit value at +8.
- AppBiz+0xa69e40 performs the SDK-to-AppMessage conversion, including owned
  message/user context; AppBiz+0x4e07a0 consumes the UI completion. Their
  decompiled bodies do not yet establish a reviewed minimal clientId/messageId
  extractor. No AppMessage offsets have been added to the executable.

## Request and Receipt Contract

Each test request must contain a unique request ID and explicit account,
customer target ID, cid, exact text, expiry and one-shot confirmation. Obtain
account-to-shop and customer-to-cid evidence from current native/bridge state;
cid syntax alone cannot establish account ownership. Validate the supported
AppBiz and PRGBASE hashes before accessing private layouts.

Persist intent before the call and consume the request once. Record the
process identity and current log cursor. Serialize execution. Do not inspect
or modify the current editor, switch accounts/conversations, or invoke Enter.

Receipt storage needs distinct states for call entered, call returned, callback
observed, callback data copied, final bind-state destruction, and confirmed
business outcome. A callback may be synchronous, asynchronous, repeated, or
missing; none of these possibilities may invalidate storage or cause a retry.

Initially copy only independently validated scalar fields while the callback
is active. AppMessage field extraction remains pending ABI validation. Do not
count synthetic no-op callback tests as validation of real receipt parsing.

Correlate the exact account/cid/text with records after the request log cursor,
then bind the observed clientId/messageId. Require the matching final
`onMsgSendUpdate`, `sendStatus=0`, and `progress=100` for confirmed success.
An outgoing local echo, enqueue, socket write or native return is insufficient.
If the outcome is unknown, inspect the existing message; never automatically
retry through either direct-send or the Enter fallback.

The normal-UI log observation on 2026-09-07 produced two distinct sends of the
same text in one short window, each with duplicate WebEventCenter/BridgeChatMsg
receipts. Matching account/cid/text/time is therefore a candidate filter, not
a unique request binding. Preserve candidate IDs and fail closed on ambiguity;
do not pick the first successful match. `newmsgs` supplies current event
identity, while `latestmsg` can refer to an earlier opposite-direction message.
See [RECEIPT_OBSERVATION_20260907.md](RECEIPT_OBSERVATION_20260907.md).
This run validates log identifiers/statuses, not the ResultCode+8 memory layout.

## Lifetime Contract

The synthetic worker now has an owned thread handle. Release checks that
handle with WaitForSingleObject before closing its IPC or unloading code;
`workerCompleted` alone is insufficient. Tests deliberately hold the worker
after notification and require ERROR_BUSY on premature release.

Real SDK callbacks do not run on that owned worker. Waiting for an entire SDK
thread to exit is inappropriate because it may live for the whole process.
Likewise, decrementing an in-flight counter or signaling final destruction
just before returning does not prove that the callback has left our DLL.

Selected experimental strategy: use a separate, versioned receipt module pinned
with GetModuleHandleEx(FROM_ADDRESS | PIN) for the entire target process, and
retain its PRGBASE dependency. Do not pin the large discovery/research hook.
The new `qn_receipt_lab_v1.dll` tests this strategy only in disposable test
processes; it has not been loaded into Qianniu or wired to the native send path.

The alternatives and operational cost remain explicit:

- Retain the receipt module for the whole Qianniu process lifetime. This avoids
  premature unload but deliberately leaves a versioned module loaded until
  Qianniu exits; cleanup must report that state honestly.
- Establish a supported native completion/quiescence mechanism that proves all
  executions have left the module before releasing it. This is not established
  by the current synthetic worker test.

Controller disconnect/timeout must leave callback storage and code alive when
native code may still own a copy. The current two-stage target dry-run can keep
its self-reference and IPC if the controller disappears before cleanup; it does
not provide a complete crash-recovery protocol for a production helper.

The lab stores at most 16 immutable request identities in process-owned slots,
never recycles a slot, rejects reused IDs, and fails closed on capacity exhaustion.
Timeout is an observation, not cancellation or permission to retry. The native
callback owns its small bind-state allocation until final destruction; snapshots
remain in the pinned DLL. An SRW lock serializes receipt publication and reads.
The first valid scalar is preserved; conflicting duplicates are counted, not
silently substituted. Final destruction does not imply business success.

This bounded lab is not a production receipt service. It has no persistent intent
journal, reconnect IPC, account/cid correlation, native version admission gate,
or restart recovery. A real one-shot probe must supply those guards before any
send. Process death loses the lab records and leaves delivery unknown. Pinning
also means replacing a loaded receipt DLL requires a process restart or a new
explicitly reviewed module version, not FreeLibrary-based cleanup.

## No-Send Receipt Lab Results

Build and run `qn_receipt_lab_test.exe <prgbase.dll>` with the verified 9.97.80N
PRGBASE SHA256 `4D50ACBCCEE823D5FE01B1CE7082ED1FC97070930110727CCDBFDA628247F0FC`.
The test uses the real exported bind-state/callback constructors, copy,
destructor and polymorphic invoke, but synthetic borrowed result bytes and a
null AppMessage. It does not construct a real SDK result or resolve any send
address. Tested on 2026-09-07:

1. Synchronous error snapshot before call return, retained after borrowed bytes
   are invalidated.
2. Asynchronous invocation after caller callback destruction, with one final
   native bind-state destructor.
3. Four concurrent workers with 400 identical notifications, then one
   conflicting notification; first result stable, conflict counted, destroy once.
4. Deterministic timeout followed by late callback after controller loader
   references are released; DLL remains pinned and the result remains readable.
5. Missing callback followed by final destruction remains an unknown outcome.
6. Null result is invalid, not a zero/success code.
7. Bounded slot exhaustion and request-ID reuse are rejected.

All seven passed, then passed 20 consecutive test-process runs. The four prior
ABI/lifecycle/release-race/unhook-timeout regressions passed unchanged. Evidence:
`.tmp/qn-native-submit-probe/receipt-lab-20260907.log`,
`receipt-lab-repeat-20260907.log`, and `receipt-prior-regression-20260907.log`.
These prove the exercised lab ownership paths, not real SDK field extraction,
controller-process crash recovery, or successful message delivery.

## Review Gates

### Offline Correlator Implemented

`receipt-correlator.cjs` is an isolated, no-I/O state machine with a strict
parser for the two observed app.log receipt formats. It checks the CHAT account
header, exact cid/text, string IDs, final status/progress and contiguous byte
cursors within a caller-supplied process/log epoch. The caller must supply
complete records (including non-receipt lines), monotonic observation times and
a stable epoch; this module does not discover process identity or tail files.

States are `pending`, `observed_success_unbound`, `ambiguous`, `unknown` and
`confirmed`. Even a single successful candidate is never automatically bound to
a request. `bindClientId` requires a trusted caller to supply independently
obtained evidence; its source label is an assertion, not proof authentication.
Do not generate that evidence from the first matching log or the replay CLI.
`confirmed` means the currently observed receipt agrees with that supplied
binding, not that this module independently established the binding.

Timeout is retained even if a later bound receipt resolves the outcome.
`retryAllowed` is always false. Conflicting IDs, text/cid reuse, status
regression, malformed target receipts, clock/cursor discontinuity and capacity
limits fail closed with sticky issues. Nonzero statuses are not interpreted as
terminal failure because their enum is not yet validated. Snapshots are current
observations, not irrevocable decisions: later contradictions can downgrade
them. They must not trigger sends or a retry fallback.

The lab caps candidates at 16 and state transitions at 64 per candidate. It has
no persistent journal, crash recovery, callback extraction, target access or
send capability, and is not imported by the production daemon. Receiving and
local-echo events are excluded, so neither `latestmsg` nor `newmsgs` is misread
as a final sending receipt.

23 offline tests pass. Replaying the complete 10:08-10:10 capture produces
`ambiguous`, two candidates, two records and one duplicate per candidate,
`binding=null`, `issues=[]`, `retryAllowed=false`. Per-line arrival times were
not captured, so replay uses synthetic time and explicitly does not validate
timing or request binding. The private real ResultCode+8 gate remains open.

### Remaining Work

The isolated hardware-debugger lifecycle experiment now demonstrates a real
blocking safety issue: observer death while a callback breakpoint event is
pending can terminate its fixture with 0x80000004 despite later register
restoration. Six other scenarios pass, but the overall safety gate fails.
Do not proceed to a Qianniu attach or live send based on the normal-case result.
See [DEBUGGER_LIFECYCLE_RESULTS.md](DEBUGGER_LIFECYCLE_RESULTS.md).

Follow-up isolation work repairs the pending-event crash with a preinstalled
narrow target-side exception guard, including watchdog termination at the
pending event. Eight guarded scenarios pass repeatedly, while the unguarded
control still fails. The remaining gate is now safe real-target packaging,
lifetime/record ownership and admission checks, not a claim that the guarded
fixture still exhibits the original crash. Do not attach the fixture-only lab
to Qianniu. See [DEBUGGER_GUARD_RESULTS.md](DEBUGGER_GUARD_RESULTS.md).

Static identity extraction is now supported by independent MsgCode JSON
mappings: AppMessage+0x30 is messageId and +0x50 is clientId for this version.
The bounded read-provider snapshot implementation passes eight synthetic test
groups; it is not connected to the receipt lab or real target. See
[COMPLETION_OBSERVER_DESIGN.md](COMPLETION_OBSERVER_DESIGN.md) for evidence,
callback entry registers, weak/UI lifetime restrictions and proposed debugger
observation gates. Dynamic layout verification and request provenance remain
unresolved; a parsed ID alone does not authorize `bindClientId`.

1. Validate ResultCode+8 against a real normal-UI completion and establish
   clientId/messageId extraction or unambiguous account/cid/text log correlation.
   Prefer read-only observation of a user-controlled test message.
2. Review target integration of the selected pinned module, version/hash guards,
   persistent one-shot intent and reconnect/unknown-outcome handling. A lab
   timeout marker is not a complete controller recovery protocol.
3. Prepare a single, explicitly reviewed live request. Keep automatic retries
   disabled and the working daemon independent of this experiment.
