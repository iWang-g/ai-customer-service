#include "completion_once_shared.h"

namespace {
using namespace completion_once;
using namespace qn_debugger_lab;
completion_once::Shared* gState = nullptr;
HANDLE gMapping = nullptr, gThread = nullptr, gWorker = nullptr;
PVOID gHandler = nullptr;
DWORD gAnchor = 0;
bool ReadSelf(void*, std::uint64_t address, void* target, std::size_t size) {
  SIZE_T read = 0;
  return ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(address), target, size, &read) && read == size;
}
Registers DebugRegisters(const CONTEXT& c) { return {c.Dr0,c.Dr1,c.Dr2,c.Dr3,c.Dr6,c.Dr7}; }
bool Owned(const CONTEXT& c) {
  const auto& r = gState->record.original;
  return c.Dr0 == gState->entry && c.Dr1 == r.dr1 && c.Dr2 == r.dr2 && c.Dr3 == r.dr3 &&
      (c.Dr7 & ~0x400ULL) == ((r.dr7 & ~0xf0403ULL) | 1);
}
LONG CALLBACK Observe(EXCEPTION_POINTERS* pointers) {
  auto* s = gState;
  if (!s || !pointers || !pointers->ContextRecord || !pointers->ExceptionRecord ||
      GetCurrentThreadId() != s->identity.tid) return EXCEPTION_CONTINUE_SEARCH;
  FILETIME created{}, exited{}, kernel{}, user{};
  if (!GetThreadTimes(GetCurrentThread(), &created, &exited, &kernel, &user) ||
      !ClaimRecovery(s->record, *pointers->ExceptionRecord, *pointers->ContextRecord,
          GetCurrentThreadId(), created, s->entry, !IsDebuggerPresent())) return EXCEPTION_CONTINUE_SEARCH;
  auto& c = *pointers->ContextRecord;
  s->hitTid = GetCurrentThreadId(); s->bindState = c.Rcx;
  s->resultPointer = c.Rdx; s->messagePointer = c.R8;
  s->snapshot = qn_research::SnapshotMessageIdentity(&ReadSelf, nullptr, c.Rdx, c.R8);
  SetRegisters(c, s->record.original);
  InterlockedExchange(&s->record.dirty, 0);
  InterlockedOr(&s->record.state, RecoveryDone);
  InterlockedIncrement(&s->hits);
  InterlockedExchange(&s->snapshotReady, 1);
  return EXCEPTION_CONTINUE_EXECUTION;
}
bool Context(CONTEXT* c) {
  *c = {}; c->ContextFlags = CONTEXT_DEBUG_REGISTERS | CONTEXT_CONTROL;
  return GetThreadContext(gThread, c) != 0;
}
bool Resume() { return ResumeThread(gThread) == 1; }
bool Cleanup() {
  const DWORD suspended = SuspendThread(gThread);
  if (suspended == DWORD(-1)) return false;
  if (suspended != 0) { ResumeThread(gThread); return false; }
  CONTEXT context{};
  bool ok = Context(&context);
  if (ok && !SameDebugRegisters(DebugRegisters(context), gState->record.original)) {
    ok = Owned(context);
    if (ok) {
      InterlockedOr(&gState->record.state, RestoreIntent);
      SetRegisters(context, gState->record.original);
      ok = SetThreadContext(gThread, &context) != 0;
    }
  }
  CONTEXT verified{};
  ok = ok && Context(&verified) && SameDebugRegisters(DebugRegisters(verified), gState->record.original);
  if (ok) {
    InterlockedExchange(&gState->record.dirty, 0);
    InterlockedOr(&gState->record.state, ExternalRestored);
  }
  const bool resumed = Resume();
  return ok && resumed;
}
DWORD WINAPI Worker(void*) {
  auto* s = gState; s->workerTid = GetCurrentThreadId();
  DWORD_PTR response = 0;
  if (s->identity.hwnd && !SendMessageTimeoutW(reinterpret_cast<HWND>(s->identity.hwnd), WM_NULL,
      0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 3000, &response)) {
    s->error = ERROR_TIMEOUT; InterlockedExchange(&s->phase, Refused); return 0;
  }
  const DWORD suspended = SuspendThread(gThread);
  if (suspended != 0) {
    if (suspended != DWORD(-1)) ResumeThread(gThread);
    s->error = ERROR_BUSY; InterlockedExchange(&s->phase, Refused); return 0;
  }
  CONTEXT original{};
  bool ok = Context(&original) && !IsDebuggerPresent() &&
      !(original.Dr0 | original.Dr1 | original.Dr2 | original.Dr3) &&
      !(original.Dr7 & ~0x400ULL) && !(original.Dr6 & 0xe00fULL) && !(original.EFlags & 0x100);
  if (!ok) {
    const bool resumed = Resume();
    s->error = resumed ? ERROR_BUSY : ERROR_INVALID_STATE;
    InterlockedExchange(&s->phase, Refused); return 0;
  }
  s->record.id = s->identity.tid; s->record.created = s->identity.threadCreated;
  s->record.original = DebugRegisters(original);
  InterlockedExchange(&s->record.dirty, 1);
  InterlockedExchange(&s->record.state, Published);
  CONTEXT armed = original;
  armed.Dr0 = s->entry; armed.Dr7 = (original.Dr7 & ~0xf0403ULL) | 1;
  armed.Dr6 &= ~0xe00fULL;
  ok = SetThreadContext(gThread, &armed) != 0;
  CONTEXT verify{};
  ok = ok && Context(&verify) && Owned(verify);
  if (!ok) {
    SetThreadContext(gThread, &original);
    Resume(); s->error = ERROR_INVALID_STATE;
    InterlockedExchange(&s->phase, Refused); return 0;
  }
  InterlockedExchange(&s->phase, Armed);
  if (!Resume()) { s->error = ERROR_INVALID_STATE; InterlockedExchange(&s->phase, Refused); return 0; }
  const ULONGLONG deadline = GetTickCount64() + s->durationMs;
  while (!Load(&s->snapshotReady) && !Load(&s->stop) && GetTickCount64() < deadline) Sleep(10);
  const bool clean = Cleanup();
  DWORD_PTR barrierResult = 0;
  const bool quiescent = clean && (!s->identity.hwnd || SendMessageTimeoutW(
      reinterpret_cast<HWND>(s->identity.hwnd), WM_NULL, 0, 0, SMTO_ABORTIFHUNG | SMTO_BLOCK, 3000, &barrierResult));
  // After restored registers and a GUI round trip, no old pending trap can remain.
  if (quiescent) InterlockedOr(&s->record.state, EventContinued);
  InterlockedExchange(&s->cleanupVerified, quiescent ? 1 : 0);
  s->error = quiescent ? (Load(&s->snapshotReady) ? ERROR_SUCCESS : ERROR_TIMEOUT) : ERROR_INVALID_STATE;
  InterlockedExchange(&s->workerDone, 1);
  InterlockedExchange(&s->phase, Finished);
  return 0;
}
DWORD Initialize(const wchar_t* name) {
  if (gState) return ERROR_ALREADY_INITIALIZED;
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  auto* s = mapping ? static_cast<completion_once::Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS,
      0, 0, sizeof(completion_once::Shared))) : nullptr;
  if (!s) { if (mapping) CloseHandle(mapping); return ERROR_FILE_NOT_FOUND; }
  FILETIME pc{}, tc{}, exited{}, kernel{}, user{};
  wchar_t image[32768]{}; const DWORD n = GetModuleFileNameW(nullptr, image, 32768);
  bool valid = n && n < 32768 && s->magic == completion_once::kMagic && s->size == sizeof(*s) && s->token &&
      s->identity.pid == GetCurrentProcessId() && s->identity.tid == GetCurrentThreadId() &&
      s->durationMs >= 100 && s->durationMs <= 60000 && !IsDebuggerPresent() &&
      GetProcessTimes(GetCurrentProcess(), &pc, &exited, &kernel, &user) && SameTime(pc, s->identity.processCreated) &&
      GetThreadTimes(GetCurrentThread(), &tc, &exited, &kernel, &user) && SameTime(tc, s->identity.threadCreated);
