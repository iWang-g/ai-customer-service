# Live Read-Only Admission, 2026-09-07

Status: actual-client process/module/entry snapshots now pass. This is not a
guard installation, callback ABI validation, shop binding, or send test.

Follow-up: the separate disposable-process transport suite now passes fifteen
cases repeatedly. Actual-client installation remains unimplemented. See
[INSTALL_TRANSPORT_RESULTS.md](INSTALL_TRANSPORT_RESULTS.md).

Actual-client follow-up: the dedicated inert no-send DLL is now installed in
the real reception process and a new-controller status query passed. The
original strict scan still refuses research modules. See
[LIVE_NOSEND_INSTALL_RESULTS.md](LIVE_NOSEND_INSTALL_RESULTS.md).

## Dedicated Tool

`qn_live_admission.exe` is independent of the debugger/hook executables. It
only supports `--self-test`, fixed-root `--scan`, and `--scan-window`.
It opens target processes with QUERY_INFORMATION, VM_READ and SYNCHRONIZE,
not write, VM-operation, remote-thread or debug-attach access. It contains no
installation, SDK call, breakpoint or window-activation operation.

The tool checks:

- Exact `D:\qianniu\AliWorkbench.exe` process path, creation time, session,
  native AMD64 status, no attached debugger and process liveness.
- A unique AppBiz module per process at the expected versioned path, matching
  SizeOfImage and stable module identity on a second enumeration. Existing
  `qn_` research modules cause refusal.
- The pinned-open disk file's SHA256 matches the analyzed version. Its file
  handle denies new writes/deletes during the short scan. PE structures and
  raw section spans are bounds-checked using Windows PE structure definitions.
- Runtime headers match disk except for the specifically allowed ImageBase
  field described below. Other header differences are refused.
- Both callback RVA `0x4f0380` and outer send RVA `0xa73a40` have 32 bytes
  exactly matching the disk image, lie in executable/non-writable file-backed
  sections, and have committed MEM_IMAGE/PAGE_EXECUTE_READ memory belonging
  to the enumerated module base.

## Measured Results

Both running processes passed the byte/identity checks:

| Field | Value |
| --- | --- |
| PIDs | 36124, 33624 |
| Native architecture/session | AMD64, session 1 |
| AppBiz base/size | `0x7ffbb21c0000`, 32534528 bytes |
| Callback entry | `0x7ffbb26b0380`, 32 bytes match |
| Outer send entry | `0x7ffbb2c33a40`, 32 bytes match |
| AppBiz SHA256 | `565AB778C7A5829B080E17551308254C0B9D7F1F4A2859782ADAC500C055E41C` |

Process name and module hash alone are therefore ambiguous. `--scan` retains
that refusal (exit 3) rather than selecting the first process.

`--scan-window` follows the existing probe's exact window policy: one visible
`Qt5152QWindowIcon` titled Qianniu reception desk, with a PID among validated
processes. It compares HWND/PID/TID snapshots before and after the scan and
requires a unique stable match. It does not activate, restore, or send a window
message. Three repeated runs selected:

```text
pid=36124
creation_filetime=134330727293831632
tid=29752
hwnd=0xaa0a4c
result=read_only_identity_snapshot_ok
unique_target=1
read_only=1
debug_attach=0 remote_write=0 hook_install=0 sdk_calls=0 send_invoked=0
shop_binding=0 install_ready=0
```

This binds a reception window to a process, not the intended shop or native
service instance. Addresses and identities expire on restart or state change.
Exit zero means the read-only snapshot passed, not installation is permitted.

## PE Header Difference

Initial exact header comparison refused both processes. The four changed
bytes at file offsets `0x162..0x165` were inside OptionalHeader.ImageBase:
disk preferred base `0x180000000`, runtime field equal to actual loaded base
`0x7ffbb21c0000`. No other header bytes differed.

The final comparator computes this field's offset from the PE structures,
requires its value to equal either the disk preferred base or the independently
enumerated actual base, then normalizes only those eight bytes for comparison.
It does not ignore arbitrary headers, relocations in code, or byte mismatches
at the callback/send entries. An unknown base or another changed header byte
still fails.

## Tests And Limits

Pure tests pass: one valid PE, nine malformed PE cases, five rejected code
spans, two allowed/three rejected header cases, and one valid/four invalid
window selections. Three real window-bound scans passed; the process-only
scan still refused its two-candidate ambiguity.

This is a snapshot, not a race-free installation transaction. It does not hold
the selected process/thread identity for a later operation, pin AppBiz in the
target, bind GUI thread creation identity, inspect account service instances,
or compare full executable sections. Those distinctions matter before writing
or loading anything. Revalidation must occur at the installation boundary.

The existing loader in probe.cpp uses thread-specific WH_CALLWNDPROC and a
registered window message. Reusing that transport requires a separate minimal
no-send module and request contract; it must not dispatch the existing send,
callback-invocation or debugger paths. The next stage is a disposable-process
test of this installation transport and retained lifecycle, followed by an
explicit no-breakpoint real install with before/after identity receipts.
No such real installation happened in this round.

The ideal call remains `sendText(shopUid, cid, text)` without UI switching.
Known entry/parameter evidence and these matching live bytes support continued
research. They do not prove borrowed callback layouts, account routing,
delivery confirmation or long-term cross-version stability.

## Evidence

Logs in `.tmp/qn-native-submit-probe/`:

```text
live-admission-self-test-20260907.log
live-admission-window-repeat-{1,2,3}-20260907.log
live-admission-process-ambiguity-20260907.log
live-admission-header-diagnostic-20260907.log
```

```powershell
cmake --build build --parallel
.\build\qn_live_admission.exe --self-test
.\build\qn_live_admission.exe --scan-window
# Expected exit 3 with the currently observed two processes:
.\build\qn_live_admission.exe --scan
```
