# Unselected Conversation and Minimized Direct Send, 2026-09-07

## Result

One authorized real message succeeded at approximately 14:35:47 China time:

```text
shopUid=2222303856223
recipient=tb4947894539
cid=2214525969878.1-2216058631944.1#11001@cntaobao
text=CodexDirectSend-20260907063546281
messageId=4294243318049.PNM
clientId=7502615584203341922
callback result=0 count=1 destroyed=1 conflicts=0
business status=confirmed candidates=1 sendStatus=0 progress=100
```

Before AND after this send, the target-shop page's read-only getActiveUser was
`tb810776366`, targetId `2207408968472`, cid
`2207408968472.1-2216058631944.1#11001@cntaobao`. The sending destination was not
the selected conversation. Both shop pages retained their previous context.

The reception window was minimized before dispatch and at the final query.
Controller-side observation from immediately before dispatch until two seconds
after native completion produced:

```text
baseline_minimized=1 final_minimized=1 samples=168
not_minimized_samples=0 invalid_window_samples=0
restore_events=0 target_foreground_events=0 foreground_changed_samples=0
```

The watcher requested Sleep(5), not a guaranteed 5 ms sampling cadence; Windows
scheduling can lengthen it. Out-of-context WinEvent hooks independently monitored
MINIMIZEEND and foreground events. No restoration or activation was observed in
this interval. This is bounded empirical evidence, not proof about every instant,
every version, or other Windows session states.

## Scope and Implementation

V2 uses the same successful owned callback and outer CAppMessageService send ABI.
It adds a distinct DLL/message/mapping/consumed journal, an explicit sixth module
allowlist entry, and a GUI-side IsIconic gate immediately before invocation. It
does not reset V1's consumed state or overwrite a loaded DLL. No openChat, shop
switch, input insertion, UIA, Enter or OnClick was used in the send path.

The new JS coordinator uses the prior independently confirmed account/cid mapping
only after proving the exact same native PID/TID/process creation identity and
finding the live account service again. Fresh read-only page context proves the
target conversation is not selected. It no longer requires the destination to be
the active conversation. This is still a fixed-authorized-destination experiment,
not a general account/cid resolver or production queue.

A preliminary empty-parameter getRecentContacts query returned parameter error;
it was not used as mapping proof. The first coordinator run stopped at a read-only
HTTP 409 before creating V2 intent or invoking any native send. The final run
used one getActiveUser result for both login/context evidence; only rejected
read-only HTTP 409 queries can be retried. No send was retried.

The user reported a different selected shop/conversation. The measurable bridge
evidence specifically establishes a different conversation in the target shop's
page; it does not independently identify the top-level selected shop tab. A
Computer Use screenshot was refused because the window was minimized. It was
never restored for inspection.

## Cleanup and Evidence

A separate V2 --status call returned the same IDs, callback count and destruction
count. Both AliWorkbench processes remained responsive with unchanged start times.
Temporary call hooks, external observation hooks and watcher thread were cleaned
up. The V2 DLL/receipt, V1 DLL and older observer modules remain pinned until the
client exits; six research DLLs are now explicitly allowed. Use the V2 status tool
and do not rebuild the resident DLL targets. Production daemon remains unchanged.
The temporary bridge server PID 38064 was stopped after verification.

Seven focused JS tests passed (four existing coordinator tests and three new
context/window/process-identity guard tests). Native callback code was reused.

```text
DLL SHA256 22AE0F81977A74992BEABC2EA104D13E851B635B817CA300A135871015E98F3F
EXE SHA256 9A5F0A62EA379017FD836A3293E1B208B4B88CD489D6CA972C40F03EBA70EA1A
```

Evidence in `.tmp/qn-native-submit-probe/`: `direct-v2-intent.json`,
`direct-v2-consumed-36124-134330727293831632.bin`, `direct-v2-controller.log`,
`direct-v2-appended.log`, `direct-v2-delivery.json`, `direct-v2-result.json`,
`direct-v2-status.log`. Keep all one-shot consumption records.

```powershell
.\tools\qn-native-submit-probe\build\qn_direct_once_probe_v2.exe --status
```

Next engineering step is a bounded serialized request service with per-request
receipt slots and account/cid validation independent of the page bridge. These
two one-shot sends do not yet validate repeated use of one DLL slot, arbitrary
recipients, process restart recovery, logout, locked desktops or Windows services.
