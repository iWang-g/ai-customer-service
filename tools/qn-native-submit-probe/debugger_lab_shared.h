#pragma once
#include <windows.h>

namespace qn_debugger_lab {
constexpr DWORD kMagic = 0x51444231;
constexpr DWORD kGuardVersion = 1;
constexpr int kSlots = 32;
enum Mode : LONG { Normal, Timeout, ObserverCrash, ObserverHang, TargetExit,
  CrashAtCallback, InvalidSnapshot, HangAtCallback, CloseBeforeCallback,
  CleanupBeforeClaim, CleanupAfterClaim, RestoreThenObserverExit,
  RestoreThenContinue, RestoreWithoutReceiptExit, UngatedCleanupRace };
struct Registers { DWORD64 dr0, dr1, dr2, dr3, dr6, dr7; };
enum RecordBits : LONG {
  Published = 1, PendingOwned = 2, RestoreIntent = 4, ExternalRestored = 8,
  RecoveryClaimed = 16, RecoveryDone = 32, EventContinued = 64, ThreadEnded = 128
};
enum ConflictCase : LONG { NoConflict, ExistingDebugger, DebuggerAttachRace,
  DisabledDr0WithDr2Conflict, EnabledDr1Conflict, EnableOnlyConflict,
  PartialArmConflict, LateThreadConflict, TrapFlagConflict };
enum Refusal : LONG { NoRefusal, DebuggerPresentRefusal, AttachFailedRefusal,
  RegisterRefusal, TrapFlagRefusal, DebugQueryRefusal };
struct ThreadRecord {
  DWORD id;
  FILETIME created;
  Registers original;
  volatile LONG dirty;
  volatile LONG guardConsumed;
  volatile LONG state;
};
struct Shared {
  DWORD magic;
  DWORD targetId;
  FILETIME targetCreated;
  LONG mode;
  LONG guarded;
  DWORD observerId;
  volatile LONG guardReady;
  volatile LONG guardHandled;
  volatile LONG guardRemoved;
  volatile LONG guardSeen;
  DWORD guardObserverWait;
  DWORD guardDebuggerPresent;
  DWORD64 guardRip, guardDr0, guardDr6, guardDr7;
  DWORD guardFlags;
  volatile LONG attached;
  volatile LONG ready;
  volatile LONG runCallbacks;
  volatile LONG finish;
  volatile LONG detached;
  volatile LONG callbackCount;
  volatile LONG hits;
  volatile LONG rejectedSnapshots;
  volatile LONG handledExceptions;
  volatile LONG foreignStepsHandled;
  volatile LONG forwardedExceptions;
  volatile LONG armedThreads;
  volatile LONG cleanThreads;
  volatile LONG exitedThreads;
  volatile LONG error;
  volatile LONG slots;
  DWORD errorCode;
  char errorStep[128];
  DWORD64 entry;
  unsigned char entryBytes[16];
  ThreadRecord threads[kSlots];
  DWORD guardVersion;
  DWORD sharedSize;
  volatile LONG moduleGuard;
  // High bit is terminal close; low bits are in-progress journal publishers.
  volatile LONG admission;
  volatile LONG moduleActive;
  volatile LONG moduleCalls;
  volatile LONG modulePinned;
  volatile LONG moduleRetained;
  volatile LONG moduleGateEntered;
  volatile LONG moduleGateRelease;
  volatile LONG moduleGateTimeout;
  volatile LONG moduleCleanupVerified;
  volatile LONG recordArbitration;
  volatile LONG racePhase;
  volatile LONG raceRelease;
  volatile LONG raceTimeout;
  volatile LONG raceSlot;
  volatile LONG raceCleanupVerified;
  volatile LONG recoveredAfterClean;
  volatile LONG recoveredCleanContext;
  volatile LONG continuedEvents;
  LONG conflictCase;
  volatile LONG refusal;
  DWORD refusalError;
  volatile LONG attachAttempts;
  volatile LONG observerDetachCalls;
  volatile LONG observerPreflightReady;
  volatile LONG observerAttachRelease;
  volatile LONG incumbentReady;
  volatile LONG incumbentStop;
  volatile LONG incumbentDetached;
  volatile LONG incumbentForwarded;
  volatile LONG conflictSeedNeeded;
  volatile LONG conflictSeedReady;
  DWORD conflictThreadId;
  volatile LONG conflictProceed;
};
constexpr LONG kClosed = static_cast<LONG>(0x80000000UL);
inline LONG Load(volatile LONG* p) { return InterlockedCompareExchange(p, 0, 0); }
inline bool BeginPublish(Shared* s) {
  LONG state = Load(&s->admission);
  for (;;) {
    if (state < 0 || state == 0x7fffffff) return false;
    const LONG previous = InterlockedCompareExchange(&s->admission, state + 1, state);
    if (previous == state) return true;
    state = previous;
  }
}
inline void EndPublish(Shared* s) { InterlockedDecrement(&s->admission); }
inline bool SameTime(const FILETIME& a, const FILETIME& b) {
  return a.dwLowDateTime == b.dwLowDateTime && a.dwHighDateTime == b.dwHighDateTime;
}
inline void SetRegisters(CONTEXT& c, const Registers& r) {
  c.Dr0=r.dr0; c.Dr1=r.dr1; c.Dr2=r.dr2; c.Dr3=r.dr3; c.Dr6=r.dr6; c.Dr7=r.dr7;
}
inline bool GuardMatches(const EXCEPTION_RECORD& exception, const CONTEXT& context,
                         DWORD tid, const FILETIME& created, const ThreadRecord& record,
                         DWORD64 entry, bool debuggerAbsent) {
  return debuggerAbsent && exception.ExceptionCode == EXCEPTION_SINGLE_STEP &&
      exception.NumberParameters == 0 &&
      !(exception.ExceptionFlags & EXCEPTION_NONCONTINUABLE) &&
      reinterpret_cast<DWORD64>(exception.ExceptionAddress) == entry &&
      context.Rip == entry && (context.Dr6 & 0xe00fULL) == 1 &&
      !(context.EFlags & 0x100) && context.Dr0 == entry &&
      context.Dr1 == record.original.dr1 && context.Dr2 == record.original.dr2 &&
      context.Dr3 == record.original.dr3 &&
      (context.Dr7 & ~0x400ULL) == ((record.original.dr7 & ~0xf0403ULL) | 1) &&
      record.id == tid && SameTime(record.created, created) && record.dirty &&
      !record.guardConsumed;
}
inline bool SameDebugRegisters(const Registers& a, const Registers& b) {
  return a.dr0 == b.dr0 && a.dr1 == b.dr1 && a.dr2 == b.dr2 && a.dr3 == b.dr3 &&
      (a.dr6 & 0xe00fULL) == (b.dr6 & 0xe00fULL) &&
      (a.dr7 & ~0x400ULL) == (b.dr7 & ~0x400ULL);
}
inline bool RetainedGuardMatches(const EXCEPTION_RECORD& exception, const CONTEXT& context,
                                 DWORD tid, const FILETIME& created, const ThreadRecord& record,
                                 DWORD64 entry, bool debuggerAbsent, LONG state) {
  if (!(state & Published) || (state & (RecoveryClaimed | EventContinued | ThreadEnded))) return false;
  // dirty is work accounting, not an exception revocation token.
  ThreadRecord candidate{};
  candidate.id = record.id; candidate.created = record.created;
  candidate.original = record.original; candidate.dirty = 1;
  // Windows preserves the original exception CONTEXT in the measured races.
  // Never replace missing hardware evidence with lifecycle flags.
  return GuardMatches(exception, context, tid, created, candidate, entry, debuggerAbsent);
}
inline bool ClaimRecovery(ThreadRecord& record, const EXCEPTION_RECORD& exception,
                          const CONTEXT& context, DWORD tid, const FILETIME& created,
                          DWORD64 entry, bool debuggerAbsent) {
  LONG state = Load(&record.state);
  for (;;) {
    if (!RetainedGuardMatches(exception, context, tid, created, record, entry, debuggerAbsent, state)) return false;
    const LONG previous = InterlockedCompareExchange(&record.state, state | RecoveryClaimed, state);
    if (previous == state) return true;
    state = previous;
  }
}
struct GuardSnapshot {
  DWORD size;
  DWORD version;
  LONG closed;
  LONG publishers;
  LONG active;
  LONG calls;
  LONG pinned;
  LONG retained;
};
using InstallGuardFn = DWORD (WINAPI*)(DWORD, const wchar_t*);
using CloseGuardFn = DWORD (WINAPI*)();
using QueryGuardFn = DWORD (WINAPI*)(GuardSnapshot*);
}  // namespace qn_debugger_lab
