#include <windows.h>
#include <tlhelp32.h>

#include "message_identity_snapshot.h"
#include "debugger_lab_shared.h"

#include <array>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>

namespace {
using namespace qn_debugger_lab;
constexpr DWORD kHandledException = 0xe0425151;
constexpr ULONG_PTR kForeignStepToken = 0x514e53544550ULL;
Shared* gShared = nullptr;
int gUnsafeOutcomes = 0;
HANDLE gObserverLifetime = nullptr;

void Check(bool ok, const char* step) {
  if (!ok) {
    const DWORD error = GetLastError();
    if (gShared && !gShared->error) {
      gShared->errorCode = error;
      std::snprintf(gShared->errorStep, sizeof(gShared->errorStep), "%s", step);
      InterlockedExchange(&gShared->error, 1);
    }
    std::fprintf(stderr, "FAIL %s win32=%lu\n", step, error);
    ExitProcess(1);
  }
}
bool WaitFlag(volatile LONG* flag, DWORD milliseconds) {
  const ULONGLONG deadline = GetTickCount64() + milliseconds;
  while (!Load(flag) && GetTickCount64() < deadline) Sleep(5);
  return Load(flag) != 0;
}
Registers GetRegisters(const CONTEXT& c) { return {c.Dr0,c.Dr1,c.Dr2,c.Dr3,c.Dr6,c.Dr7}; }
bool SameRegisters(const Registers& a, const Registers& b) {
  return a.dr0==b.dr0 && a.dr1==b.dr1 && a.dr2==b.dr2 && a.dr3==b.dr3 &&
      (a.dr6 & 0xe00fULL)==(b.dr6 & 0xe00fULL) &&
      (a.dr7 & ~0x400ULL)==(b.dr7 & ~0x400ULL);
}
bool Available(const CONTEXT& c) {
  // Refuse any preexisting breakpoint, including a disabled nonzero address.
  return !c.Dr0 && !c.Dr1 && !c.Dr2 && !c.Dr3 && !(c.Dr7 & 0xffff00ffULL);
}
bool ThreadIdentity(HANDLE thread, FILETIME* created) {
  FILETIME exit{}, kernel{}, user{};
  return GetThreadTimes(thread, created, &exit, &kernel, &user) != 0;
}
bool ThreadExists(DWORD id) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
  Check(snapshot != INVALID_HANDLE_VALUE, "snapshot exited-thread check");
  THREADENTRY32 entry{}; entry.dwSize = sizeof(entry);
  BOOL more = Thread32First(snapshot, &entry);
  Check(more || GetLastError() == ERROR_NO_MORE_FILES, "start thread enumeration");
  while (more) {
    if (entry.th32ThreadID == id) { CloseHandle(snapshot); return true; }
    more = Thread32Next(snapshot, &entry);
  }
  Check(GetLastError() == ERROR_NO_MORE_FILES, "complete thread enumeration");
  CloseHandle(snapshot);
  return false;
}
bool ReadRemote(void* process, std::uint64_t address, void* target, std::size_t size) {
  SIZE_T read = 0;
  return ReadProcessMemory(process, reinterpret_cast<const void*>(address), target,
      size, &read) && read == size;
}
std::wstring SelfPath() {
  wchar_t path[32768]{};
  const DWORD size = GetModuleFileNameW(nullptr, path, 32768);
  Check(size && size < 32768, "self path");
  return path;
}
Shared* OpenShared(const wchar_t* name, HANDLE* mapping) {
  *mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  Check(*mapping != nullptr, "open lab mapping");
  auto* shared = static_cast<Shared*>(MapViewOfFile(*mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
  Check(shared && shared->magic == kMagic, "lab mapping identity");
  gShared = shared;
  return shared;
}

// Three register arguments deliberately model the examined Win64 callback ABI.
__attribute__((noinline)) void FixtureCallback(void* bind, const void* result, const void* message) {
  Check(bind && result && message, "fixture arguments");
  InterlockedIncrement(&gShared->callbackCount);
}
void String(unsigned char* descriptor, const char* value) {
  const std::uint64_t size = std::strlen(value), capacity = size <= 15 ? 15 : 255;
  if (size <= 15) std::memcpy(descriptor, value, size + 1);
  else std::memcpy(descriptor, &value, sizeof(value));
  std::memcpy(descriptor + 16, &size, 8);
  std::memcpy(descriptor + 24, &capacity, 8);
}
DWORD WINAPI CallbackWorker(void*) {
  unsigned char result[0x70]{}, message[0x70]{};
  String(message + 0x30, "4293759074497.PNM");
  String(message + 0x50, gShared->mode == InvalidSnapshot ? "invalid-client" : "7502548731028308036");
  DWORD64 bind = 0x51514c4142ULL;
  FixtureCallback(&bind, result, message);
  FixtureCallback(&bind, result, message);
  return 0;
}
LONG CALLBACK HandleFixtureException(EXCEPTION_POINTERS* exception) {
  if (exception->ExceptionRecord->ExceptionCode == EXCEPTION_SINGLE_STEP &&
      exception->ExceptionRecord->NumberParameters == 1 &&
      exception->ExceptionRecord->ExceptionInformation[0] == kForeignStepToken) {
    InterlockedIncrement(&gShared->foreignStepsHandled);
    return EXCEPTION_CONTINUE_EXECUTION;
  }
  if (exception->ExceptionRecord->ExceptionCode != kHandledException) return EXCEPTION_CONTINUE_SEARCH;
  InterlockedIncrement(&gShared->handledExceptions);
  return EXCEPTION_CONTINUE_EXECUTION;
}
LONG CALLBACK RecoverOwnedBreakpoint(EXCEPTION_POINTERS* pointers) {
  // No waiting, logging, allocation, SDK calls, or global exception swallowing.
  if (!gShared || !gObserverLifetime || !pointers || !pointers->ExceptionRecord ||
      !pointers->ContextRecord ||
      pointers->ExceptionRecord->ExceptionCode != EXCEPTION_SINGLE_STEP) return EXCEPTION_CONTINUE_SEARCH;
  InterlockedIncrement(&gShared->guardSeen);
  gShared->guardObserverWait = WaitForSingleObject(gObserverLifetime, 0);
  gShared->guardDebuggerPresent = IsDebuggerPresent() ? 1 : 0;
  gShared->guardRip = pointers->ContextRecord->Rip;
  gShared->guardDr0 = pointers->ContextRecord->Dr0;
  gShared->guardDr6 = pointers->ContextRecord->Dr6;
  gShared->guardDr7 = pointers->ContextRecord->Dr7;
  gShared->guardFlags = pointers->ContextRecord->EFlags;
  // Windows can deliver the orphaned event before the exiting observer's
  // process object becomes signaled. Require detached state, not exit timing.
  if (gShared->guardDebuggerPresent || gShared->guardObserverWait == WAIT_FAILED) return EXCEPTION_CONTINUE_SEARCH;
  FILETIME created{};
  if (!ThreadIdentity(GetCurrentThread(), &created)) return EXCEPTION_CONTINUE_SEARCH;
  const DWORD tid = GetCurrentThreadId();
  const LONG slots = Load(&gShared->slots);
  if (slots < 0 || slots > kSlots) return EXCEPTION_CONTINUE_SEARCH;
  for (LONG i = 0; i < slots; ++i) {
    auto& record = gShared->threads[i];
    if (!Load(&record.dirty) || !GuardMatches(*pointers->ExceptionRecord,
        *pointers->ContextRecord, tid, created, record, gShared->entry, true)) continue;
    if (InterlockedCompareExchange(&record.guardConsumed, 1, 0) != 0) return EXCEPTION_CONTINUE_SEARCH;
    SetRegisters(*pointers->ContextRecord, record.original);
    InterlockedExchange(&record.dirty, 0);
    InterlockedIncrement(&gShared->guardHandled);
    return EXCEPTION_CONTINUE_EXECUTION;
  }
  return EXCEPTION_CONTINUE_SEARCH;
}
template <typename T> T Resolve(HMODULE module, const char* name) {
  const FARPROC raw = GetProcAddress(module, name);
  Check(raw != nullptr, name);
  T result = nullptr;
  static_assert(sizeof(result) == sizeof(raw));
  std::memcpy(&result, &raw, sizeof(result));
  return result;
}
struct ModuleApi {
  HMODULE module;
  InstallGuardFn install;
  CloseGuardFn close;
  QueryGuardFn query;
};
GuardSnapshot Query(const ModuleApi& api) {
  GuardSnapshot snapshot{}; snapshot.size = sizeof(snapshot);
  Check(api.query(&snapshot) == ERROR_SUCCESS && snapshot.version == kGuardVersion, "module snapshot");
  return snapshot;
}
bool PendingMode(LONG mode) {
  return mode == CrashAtCallback || mode == HangAtCallback || mode == CloseBeforeCallback ||
      mode == CleanupBeforeClaim || mode == CleanupAfterClaim || mode == RestoreThenObserverExit ||
      mode == RestoreWithoutReceiptExit || mode == UngatedCleanupRace;
}
DWORD WINAPI ConflictHoldWorker(void*) {
  Check(WaitFlag(&gShared->conflictProceed, 15000), "conflict fixture worker release");
  return 0;
}
DWORD WINAPI ConcurrentModuleClose(void* raw) {
  auto& api = *static_cast<ModuleApi*>(raw);
  Check(WaitFlag(&gShared->moduleGateEntered, 12000), "handler paused after recovery notification");
  const auto before = Query(api);
  Check(before.active == 1 && Load(&gShared->guardHandled) == 1, "ack is not code quiescence");
  Check(api.close() == ERROR_SUCCESS && api.close() == ERROR_SUCCESS, "idempotent close while handler active");
  Check(!BeginPublish(gShared), "close blocks new breakpoint publishers");
  Check(FreeLibrary(api.module) != 0, "release caller DLL reference while handler active");
  api.module = nullptr;
  const auto after = Query(api);
  Check(after.closed && after.active == 1 && after.pinned && after.retained && !after.publishers,
      "handler and storage survive caller release");
  InterlockedExchange(&gShared->moduleCleanupVerified, 1);
  InterlockedExchange(&gShared->moduleGateRelease, 1);
  return 0;
}
int Target(const wchar_t* name) {
  HANDLE mapping = nullptr;
  auto* shared = OpenShared(name, &mapping);
  PVOID guard = nullptr;
  ModuleApi api{};
  auto callback = &FixtureCallback;
  static_assert(sizeof(callback) == sizeof(shared->entry));
  std::memcpy(&shared->entry, &callback, sizeof(callback));
  std::memcpy(shared->entryBytes, reinterpret_cast<const void*>(shared->entry), 16);
  if (shared->moduleGuard) {
    const auto path = SelfPath();
    const auto dll = path.substr(0, path.find_last_of(L"\\/") + 1) +
        (shared->moduleGuard == 3 ? L"qn_debugger_guard_race_lab_v1.dll" :
         shared->moduleGuard == 2 ? L"qn_debugger_guard_delay_lab_v1.dll" : L"qn_debugger_guard_lab_v1.dll");
    api.module = LoadLibraryExW(dll.c_str(), nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
    Check(api.module != nullptr, "load fixture protection DLL");
    api.install = Resolve<InstallGuardFn>(api.module, "QnDebuggerGuardInstallV1");
    api.close = Resolve<CloseGuardFn>(api.module, "QnDebuggerGuardCloseV1");
    api.query = Resolve<QueryGuardFn>(api.module, "QnDebuggerGuardQueryV1");
    Check(api.close() == ERROR_INVALID_STATE, "close before installation rejected");
    Check(api.install(kGuardVersion + 1, name) == ERROR_REVISION_MISMATCH, "module version gate");
    Check(api.install(kGuardVersion, name) == ERROR_SUCCESS, "install independent retained guard");
    Check(api.install(kGuardVersion, name) == ERROR_ALREADY_INITIALIZED, "reject duplicate installation");
    const auto snapshot = Query(api);
    Check(snapshot.pinned && snapshot.retained && !snapshot.closed, "module lifetime readiness");
  } else if (shared->guarded) {
    Check(shared->observerId != 0, "observer identity published before target resume");
    gObserverLifetime = OpenProcess(SYNCHRONIZE, FALSE, shared->observerId);
    Check(gObserverLifetime != nullptr, "guard holds observer process handle");
    guard = AddVectoredExceptionHandler(1, &RecoverOwnedBreakpoint);
    Check(guard != nullptr, "install narrow fixture guard");
    InterlockedExchange(&shared->guardReady, 1);
  }
  HANDLE conflictWorker = nullptr;
  if (shared->conflictCase == PartialArmConflict) {
    conflictWorker = CreateThread(nullptr, 0, &ConflictHoldWorker, nullptr, 0, nullptr);
    Check(conflictWorker != nullptr, "create second preflight fixture thread");
  }
  Check(WaitFlag(&shared->attached, 15000), "target attach gate");
  OutputDebugStringA("QN_DEBUGGER_LAB_READY_V1");
  Check(WaitFlag(&shared->runCallbacks, 15000), "target run gate");
  if (shared->conflictCase == LateThreadConflict) {
    conflictWorker = CreateThread(nullptr, 0, &ConflictHoldWorker, nullptr, 0, nullptr);
    Check(conflictWorker != nullptr, "create late conflict fixture thread");
  }
  if (conflictWorker) {
    Check(WaitForSingleObject(conflictWorker, 15000) == WAIT_OBJECT_0, "conflict worker exits after owner cleanup");
    CloseHandle(conflictWorker);
  }
  if (shared->mode == TargetExit) ExitProcess(29);
  PVOID handler = AddVectoredExceptionHandler(1, &HandleFixtureException);
  Check(handler != nullptr, "install fixture exception handler");
  RaiseException(kHandledException, 0, 0, nullptr);
  const ULONG_PTR foreignToken = kForeignStepToken;
  RaiseException(EXCEPTION_SINGLE_STEP, 0, 1, &foreignToken);
  HANDLE cleanup = nullptr;
  if (shared->moduleGuard == 2 && PendingMode(shared->mode)) {
    cleanup = CreateThread(nullptr, 0, &ConcurrentModuleClose, &api, 0, nullptr);
    Check(cleanup != nullptr, "create concurrent DLL close worker");
  }
  if (shared->mode == CloseBeforeCallback) {
    Check(api.close() == ERROR_SUCCESS && Query(api).closed, "close before breakpoint delivery");
    Check(!BeginPublish(shared), "terminal close refuses new journal entries");
  }
  CallbackWorker(nullptr);
  if (cleanup) {
    Check(WaitForSingleObject(cleanup, 5000) == WAIT_OBJECT_0, "concurrent cleanup worker completed");
    CloseHandle(cleanup);
    Check(!Load(&shared->moduleGateTimeout) && Load(&shared->moduleCleanupVerified), "bounded gate released by cleanup");
  }
  HANDLE worker = CreateThread(nullptr, 0, &CallbackWorker, nullptr, 0, nullptr);
  Check(worker != nullptr, "create late target thread");
  Check(WaitForSingleObject(worker, 10000) == WAIT_OBJECT_0, "late target thread exit");
  CloseHandle(worker);
  Check(WaitFlag(&shared->finish, 15000), "target finish gate");
  Check(!IsDebuggerPresent(), "target debugger detached");
  Check(std::memcmp(shared->entryBytes, reinterpret_cast<const void*>(shared->entry), 16)==0,
      "code bytes unchanged");
  RemoveVectoredExceptionHandler(handler);
  if (guard) {
    Check(RemoveVectoredExceptionHandler(guard) != 0, "remove fixture guard");
    CloseHandle(gObserverLifetime); gObserverLifetime = nullptr;
    InterlockedExchange(&shared->guardRemoved, 1);
  }
  if (shared->moduleGuard) {
    Check(api.close() == ERROR_SUCCESS, "logical close after callbacks");
    if (api.module) Check(FreeLibrary(api.module) != 0, "release final caller DLL reference");
    Check(api.install(kGuardVersion, name) == ERROR_ALREADY_INITIALIZED, "no session reuse after close");
    // Tear down the caller's view and handle. The DLL owns a separate retained view.
    UnmapViewOfFile(shared); CloseHandle(mapping); gShared = nullptr;
    const auto snapshot = Query(api);
    Check(snapshot.closed && snapshot.pinned && snapshot.retained && !snapshot.active && !snapshot.publishers,
        "module survives caller mapping teardown");
    const LONG calls = snapshot.calls;
    const PVOID foreignHandler = AddVectoredExceptionHandler(0, [](EXCEPTION_POINTERS* e) -> LONG {
      return e->ExceptionRecord->ExceptionCode == kHandledException ?
          EXCEPTION_CONTINUE_EXECUTION : EXCEPTION_CONTINUE_SEARCH;
    });
    Check(foreignHandler != nullptr, "install post-teardown exception sink");
    RaiseException(kHandledException, 0, 0, nullptr);
    Check(RemoveVectoredExceptionHandler(foreignHandler) != 0, "remove post-teardown sink");
    Check(Query(api).calls > calls, "retained VEH executes after all caller resources released");
    return 0;
  }
  UnmapViewOfFile(shared); CloseHandle(mapping); gShared = nullptr;
  return 0;
}

void RestoreThread(HANDLE thread, ThreadRecord& record, bool suspended) {
  if (!Load(&record.dirty)) return;
  if (WaitForSingleObject(thread, 0) == WAIT_OBJECT_0) {
    if (gShared->recordArbitration) InterlockedOr(&record.state, ThreadEnded);
    InterlockedExchange(&record.dirty, 0);
    InterlockedIncrement(&gShared->exitedThreads);
    return;
  }
  if (suspended) Check(SuspendThread(thread) != DWORD(-1), "suspend for restore");
  FILETIME created{};
  Check(ThreadIdentity(thread, &created) && SameTime(created, record.created), "thread identity before restore");
  CONTEXT c{}; c.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  Check(GetThreadContext(thread, &c) != 0, "read restore context");
  const bool ours = c.Dr0 == gShared->entry && c.Dr1 == record.original.dr1 &&
      c.Dr2 == record.original.dr2 && c.Dr3 == record.original.dr3 &&
      (c.Dr7 & ~0x400ULL) == ((record.original.dr7 & ~0xf0403ULL) | 1);
  if (!ours && !SameRegisters(GetRegisters(c), record.original)) {
    std::snprintf(gShared->errorStep, sizeof(gShared->errorStep),
        "ownership dr0=%llx entry=%llx dr7=%llx original7=%llx dr6=%llx original6=%llx",
        c.Dr0, gShared->entry, c.Dr7, record.original.dr7, c.Dr6, record.original.dr6);
    InterlockedExchange(&gShared->error, 1);
  }
  Check(ours || SameRegisters(GetRegisters(c), record.original), "restore ownership");
  if (gShared->recordArbitration) InterlockedOr(&record.state, RestoreIntent);
  SetRegisters(c, record.original);
  Check(SetThreadContext(thread, &c) != 0, "restore debug registers");
  if (!suspended && gShared->mode == RestoreWithoutReceiptExit) ExitProcess(75);
  CONTEXT verified{}; verified.ContextFlags = CONTEXT_DEBUG_REGISTERS;
  Check(GetThreadContext(thread, &verified) && SameRegisters(GetRegisters(verified), record.original),
      "verify restored debug registers");
  if (gShared->recordArbitration) InterlockedOr(&record.state, ExternalRestored);
  InterlockedExchange(&record.dirty, 0);
  InterlockedIncrement(&gShared->cleanThreads);
  if (suspended) Check(ResumeThread(thread) != DWORD(-1), "resume restored thread");
}

int Observer(const wchar_t* name) {
  HANDLE mapping = nullptr;
  auto* shared = OpenShared(name, &mapping);
  HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE,
      FALSE, shared->targetId);
  Check(process != nullptr, "open owned fixture");
  wchar_t path[32768]{}; DWORD length = 32768;
  FILETIME created{}, exit{}, kernel{}, user{};
  BOOL debugged = FALSE;
  Check(QueryFullProcessImageNameW(process, 0, path, &length) && SelfPath() == path &&
      GetProcessTimes(process, &created, &exit, &kernel, &user) && SameTime(created, shared->targetCreated),
      "owned fixture path/start identity");
  const auto refuse = [&](Refusal reason, DWORD error = ERROR_SUCCESS) {
    shared->refusalError = error;
    InterlockedExchange(&shared->refusal, reason);
    InterlockedOr(&shared->admission, kClosed);
  };
  const auto closeUnattached = [&]() {
    CloseHandle(process); UnmapViewOfFile(shared); CloseHandle(mapping); gShared = nullptr;
    return 42;
  };
  if (!CheckRemoteDebuggerPresent(process, &debugged)) {
    refuse(DebugQueryRefusal, GetLastError()); return closeUnattached();
  }
  if (debugged) { refuse(DebuggerPresentRefusal); return closeUnattached(); }
  if (shared->guarded) Check(WaitFlag(&shared->guardReady, 5000), "guard installed before attach");
  if (shared->conflictCase == DebuggerAttachRace) {
    InterlockedExchange(&shared->observerPreflightReady, 1);
    Check(WaitFlag(&shared->observerAttachRelease, 5000), "fixture attach race release");
  }
  InterlockedIncrement(&shared->attachAttempts);
  if (!DebugActiveProcess(shared->targetId)) {
    refuse(AttachFailedRefusal, GetLastError()); return closeUnattached();
  }
  Check(DebugSetProcessKillOnExit(FALSE) != 0, "disable debugger exit kill");
  InterlockedExchange(&shared->attached, 1);
  std::map<DWORD, HANDLE> threads;
  std::map<DWORD, int> armed;
  bool loaderBreakpoint = false, ready = false, targetExited = false;
  const ULONGLONG deadline = GetTickCount64() + 1800;
  const auto seedGate = [&](DWORD tid) {
    shared->conflictThreadId = tid;
    InterlockedExchange(&shared->conflictSeedNeeded, 1);
    Check(WaitFlag(&shared->conflictSeedReady, 5000), "foreign register seed owner ready");
  };
  const auto admissible = [&](const CONTEXT& c) {
    if (!Available(c)) { refuse(RegisterRefusal); return false; }
    if (c.EFlags & 0x100) { refuse(TrapFlagRefusal); return false; }
    return true;
  };
  auto arm = [&](DWORD tid, HANDLE thread) {
    if (shared->moduleGuard && !BeginPublish(shared)) return;
    CONTEXT c{}; c.ContextFlags = CONTEXT_DEBUG_REGISTERS | CONTEXT_CONTROL;
    Check(GetThreadContext(thread, &c) != 0, "read breakpoint context");
    if (!admissible(c)) {
      if (shared->moduleGuard) EndPublish(shared);
      return;
    }
    const LONG index = Load(&shared->slots);
    Check(index < kSlots, "bounded thread journal");
    auto& record = shared->threads[index];
    record.id = tid;
    Check(ThreadIdentity(thread, &record.created), "record thread creation");
    record.original = GetRegisters(c);
    // Publish undo information before changing any target register.
    if (shared->recordArbitration) InterlockedExchange(&record.state, Published);
    InterlockedExchange(&shared->slots, index + 1);
    InterlockedExchange(&record.dirty, 1);
    c.Dr0 = shared->entry;
    c.Dr7 = (c.Dr7 & ~0xf0003ULL) | 1;
    Check(SetThreadContext(thread, &c) != 0, "set hardware execution breakpoint");
    armed[tid] = index;
    InterlockedIncrement(&shared->armedThreads);
    if (shared->moduleGuard) EndPublish(shared);
  };
  while (GetTickCount64() < deadline) {
    DEBUG_EVENT event{};
    if (!WaitForDebugEvent(&event, 50)) {
      Check(GetLastError() == ERROR_SEM_TIMEOUT, "debug event wait");
      continue;
    }
    DWORD disposition = DBG_CONTINUE;
    ThreadRecord* continuedRecord = nullptr;
    if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
      if (event.u.CreateProcessInfo.hFile) CloseHandle(event.u.CreateProcessInfo.hFile);
      if (event.u.CreateProcessInfo.hProcess) CloseHandle(event.u.CreateProcessInfo.hProcess);
      threads[event.dwThreadId] = event.u.CreateProcessInfo.hThread;
    } else if (event.dwDebugEventCode == CREATE_THREAD_DEBUG_EVENT) {
      threads[event.dwThreadId] = event.u.CreateThread.hThread;
      if (ready) {
        if (shared->conflictCase == LateThreadConflict && !Load(&shared->conflictSeedNeeded)) seedGate(event.dwThreadId);
        arm(event.dwThreadId, event.u.CreateThread.hThread);
      }
    } else if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
      if (event.u.LoadDll.hFile) CloseHandle(event.u.LoadDll.hFile);
    } else if (event.dwDebugEventCode == EXIT_THREAD_DEBUG_EVENT) {
      const auto found = armed.find(event.dwThreadId);
      if (found != armed.end()) {
        auto& record = shared->threads[found->second];
        if (shared->recordArbitration) InterlockedOr(&record.state, ThreadEnded);
        if (InterlockedExchange(&record.dirty, 0)) InterlockedIncrement(&shared->exitedThreads);
        armed.erase(found);
      }
      // Windows closes the thread handle when this exit event is continued.
      threads.erase(event.dwThreadId);
    } else if (event.dwDebugEventCode == OUTPUT_DEBUG_STRING_EVENT && !ready) {
      char marker[64]{};
      const auto& info = event.u.DebugString;
      if (!info.fUnicode && info.nDebugStringLength <= sizeof(marker) &&
          ReadRemote(process, reinterpret_cast<DWORD64>(info.lpDebugStringData), marker, info.nDebugStringLength) &&
          std::strcmp(marker, "QN_DEBUGGER_LAB_READY_V1") == 0) {
        unsigned char bytes[16]{};
        Check(shared->entry && ReadRemote(process, shared->entry, bytes, sizeof(bytes)) &&
            std::memcmp(bytes, shared->entryBytes, sizeof(bytes)) == 0, "fixture entry identity");
        ready = true;
        if (shared->conflictCase == DisabledDr0WithDr2Conflict || shared->conflictCase == EnabledDr1Conflict ||
            shared->conflictCase == EnableOnlyConflict || shared->conflictCase == TrapFlagConflict)
          seedGate(event.dwThreadId);
        // The current debug event freezes the target. Preflight every thread
        // before publishing any undo record, then recheck immediately on arm.
        for (const auto& thread : threads) {
          CONTEXT c{}; c.ContextFlags = CONTEXT_DEBUG_REGISTERS | CONTEXT_CONTROL;
          Check(GetThreadContext(thread.second, &c) != 0, "all-thread admission preflight");
          if (!admissible(c)) break;
        }
        if (!Load(&shared->refusal)) for (const auto& thread : threads) {
          if (shared->conflictCase == PartialArmConflict && armed.size() == 1 &&
              !Load(&shared->conflictSeedNeeded)) seedGate(thread.first);
          arm(thread.first, thread.second);
          if (Load(&shared->refusal)) break;
        }
        InterlockedExchange(&shared->ready, 1);
        if (shared->mode == ObserverCrash) ExitProcess(73);
        if (shared->mode == ObserverHang) Sleep(INFINITE);
        if (!Load(&shared->refusal) && (shared->mode == Normal || shared->mode == TargetExit ||
            PendingMode(shared->mode) || shared->mode == InvalidSnapshot || shared->mode == RestoreThenContinue ||
            shared->conflictCase == LateThreadConflict)) {
          InterlockedExchange(&shared->runCallbacks, 1);
        }
      }
    } else if (event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      const auto& exception = event.u.Exception;
      disposition = DBG_EXCEPTION_NOT_HANDLED;
      if (!loaderBreakpoint && !ready && exception.dwFirstChance &&
          exception.ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT) {
        loaderBreakpoint = true;
        disposition = DBG_CONTINUE;
      } else if (exception.ExceptionRecord.ExceptionCode == EXCEPTION_SINGLE_STEP &&
          armed.count(event.dwThreadId)) {
        CONTEXT c{}; c.ContextFlags = CONTEXT_FULL | CONTEXT_DEBUG_REGISTERS;
        HANDLE thread = threads.at(event.dwThreadId);
        Check(GetThreadContext(thread, &c) != 0, "breakpoint context");
        if (c.Rip == shared->entry && (c.Dr6 & 0xf) == 1 &&
            reinterpret_cast<DWORD64>(exception.ExceptionRecord.ExceptionAddress) == shared->entry) {
          auto& record = shared->threads[armed.at(event.dwThreadId)];
          if (shared->recordArbitration) {
            Check(GuardMatches(exception.ExceptionRecord, c, event.dwThreadId, record.created,
                record, shared->entry, true), "exact ownership before pending event publication");
            InterlockedOr(&record.state, PendingOwned);
          }
          DWORD64 bind = 0;
          const auto snapshot = qn_research::SnapshotMessageIdentity(&ReadRemote, process, c.Rdx, c.R8);
          Check(ReadRemote(process, c.Rcx, &bind, sizeof(bind)) && bind == 0x51514c4142ULL,
              "live fixture bind argument");
          if (shared->mode == InvalidSnapshot) {
            Check(snapshot.status == qn_research::SnapshotStatus::InvalidIdentity &&
                !snapshot.clientId[0] && !snapshot.messageId[0], "reject invalid snapshot without partial IDs");
            InterlockedIncrement(&shared->rejectedSnapshots);
          } else {
            Check(snapshot.status == qn_research::SnapshotStatus::Ok &&
              std::strcmp(snapshot.clientId.data(), "7502548731028308036") == 0 &&
              std::strcmp(snapshot.messageId.data(), "4293759074497.PNM") == 0, "live fixture callback snapshot");
          }
          if (PendingMode(shared->mode)) {
            InterlockedIncrement(&shared->hits);
            if (shared->mode == RestoreThenObserverExit || shared->mode == RestoreWithoutReceiptExit)
              RestoreThread(thread, record, false);
            if (shared->mode == HangAtCallback) Sleep(INFINITE);
            ExitProcess(75);
          }
          RestoreThread(thread, record, false);
          continuedRecord = &record;
          armed.erase(event.dwThreadId);
          InterlockedIncrement(&shared->hits);
          disposition = DBG_CONTINUE;
        }
      }
      if (exception.ExceptionRecord.ExceptionCode == kHandledException) {
        InterlockedIncrement(&shared->forwardedExceptions);
      }
    } else if (event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
      targetExited = true;
      for (const auto& item : armed) {
        if (shared->recordArbitration) InterlockedOr(&shared->threads[item.second].state, ThreadEnded);
        if (InterlockedExchange(&shared->threads[item.second].dirty, 0)) {
          InterlockedIncrement(&shared->exitedThreads);
        }
      }
    }
    if (Load(&shared->refusal)) {
      // Refusal occurs at setup/thread creation, not an exception we own.
      // Keep the current event stopped while rolling back only our journal.
      for (const auto& item : armed) RestoreThread(threads.at(item.first), shared->threads[item.second], false);
      armed.clear();
    }
    Check(ContinueDebugEvent(event.dwProcessId, event.dwThreadId, disposition) != 0, "continue debug event");
    if (continuedRecord && shared->recordArbitration) {
      InterlockedOr(&continuedRecord->state, EventContinued);
      InterlockedIncrement(&shared->continuedEvents);
    }
    if (targetExited || Load(&shared->refusal)) break;
  }
  Check(ready, "fixture ready within deadline");
  if (!targetExited) {
    for (const auto& item : armed) RestoreThread(threads.at(item.first), shared->threads[item.second], true);
    InterlockedIncrement(&shared->observerDetachCalls);
    Check(DebugActiveProcessStop(shared->targetId) != 0, "detach fixture");
  }
  InterlockedExchange(&shared->detached, 1);
  // Debug API closes process/thread debug-event handles on process exit/detach.
  CloseHandle(process);
  const bool refused = Load(&shared->refusal) != 0;
  UnmapViewOfFile(shared); CloseHandle(mapping); gShared = nullptr;
  return refused ? 42 : 0;
}

