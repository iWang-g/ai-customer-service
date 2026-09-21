# Real Completion Identity Capture, 2026-09-07

Status: **one real normal-send completion was captured, and both native IDs
exactly match the successful business receipt**. Direct-send remains disabled.
This was an Ability draft plus native UI OnClick(0) send, not SendTextMsg called
with our own callback.

## Focused Observer

The new `completion_once` module uses a single GUI-thread hardware execution
breakpoint at the validated AppBiz RVA `0x4f0380`. It does not attach a process
debugger, patch executable bytes/vtables, replace/invoke native callbacks, or
initiate a message. The target-side module/VEH/state are pinned until exit.

A target-owned worker briefly suspends the bound GUI thread, refuses debugger,
occupied debug registers, trap flag or a preexisting suspension, records its
original registers, and arms DR0 once. The narrow VEH reuses the tested exact
exception/context/identity predicate and record arbitration from
`debugger_lab_shared.h`. At the one matching entry it copies ResultCode+8 and
the message identity fields using the bounded allocation-free read-provider
parser, restores the original debug registers in the exception context, and
continues the original function without altering its arguments.

The worker independently restores/verifies debug registers after a hit or at
60 seconds. It does not require a living external controller to reach its
deadline. Starting/stopping observation nevertheless changes thread execution
and debug registers; it must not be described as zero-impact or entirely passive.

V2/V3 add a restored-register GUI round trip before retiring the old recovery
record. Without this terminal retirement, a retained timeout record at the same
address/thread could incorrectly match a future observation's trap. Before
starting a later epoch, the controller verifies the earlier epoch's completed
worker, cleanup and GUI status receipt, performs another GUI round trip and
retires its record. `EventContinued` is reused as the terminal predicate bit;
no Windows ContinueDebugEvent call is made by this observer.

Separate V1/V2/V3 module paths and mappings were used; no resident image was
overwritten or forcibly unloaded. The admission API allows only their exact
paths plus the prior `qn_live_nosend.dll`, not arbitrary `qn_` modules. The
standalone strict admission CLI still defaults to allowing none.

## Attempts, Without Overclaiming

1. V1 armed for 60 seconds. Ability wrote the marker, but the Win32 Enter helper
   produced no send receipt; the user confirmed it had not sent. V1 timed out
   with zero hits and verified cleanup. A later discovery saw no global Qt
   focus widget; activation restored TextRichEdit. This does not prove the
   exact focus state at the instant of the earlier Enter.
2. V2 also timed out cleanly. Its window ended at 13:49:30; the approved native
   retry sent at 13:49:33, about three seconds too late. This zero-hit result
   does not contradict the callback entry. The draft had become empty by the
   retry; after checking there was no earlier matching send event, the script
   restored the same marker once and invoked native OnClick(0).
3. V3 used `run-observed-native-test.cjs` to launch the guarded send immediately
   when the observer printed ARMED, without an intervening tool/model round
   trip. Within about four seconds the send and completion capture succeeded.

Exactly two distinct test texts have confirmed outgoing success receipts, both
to the authorized shop `2222303856223` and receiver `2214525969878`, cid
`2214525969878.1-2216058631944.1#11001@cntaobao`:

| Text | Client ID | Message ID |
| --- | --- | --- |
| CodexCompletionProbe-20260907054206458 | 7502603953792614494 | 4288428934999.PNM |
| CodexCompletionProbe-20260907055228316 | 7502604691893649504 | 4294167478215.PNM |

Only the second message has the matching native snapshot. The first successful
message is a send-path check, not callback-layout evidence.

## Captured Native Result

PID 36124, GUI TID 29752, AppBiz base `0x7ffbb21c0000`, entry
`0x7ffbb26b0380`, same analyzed 9.97.80N AppBiz hash as previous records:

```text
hits=1 snapshot_ready=1 snapshot_status=0 result_valid=1 result=0
messageId=4294167478215.PNM clientId=7502604691893649504
hit_tid=29752 bind=0x2b97579fce0
result_ptr=0xd42392a5f0 message_ptr=0xd423929d50
cleanup=1 worker_done=1 error=0 debug_attach=0 sdk_send=0
```

These addresses are transient evidence, never reusable objects. The snapshot
was copied at entry while the callback's borrowed arguments were valid; later
status reads use our owned copy. RCX/RDX/R8 and the ResultCode+8,
AppMessage+0x30/messageId and +0x50/clientId layout now have one live successful
sample matching the independent native business log.

`check-completion-evidence.cjs` compares both strings exactly, binds the
captured clientId into the existing receipt correlator, and replays the bounded
capture using its original byte cursor/account/cid/text and file identity. It
returns `confirmed`, one candidate, no issues and retryAllowed=false. It does
not bind by simply choosing the first matching log line.

## Verification And Retained State

Two focused fixtures passed: one snapshot while the original function executes
twice, and timeout with no hit. Both verify restored registers. The receipt
correlator's 23 tests passed. V3 status from another process returned the same
snapshot and incremented querySequence to 2, after the worker handle signaled.
Both AliWorkbench processes remain responsive with unchanged creation times.

Temporary window hooks and hardware breakpoints are removed/restored. Completed
worker handles, snapshots, pinned DLLs and registered but logically retired
narrow VEH callbacks remain until client exit. They were not physically
unloaded. Bridge PID 38136, started only for this experiment, was stopped,
restoring its initially-off state. No scheduled task was created and production
auto-reply code was not modified.

Loaded completion-module hashes:

```text
V1 57571C4148CE9F7FA2BD01469A407A1E91CE70E3A0221D24F4297FE5373B41EF
V2 6B86031CB7C3F4E060C4F403BE737ABF2E4A8148F0E26588DE1F500906AD6861
V3 2368DE884C4A61E9C32B9CAB8770C5F631FD76DB0E256A781848F3B10AACB0B7
```

Build only new targets while these images are resident; do not use an all-target
build that tries to relink a loaded DLL. Current status command:

```powershell
.\build\qn_completion_once_probe_v3.exe --status
node check-completion-evidence.cjs
```

The old no-send/V1/V2 controllers may now refuse newer resident modules by
their older allowlists. Do not interpret that as a client fault or broadly
disable module checks. The one-shot mappings refuse a second arm in an epoch.

## Evidence And Next Step

Evidence in `.tmp/qn-native-submit-probe/`:

```text
completion-once-live-20260907.log
completion-once-v2-live-20260907.log
completion-once-v3-live-20260907.log
completion-once-v3-status-20260907.log
completion-observed-send-20260907.log
completion-test-message.json
completion-test-message-3.json
completion-test-appended.log
completion-test-appended-3.log
completion-evidence-correlation.json
completion-once-fixture-{hit,timeout}-20260907.log
```

This is one success on one thread/account/version, not cross-version or error
path coverage. It does not validate all callback threads, worker/API failure
paths, debugger attach races, hostile shared-state writers, or arbitrary
controller/target failures. The handler restores only the exact owned state;
it is not a general exception recovery mechanism.

Next implement the single-send probe's own pinned 8-byte Chromium callback and
account-bound CMessageBiz call, using these verified borrowed-field reads and
the correlator for final confirmation. Do not reuse the observed UI bind-state
or Presenter/WeakReference. The normal-UI layout result validates parsing, not
the origin/lifecycle of a future direct-send request. Keep direct-send disabled
until that dedicated callback path is ready for its explicit once-only test.
