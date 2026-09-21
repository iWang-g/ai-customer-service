#include "install_transport_shared.h"
#include <bcrypt.h>
#include <cstdio>
#include <cstring>
#include <string>

namespace {
using namespace install_lab;
void Check(bool ok, const char* label) {
  if (!ok) {
    std::fprintf(stderr, "FAIL %s win32=%lu\n", label, GetLastError());
    ExitProcess(1);
  }
}
template<class T> T Resolve(HMODULE module, const char* name) {
  const FARPROC raw = GetProcAddress(module, name);
  T fn = nullptr;
  static_assert(sizeof(raw) == sizeof(fn));
  std::memcpy(&fn, &raw, sizeof(fn));
  Check(fn != nullptr, name);
  return fn;
}
bool WaitValue(volatile LONG* value, LONG expected, DWORD ms = 5000) {
  const ULONGLONG end = GetTickCount64() + ms;
  while (Read(value) != expected && GetTickCount64() < end) Sleep(1);
  return Read(value) == expected;
}
LRESULT CALLBACK WindowProc(HWND window, UINT msg, WPARAM wp, LPARAM lp) {
  if (msg == kQuery) {
    HMODULE module = GetModuleHandleW(kDll);
    if (!module) return ERROR_MOD_NOT_FOUND;
    const auto query = Resolve<DWORD (*)()>(module, "QnInstallFixtureQuery");
    return query();
  }
  if (msg == WM_CLOSE) { DestroyWindow(window); return 0; }
  if (msg == WM_DESTROY) { PostQuitMessage(0); return 0; }
  return DefWindowProcW(window, msg, wp, lp);
}
int Child() {
  Check(FixtureProcess(), "fixture-only executable");
  wchar_t name[96]{};
  MappingName(name, GetCurrentProcessId());
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  Check(mapping != nullptr, "child mapping");
  auto* s = static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
  Check(s != nullptr, "child view");
  WNDCLASSW wc{};
  wc.lpfnWndProc = WindowProc;
  wc.hInstance = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"QnDisposableInstallFixture";
  Check(RegisterClassW(&wc) != 0, "register fixture window");
  HWND window = CreateWindowExW(0, wc.lpszClassName, L"Fixture", 0, 0, 0, 0, 0,
      HWND_MESSAGE, nullptr, wc.hInstance, nullptr);
  Check(window != nullptr, "message-only window");
  s->childPid = GetCurrentProcessId(); s->childTid = GetCurrentThreadId();
  s->hwnd = reinterpret_cast<ULONG_PTR>(window);
  FILETIME exited{}, kernel{}, user{};
  Check(GetProcessTimes(GetCurrentProcess(), &s->processCreated, &exited, &kernel, &user) &&
      GetThreadTimes(GetCurrentThread(), &s->threadCreated, &exited, &kernel, &user), "child identity");
  InterlockedExchange(&s->ready, 1);
  MSG msg{};
  BOOL rc;
  while ((rc = GetMessageW(&msg, nullptr, 0, 0)) > 0) DispatchMessageW(&msg);
  Check(rc == 0, "message loop exit");
  UnmapViewOfFile(s); CloseHandle(mapping);
  return 0;
}
DWORD_PTR Send(HWND window, UINT message, DWORD timeout, bool expectedSuccess) {
  DWORD_PTR result = 0;
  SetLastError(ERROR_SUCCESS);
  const LRESULT ok = SendMessageTimeoutW(window, message, 0, 0,
      SMTO_ABORTIFHUNG | SMTO_BLOCK, timeout, &result);
  Check(expectedSuccess ? ok != 0 : ok == 0, "message transport outcome");
  if (!expectedSuccess) Check(GetLastError() == ERROR_TIMEOUT, "transport timeout code");
  return result;
}
enum Scenario { Normal, Version, Token, Pid, Tid, ProcessTime, ThreadTime, Window, Operation,
                Duplicate, TimeoutRelease, TimeoutExpires, Magic, Size, InvalidDelay };
constexpr const char* kNames[] = {"normal", "version", "token", "pid", "tid", "process_time",
    "thread_time", "hwnd", "operation", "duplicate", "timeout_release", "timeout_expires",
    "magic", "size", "invalid_delay"};
void Run(Scenario scenario, const wchar_t* executable, const std::wstring& dll) {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  Check(job != nullptr, "create cleanup job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "job policy");
  std::wstring command = L"\"" + std::wstring(executable) + L"\" --fixture-child";
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  Check(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child), "spawn own suspended child");
  if (!AssignProcessToJobObject(job, child.hProcess)) {
    TerminateProcess(child.hProcess, 2);
    WaitForSingleObject(child.hProcess, 5000);
    Check(false, "assign child job");
  }
  wchar_t name[96]{}; MappingName(name, child.dwProcessId);
  HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Shared), name);
  const DWORD mappingError = GetLastError();
  Check(mapping && mappingError != ERROR_ALREADY_EXISTS, "unique fixture mapping");
  auto* s = static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
  Check(s != nullptr, "parent view");
  *s = {};
  Check(BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&s->token), sizeof(s->token),
      BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0 && s->token, "random request token");
  Check(ResumeThread(child.hThread) == 1, "resume child");
  Check(WaitValue(&s->ready, 1), "child ready");
  Check(s->childPid == child.dwProcessId && s->childTid == child.dwThreadId, "owned child identity");
  FILETIME pc{}, tc{}, exited{}, kernel{}, user{};
  Check(GetProcessTimes(child.hProcess, &pc, &exited, &kernel, &user) &&
      GetThreadTimes(child.hThread, &tc, &exited, &kernel, &user) &&
      Same(pc, s->processCreated) && Same(tc, s->threadCreated), "retained handle identity");
  HWND window = reinterpret_cast<HWND>(s->hwnd);
  DWORD windowPid = 0;
  Check(GetWindowThreadProcessId(window, &windowPid) == child.dwThreadId &&
      windowPid == child.dwProcessId, "owned window identity");
  s->request = {kMagic, sizeof(Request), kVersion, 1, s->childPid, s->childTid,
      pc, tc, s->hwnd, s->token, 0};
  DWORD expected = ERROR_INVALID_DATA;
  switch (scenario) {
    case Version: ++s->request.version; expected = ERROR_REVISION_MISMATCH; break;
    case Token: s->request.token ^= 1; break;
    case Pid: ++s->request.pid; break;
    case Tid: ++s->request.tid; break;
    case ProcessTime: ++s->request.processCreated.dwLowDateTime; break;
    case ThreadTime: ++s->request.threadCreated.dwLowDateTime; break;
    case Window: ++s->request.hwnd; break;
    case Operation: ++s->request.operation; expected = ERROR_INVALID_FUNCTION; break;
    case Magic: ++s->request.magic; expected = ERROR_REVISION_MISMATCH; break;
    case Size: --s->request.size; expected = ERROR_REVISION_MISMATCH; break;
    case InvalidDelay: s->request.delay = 2; expected = ERROR_INVALID_FUNCTION; break;
    default: expected = ERROR_SUCCESS; break;
  }
  const bool delay = scenario == TimeoutRelease || scenario == TimeoutExpires;
  if (delay) s->request.delay = 1;
  HMODULE module = LoadLibraryW(dll.c_str());
  Check(module != nullptr, "local fixture dll");
  const auto hookProc = Resolve<HOOKPROC>(module, "QnInstallFixtureHook");
  HHOOK hook = SetWindowsHookExW(WH_CALLWNDPROC, hookProc, module, child.dwThreadId);
  Check(hook != nullptr, "thread-specific fixture hook");
  const UINT message = RegisterWindowMessageW(kMessage);
  Check(message != 0, "registered message");
  Send(window, message, 5000, true);
  Check(Read(&s->state) == Idle && Read(&s->installed) == 0 && Read(&s->pinCount) == 0,
      "unpublished request ignored");
  InterlockedExchange(&s->state, Pending);
  Send(window, message, delay ? 250 : 5000, !delay);
  if (delay) {
    Check(Read(&s->gate) == 1 && Read(&s->active) == 1 && Read(&s->installed) == 1,
        "timeout leaves pinned in-flight operation");
    Check(UnhookWindowsHookEx(hook) != 0 && FreeLibrary(module) != 0, "unhook and drop local module while active");
    hook = nullptr; module = nullptr;
    if (scenario == TimeoutRelease) InterlockedExchange(&s->release, 1);
    else expected = ERROR_TIMEOUT;
  }
  Check(WaitValue(&s->state, Complete), "completion receipt");
  Check(s->result == expected && s->receiptPid == child.dwProcessId &&
      s->receiptTid == child.dwThreadId && s->receiptToken == s->request.token, "identity and result receipt");
  const bool installed = expected == ERROR_SUCCESS || delay;
  Check(Read(&s->installed) == (installed ? 1 : 0) &&
      Read(&s->pinCount) == (installed ? 1 : 0), "pin only after admission");
  if (scenario == Duplicate) {
    InterlockedExchange(&s->state, Pending);
    Send(window, message, 5000, true);
    Check(Read(&s->state) == Complete && s->result == ERROR_ALREADY_INITIALIZED &&
        Read(&s->pinCount) == 1, "duplicate rejected without extra pin");
  }
  if (hook) Check(UnhookWindowsHookEx(hook) != 0, "unhook");
  if (module) Check(FreeLibrary(module) != 0, "local unload");
  if (installed) {
    // The child's GUI query executes after the hook stack has returned, without LoadLibrary.
    Check(Send(window, kQuery, 5000, true) == ERROR_SUCCESS && s->queryInstalled == 1 &&
        s->queryActive == 0 && s->queryPinCount == 1, "post-unhook retained module query");
  }
  Check(WaitForSingleObject(child.hProcess, 0) == WAIT_TIMEOUT, "child remains alive");
  Send(window, WM_CLOSE, 5000, true);
  Check(WaitForSingleObject(child.hProcess, 5000) == WAIT_OBJECT_0, "clean child exit");
  DWORD exitCode = 1;
  Check(GetExitCodeProcess(child.hProcess, &exitCode) && exitCode == 0, "child success");
  CloseHandle(child.hThread); CloseHandle(child.hProcess);
  UnmapViewOfFile(s); CloseHandle(mapping); CloseHandle(job);
  std::printf("PASS case=%s result=%lu installed=%d child_exit=0\n", kNames[scenario], expected, installed ? 1 : 0);
}