int Incumbent(const wchar_t* name) {
  HANDLE mapping = nullptr;
  auto* s = OpenShared(name, &mapping);
  HANDLE process = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, s->targetId);
  Check(process != nullptr, "incumbent opens own fixture");
  wchar_t path[32768]{}; DWORD length = 32768;
  FILETIME created{}, exited{}, kernel{}, user{};
  Check(QueryFullProcessImageNameW(process, 0, path, &length) && SelfPath() == path &&
      GetProcessTimes(process, &created, &exited, &kernel, &user) && SameTime(created, s->targetCreated),
      "incumbent fixture identity");
  Check(DebugActiveProcess(s->targetId) != 0, "incumbent attaches fixture");
  Check(DebugSetProcessKillOnExit(FALSE) != 0, "incumbent exit policy");
  InterlockedExchange(&s->attached, 1);
  bool loader = false;
  const ULONGLONG deadline = GetTickCount64() + 15000;
  while (GetTickCount64() < deadline && !Load(&s->incumbentStop)) {
    DEBUG_EVENT event{};
    if (!WaitForDebugEvent(&event, 20)) {
      Check(GetLastError() == ERROR_SEM_TIMEOUT, "incumbent event wait");
      continue;
    }
    DWORD disposition = DBG_CONTINUE;
    if (event.dwDebugEventCode == CREATE_PROCESS_DEBUG_EVENT) {
      if (event.u.CreateProcessInfo.hFile) CloseHandle(event.u.CreateProcessInfo.hFile);
      if (event.u.CreateProcessInfo.hProcess) CloseHandle(event.u.CreateProcessInfo.hProcess);
    } else if (event.dwDebugEventCode == LOAD_DLL_DEBUG_EVENT) {
      if (event.u.LoadDll.hFile) CloseHandle(event.u.LoadDll.hFile);
    } else if (event.dwDebugEventCode == OUTPUT_DEBUG_STRING_EVENT) {
      char marker[64]{}; const auto& info = event.u.DebugString;
      if (!info.fUnicode && info.nDebugStringLength <= sizeof(marker) &&
          ReadRemote(process, reinterpret_cast<DWORD64>(info.lpDebugStringData), marker, info.nDebugStringLength) &&
          std::strcmp(marker, "QN_DEBUGGER_LAB_READY_V1") == 0) InterlockedExchange(&s->incumbentReady, 1);
    } else if (event.dwDebugEventCode == EXCEPTION_DEBUG_EVENT) {
      disposition = DBG_EXCEPTION_NOT_HANDLED;
      if (!loader && event.u.Exception.dwFirstChance &&
          event.u.Exception.ExceptionRecord.ExceptionCode == EXCEPTION_BREAKPOINT) {
        loader = true; disposition = DBG_CONTINUE;
      }
      if (event.u.Exception.ExceptionRecord.ExceptionCode == kHandledException)
        InterlockedIncrement(&s->incumbentForwarded);
    } else if (event.dwDebugEventCode == EXIT_PROCESS_DEBUG_EVENT) {
      Check(false, "fixture must stay alive until incumbent detaches");
    }
    Check(ContinueDebugEvent(event.dwProcessId, event.dwThreadId, disposition) != 0, "incumbent continues event");
  }
  Check(Load(&s->incumbentStop) && Load(&s->incumbentReady), "incumbent controlled stop");
  Check(DebugActiveProcessStop(s->targetId) != 0, "incumbent voluntarily detaches");
  InterlockedExchange(&s->incumbentDetached, 1);
  CloseHandle(process); UnmapViewOfFile(s); CloseHandle(mapping); gShared = nullptr;
  return 0;
}

