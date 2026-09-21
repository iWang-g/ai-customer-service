#include "debugger_lab_shared.h"
#include <cwchar>

// Disposable-fixture DLL only. No remote loader or arbitrary-target API.
namespace {
using namespace qn_debugger_lab;
SRWLOCK gInstallLock = SRWLOCK_INIT;
Shared* gState = nullptr;
HANDLE gMapping = nullptr;
HANDLE gObserver = nullptr;
PVOID gHandler = nullptr;
volatile LONG gInstalled = 0;
DWORD64 gEntry = 0;

#ifdef QN_GUARD_RACE_GATES
void RaceGate(Shared* s, LONG slot, LONG phase) {
  InterlockedExchange(&s->raceSlot, slot);
  InterlockedExchange(&s->racePhase, phase);
  const ULONGLONG deadline = GetTickCount64() + 4000;
  while (!Load(&s->raceRelease) && GetTickCount64() < deadline) Sleep(1);
  if (!Load(&s->raceRelease)) InterlockedExchange(&s->raceTimeout, 1);
}
#endif

LONG CALLBACK Recover(EXCEPTION_POINTERS* pointers) {
  if (!Load(&gInstalled) || !pointers || !pointers->ExceptionRecord || !pointers->ContextRecord)
    return EXCEPTION_CONTINUE_SEARCH;
  auto* s = gState;
  InterlockedIncrement(&s->moduleActive);
  InterlockedIncrement(&s->moduleCalls);
  LONG result = EXCEPTION_CONTINUE_SEARCH;
  if (pointers->ExceptionRecord->ExceptionCode == EXCEPTION_SINGLE_STEP) {
    InterlockedIncrement(&s->guardSeen);
    const DWORD wait = WaitForSingleObject(gObserver, 0);
    const bool absent = !IsDebuggerPresent();
    FILETIME created{}, exited{}, kernel{}, user{};
    const LONG slots = Load(&s->slots);
    if (absent && wait != WAIT_FAILED && slots >= 0 && slots <= kSlots &&
        GetThreadTimes(GetCurrentThread(), &created, &exited, &kernel, &user)) {
      for (LONG i = 0; i < slots; ++i) {
        auto& r = s->threads[i];
#ifdef QN_GUARD_RACE_GATES
        if (s->mode == CleanupBeforeClaim && r.id == GetCurrentThreadId() && SameTime(r.created, created) &&
            pointers->ContextRecord->Rip == gEntry &&
            reinterpret_cast<DWORD64>(pointers->ExceptionRecord->ExceptionAddress) == gEntry)
          RaceGate(s, i, 1);
#endif
        if (s->recordArbitration) {
          if (!ClaimRecovery(r, *pointers->ExceptionRecord, *pointers->ContextRecord,
              GetCurrentThreadId(), created, gEntry, absent)) continue;
        } else {
          if (!Load(&r.dirty) || !GuardMatches(*pointers->ExceptionRecord, *pointers->ContextRecord,
              GetCurrentThreadId(), created, r, gEntry, absent)) continue;
          if (InterlockedCompareExchange(&r.guardConsumed, 1, 0) != 0) break;
        }
#ifdef QN_GUARD_RACE_GATES
        if (s->mode == CleanupAfterClaim) RaceGate(s, i, 2);
#endif
        if (!Load(&r.dirty)) InterlockedIncrement(&s->recoveredAfterClean);
        const auto* context = pointers->ContextRecord;
        const Registers current{context->Dr0,context->Dr1,context->Dr2,context->Dr3,context->Dr6,context->Dr7};
        if (SameDebugRegisters(current, r.original)) InterlockedIncrement(&s->recoveredCleanContext);
        SetRegisters(*pointers->ContextRecord, r.original);
        InterlockedExchange(&r.dirty, 0);
        if (s->recordArbitration) InterlockedOr(&r.state, RecoveryDone);
        InterlockedIncrement(&s->guardHandled);
        result = EXCEPTION_CONTINUE_EXECUTION;
#ifdef QN_GUARD_LAB_DELAY
        // Deliberate, bounded fault-injection seam, ONLY in the separate test DLL.
        // It proves that a recovery notification is not handler-code quiescence.
        InterlockedExchange(&s->moduleGateEntered, 1);
        const ULONGLONG deadline = GetTickCount64() + 4000;
        while (!Load(&s->moduleGateRelease) && GetTickCount64() < deadline) Sleep(1);
        if (!Load(&s->moduleGateRelease)) InterlockedExchange(&s->moduleGateTimeout, 1);
#endif
        break;
      }
    }
  }
  InterlockedDecrement(&s->moduleActive);
  // Even active==0 does not permit unload: the return instruction is still here.
  return result;
}
DWORD Install(DWORD version, const wchar_t* name) {
  if (version != kGuardVersion) return ERROR_REVISION_MISMATCH;
  if (!name || std::wcsncmp(name, L"Local\\QnDebuggerLab-", 19) != 0)
    return ERROR_INVALID_PARAMETER;
  if (Load(&gInstalled)) return ERROR_ALREADY_INITIALIZED;
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  if (!mapping) return GetLastError();
  auto* s = static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
  if (!s) { const DWORD error = GetLastError(); CloseHandle(mapping); return error; }
  FILETIME created{}, exited{}, kernel{}, user{};
  DWORD error = ERROR_SUCCESS;
  if (s->magic != kMagic || s->sharedSize != sizeof(Shared) || s->guardVersion != kGuardVersion ||
      s->targetId != GetCurrentProcessId() || !s->moduleGuard || !s->entry ||
      !GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user) ||
      !SameTime(created, s->targetCreated) || IsDebuggerPresent() || Load(&s->slots) ||
      Load(&s->admission)) error = ERROR_INVALID_STATE;
  HANDLE observer = error == ERROR_SUCCESS ? OpenProcess(SYNCHRONIZE, FALSE, s->observerId) : nullptr;
  if (error == ERROR_SUCCESS && !observer) error = GetLastError();
  HMODULE pinned = nullptr;
  if (error == ERROR_SUCCESS && !GetModuleHandleExW(
      GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      reinterpret_cast<LPCWSTR>(&gInstallLock), &pinned)) error = GetLastError();
  if (error != ERROR_SUCCESS) {
    if (observer) CloseHandle(observer);
    UnmapViewOfFile(s); CloseHandle(mapping); return error;
  }
  gState = s; gMapping = mapping; gObserver = observer; gEntry = s->entry;
  gHandler = AddVectoredExceptionHandler(1, &Recover);
  if (!gHandler) {
    error = GetLastError();
    if (error == ERROR_SUCCESS) error = ERROR_NOT_ENOUGH_MEMORY;
    gState = nullptr; gMapping = nullptr; gObserver = nullptr;
    CloseHandle(observer); UnmapViewOfFile(s); CloseHandle(mapping);
    return error;
  }
  // Independent view, process handle and pinned code intentionally survive Close.
  InterlockedExchange(&s->modulePinned, 1);
  InterlockedExchange(&s->moduleRetained, 1);
  InterlockedExchange(&gInstalled, 1);
  InterlockedExchange(&s->guardReady, 1);
  return ERROR_SUCCESS;
}
}  // namespace