enum LossMode { BeforePublish, ActiveRelease, ActiveExpires, AfterComplete, AfterUnhook, JobOwnerDies };
constexpr const char* kLossNames[] = {"before_publish", "active_release", "active_expires",
    "after_complete", "after_unhook", "job_owner_dies"};
constexpr DWORD kKilledController = 0x514e4b01;
struct LossBootstrap {
  DWORD magic, size, mode, supervisorPid;
  FILETIME supervisorCreated;
  Request target;
  volatile LONG stage;
};
void LossName(wchar_t (&name)[96], DWORD pid) {
  swprintf_s(name, L"Local\\QnInstallLossFixture-%lu", pid);
}
HANDLE CleanupJob() {
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  Check(job != nullptr, "loss cleanup job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  Check(SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)),
      "loss job policy");
  return job;
}
PROCESS_INFORMATION SpawnOwned(const wchar_t* executable, const wchar_t* mode, HANDLE job) {
  std::wstring command = L"\"" + std::wstring(executable) + L"\" " + mode;
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  Check(CreateProcessW(executable, command.data(), nullptr, nullptr, FALSE,
      CREATE_SUSPENDED | CREATE_NO_WINDOW, nullptr, nullptr, &startup, &process), "loss spawn owned fixture");
  if (!AssignProcessToJobObject(job, process.hProcess)) {
    TerminateProcess(process.hProcess, 2);
    WaitForSingleObject(process.hProcess, 5000);
    Check(false, "loss assign owned fixture");
  }
  return process;
}
bool ExactFixtureImage(HANDLE process, const wchar_t* executable) {
  wchar_t path[32768]{};
  DWORD size = 32768;
  return QueryFullProcessImageNameW(process, 0, path, &size) && std::wcscmp(path, executable) == 0;
}
int LossController(const wchar_t* executable, const std::wstring& dll) {
  // No target CLI: only a supervisor-created bootstrap for this fresh fixture PID.
  wchar_t name[96]{}; LossName(name, GetCurrentProcessId());
  HANDLE bootstrapMap = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  Check(bootstrapMap != nullptr, "loss controller bootstrap");
  auto* boot = static_cast<LossBootstrap*>(MapViewOfFile(bootstrapMap, FILE_MAP_ALL_ACCESS,
      0, 0, sizeof(LossBootstrap)));
  Check(boot && boot->magic == kMagic && boot->size == sizeof(LossBootstrap) &&
      boot->mode <= JobOwnerDies, "loss bootstrap structure");
  const Request request = boot->target;
  HANDLE supervisor = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, boot->supervisorPid);
  FILETIME pc{}, tc{}, exited{}, kernel{}, user{};
  Check(supervisor && ExactFixtureImage(supervisor, executable) &&
      GetProcessTimes(supervisor, &pc, &exited, &kernel, &user) &&
      Same(pc, boot->supervisorCreated) && WaitForSingleObject(supervisor, 0) == WAIT_TIMEOUT,
      "loss trusted supervisor identity");
  const DWORD rights = PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE |
      (boot->mode == JobOwnerDies ? PROCESS_SET_QUOTA | PROCESS_TERMINATE : 0);
  HANDLE target = OpenProcess(rights, FALSE, request.pid);
  HANDLE thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, request.tid);
  HWND window = reinterpret_cast<HWND>(request.hwnd);
  DWORD windowPid = 0;
  Check(target && thread && ExactFixtureImage(target, executable) &&
      GetProcessTimes(target, &pc, &exited, &kernel, &user) && Same(pc, request.processCreated) &&
      GetThreadTimes(thread, &tc, &exited, &kernel, &user) && Same(tc, request.threadCreated) &&
      GetProcessIdOfThread(thread) == request.pid &&
      GetWindowThreadProcessId(window, &windowPid) == request.tid && windowPid == request.pid &&
      WaitForSingleObject(target, 0) == WAIT_TIMEOUT, "loss exact disposable target identity");
  if (boot->mode == JobOwnerDies) {
    // This controller alone owns the nested kill-on-close Job handle.
    HANDLE ownedJob = CleanupJob();
    Check(AssignProcessToJobObject(ownedJob, target) != 0, "nested job target assignment");
  }
  MappingName(name, request.pid);
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  auto* s = mapping ? static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS,
      0, 0, sizeof(Shared))) : nullptr;
  Check(s && Read(&s->ready) == 1 && Read(&s->state) == Idle && s->token == request.token &&
      s->hwnd == request.hwnd && s->childPid == request.pid && s->childTid == request.tid,
      "loss target mapping identity");
  HMODULE module = LoadLibraryW(dll.c_str());
  Check(module != nullptr, "loss local dll");
  HHOOK hook = SetWindowsHookExW(WH_CALLWNDPROC,
      Resolve<HOOKPROC>(module, "QnInstallFixtureHook"), module, request.tid);
  Check(hook != nullptr, "loss install transport hook");
  InterlockedExchange(&boot->stage, 1);
  if (boot->mode == BeforePublish) {
    Sleep(INFINITE);
    return 9;
  }
  s->request = request;
  InterlockedExchange(&s->state, Pending);
  InterlockedExchange(&boot->stage, 2);
  const UINT message = RegisterWindowMessageW(kMessage);
  Check(message != 0, "loss registered message");
  Send(window, message, 10000, true);
  Check(Read(&s->state) == Complete, "loss controller completion");
  if (boot->mode == AfterUnhook) {
    Check(UnhookWindowsHookEx(hook) && FreeLibrary(module), "loss pre-death explicit unhook");
    InterlockedExchange(&boot->stage, 4);
  } else {
    InterlockedExchange(&boot->stage, 3);
  }
  // Supervisor forcibly terminates this process, without executing cleanup code.
  Sleep(INFINITE);
  return 9;
}
void RunLoss(LossMode mode, const wchar_t* executable) {
  HANDLE job = CleanupJob();
  auto target = SpawnOwned(executable, L"--fixture-child", job);
  wchar_t name[96]{}; MappingName(name, target.dwProcessId);
  HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
      0, sizeof(Shared), name);
  const DWORD mappingError = GetLastError();
  Check(mapping && mappingError != ERROR_ALREADY_EXISTS, "loss fresh target mapping");
  auto* s = static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
  Check(s != nullptr, "loss target view");
  *s = {};
  Check(BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&s->token), sizeof(s->token),
      BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0 && s->token, "loss target token");
  Check(ResumeThread(target.hThread) == 1 && WaitValue(&s->ready, 1), "loss target ready");
  FILETIME pc{}, tc{}, exited{}, kernel{}, user{};
  Check(GetProcessTimes(target.hProcess, &pc, &exited, &kernel, &user) &&
      GetThreadTimes(target.hThread, &tc, &exited, &kernel, &user) &&
      Same(pc, s->processCreated) && Same(tc, s->threadCreated) &&
      s->childPid == target.dwProcessId && s->childTid == target.dwThreadId, "loss supervisor target identity");
  HWND window = reinterpret_cast<HWND>(s->hwnd);
  const bool activeDeath = mode == ActiveRelease || mode == ActiveExpires || mode == JobOwnerDies;
  const Request request{kMagic, sizeof(Request), kVersion, 1, target.dwProcessId, target.dwThreadId,
      pc, tc, s->hwnd, s->token, activeDeath ? 1UL : 0UL};
  auto controller = SpawnOwned(executable, L"--loss-controller", job);
  LossName(name, controller.dwProcessId);
  HANDLE bootstrapMap = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE,
      0, sizeof(LossBootstrap), name);
  const DWORD bootError = GetLastError();
  Check(bootstrapMap && bootError != ERROR_ALREADY_EXISTS, "loss fresh bootstrap");
  auto* boot = static_cast<LossBootstrap*>(MapViewOfFile(bootstrapMap, FILE_MAP_ALL_ACCESS,
      0, 0, sizeof(LossBootstrap)));
  Check(boot != nullptr, "loss bootstrap view");
  *boot = {};
  boot->magic = kMagic; boot->size = sizeof(LossBootstrap); boot->mode = mode;
  boot->supervisorPid = GetCurrentProcessId(); boot->target = request;
  Check(GetProcessTimes(GetCurrentProcess(), &boot->supervisorCreated, &exited, &kernel, &user),
      "loss supervisor creation time");
  Check(ResumeThread(controller.hThread) == 1, "loss resume controller");
  const LONG expectedStage = mode == BeforePublish ? 1 : (mode == AfterUnhook ? 4 : (activeDeath ? 2 : 3));
  Check(WaitValue(&boot->stage, expectedStage), "loss deterministic controller stage");
  if (activeDeath) {
    Check(WaitValue(&s->gate, 1) && Read(&s->active) == 1 && Read(&s->state) == Processing &&
        Read(&s->installed) == 1, "loss kill occurs inside pinned hook");
  }
  Check(TerminateProcess(controller.hProcess, kKilledController) &&
      WaitForSingleObject(controller.hProcess, 5000) == WAIT_OBJECT_0, "loss force controller death");
  DWORD controllerExit = 0;
  Check(GetExitCodeProcess(controller.hProcess, &controllerExit) && controllerExit == kKilledController,
      "loss controller did not exit normally");
  DWORD targetExit = STILL_ACTIVE;
  if (mode == JobOwnerDies) {
    Check(WaitForSingleObject(target.hProcess, 5000) == WAIT_OBJECT_0 &&
        GetExitCodeProcess(target.hProcess, &targetExit) && targetExit != STILL_ACTIVE,
        "nested job owner death terminates fixture target");
  } else {
    Check(WaitForSingleObject(target.hProcess, 0) == WAIT_TIMEOUT, "target survives controller death");
    // Drop the supervisor's old view too, then reconnect without any reinstall.
    Check(UnmapViewOfFile(s) && CloseHandle(mapping), "loss drop old supervisor mapping");
    MappingName(name, target.dwProcessId);
    mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
    Check(mapping != nullptr, "loss reopen retained mapping");
    s = static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)));
    Check(s && s->token == request.token && s->childPid == request.pid && s->childTid == request.tid &&
        Same(s->processCreated, request.processCreated) && Same(s->threadCreated, request.threadCreated),
        "loss reconnected identity");
    if (mode == BeforePublish) {
      const DWORD_PTR query = Send(window, kQuery, 5000, true);
      Check((query == ERROR_MOD_NOT_FOUND || query == ERROR_INVALID_STATE) &&
          Read(&s->state) == Idle && Read(&s->installed) == 0 && Read(&s->pinCount) == 0,
          "death before publish leaves no installed state");
    } else {
      if (mode == ActiveRelease) InterlockedExchange(&s->release, 1);
      Check(WaitValue(&s->state, Complete), "loss retained operation completes");
      const DWORD expected = mode == ActiveExpires ? ERROR_TIMEOUT : ERROR_SUCCESS;
      Check(s->result == expected && s->receiptPid == request.pid && s->receiptTid == request.tid &&
          s->receiptToken == request.token, "loss reconnected result receipt");
      s->queryInstalled = s->queryActive = s->queryPinCount = MAXDWORD;
      Check(Send(window, kQuery, 5000, true) == ERROR_SUCCESS && s->queryInstalled == 1 &&
          s->queryActive == 0 && s->queryPinCount == 1, "loss live GUI query without reinstall");
    }
    Send(window, WM_CLOSE, 5000, true);
    Check(WaitForSingleObject(target.hProcess, 5000) == WAIT_OBJECT_0 &&
        GetExitCodeProcess(target.hProcess, &targetExit) && targetExit == 0,
        "loss survivor exits normally");
  }
  const LONG finalState = Read(&s->state);
  const LONG installed = Read(&s->installed);
  const DWORD result = s->result;
  UnmapViewOfFile(boot); CloseHandle(bootstrapMap);
  UnmapViewOfFile(s); CloseHandle(mapping);
  CloseHandle(controller.hThread); CloseHandle(controller.hProcess);
  CloseHandle(target.hThread); CloseHandle(target.hProcess);
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
  const ULONGLONG deadline = GetTickCount64() + 5000;
  do {
    Check(QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting,
        sizeof(accounting), nullptr), "loss outer job accounting");
    if (!accounting.ActiveProcesses) break;
    Sleep(1);
  } while (GetTickCount64() < deadline);
  Check(accounting.ActiveProcesses == 0, "loss no fixture processes left in job");
  CloseHandle(job);
  char resultText[32]{};
  if (finalState == Complete) std::snprintf(resultText, sizeof(resultText), "%lu", result);
  else std::snprintf(resultText, sizeof(resultText), "unpublished");
  std::printf("PASS loss=%s controller_exit=0x%lx target_exit=0x%lx survived=%d state=%ld "
      "installed=%ld receipt_complete=%d result=%s job_active=0\n", kLossNames[mode], controllerExit, targetExit,
      mode != JobOwnerDies ? 1 : 0, finalState, installed, finalState == Complete ? 1 : 0, resultText);
}
}
int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wcscmp(argv[1], L"--fixture-child") == 0) return Child();
  if (argc != 2 || (std::wcscmp(argv[1], L"--self-test") != 0 &&
      std::wcscmp(argv[1], L"--controller-loss") != 0 && std::wcscmp(argv[1], L"--loss-controller") != 0)) {
    std::fprintf(stderr, "Usage: qn_install_transport_lab.exe --self-test | --controller-loss\n");
    return 2;
  }
  wchar_t executable[32768]{};
  const DWORD size = GetModuleFileNameW(nullptr, executable, 32768);
  Check(size && size < 32768 && FixtureProcess(), "fixture path");
  std::wstring dll(executable);
  dll.resize(dll.find_last_of(L"\\") + 1); dll += kDll;
  if (std::wcscmp(argv[1], L"--loss-controller") == 0) return LossController(executable, dll);
  if (std::wcscmp(argv[1], L"--controller-loss") == 0) {
    for (int i = BeforePublish; i <= JobOwnerDies; ++i) RunLoss(static_cast<LossMode>(i), executable);
    std::puts("PASS controller_loss cases=6 client_access=0 sdk_calls=0 breakpoint=0 send=0");
    return 0;
  }
  for (int i = Normal; i <= InvalidDelay; ++i) Run(static_cast<Scenario>(i), executable, dll);
  std::puts("PASS fixture_only cases=15 client_access=0 sdk_calls=0 breakpoint=0 send=0");
  return 0;
}