PROCESS_INFORMATION Launch(const std::wstring& role, const std::wstring& name, HANDLE job) {
  const std::wstring executable = SelfPath();
  std::wstring command = L"\"" + executable + L"\" " + role + L" " + name;
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  Check(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process) != 0, "launch isolated role");
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, 1);
    Check(false, "assign owned-process cleanup job");
  }
  return process;
}
void Scenario(Mode mode, int index, bool guarded, LONG moduleGuard, bool arbitration = false) {
  const std::wstring name = L"Local\\QnDebuggerLab-" + std::to_wstring(GetCurrentProcessId()) +
      L"-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(index);
  HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Shared), name.c_str());
  Check(mapping && GetLastError() != ERROR_ALREADY_EXISTS, "unique lab mapping");
  auto* shared = static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
  Check(shared != nullptr, "map lab state");
  gShared = shared;
  shared->magic = kMagic; shared->mode = mode; shared->guarded = guarded ? 1 : 0;
  shared->moduleGuard = moduleGuard;
  shared->recordArbitration = arbitration ? 1 : 0;
  shared->guardVersion = kGuardVersion;
  shared->sharedSize = sizeof(Shared);
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};
  limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  Check(job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limit, sizeof(limit)), "isolated job");
  auto target = Launch(L"--fixture", name, job);
  shared->targetId = target.dwProcessId;
  FILETIME exit{}, kernel{}, user{};
  Check(GetProcessTimes(target.hProcess, &shared->targetCreated, &exit, &kernel, &user), "target start identity");
  auto observer = Launch(L"--observer", name, job);
  shared->observerId = observer.dwProcessId;
  Check(ResumeThread(target.hThread) != DWORD(-1), "start target");
  Check(ResumeThread(observer.hThread) != DWORD(-1), "start observer");
  const DWORD wait = WaitForSingleObject(observer.hProcess, 5000);
  bool killedByWatchdog = false;
  if (wait == WAIT_TIMEOUT) {
    killedByWatchdog = true;
    Check(TerminateProcess(observer.hProcess, 74) != 0, "watchdog stop owned observer");
    Check(WaitForSingleObject(observer.hProcess, 3000) == WAIT_OBJECT_0, "watchdog observer exit");
  } else Check(wait == WAIT_OBJECT_0, "observer exit wait");
  DWORD observerCode = 0;
  Check(GetExitCodeProcess(observer.hProcess, &observerCode), "observer exit code");
  if (Load(&shared->error) || observerCode == 1 || observerCode == 2) {
    std::fprintf(stderr, "observerCode=%lu childStep=%s childWin32=%lu\n",
        observerCode, shared->errorStep, shared->errorCode);
  }
  const bool pendingCrash = PendingMode(mode);
  const bool raceControl = moduleGuard == 3 && !arbitration;
  const bool abnormal = mode == ObserverCrash || mode == ObserverHang || pendingCrash;
  Check((mode == ObserverHang || mode == HangAtCallback) == killedByWatchdog, "watchdog scenario expectation");
  Check(observerCode == (mode == ObserverCrash ? 73UL : (mode == ObserverHang || mode == HangAtCallback) ? 74UL :
      pendingCrash ? 75UL : 0UL), "observer expected outcome");
  Check(!Load(&shared->error) && Load(&shared->ready), "observer fixture health");
  if (mode == CleanupBeforeClaim || mode == CleanupAfterClaim) {
    Check(WaitFlag(&shared->racePhase, 3000), "guard reaches requested race phase");
    Check(Load(&shared->racePhase) == (mode == CleanupBeforeClaim ? 1 : 2), "exact race phase");
    const LONG slot = Load(&shared->raceSlot);
    Check(slot >= 0 && slot < Load(&shared->slots), "race journal slot bounds");
    auto& record = shared->threads[slot];
    Check(Load(&record.dirty) && !Load(&shared->guardHandled), "cleanup races incomplete exception recovery");
    if (arbitration) Check((Load(&record.state) & RecoveryClaimed) ==
        (mode == CleanupAfterClaim ? static_cast<LONG>(RecoveryClaimed) : 0L), "expected recovery claim state before cleanup");
    HANDLE thread = OpenThread(THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_SUSPEND_RESUME |
        THREAD_QUERY_INFORMATION | SYNCHRONIZE, FALSE, record.id);
    Check(thread && GetProcessIdOfThread(thread) == shared->targetId, "open owned race thread");
    RestoreThread(thread, record, true);
    CloseHandle(thread);
    Check(!Load(&record.dirty) && !Load(&shared->guardHandled), "external cleanup completed before recovery");
    if (arbitration) Check((Load(&record.state) & (Published | ExternalRestored)) == (Published | ExternalRestored),
        "register cleanup retains recovery eligibility");
    InterlockedExchange(&shared->raceCleanupVerified, 1);
    InterlockedExchange(&shared->raceRelease, 1);
  }
  // Wait for the pending exception owner to recover before touching its journal.
  // Acknowledgment alone is not handler-code quiescence; code/storage are retained.
  if (guarded && pendingCrash && !raceControl && mode != UngatedCleanupRace &&
      !WaitFlag(&shared->guardHandled, 3000)) {
    std::fprintf(stderr, "guardSeen=%ld wait=%lu debuggerPresent=%lu rip=%llx entry=%llx dr0=%llx dr6=%llx dr7=%llx flags=%lx\n",
        Load(&shared->guardSeen), shared->guardObserverWait, shared->guardDebuggerPresent, shared->guardRip, shared->entry,
        shared->guardDr0, shared->guardDr6, shared->guardDr7, shared->guardFlags);
    Check(false, "target-side pending exception recovery");
  }
  const DWORD targetWait = WaitForSingleObject(target.hProcess, 0);
  Check(targetWait == WAIT_TIMEOUT || targetWait == WAIT_OBJECT_0, "target liveness check");
  if (mode != TargetExit && targetWait == WAIT_TIMEOUT) {
    BOOL debugged = TRUE;
    Check(CheckRemoteDebuggerPresent(target.hProcess, &debugged) && !debugged, "external detach verification");
    // The watchdog only touches journaled threads of its own disposable target.
    for (LONG i = 0; i < Load(&shared->slots); ++i) {
      auto& record = shared->threads[i];
      if (!Load(&record.dirty)) continue;
      HANDLE thread = OpenThread(THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_SUSPEND_RESUME |
          THREAD_QUERY_INFORMATION | SYNCHRONIZE, FALSE, record.id);
      if (!thread && GetLastError() == ERROR_INVALID_PARAMETER && !ThreadExists(record.id)) {
        if (arbitration) InterlockedOr(&record.state, ThreadEnded);
        InterlockedExchange(&record.dirty, 0);
        InterlockedIncrement(&shared->exitedThreads);
        continue;
      }
      Check(thread != nullptr, "watchdog open journaled thread");
      Check(GetProcessIdOfThread(thread) == shared->targetId, "watchdog thread owner");
      RestoreThread(thread, record, true);
      CloseHandle(thread);
    }
    for (LONG i = 0; i < Load(&shared->slots); ++i) Check(!Load(&shared->threads[i].dirty), "no dirty breakpoints");
    if (mode == UngatedCleanupRace) Check(WaitFlag(&shared->guardHandled, 3000), "ungated cleanup followed by recovery");
    InterlockedExchange(&shared->runCallbacks, 1);
    InterlockedExchange(&shared->finish, 1);
  }
  Check(WaitForSingleObject(target.hProcess, 10000) == WAIT_OBJECT_0, "target exits after cleanup");
  DWORD targetCode = 0;
  Check(GetExitCodeProcess(target.hProcess, &targetCode), "target exit code");
  const bool unsafe = (!guarded || raceControl) && pendingCrash && targetCode != 0;
  if (unsafe) {
    Check(targetCode == EXCEPTION_SINGLE_STEP, "negative control exact exception code");
    ++gUnsafeOutcomes;
    std::printf("UNSAFE observer_exit_at_pending_callback targetExit=0x%08lx expected=0 "
        "pending_exception_not_safely_resumed=1\n", targetCode);
  } else {
    Check(targetCode == (mode == TargetExit ? 29UL : 0UL), "target expected outcome");
  }
  Check(!Load(&shared->error), "no target errors");
  Check(Load(&shared->hits) == (mode == Normal || mode == InvalidSnapshot || mode == RestoreThenContinue ? 2 :
      pendingCrash ? 1 : 0), "expected hardware hits");
  Check(Load(&shared->rejectedSnapshots) == (mode == InvalidSnapshot ? 2 : 0), "expected rejected snapshots");
  if (mode != TargetExit && !unsafe)
    Check(Load(&shared->callbackCount) == 4 && Load(&shared->handledExceptions) == 1 &&
        Load(&shared->foreignStepsHandled) == 1,
      "callbacks and unrelated exception remain functional");
  if (mode == Normal) Check(Load(&shared->forwardedExceptions) == 1 && Load(&shared->armedThreads) >= 2,
      "late thread and exception forwarding");
  if (guarded && !moduleGuard && mode != TargetExit)
    Check(Load(&shared->guardRemoved) == 1, "fixture guard removed");
  if (moduleGuard && mode != TargetExit && !unsafe) {
    Check(!Load(&shared->guardRemoved) && Load(&shared->modulePinned) && Load(&shared->moduleRetained) &&
        Load(&shared->admission) == kClosed && !Load(&shared->moduleActive), "module closed but lifetime retained");
    if (moduleGuard == 2 && pendingCrash)
      Check(Load(&shared->moduleCleanupVerified) && !Load(&shared->moduleGateTimeout), "concurrent cleanup receipt");
  }
  if (guarded && pendingCrash && !unsafe) Check(Load(&shared->guardHandled) == 1, "exactly one recovered exception");
  if (guarded && !pendingCrash) Check(Load(&shared->guardHandled) == 0, "guard leaves normal path untouched");
  std::printf("%s mode=%ld guarded=%d guardHandled=%ld guardRemoved=%ld targetPid=%lu hits=%ld callbacks=%ld armed=%ld restored=%ld exited=%ld "
      "rejectedSnapshots=%ld foreignStepsHandled=%ld "
      "watchdog=%d observerAbnormal=%d targetExit=%lu\n",
      unsafe ? "FAIL_SAFETY" : "PASS", static_cast<LONG>(mode),
      guarded ? 1 : 0, Load(&shared->guardHandled), Load(&shared->guardRemoved), shared->targetId,
      Load(&shared->hits), Load(&shared->callbackCount), Load(&shared->armedThreads), Load(&shared->cleanThreads),
      Load(&shared->exitedThreads), Load(&shared->rejectedSnapshots), Load(&shared->foreignStepsHandled), killedByWatchdog ? 1 : 0,
      abnormal ? 1 : 0, targetCode);
  if (moduleGuard) std::printf("MODULE mode=%ld variant=%ld pinned=%ld retained=%ld active=%ld admission=0x%lx concurrentCleanup=%ld gateTimeout=%ld\n",
      static_cast<LONG>(mode), moduleGuard, Load(&shared->modulePinned), Load(&shared->moduleRetained),
      Load(&shared->moduleActive), static_cast<unsigned long>(Load(&shared->admission)),
      Load(&shared->moduleCleanupVerified), Load(&shared->moduleGateTimeout));
  if (moduleGuard == 3) {
    Check(!Load(&shared->raceTimeout), "race gate released without timeout");
    if (mode == CleanupBeforeClaim || mode == CleanupAfterClaim) {
      Check(Load(&shared->raceCleanupVerified), "cleanup race has an independent receipt");
      if (!unsafe) Check(Load(&shared->recoveredAfterClean) == 1, "recovery survives dirty flag cleared");
    }
    if (mode == RestoreThenContinue) Check(Load(&shared->continuedEvents) == 2 &&
        Load(&shared->guardHandled) == 0, "successful continuation does not use exception guard");
    if (arbitration) {
      LONG claims = 0, continuations = 0;
      for (LONG i = 0; i < Load(&shared->slots); ++i) {
        const LONG state = Load(&shared->threads[i].state);
        Check(state & Published, "record publication retained");
        Check(!((state & RecoveryClaimed) && (state & EventContinued)), "event has one completion owner");
        if (state & RecoveryClaimed) {
          ++claims;
          Check(state & RecoveryDone, "claimed recovery completed");
        }
        if (state & EventContinued) ++continuations;
      }
      Check(claims == Load(&shared->guardHandled) && continuations == Load(&shared->continuedEvents),
          "per-record terminal receipts match totals");
      Check(!Load(&shared->recoveredCleanContext), "no recovery without original hardware fingerprint");
    }
    std::printf("ARBITRATION mode=%ld enabled=%d phase=%ld cleanupVerified=%ld recoveredAfterClean=%ld cleanContext=%ld continued=%ld gateTimeout=%ld\n",
        static_cast<LONG>(mode), arbitration ? 1 : 0, Load(&shared->racePhase), Load(&shared->raceCleanupVerified),
        Load(&shared->recoveredAfterClean), Load(&shared->recoveredCleanContext), Load(&shared->continuedEvents),
        Load(&shared->raceTimeout));
  }
  CloseHandle(observer.hThread); CloseHandle(observer.hProcess);
  CloseHandle(target.hThread); CloseHandle(target.hProcess); CloseHandle(job);
  UnmapViewOfFile(shared); CloseHandle(mapping); gShared = nullptr;
}
void ConflictScenario(ConflictCase conflict) {
  const auto name = L"Local\\QnDebuggerLab-" + std::to_wstring(GetCurrentProcessId()) +
      L"-conflict-" + std::to_wstring(GetTickCount64()) + L"-" + std::to_wstring(conflict);
  HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Shared), name.c_str());
  Check(mapping && GetLastError() != ERROR_ALREADY_EXISTS, "unique conflict mapping");
  auto* s = static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
  Check(s != nullptr, "map conflict state");
  gShared = s;
  s->magic = kMagic; s->sharedSize = sizeof(Shared); s->guardVersion = kGuardVersion;
  s->mode = Timeout; s->guarded = 1; s->moduleGuard = 1; s->recordArbitration = 1; s->conflictCase = conflict;
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limit{};
  limit.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  Check(job && SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limit, sizeof(limit)), "conflict cleanup job");
  auto target = Launch(L"--fixture", name, job);
  s->targetId = target.dwProcessId;
  FILETIME exited{}, kernel{}, user{};
  Check(GetProcessTimes(target.hProcess, &s->targetCreated, &exited, &kernel, &user), "conflict target identity");
  auto observer = Launch(L"--observer", name, job);
  s->observerId = observer.dwProcessId;
  Check(ResumeThread(target.hThread) != DWORD(-1) && WaitFlag(&s->guardReady, 5000), "fixture guard before conflicts");
  const bool debuggerCase = conflict == ExistingDebugger || conflict == DebuggerAttachRace;
  PROCESS_INFORMATION incumbent{};
  HANDLE seededThread = nullptr;
  CONTEXT original{}, seeded{};
  FILETIME seededCreated{};
  if (debuggerCase) {
    if (conflict == DebuggerAttachRace) {
      Check(ResumeThread(observer.hThread) != DWORD(-1), "candidate preflight before competitor attach");
      Check(WaitFlag(&s->observerPreflightReady, 5000), "candidate observed no debugger before race");
    }
    incumbent = Launch(L"--incumbent", name, job);
    Check(ResumeThread(incumbent.hThread) != DWORD(-1) && WaitFlag(&s->incumbentReady, 5000), "incumbent owns real debug connection");
    BOOL present = FALSE;
    Check(CheckRemoteDebuggerPresent(target.hProcess, &present) && present, "independent incumbent presence check");
    if (conflict == ExistingDebugger) Check(ResumeThread(observer.hThread) != DWORD(-1), "start competing observer");
    else InterlockedExchange(&s->observerAttachRelease, 1);
  } else {
    Check(ResumeThread(observer.hThread) != DWORD(-1) && WaitFlag(&s->conflictSeedNeeded, 5000), "observer reaches conflict injection boundary");
    seededThread = OpenThread(THREAD_GET_CONTEXT | THREAD_SET_CONTEXT | THREAD_SUSPEND_RESUME |
        THREAD_QUERY_INFORMATION | SYNCHRONIZE, FALSE, s->conflictThreadId);
    Check(seededThread && GetProcessIdOfThread(seededThread) == s->targetId &&
        ThreadIdentity(seededThread, &seededCreated), "seed owner verifies thread identity");
    // The seed owner holds its own suspension across refusal. This also lets
    // us test TF without letting an unowned trap execute during the fixture.
    Check(SuspendThread(seededThread) == 0, "seed owner takes one suspension");
    original.ContextFlags = CONTEXT_DEBUG_REGISTERS | CONTEXT_CONTROL;
    Check(GetThreadContext(seededThread, &original) && Available(original) && !(original.EFlags & 0x100), "clean foreign seed baseline");
    seeded = original;
    if (conflict == DisabledDr0WithDr2Conflict) {
      // This Windows build reads all DR addresses as zero with no enabled slot.
      // Keep DR0 disabled but activate an independent DR2 to retain its value.
      seeded.Dr0 = 0x12345000; seeded.Dr2 = 0x23456000; seeded.Dr7 |= 16;
    } else if (conflict == EnabledDr1Conflict || conflict == PartialArmConflict || conflict == LateThreadConflict) {
      seeded.Dr1 = 0x12345000; seeded.Dr7 |= 4;
    }
    else if (conflict == EnableOnlyConflict) seeded.Dr7 |= 16;
    else if (conflict == TrapFlagConflict) seeded.EFlags |= 0x100;
    else Check(false, "known register conflict fixture");
    Check(SetThreadContext(seededThread, &seeded) != 0, "foreign owner seeds actual context");
    CONTEXT verified{}; verified.ContextFlags = original.ContextFlags;
    const bool readback = GetThreadContext(seededThread, &verified) != 0;
    const bool seedMatches = readback && SameRegisters(GetRegisters(verified), GetRegisters(seeded)) &&
        (verified.EFlags & 0x100) == (seeded.EFlags & 0x100);
    if (!seedMatches) std::fprintf(stderr,
        "SEED conflict=%ld read=%d expected dr0=%llx dr1=%llx dr6=%llx dr7=%llx flags=%lx actual dr0=%llx dr1=%llx dr6=%llx dr7=%llx flags=%lx\n",
        static_cast<LONG>(conflict), readback ? 1 : 0, seeded.Dr0, seeded.Dr1, seeded.Dr6, seeded.Dr7, seeded.EFlags,
        verified.Dr0, verified.Dr1, verified.Dr6, verified.Dr7, verified.EFlags);
    Check(seedMatches, "foreign seed readback");
    InterlockedExchange(&s->conflictSeedReady, 1);
  }
  Check(WaitForSingleObject(observer.hProcess, 7000) == WAIT_OBJECT_0, "refusing observer exits without watchdog");
  DWORD observerCode = 0;
  Check(GetExitCodeProcess(observer.hProcess, &observerCode) && observerCode == 42 && !Load(&s->error), "structured refusal outcome");
  const Refusal expected = conflict == ExistingDebugger ? DebuggerPresentRefusal :
      conflict == DebuggerAttachRace ? AttachFailedRefusal : conflict == TrapFlagConflict ? TrapFlagRefusal : RegisterRefusal;
  Check(Load(&s->refusal) == expected, "specific conflict reason");
  Check(Load(&s->admission) == kClosed, "refusal drains admission and closes session");
  Check(!Load(&s->hits) && !Load(&s->guardHandled), "no callback breakpoint or recovery used to conceal refusal");
  for (LONG i = 0; i < Load(&s->slots); ++i) Check(!Load(&s->threads[i].dirty), "all candidate breakpoints rolled back");
  if (debuggerCase) {
    BOOL present = FALSE;
    Check(CheckRemoteDebuggerPresent(target.hProcess, &present) && present &&
        WaitForSingleObject(incumbent.hProcess, 0) == WAIT_TIMEOUT, "candidate did not detach or terminate incumbent");
    Check(Load(&s->attachAttempts) == (conflict == ExistingDebugger ? 0 : 1) &&
        !Load(&s->observerDetachCalls) && !Load(&s->slots) && !Load(&s->armedThreads), "no takeover or target context writes");
    if (conflict == DebuggerAttachRace) Check(s->refusalError != ERROR_SUCCESS, "attach-race failure code retained");
  } else {
    Check(Load(&s->attachAttempts) == 1 && Load(&s->observerDetachCalls) == 1 && Load(&s->detached), "candidate detached after refusal rollback");
    BOOL present = TRUE;
    Check(CheckRemoteDebuggerPresent(target.hProcess, &present) && !present, "independent candidate detach check");
    FILETIME currentCreated{};
    Check(ThreadIdentity(seededThread, &currentCreated) && SameTime(currentCreated, seededCreated), "same seeded thread after refusal");
    CONTEXT after{}; after.ContextFlags = original.ContextFlags;
    Check(GetThreadContext(seededThread, &after) && SameRegisters(GetRegisters(after), GetRegisters(seeded)) &&
        (after.EFlags & 0x100) == (seeded.EFlags & 0x100), "candidate preserved foreign registers and TF");
    const bool partial = conflict == PartialArmConflict || conflict == LateThreadConflict;
    Check(partial ? Load(&s->armedThreads) >= 1 : Load(&s->armedThreads) == 0, "preflight or partial rollback coverage");
    Check(Load(&s->cleanThreads) == Load(&s->armedThreads), "each candidate register write was restored");
    // Only the actor that introduced the foreign state removes it.
    SetRegisters(after, GetRegisters(original));
    after.EFlags = (after.EFlags & ~0x100UL) | (original.EFlags & 0x100);
    Check(SetThreadContext(seededThread, &after) != 0, "seed owner restores own state");
    CONTEXT finalContext{}; finalContext.ContextFlags = original.ContextFlags;
    Check(GetThreadContext(seededThread, &finalContext) && SameRegisters(GetRegisters(finalContext), GetRegisters(original)) &&
        (finalContext.EFlags & 0x100) == (original.EFlags & 0x100), "seed owner cleanup verified");
    Check(ResumeThread(seededThread) == 1, "seed owner releases exactly its own suspension");
    CloseHandle(seededThread);
  }
  InterlockedExchange(&s->conflictProceed, 1);
  InterlockedExchange(&s->runCallbacks, 1);
  const ULONGLONG callbackDeadline = GetTickCount64() + 5000;
  while (Load(&s->callbackCount) != 4 && GetTickCount64() < callbackDeadline) Sleep(5);
  Check(Load(&s->callbackCount) == 4, "target keeps working after rejection");
  if (debuggerCase) {
    Check(Load(&s->incumbentForwarded) == 1, "incumbent handles subsequent real event after refusal");
    InterlockedExchange(&s->incumbentStop, 1);
    Check(WaitForSingleObject(incumbent.hProcess, 5000) == WAIT_OBJECT_0, "incumbent voluntarily finishes");
    DWORD code = 0;
    Check(GetExitCodeProcess(incumbent.hProcess, &code) && code == 0 && Load(&s->incumbentDetached), "incumbent clean exit");
  }
  InterlockedExchange(&s->finish, 1);
  Check(WaitForSingleObject(target.hProcess, 5000) == WAIT_OBJECT_0, "conflict target exits normally");
  DWORD targetCode = 0;
  Check(GetExitCodeProcess(target.hProcess, &targetCode) && targetCode == 0 && !Load(&s->error) &&
      Load(&s->handledExceptions) == 1 && Load(&s->foreignStepsHandled) == 1 && !Load(&s->guardHandled), "target and unrelated exceptions remain healthy");
  std::printf("PASS conflict=%ld reason=%ld win32=%lu observerExit=%lu attachAttempts=%ld detachCalls=%ld armed=%ld restored=%ld "
      "foreignStatePreserved=%d incumbentForwarded=%ld callbacks=%ld targetExit=%lu\n", static_cast<LONG>(conflict),
      Load(&s->refusal), s->refusalError, observerCode, Load(&s->attachAttempts), Load(&s->observerDetachCalls),
      Load(&s->armedThreads), Load(&s->cleanThreads), debuggerCase ? 0 : 1, Load(&s->incumbentForwarded),
      Load(&s->callbackCount), targetCode);
  if (incumbent.hProcess) { CloseHandle(incumbent.hThread); CloseHandle(incumbent.hProcess); }
  CloseHandle(observer.hThread); CloseHandle(observer.hProcess);
  CloseHandle(target.hThread); CloseHandle(target.hProcess); CloseHandle(job);
  UnmapViewOfFile(s); CloseHandle(mapping); gShared = nullptr;
}