#ifdef QN_COMPLETION_FIXTURE
  const wchar_t* leaf = std::wcsrchr(image, L'\\');
  valid = valid && leaf && std::wcscmp(leaf + 1, L"qn_completion_fixture.exe") == 0 && s->identity.hwnd == 0;
#else
  valid = valid && _wcsicmp(image, L"D:\\qianniu\\AliWorkbench.exe") == 0 &&
      s->entry == s->identity.appBase + 0x4f0380;
  try { valid = valid && QnCheckLiveIdentity(s->identity, kDll, live_nosend::kDllPath, kPriorDll, kSecondPriorDll); }
  catch (...) { valid = false; }
#endif
  if (!valid) { UnmapViewOfFile(s); CloseHandle(mapping); return ERROR_INVALID_DATA; }
  HMODULE pinned = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      reinterpret_cast<LPCWSTR>(&gAnchor), &pinned)) { UnmapViewOfFile(s); CloseHandle(mapping); return ERROR_INVALID_STATE; }
  gState = s; gMapping = mapping;
  gThread = OpenThread(THREAD_SUSPEND_RESUME | THREAD_GET_CONTEXT | THREAD_SET_CONTEXT |
      THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, s->identity.tid);
  gHandler = gThread ? AddVectoredExceptionHandler(1, &Observe) : nullptr;
  if (!gHandler) { s->error = GetLastError(); InterlockedExchange(&s->phase, Refused); return s->error; }
  InterlockedExchange(&s->phase, Installed);
  gWorker = CreateThread(nullptr, 0, &Worker, nullptr, 0, nullptr);
  if (!gWorker) { s->error = GetLastError(); InterlockedExchange(&s->phase, Refused); return s->error; }
  return ERROR_SUCCESS;
}
}
#ifdef QN_COMPLETION_FIXTURE
extern "C" __declspec(dllexport) DWORD QnCompletionFixtureInitialize(const wchar_t* name) { return Initialize(name); }
#endif
extern "C" __declspec(dllexport) LRESULT CALLBACK QnCompletionOnceHook(int code, WPARAM wp, LPARAM lp) {
  using namespace completion_once;
  if (code != HC_ACTION) return CallNextHookEx(nullptr, code, wp, lp);
  const auto* msg = reinterpret_cast<const CWPSTRUCT*>(lp);
  if (!msg || msg->message != RegisterWindowMessageW(kMessage)) return CallNextHookEx(nullptr, code, wp, lp);
  if (gState) {
    if (msg->wParam == 2 && static_cast<std::uint64_t>(msg->lParam) == gState->token &&
        GetCurrentThreadId() == gState->identity.tid &&
        reinterpret_cast<ULONG_PTR>(msg->hwnd) == gState->identity.hwnd &&
        gWorker && WaitForSingleObject(gWorker, 0) == WAIT_OBJECT_0) InterlockedIncrement(&gState->querySequence);
  } else if (msg->wParam == 1) {
    QnLiveIdentity id{}; id.pid = GetCurrentProcessId(); FILETIME exited{}, kernel{}, user{};
    if (GetProcessTimes(GetCurrentProcess(), &id.processCreated, &exited, &kernel, &user)) {
      wchar_t name[128]{}; Name(name, id); Initialize(name);
    }
  }
  return CallNextHookEx(nullptr, code, wp, lp);
}