extern "C" __declspec(dllexport) DWORD WINAPI QnDebuggerGuardInstallV1(DWORD version, const wchar_t* name) {
  AcquireSRWLockExclusive(&gInstallLock);
  const DWORD result = Install(version, name);
  ReleaseSRWLockExclusive(&gInstallLock);
  return result;
}
extern "C" __declspec(dllexport) DWORD WINAPI QnDebuggerGuardCloseV1() {
  if (!Load(&gInstalled)) return ERROR_INVALID_STATE;
  // Never revoke undo records or remove VEH. Existing publishers may finish.
  InterlockedOr(&gState->admission, kClosed);
  return ERROR_SUCCESS;
}
extern "C" __declspec(dllexport) DWORD WINAPI QnDebuggerGuardQueryV1(GuardSnapshot* out) {
  if (!out || out->size != sizeof(GuardSnapshot)) return ERROR_INVALID_PARAMETER;
  if (!Load(&gInstalled)) return ERROR_INVALID_STATE;
  const LONG admission = Load(&gState->admission);
  *out = {sizeof(GuardSnapshot), kGuardVersion, admission < 0 ? 1 : 0,
      admission & 0x7fffffff, Load(&gState->moduleActive), Load(&gState->moduleCalls),
      Load(&gState->modulePinned), Load(&gState->moduleRetained)};
  return ERROR_SUCCESS;
}