void GuardPredicateTests() {
  constexpr DWORD64 entry = 0x1234000;
  EXCEPTION_RECORD exception{};
  exception.ExceptionCode = EXCEPTION_SINGLE_STEP;
  exception.ExceptionAddress = reinterpret_cast<void*>(entry);
  CONTEXT context{};
  context.Rip = entry; context.Dr0 = entry; context.Dr6 = 0xffff0ff1; context.Dr7 = 0x401;
  ThreadRecord record{};
  record.id = 123; record.created = {456, 789}; record.dirty = 1;
  const auto matches = [&](const EXCEPTION_RECORD& e, const CONTEXT& c,
                           const ThreadRecord& r, bool absent = true) {
    return GuardMatches(e, c, 123, FILETIME{456, 789}, r, entry, absent);
  };
  Check(matches(exception, context, record), "guard exact predicate positive");
  Check(!matches(exception, context, record, false), "guard does not intercept attached debugger");
  for (int i = 0; i < 14; ++i) {
    auto e = exception; auto c = context; auto r = record;
    switch (i) {
      case 0: e.ExceptionCode = EXCEPTION_ACCESS_VIOLATION; break;
      case 1: e.ExceptionFlags = EXCEPTION_NONCONTINUABLE; break;
      case 2: e.ExceptionAddress = nullptr; break;
      case 3: c.Rip += 1; break;
      case 4: c.Dr0 += 1; break;
      case 5: c.Dr6 |= 2; break;
      case 6: c.Dr6 |= 0x4000; break;
      case 7: c.Dr7 |= 4; break;
      case 8: c.EFlags |= 0x100; break;
      case 9: r.id += 1; break;
      case 10: r.created.dwLowDateTime += 1; break;
      case 11: r.dirty = 0; break;
      case 12: r.guardConsumed = 1; break;
      case 13: e.NumberParameters = 1; break;
    }
    Check(!matches(e,c,r), "guard rejects foreign or stale exception");
  }
  std::puts("PASS guard_predicates positive=1 negative=15");
}
struct PublicationRace {
  Shared state{};
  volatile LONG reserved = 0;
  volatile LONG release = 0;
};
DWORD WINAPI PublicationWorker(void* raw) {
  auto& race = *static_cast<PublicationRace*>(raw);
  Check(BeginPublish(&race.state), "worker reserves publication");
  InterlockedExchange(&race.reserved, 1);
  Check(WaitFlag(&race.release, 3000), "worker publication release gate");
  EndPublish(&race.state);
  return 0;
}
void AdmissionTests() {
  Shared state{};
  Check(BeginPublish(&state), "reserve publication before close");
  InterlockedOr(&state.admission, kClosed);
  Check(Load(&state.admission) == (kClosed | 1) && !BeginPublish(&state), "close preserves existing reservation");
  EndPublish(&state);
  Check(Load(&state.admission) == kClosed && !BeginPublish(&state), "closed state cannot reopen after drain");
  for (int i = 0; i < 16; ++i) {
    PublicationRace race;
    HANDLE worker = CreateThread(nullptr, 0, &PublicationWorker, &race, 0, nullptr);
    Check(worker && WaitFlag(&race.reserved, 3000), "concurrent publication established");
    InterlockedOr(&race.state.admission, kClosed);
    Check(Load(&race.state.admission) == (kClosed | 1) && !BeginPublish(&race.state),
        "concurrent close retains reservation and refuses new work");
    InterlockedExchange(&race.release, 1);
    Check(WaitForSingleObject(worker, 3000) == WAIT_OBJECT_0, "concurrent publisher drains");
    CloseHandle(worker);
    Check(Load(&race.state.admission) == kClosed, "concurrent drain does not reopen");
  }
  std::puts("PASS admission close_with_publisher=1 late_publish_rejected=1 no_reopen=1 concurrent_rounds=16");
}
void ArbitrationPredicateTests() {
  constexpr DWORD64 entry = 0x1234000;
  ThreadRecord r{}; r.id = 123; r.created = {456,789}; r.state = Published;
  EXCEPTION_RECORD e{}; e.ExceptionCode = EXCEPTION_SINGLE_STEP;
  e.ExceptionAddress = reinterpret_cast<void*>(entry);
  CONTEXT c{}; c.Rip = entry; c.Dr0 = entry; c.Dr6 = 0xffff0ff1; c.Dr7 = 0x401;
  const auto matches = [&](const EXCEPTION_RECORD& ex, const CONTEXT& cx, LONG state, bool absent = true) {
    return RetainedGuardMatches(ex, cx, 123, FILETIME{456,789}, r, entry, absent, state);
  };
  Check(matches(e,c,Published), "published undo remains eligible with dirty zero");
  CONTEXT clean = c; SetRegisters(clean, r.original);
  constexpr LONG progress = Published | PendingOwned | RestoreIntent | ExternalRestored;
  Check(matches(e,c,progress), "completed register cleanup does not revoke original exception context");
  Check(!matches(e,clean,Published) && !matches(e,clean,progress), "lifecycle flags cannot substitute missing hardware evidence");
  for (int i = 0; i < 16; ++i) {
    auto ex = e; auto cx = c; LONG state = progress; bool absent = true;
    switch (i) {
      case 0: state &= ~Published; break;
      case 1: cx.Dr0 += 1; break;
      case 2: cx.Dr6 |= 0x4000; break;
      case 3: state |= EventContinued; break;
      case 4: state |= ThreadEnded; break;
      case 5: state |= RecoveryClaimed; break;
      case 6: cx.Rip += 1; break;
      case 7: ex.ExceptionAddress = nullptr; break;
      case 8: ex.ExceptionCode = EXCEPTION_ACCESS_VIOLATION; break;
      case 9: ex.ExceptionFlags = EXCEPTION_NONCONTINUABLE; break;
      case 10: ex.NumberParameters = 1; break;
      case 11: cx.EFlags |= 0x100; break;
      case 12: cx.Dr6 |= 2; break;
      case 13: cx.Dr1 = 123; break;
      case 14: cx.Dr7 |= 4; break;
      case 15: absent = false; break;
    }
    Check(!matches(ex,cx,state,absent), "retained recovery rejects unowned, stale or foreign event");
  }
  Check(!RetainedGuardMatches(e,c,124,r.created,r,entry,true,progress), "retained wrong thread rejected");
  Check(!RetainedGuardMatches(e,c,123,FILETIME{457,789},r,entry,true,progress), "retained wrong creation rejected");
  r.state = Published;
  Check(ClaimRecovery(r,e,c,123,r.created,entry,true), "one-shot recovery claim");
  InterlockedOr(&r.state, ExternalRestored);
  Check(!ClaimRecovery(r,e,c,123,r.created,entry,true), "duplicate recovery refused after concurrent cleanup mark");
  Check((Load(&r.state) & (RecoveryClaimed | ExternalRestored)) == (RecoveryClaimed | ExternalRestored),
      "monotonic state retains both actors' progress");
  std::puts("PASS arbitration_predicates positive=2 negative=20 one_shot=1 monotonic_progress=1");
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && std::wcsncmp(argv[2], L"Local\\QnDebuggerLab-", 19) == 0) {
    if (std::wcscmp(argv[1], L"--fixture") == 0) return Target(argv[2]);
    if (std::wcscmp(argv[1], L"--observer") == 0) return Observer(argv[2]);
    if (std::wcscmp(argv[1], L"--incumbent") == 0) return Incumbent(argv[2]);
  }
  const bool stress = argc == 2 && std::wcscmp(argv[1], L"--record-race-stress") == 0;
  const bool race = stress || (argc == 2 && std::wcscmp(argv[1], L"--record-race") == 0);
  const bool raceControl = argc == 2 && std::wcscmp(argv[1], L"--record-race-control") == 0;
  const bool conflicts = argc == 2 && std::wcscmp(argv[1], L"--conflict-refusal") == 0;
  const LONG moduleGuard = (race || raceControl) ? 3 :
      argc == 2 && std::wcscmp(argv[1], L"--module-guard") == 0 ? 1 :
      argc == 2 && std::wcscmp(argv[1], L"--module-guard-delay") == 0 ? 2 : 0;
  const bool guarded = moduleGuard || (argc == 2 && std::wcscmp(argv[1], L"--guarded") == 0);
  if (argc != 1 && !guarded && !conflicts) { std::fprintf(stderr, "Only self-contained laboratory mode is supported.\n"); return 2; }
  CONTEXT occupied{}; occupied.Dr1 = 0x123;
  Check(!Available(occupied), "occupied register rejected");
  occupied = {}; occupied.Dr7 = 4;
  Check(!Available(occupied), "occupied enable bit rejected");
  GuardPredicateTests();
  AdmissionTests();
  if (conflicts) {
    for (int i = 1; i <= 8; ++i) ConflictScenario(static_cast<ConflictCase>(i));
  } else if (race || raceControl) {
    ArbitrationPredicateTests();
    if (raceControl) Scenario(CleanupBeforeClaim, 0, true, moduleGuard, false);
    else if (stress) {
      for (int i = 0; i < 32; ++i) Scenario(UngatedCleanupRace, i, true, moduleGuard, true);
    } else for (int i = 0; i < 15; ++i) Scenario(static_cast<Mode>(i), i, true, moduleGuard, true);
  } else {
    for (int i = 0; i < (moduleGuard ? 9 : guarded ? 8 : 7); ++i)
      Scenario(static_cast<Mode>(i), i, guarded, moduleGuard);
  }
  std::printf("result=%s unsafeOutcomes=%d qianniu_attached=0 send_invoked=0 "
      "real_sdk_callback_validated=0 live_target_ready=0\n",
      gUnsafeOutcomes ? "debugger_lifecycle_safety_failed" : conflicts ? "debugger_conflict_refusal_lab_ok" :
      race ? "debugger_record_race_lab_ok" :
      moduleGuard ? "debugger_module_guard_lab_ok" :
      guarded ? "debugger_guarded_lab_ok" : "debugger_lifecycle_lab_ok",
      gUnsafeOutcomes);
  return gUnsafeOutcomes ? 1 : 0;
}
