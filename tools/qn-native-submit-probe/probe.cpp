#include "probe_shared.h"

#include <bcrypt.h>
#include <tlhelp32.h>

#include <cstdio>
#include <cstring>
#include <cwchar>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>

namespace {

struct CandidateWindow {
  HWND window;
  DWORD processId;
  DWORD threadId;
};

constexpr wchar_t kExpectedAppBizSha256[] =
    L"565AB778C7A5829B080E17551308254C0B9D7F1F4A2859782ADAC500C055E41C";
constexpr wchar_t kExpectedAimSha256[] =
    L"65CF5CC2F3C3F7ACBF182595D97C83CC52FF1CD56561BABE3DD7AFC6C6921AE5";
constexpr wchar_t kExpectedPrgBaseSha256[] =
    L"4D50ACBCCEE823D5FE01B1CE7082ED1FC97070930110727CCDBFDA628247F0FC";

using CallbackInvokeFn = void (*)(void*, const void*, const void*);
using BindStateDestroyFn = void (*)(const void*);
using BindStateCancelledFn = bool (*)(const void*);
using BindStateConstructorFn = void* (*)(
    void*, CallbackInvokeFn, BindStateDestroyFn, BindStateCancelledFn);
using CallbackFromBindStateFn = void* (*)(void*, void*);
using CallbackCopyConstructorFn = void* (*)(void*, const void*);
using CallbackDestructorFn = void (*)(void*);
using CallbackPolymorphicInvokeFn = CallbackInvokeFn (*)(const void*);
using CallbackLifecycleStartFn = DWORD (*)(
    const wchar_t*, HANDLE, CallbackLifecycleResult*);
using CallbackLifecycleReleaseFn = DWORD (*)();

volatile LONG gCallbackDryRunInvokeCount = 0;
volatile LONG gCallbackDryRunDestroyCount = 0;
volatile LONG gCallbackDryRunCancelledCount = 0;
volatile LONG gCallbackDryRunDestroyRefCount = -1;
const void* gCallbackDryRunLastBindState = nullptr;
const void* gCallbackDryRunLastResult = nullptr;
const void* gCallbackDryRunLastMessage = nullptr;

void CallbackDryRunInvoke(
    void* bindState, const void* result, const void* message) {
  gCallbackDryRunLastBindState = bindState;
  gCallbackDryRunLastResult = result;
  gCallbackDryRunLastMessage = message;
  InterlockedIncrement(&gCallbackDryRunInvokeCount);
}

void CallbackDryRunDestroy(const void* bindState) {
  if (bindState != nullptr) {
    gCallbackDryRunDestroyRefCount =
        *static_cast<const volatile LONG*>(bindState);
  }
  InterlockedIncrement(&gCallbackDryRunDestroyCount);
  if (bindState != nullptr) {
    HeapFree(GetProcessHeap(), 0, const_cast<void*>(bindState));
  }
}

bool CallbackDryRunIsCancelled(const void* bindState) {
  gCallbackDryRunLastBindState = bindState;
  InterlockedIncrement(&gCallbackDryRunCancelledCount);
  return false;
}

BOOL CALLBACK FindQianniuWindow(HWND window, LPARAM parameter) {
  if (!IsWindowVisible(window)) {
    return TRUE;
  }
  wchar_t className[128] = {};
  wchar_t title[256] = {};
  GetClassNameW(window, className, _countof(className));
  GetWindowTextW(window, title, _countof(title));
  if (wcscmp(className, L"Qt5152QWindowIcon") != 0 ||
      wcscmp(title, L"千牛接待台") != 0) {
    return TRUE;
  }

  DWORD processId = 0;
  const DWORD threadId = GetWindowThreadProcessId(window, &processId);
  auto* candidates = reinterpret_cast<std::vector<CandidateWindow>*>(parameter);
  candidates->push_back({window, processId, threadId});
  return TRUE;
}

bool IsAliWorkbenchProcess(DWORD processId, std::wstring* imagePath) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, processId);
  if (process == nullptr) {
    return false;
  }
  wchar_t path[32768] = {};
  DWORD pathLength = _countof(path);
  const bool queried = QueryFullProcessImageNameW(process, 0, path, &pathLength);
  CloseHandle(process);
  if (!queried) {
    return false;
  }
  *imagePath = path;
  const wchar_t* baseName = wcsrchr(path, L'\\');
  baseName = baseName == nullptr ? path : baseName + 1;
  return _wcsicmp(baseName, L"AliWorkbench.exe") == 0;
}

bool FindModulePath(
    DWORD processId,
    const wchar_t* moduleName,
    std::wstring* modulePath,
    bool* enumerationOk = nullptr) {
  if (enumerationOk != nullptr) *enumerationOk = false;
  HANDLE snapshot = CreateToolhelp32Snapshot(
      TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, processId);
  if (snapshot == INVALID_HANDLE_VALUE) {
    return false;
  }
  MODULEENTRY32W entry = {};
  entry.dwSize = sizeof(entry);
  bool found = false;
  if (Module32FirstW(snapshot, &entry)) {
    do {
      if (_wcsicmp(entry.szModule, moduleName) == 0) {
        *modulePath = entry.szExePath;
        found = true;
        break;
      }
    } while (Module32NextW(snapshot, &entry));
  }
  const DWORD enumerationError = GetLastError();
  if (enumerationOk != nullptr) {
    *enumerationOk = found || enumerationError == ERROR_NO_MORE_FILES;
  }
  CloseHandle(snapshot);
  return found;
}

bool Sha256File(const std::wstring& path, std::wstring* digest) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  HANDLE file = INVALID_HANDLE_VALUE;
  std::vector<unsigned char> hashObject;
  std::vector<unsigned char> hashBytes;
  bool ok = false;

  do {
    if (BCryptOpenAlgorithmProvider(
            &algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) {
      break;
    }
    DWORD objectLength = 0;
    DWORD hashLength = 0;
    DWORD bytesWritten = 0;
    if (BCryptGetProperty(
            algorithm,
            BCRYPT_OBJECT_LENGTH,
            reinterpret_cast<PUCHAR>(&objectLength),
            sizeof(objectLength),
            &bytesWritten,
            0) < 0 ||
        BCryptGetProperty(
            algorithm,
            BCRYPT_HASH_LENGTH,
            reinterpret_cast<PUCHAR>(&hashLength),
            sizeof(hashLength),
            &bytesWritten,
            0) < 0) {
      break;
    }
    hashObject.resize(objectLength);
    hashBytes.resize(hashLength);
    if (BCryptCreateHash(
            algorithm,
            &hash,
            hashObject.data(),
            static_cast<ULONG>(hashObject.size()),
            nullptr,
            0,
            0) < 0) {
      break;
    }

    file = CreateFileW(
        path.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr);
    if (file == INVALID_HANDLE_VALUE) {
      break;
    }
    std::vector<unsigned char> buffer(1024 * 1024);
    DWORD bytesRead = 0;
    while (ReadFile(
        file,
        buffer.data(),
        static_cast<DWORD>(buffer.size()),
        &bytesRead,
        nullptr)) {
      if (bytesRead == 0) {
        ok = true;
        break;
      }
      if (BCryptHashData(hash, buffer.data(), bytesRead, 0) < 0) {
        ok = false;
        break;
      }
    }
    if (!ok || BCryptFinishHash(
            hash,
            hashBytes.data(),
            static_cast<ULONG>(hashBytes.size()),
            0) < 0) {
      ok = false;
      break;
    }
    std::wostringstream output;
    output << std::uppercase << std::hex << std::setfill(L'0');
    for (unsigned char value : hashBytes) {
      output << std::setw(2) << static_cast<unsigned int>(value);
    }
    *digest = output.str();
  } while (false);

  if (file != INVALID_HANDLE_VALUE) CloseHandle(file);
  if (hash != nullptr) BCryptDestroyHash(hash);
  if (algorithm != nullptr) BCryptCloseAlgorithmProvider(algorithm, 0);
  return ok;
}

std::wstring SiblingPath(const wchar_t* filename) {
  wchar_t executable[32768] = {};
  GetModuleFileNameW(nullptr, executable, _countof(executable));
  wchar_t* separator = wcsrchr(executable, L'\\');
  if (separator != nullptr) {
    separator[1] = L'\0';
  }
  return std::wstring(executable) + filename;
}

int CheckAppBiz(const wchar_t* path) {
  std::wstring digest;
  if (!Sha256File(path, &digest)) {
    fwprintf(stderr, L"ERROR could not hash %ls\n", path);
    return 2;
  }
  wprintf(L"path=%ls\nsha256=%ls\n", path, digest.c_str());
  if (_wcsicmp(digest.c_str(), kExpectedAppBizSha256) != 0) {
    fwprintf(stderr, L"result=unsupported_appbiz\n");
    return 3;
  }
  wprintf(L"result=analyzed_appbiz\n");
  return 0;
}

template <typename FunctionPointer>
FunctionPointer ResolveExport(HMODULE module, const char* name) {
  static_assert(sizeof(FunctionPointer) == sizeof(FARPROC));
  const FARPROC raw = module == nullptr ? nullptr : GetProcAddress(module, name);
  FunctionPointer function = nullptr;
  memcpy(&function, &raw, sizeof(function));
  return function;
}

int RunCallbackAbiDryRun(const wchar_t* path) {
  std::wstring digest;
  if (!Sha256File(path, &digest)) {
    fwprintf(stderr, L"ERROR could not hash %ls\n", path);
    return 2;
  }
  wprintf(L"path=%ls\nsha256=%ls\n", path, digest.c_str());
  if (_wcsicmp(digest.c_str(), kExpectedPrgBaseSha256) != 0) {
    fwprintf(stderr, L"result=unsupported_prgbase\n");
    return 3;
  }

  HMODULE prgBase = LoadLibraryExW(path, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (prgBase == nullptr) {
    fwprintf(stderr, L"ERROR LoadLibraryEx failed (%lu)\n", GetLastError());
    return 4;
  }

  constexpr char kBindStateConstructor[] =
      "??0BindStateBase@internal@base@@AEAA@P6AXXZP6AXPEBV012@@ZP6A_N1@Z@Z";
  constexpr char kCallbackFromBindState[] =
      "??0CallbackBaseCopyable@internal@base@@IEAA@PEAVBindStateBase@12@@Z";
  constexpr char kCallbackCopyConstructor[] =
      "??0CallbackBaseCopyable@internal@base@@QEAA@AEBV012@@Z";
  constexpr char kCallbackDestructor[] =
      "??1CallbackBaseCopyable@internal@base@@IEAA@XZ";
  constexpr char kCallbackPolymorphicInvoke[] =
      "?polymorphic_invoke@CallbackBase@internal@base@@IEBAP6AXXZXZ";

  const auto bindStateConstructor = ResolveExport<BindStateConstructorFn>(
      prgBase, kBindStateConstructor);
  const auto callbackFromBindState = ResolveExport<CallbackFromBindStateFn>(
      prgBase, kCallbackFromBindState);
  const auto callbackCopyConstructor =
      ResolveExport<CallbackCopyConstructorFn>(
          prgBase, kCallbackCopyConstructor);
  const auto callbackDestructor = ResolveExport<CallbackDestructorFn>(
      prgBase, kCallbackDestructor);
  const auto callbackPolymorphicInvoke =
      ResolveExport<CallbackPolymorphicInvokeFn>(
          prgBase, kCallbackPolymorphicInvoke);
  if (bindStateConstructor == nullptr || callbackFromBindState == nullptr ||
      callbackCopyConstructor == nullptr || callbackDestructor == nullptr ||
      callbackPolymorphicInvoke == nullptr) {
    fwprintf(stderr, L"ERROR required PRGBASE callback export is missing\n");
    FreeLibrary(prgBase);
    return 5;
  }

  gCallbackDryRunInvokeCount = 0;
  gCallbackDryRunDestroyCount = 0;
  gCallbackDryRunCancelledCount = 0;
  gCallbackDryRunDestroyRefCount = -1;
  gCallbackDryRunLastBindState = nullptr;
  gCallbackDryRunLastResult = nullptr;
  gCallbackDryRunLastMessage = nullptr;

  void* bindState = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 0x20);
  if (bindState == nullptr) {
    fwprintf(stderr, L"ERROR HeapAlloc failed\n");
    FreeLibrary(prgBase);
    return 6;
  }

  bindStateConstructor(
      bindState,
      &CallbackDryRunInvoke,
      &CallbackDryRunDestroy,
      &CallbackDryRunIsCancelled);

  LONG initialRefCount = -1;
  CallbackInvokeFn storedInvoke = nullptr;
  BindStateDestroyFn storedDestroy = nullptr;
  BindStateCancelledFn storedCancelled = nullptr;
  memcpy(&initialRefCount, bindState, sizeof(initialRefCount));
  memcpy(&storedInvoke, static_cast<unsigned char*>(bindState) + 8,
         sizeof(storedInvoke));
  memcpy(&storedDestroy, static_cast<unsigned char*>(bindState) + 16,
         sizeof(storedDestroy));
  memcpy(&storedCancelled, static_cast<unsigned char*>(bindState) + 24,
         sizeof(storedCancelled));
  if (initialRefCount != 1 || storedInvoke != &CallbackDryRunInvoke ||
      storedDestroy != &CallbackDryRunDestroy ||
      storedCancelled != &CallbackDryRunIsCancelled) {
    fwprintf(stderr, L"ERROR BindStateBase layout validation failed\n");
    CallbackDryRunDestroy(bindState);
    FreeLibrary(prgBase);
    return 7;
  }

  alignas(void*) unsigned char callback[sizeof(void*)] = {};
  alignas(void*) unsigned char callbackCopy[sizeof(void*)] = {};
  callbackFromBindState(callback, bindState);
  const void* callbackBindState = nullptr;
  memcpy(&callbackBindState, callback, sizeof(callbackBindState));
  const LONG refCountAfterAdopt =
      *static_cast<const volatile LONG*>(bindState);
  callbackCopyConstructor(callbackCopy, callback);
  const void* copiedBindState = nullptr;
  memcpy(&copiedBindState, callbackCopy, sizeof(copiedBindState));
  const LONG refCountAfterCopy =
      *static_cast<const volatile LONG*>(bindState);

  const bool cancelled = storedCancelled(bindState);
  CallbackInvokeFn invoke = callbackPolymorphicInvoke(callbackCopy);
  alignas(16) unsigned char syntheticResult[32] = {};
  alignas(16) unsigned char syntheticMessage[64] = {};
  if (invoke != nullptr) {
    invoke(bindState, syntheticResult, syntheticMessage);
  }

  const bool beforeDestroyValid = callbackBindState == bindState &&
      copiedBindState == bindState && refCountAfterAdopt == 1 &&
      refCountAfterCopy == 2 && !cancelled &&
      invoke == &CallbackDryRunInvoke && gCallbackDryRunCancelledCount == 1 &&
      gCallbackDryRunInvokeCount == 1 &&
      gCallbackDryRunLastBindState == bindState &&
      gCallbackDryRunLastResult == syntheticResult &&
      gCallbackDryRunLastMessage == syntheticMessage;

  callbackDestructor(callback);
  const LONG refCountAfterFirstDestroy =
      *static_cast<const volatile LONG*>(bindState);
  callbackDestructor(callbackCopy);
  const bool lifecycleValid = beforeDestroyValid &&
      refCountAfterFirstDestroy == 1 && gCallbackDryRunDestroyCount == 1 &&
      gCallbackDryRunDestroyRefCount == 0;

  printf(
      "callback_abi_dry_run bindStateSize=32 callbackSize=%zu "
      "initialRefCount=%ld afterAdopt=%ld afterCopy=%ld "
      "afterFirstDestroy=%ld\n",
      sizeof(callback),
      static_cast<long>(initialRefCount),
      static_cast<long>(refCountAfterAdopt),
      static_cast<long>(refCountAfterCopy),
      static_cast<long>(refCountAfterFirstDestroy));
  printf(
      "  cancelled=%d cancelCalls=%ld invokeCalls=%ld destroyCalls=%ld "
      "destroyRefCount=%ld\n",
      cancelled ? 1 : 0,
      static_cast<long>(gCallbackDryRunCancelledCount),
      static_cast<long>(gCallbackDryRunInvokeCount),
      static_cast<long>(gCallbackDryRunDestroyCount),
      static_cast<long>(gCallbackDryRunDestroyRefCount));
  printf(
      "result=%s no_qianniu_process_opened=1 no_hook_installed=1 "
      "no_send_address_resolved=1 no_send_invoked=1\n",
      lifecycleValid ? "callback_abi_dry_run_ok"
                     : "callback_abi_dry_run_validation_failed");

  FreeLibrary(prgBase);
  return lifecycleValid ? 0 : 8;
}

int RunCallbackModuleLifecycleDryRun(
    const wchar_t* prgBasePath, bool testEarlyRelease = false,
    bool testUnhookTimeout = false) {
  std::wstring digest;
  if (!Sha256File(prgBasePath, &digest)) {
    fwprintf(stderr, L"ERROR could not hash %ls\n", prgBasePath);
    return 2;
  }
  if (_wcsicmp(digest.c_str(), kExpectedPrgBaseSha256) != 0) {
    fwprintf(stderr, L"result=unsupported_prgbase\n");
    return 3;
  }

  const std::wstring hookPath = SiblingPath(L"qn_native_probe_hook.dll");
  HMODULE hook = LoadLibraryW(hookPath.c_str());
  if (hook == nullptr) {
    fwprintf(stderr, L"ERROR LoadLibrary failed for %ls (%lu)\n",
             hookPath.c_str(), GetLastError());
    return 4;
  }
  const auto start = ResolveExport<CallbackLifecycleStartFn>(
      hook, "QnCallbackLifecycleDryRun");
  if (start == nullptr) {
    fwprintf(stderr, L"ERROR callback lifecycle start export is missing\n");
    FreeLibrary(hook);
    return 5;
  }
  HANDLE doneEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (doneEvent == nullptr) {
    fwprintf(stderr, L"ERROR CreateEvent failed (%lu)\n", GetLastError());
    FreeLibrary(hook);
    return 6;
  }

  // Keep storage alive even if a timed-out worker outlives this call.
  static CallbackLifecycleResult result = {};
  ZeroMemory(&result, sizeof(result));
  result.version = kCallbackLifecycleResultVersion;
  result.destroyRefCount = -1;
  result.holdWorkerExit = testEarlyRelease ? 1 : 0;
  const DWORD startResult = start(prgBasePath, doneEvent, &result);
  FreeLibrary(hook);
  hook = nullptr;
  if (!testUnhookTimeout) {
    InterlockedExchange(&result.initialHookReleased, 1);
  }
  if (startResult != 0) {
    fwprintf(stderr, L"ERROR callback lifecycle start failed (%lu)\n",
             startResult);
    CloseHandle(doneEvent);
    return 7;
  }

  const bool retainedAfterCallerRelease =
      GetModuleHandleW(L"qn_native_probe_hook.dll") != nullptr;
  const DWORD waitResult = WaitForSingleObject(doneEvent, 8000);
  const bool callbackCompleted = waitResult == WAIT_OBJECT_0 &&
      result.workerStarted == 1 && result.workerCompleted == 1 &&
      result.workerObservedInitialHookReleased == (testUnhookTimeout ? 0 : 1) &&
      result.invokeCount == (testUnhookTimeout ? 0 : 1) && result.destroyCount == 1 &&
      result.cancelledCount == (testUnhookTimeout ? 0 : 1) && result.destroyRefCount == 0 &&
      result.initialRefCount == 1 && result.refCountAfterAdopt == 1 &&
      result.refCountAfterCopy == 2 &&
      result.refCountAfterCallerRelease == 1 &&
      result.errorCode == (testUnhookTimeout ? 12u : 0u);

  DWORD releaseResult = ERROR_TIMEOUT;
  DWORD earlyReleaseResult = ERROR_SUCCESS;
  bool retainedAfterEarlyRelease = false;
  bool unloadedAfterRelease = false;
  if (waitResult == WAIT_OBJECT_0) {
    hook = LoadLibraryW(hookPath.c_str());
    const auto release = ResolveExport<CallbackLifecycleReleaseFn>(
        hook, "QnCallbackLifecycleRelease");
    if (hook != nullptr && release != nullptr) {
      if (testEarlyRelease) {
        earlyReleaseResult = release();
        retainedAfterEarlyRelease = result.workerExitConfirmed == 0 &&
            GetModuleHandleW(L"qn_native_probe_hook.dll") != nullptr;
        InterlockedExchange(&result.allowWorkerExit, 1);
      }
      const ULONGLONG deadline = GetTickCount64() + 5000;
      do {
        releaseResult = release();
        if (releaseResult != ERROR_BUSY) break;
        Sleep(10);
      } while (GetTickCount64() < deadline);
    } else {
      releaseResult = ERROR_PROC_NOT_FOUND;
    }
    if (hook != nullptr) {
      FreeLibrary(hook);
      hook = nullptr;
    }
    Sleep(20);
    unloadedAfterRelease =
        GetModuleHandleW(L"qn_native_probe_hook.dll") == nullptr;
  }
  if (releaseResult == 0) CloseHandle(doneEvent);

  const bool valid = retainedAfterCallerRelease && callbackCompleted &&
      releaseResult == 0 && unloadedAfterRelease && result.workerExitConfirmed == 1 &&
      (!testEarlyRelease ||
       (earlyReleaseResult == ERROR_BUSY && retainedAfterEarlyRelease));
  printf(
      "release_guard earlyTest=%d earlyRelease=%lu retained=%d "
      "workerExitConfirmed=%ld timeoutTest=%d\n",
      testEarlyRelease ? 1 : 0, earlyReleaseResult,
      retainedAfterEarlyRelease ? 1 : 0,
      static_cast<long>(result.workerExitConfirmed), testUnhookTimeout ? 1 : 0);
  printf(
      "callback_module_lifecycle_dry_run retainedAfterCallerRelease=%d "
      "wait=%lu workerThread=%lu workerStarted=%ld workerCompleted=%ld "
      "workerObservedInitialHookReleased=%ld\n",
      retainedAfterCallerRelease ? 1 : 0,
      waitResult,
      result.workerThreadId,
      static_cast<long>(result.workerStarted),
      static_cast<long>(result.workerCompleted),
      static_cast<long>(result.workerObservedInitialHookReleased));
  printf(
      "  invokeCalls=%ld cancelCalls=%ld destroyCalls=%ld "
      "destroyRefCount=%ld refs=%ld->%ld->%ld->%ld "
      "callbackError=%lu release=%lu unloaded=%d\n",
      static_cast<long>(result.invokeCount),
      static_cast<long>(result.cancelledCount),
      static_cast<long>(result.destroyCount),
      static_cast<long>(result.destroyRefCount),
      static_cast<long>(result.initialRefCount),
      static_cast<long>(result.refCountAfterAdopt),
      static_cast<long>(result.refCountAfterCopy),
      static_cast<long>(result.refCountAfterCallerRelease),
      result.errorCode,
      releaseResult,
      unloadedAfterRelease ? 1 : 0);
  printf(
      "result=%s no_qianniu_process_opened=1 no_hook_installed=1 "
      "no_send_address_resolved=1 no_send_invoked=1\n",
      valid ? "callback_module_lifecycle_dry_run_ok"
            : "callback_module_lifecycle_dry_run_validation_failed");
  return valid ? 0 : 8;
}

int WatchWindowState(DWORD durationMs) {
  std::vector<CandidateWindow> candidates;
  EnumWindows(FindQianniuWindow, reinterpret_cast<LPARAM>(&candidates));
  if (candidates.size() != 1) {
    fwprintf(
        stderr,
        L"ERROR expected exactly one visible Qt5152QWindowIcon / Qianniu window; found %zu\n",
        candidates.size());
    return 2;
  }

  const CandidateWindow target = candidates.front();
  std::wstring imagePath;
  if (!IsAliWorkbenchProcess(target.processId, &imagePath)) {
    fwprintf(stderr, L"ERROR target window is not owned by AliWorkbench.exe\n");
    return 3;
  }

  const ULONGLONG started = GetTickCount64();
  bool lastVisible = IsWindowVisible(target.window) != FALSE;
  bool lastMinimized = IsIconic(target.window) != FALSE;
  bool lastForeground = GetForegroundWindow() == target.window;
  bool everNotMinimized = !lastMinimized;
  bool everForeground = lastForeground;
  wprintf(
      L"watch_target pid=%lu hwnd=0x%llx image=%ls durationMs=%lu\n",
      target.processId,
      reinterpret_cast<unsigned long long>(target.window),
      imagePath.c_str(),
      durationMs);
  wprintf(
      L"state elapsedMs=0 visible=%d minimized=%d foreground=%d foregroundHwnd=0x%llx\n",
      lastVisible ? 1 : 0,
      lastMinimized ? 1 : 0,
      lastForeground ? 1 : 0,
      reinterpret_cast<unsigned long long>(GetForegroundWindow()));

  while (GetTickCount64() - started < durationMs) {
    Sleep(20);
    const bool visible = IsWindowVisible(target.window) != FALSE;
    const bool minimized = IsIconic(target.window) != FALSE;
    const HWND foregroundWindow = GetForegroundWindow();
    const bool foreground = foregroundWindow == target.window;
    everNotMinimized = everNotMinimized || !minimized;
    everForeground = everForeground || foreground;
    if (visible != lastVisible || minimized != lastMinimized ||
        foreground != lastForeground) {
      wprintf(
          L"state elapsedMs=%llu visible=%d minimized=%d foreground=%d foregroundHwnd=0x%llx\n",
          GetTickCount64() - started,
          visible ? 1 : 0,
          minimized ? 1 : 0,
          foreground ? 1 : 0,
          reinterpret_cast<unsigned long long>(foregroundWindow));
      lastVisible = visible;
      lastMinimized = minimized;
      lastForeground = foreground;
    }
  }

  wprintf(
      L"result=watch_complete everNotMinimized=%d everForeground=%d\n",
      everNotMinimized ? 1 : 0,
      everForeground ? 1 : 0);
  return 0;
}

int RunCbtProbe(bool suppress, DWORD durationMs) {
  std::vector<CandidateWindow> candidates;
  EnumWindows(FindQianniuWindow, reinterpret_cast<LPARAM>(&candidates));
  if (candidates.size() != 1) {
    fwprintf(
        stderr,
        L"ERROR expected exactly one visible Qt5152QWindowIcon / Qianniu window; found %zu\n",
        candidates.size());
    return 2;
  }

  const CandidateWindow target = candidates.front();
  std::wstring imagePath;
  if (!IsAliWorkbenchProcess(target.processId, &imagePath)) {
    fwprintf(stderr, L"ERROR target window is not owned by AliWorkbench.exe\n");
    return 3;
  }
  if (!IsIconic(target.window)) {
    fwprintf(stderr, L"ERROR CBT probe requires Qianniu to already be minimized\n");
    return 4;
  }

  std::wstring appBizPath;
  std::wstring appBizSha256;
  if (!FindModulePath(target.processId, L"AppBiz.dll", &appBizPath) ||
      !Sha256File(appBizPath, &appBizSha256) ||
      _wcsicmp(appBizSha256.c_str(), kExpectedAppBizSha256) != 0) {
    fwprintf(stderr, L"ERROR target AppBiz.dll is not the analyzed build\n");
    return 5;
  }

  wchar_t mappingName[128] = {};
  MakeProbeObjectName(
      mappingName, _countof(mappingName), kProbeMappingPrefix, target.processId);
  HANDLE mapping = CreateFileMappingW(
      INVALID_HANDLE_VALUE,
      nullptr,
      PAGE_READWRITE,
      0,
      sizeof(ProbeShared),
      mappingName);
  const DWORD mappingError = GetLastError();
  if (mapping == nullptr || mappingError == ERROR_ALREADY_EXISTS) {
    fwprintf(stderr, L"ERROR could not create exclusive CBT mapping (%lu)\n", mappingError);
    if (mapping != nullptr) CloseHandle(mapping);
    return 6;
  }
  auto* shared = static_cast<ProbeShared*>(MapViewOfFile(
      mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ProbeShared)));
  if (shared == nullptr) {
    fwprintf(stderr, L"ERROR could not map CBT shared state (%lu)\n", GetLastError());
    CloseHandle(mapping);
    return 7;
  }
  ZeroMemory(shared, sizeof(*shared));
  shared->magic = kProbeMagic;
  shared->version = kProbeVersion;
  shared->state = kProbePending;
  shared->operation = suppress
      ? kProbeOperationSuppressCbt
      : kProbeOperationWatchCbt;
  shared->processId = target.processId;
  shared->threadId = target.threadId;
  shared->windowHandle = reinterpret_cast<UINT_PTR>(target.window);

  const std::wstring hookPath = SiblingPath(L"qn_native_probe_hook.dll");
  HMODULE hookModule = LoadLibraryW(hookPath.c_str());
  FARPROC rawHookProcedure = hookModule == nullptr
      ? nullptr
      : GetProcAddress(hookModule, "QnCbtProbeHook");
  static_assert(sizeof(HOOKPROC) == sizeof(FARPROC));
  HOOKPROC hookProcedure = nullptr;
  memcpy(&hookProcedure, &rawHookProcedure, sizeof(hookProcedure));
  HHOOK hook = hookProcedure == nullptr
      ? nullptr
      : SetWindowsHookExW(WH_CBT, hookProcedure, hookModule, target.threadId);
  if (hook == nullptr) {
    fwprintf(stderr, L"ERROR could not install thread CBT hook (%lu)\n", GetLastError());
    if (hookModule != nullptr) FreeLibrary(hookModule);
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    return 8;
  }

  wprintf(
      L"cbt_ready pid=%lu thread=%lu hwnd=0x%llx suppress=%d durationMs=%lu\n",
      target.processId,
      target.threadId,
      reinterpret_cast<unsigned long long>(target.window),
      suppress ? 1 : 0,
      durationMs);
  fflush(stdout);
  Sleep(durationMs);

  UnhookWindowsHookEx(hook);
  FreeLibrary(hookModule);
  printf("%s", shared->report);
  printf(
      "cbt_result activateCount=%ld minMaxCount=%ld suppressedCount=%ld\n",
      shared->cbtActivateCount,
      shared->cbtMinMaxCount,
      shared->cbtSuppressedCount);
  const bool minimizedAfter = IsIconic(target.window) != FALSE;
  const bool foregroundAfter = GetForegroundWindow() == target.window;
  wprintf(
      L"window_state_after minimized=%d targetForeground=%d\n",
      minimizedAfter ? 1 : 0,
      foregroundAfter ? 1 : 0);

  int exitCode = 0;
  if (suppress && (!minimizedAfter || foregroundAfter)) {
    fwprintf(stderr, L"ERROR suppressed CBT probe did not preserve minimized state\n");
    exitCode = 9;
  }
  UnmapViewOfFile(shared);
  CloseHandle(mapping);
  return exitCode;
}

int RunProbe(
    bool activateWindow,
    DWORD operation,
    const wchar_t* draft = nullptr,
    DWORD observeDurationMs = 0,
    const wchar_t* targetId = nullptr,
    const wchar_t* cid = nullptr,
    const wchar_t* directText = nullptr) {
  std::vector<CandidateWindow> candidates;
  EnumWindows(FindQianniuWindow, reinterpret_cast<LPARAM>(&candidates));
  if (candidates.size() != 1) {
    fwprintf(
        stderr,
        L"ERROR expected exactly one visible Qt5152QWindowIcon / 千牛接待台 window; found %zu\n",
        candidates.size());
    return 2;
  }

  const CandidateWindow target = candidates.front();
  std::wstring imagePath;
  if (!IsAliWorkbenchProcess(target.processId, &imagePath)) {
    fwprintf(stderr, L"ERROR target window is not owned by AliWorkbench.exe\n");
    return 3;
  }
  wprintf(
      L"target pid=%lu thread=%lu hwnd=0x%llx image=%ls\n",
      target.processId,
      target.threadId,
      reinterpret_cast<unsigned long long>(target.window),
      imagePath.c_str());

  const bool requireMinimized =
      operation == kProbeOperationDiscoverMinimized ||
      operation == kProbeOperationSubmitMinimized ||
      operation == kProbeOperationWriteDraftMinimized ||
      operation == kProbeOperationClearDraftMinimized ||
      operation == kProbeOperationDiscoverFocusChainMinimized ||
      operation == kProbeOperationReconcileMinimized ||
      operation == kProbeOperationWriteDraftFocusChainMinimized ||
      operation == kProbeOperationClearDraftFocusChainMinimized ||
      operation == kProbeOperationSubmitFocusChainMinimized ||
      operation == kProbeOperationDirectSendTextMinimized;
  const HWND foregroundBefore = GetForegroundWindow();
  const bool minimizedBefore = IsIconic(target.window) != FALSE;
  wprintf(
      L"window_state_before minimized=%d foreground=0x%llx targetForeground=%d\n",
      minimizedBefore ? 1 : 0,
      reinterpret_cast<unsigned long long>(foregroundBefore),
      foregroundBefore == target.window ? 1 : 0);
  if (requireMinimized && !minimizedBefore) {
    fwprintf(stderr, L"ERROR --discover-minimized requires Qianniu to already be minimized\n");
    return 14;
  }

  std::wstring appBizPath;
  std::wstring appBizSha256;
  if (!FindModulePath(target.processId, L"AppBiz.dll", &appBizPath) ||
      !Sha256File(appBizPath, &appBizSha256)) {
    fwprintf(stderr, L"ERROR could not locate or hash target AppBiz.dll\n");
    return 4;
  }
  wprintf(L"AppBiz=%ls sha256=%ls\n", appBizPath.c_str(), appBizSha256.c_str());
  if (_wcsicmp(appBizSha256.c_str(), kExpectedAppBizSha256) != 0) {
    fwprintf(stderr, L"ERROR AppBiz.dll version is not the analyzed build; refusing hook\n");
    return 5;
  }

  const bool callbackLifecycle =
      operation == kProbeOperationCallbackLifecycleStart;
  if (callbackLifecycle) {
    std::wstring prgBasePath;
    std::wstring prgBaseSha256;
    if (!FindModulePath(target.processId, L"prgbase.dll", &prgBasePath) ||
        !Sha256File(prgBasePath, &prgBaseSha256)) {
      fwprintf(stderr, L"ERROR could not locate or hash target prgbase.dll\n");
      return 21;
    }
    wprintf(
        L"prgbase=%ls sha256=%ls\n",
        prgBasePath.c_str(),
        prgBaseSha256.c_str());
    if (_wcsicmp(prgBaseSha256.c_str(), kExpectedPrgBaseSha256) != 0) {
      fwprintf(
          stderr,
          L"ERROR prgbase.dll version is not the analyzed build; refusing hook\n");
      return 22;
    }
  }

  if (operation == kProbeOperationEnumerateAim ||
      operation == kProbeOperationObserveAimSendStart) {
    std::wstring aimPath;
    std::wstring aimSha256;
    if (!FindModulePath(target.processId, L"aim.dll", &aimPath) ||
        !Sha256File(aimPath, &aimSha256)) {
      fwprintf(stderr, L"ERROR could not locate or hash target aim.dll\n");
      return 17;
    }
    wprintf(L"aim=%ls sha256=%ls\n", aimPath.c_str(), aimSha256.c_str());
    if (_wcsicmp(aimSha256.c_str(), kExpectedAimSha256) != 0) {
      fwprintf(stderr, L"ERROR aim.dll version is not the analyzed build; refusing hook\n");
      return 18;
    }
  }

  if (activateWindow) {
    ShowWindow(target.window, SW_RESTORE);
    if (!SetForegroundWindow(target.window)) {
      fwprintf(stderr, L"ERROR could not activate validated Qianniu window (%lu)\n", GetLastError());
      return 6;
    }
    Sleep(500);
    if (GetForegroundWindow() != target.window) {
      fwprintf(stderr, L"ERROR validated Qianniu window did not become foreground\n");
      return 7;
    }
    wprintf(L"activation=ok\n");
  }

  wchar_t mappingName[128] = {};
  wchar_t eventName[128] = {};
  MakeProbeObjectName(
      mappingName, _countof(mappingName), kProbeMappingPrefix, target.processId);
  MakeProbeObjectName(
      eventName, _countof(eventName), kProbeEventPrefix, target.processId);
  HANDLE mapping = CreateFileMappingW(
      INVALID_HANDLE_VALUE,
      nullptr,
      PAGE_READWRITE,
      0,
      sizeof(ProbeShared),
      mappingName);
  const DWORD mappingError = GetLastError();
  if (mapping == nullptr || mappingError == ERROR_ALREADY_EXISTS) {
    fwprintf(stderr, L"ERROR could not create exclusive probe mapping (%lu)\n", mappingError);
    if (mapping != nullptr) CloseHandle(mapping);
    return 8;
  }
  auto* shared = static_cast<ProbeShared*>(MapViewOfFile(
      mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ProbeShared)));
  HANDLE doneEvent = CreateEventW(nullptr, TRUE, FALSE, eventName);
  const DWORD eventError = GetLastError();
  if (shared == nullptr || doneEvent == nullptr || eventError == ERROR_ALREADY_EXISTS) {
    fwprintf(stderr, L"ERROR could not initialize exclusive probe IPC (%lu)\n", eventError);
    if (doneEvent != nullptr) CloseHandle(doneEvent);
    if (shared != nullptr) UnmapViewOfFile(shared);
    CloseHandle(mapping);
    return 9;
  }

  ZeroMemory(shared, sizeof(*shared));
  shared->magic = kProbeMagic;
  shared->version = kProbeVersion;
  shared->state = kProbePending;
  shared->operation = operation;
  shared->processId = target.processId;
  shared->threadId = target.threadId;
  shared->windowHandle = reinterpret_cast<UINT_PTR>(target.window);
  shared->methodIndex = -1;
  shared->resultCode = -1;
  if (operation == kProbeOperationWriteDraftMinimized ||
      operation == kProbeOperationWriteDraftFocusChainMinimized) {
    const size_t draftLength = draft == nullptr ? 0 : wcslen(draft);
    if (draftLength == 0 || draftLength >= kProbeDraftCapacity) {
      fwprintf(
          stderr,
          L"ERROR draft must contain between 1 and %zu UTF-16 code units\n",
          kProbeDraftCapacity - 1);
      CloseHandle(doneEvent);
      UnmapViewOfFile(shared);
      CloseHandle(mapping);
      return 16;
    }
    shared->draftLength = static_cast<DWORD>(draftLength);
    wmemcpy(shared->draft, draft, draftLength + 1);
  }
  if (operation == kProbeOperationLocateAppMessageService ||
      operation == kProbeOperationDirectSendTextMinimized) {
    const int converted = targetId == nullptr
        ? 0
        : WideCharToMultiByte(
              CP_UTF8,
              WC_ERR_INVALID_CHARS,
              targetId,
              -1,
              shared->targetId,
              static_cast<int>(sizeof(shared->targetId)),
              nullptr,
              nullptr);
    if (converted <= 0) {
      fwprintf(stderr, L"ERROR target ID is empty, invalid, or too long\n");
      CloseHandle(doneEvent);
      UnmapViewOfFile(shared);
      CloseHandle(mapping);
      return 19;
    }
  }
  if (operation == kProbeOperationDirectSendTextMinimized) {
    const int cidConverted = cid == nullptr
        ? 0
        : WideCharToMultiByte(
              CP_UTF8,
              WC_ERR_INVALID_CHARS,
              cid,
              -1,
              shared->cid,
              static_cast<int>(sizeof(shared->cid)),
              nullptr,
              nullptr);
    const int textConverted = directText == nullptr
        ? 0
        : WideCharToMultiByte(
              CP_UTF8,
              WC_ERR_INVALID_CHARS,
              directText,
              -1,
              shared->text,
              static_cast<int>(sizeof(shared->text)),
              nullptr,
              nullptr);
    if (cidConverted <= 0 || textConverted <= 0) {
      fwprintf(stderr, L"ERROR cid or text is invalid or too long\n");
      CloseHandle(doneEvent);
      UnmapViewOfFile(shared);
      CloseHandle(mapping);
      return 20;
    }
  }

  const std::wstring hookPath = SiblingPath(L"qn_native_probe_hook.dll");
  std::wstring existingTargetHookPath;
  bool hookEnumerationOk = false;
  const bool targetHookPresent = callbackLifecycle && FindModulePath(
      target.processId, L"qn_native_probe_hook.dll", &existingTargetHookPath,
      &hookEnumerationOk);
  if (callbackLifecycle && (targetHookPresent || !hookEnumerationOk)) {
    fwprintf(
        stderr,
        L"ERROR target hook is already loaded or module enumeration failed; "
        L"refusing ambiguous lifecycle test\n");
    CloseHandle(doneEvent);
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    return 23;
  }
  HMODULE hookModule = LoadLibraryW(hookPath.c_str());
  if (hookModule == nullptr) {
    fwprintf(stderr, L"ERROR LoadLibrary failed for %ls (%lu)\n", hookPath.c_str(), GetLastError());
    CloseHandle(doneEvent);
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    return 10;
  }
  FARPROC rawHookProcedure = GetProcAddress(hookModule, "QnProbeHook");
  static_assert(sizeof(HOOKPROC) == sizeof(FARPROC));
  HOOKPROC hookProcedure = nullptr;
  memcpy(&hookProcedure, &rawHookProcedure, sizeof(hookProcedure));
  HHOOK hook = hookProcedure == nullptr
      ? nullptr
      : SetWindowsHookExW(WH_CALLWNDPROC, hookProcedure, hookModule, target.threadId);
  if (hook == nullptr) {
    fwprintf(stderr, L"ERROR SetWindowsHookEx failed (%lu)\n", GetLastError());
    FreeLibrary(hookModule);
    CloseHandle(doneEvent);
    UnmapViewOfFile(shared);
    CloseHandle(mapping);
    return 11;
  }

  const UINT probeMessage = RegisterWindowMessageW(kProbeMessageName);
  DWORD_PTR messageResult = 0;
  const LRESULT sent = SendMessageTimeoutW(
      target.window,
      probeMessage,
      0,
      0,
      SMTO_ABORTIFHUNG | SMTO_BLOCK,
      3000,
      &messageResult);
  DWORD waitResult = sent == 0
      ? WAIT_FAILED
      : WaitForSingleObject(doneEvent, 5000);

  if (operation == kProbeOperationObserveAimSendStart &&
      waitResult == WAIT_OBJECT_0 && shared->resultCode == 0) {
    wprintf(L"aim_observation_window durationMs=%lu\n", observeDurationMs);
    Sleep(observeDurationMs);
    ResetEvent(doneEvent);
    shared->resultCode = -1;
    shared->operation = kProbeOperationObserveAimSendStop;
    InterlockedExchange(&shared->state, kProbePending);
    messageResult = 0;
    const LRESULT stopSent = SendMessageTimeoutW(
        target.window,
        probeMessage,
        0,
        0,
        SMTO_ABORTIFHUNG | SMTO_BLOCK,
        3000,
        &messageResult);
    waitResult = stopSent == 0
        ? WAIT_FAILED
        : WaitForSingleObject(doneEvent, 5000);
  }

  bool callbackLifecycleValid = false;
  bool retainedAfterInitialUnhook = false;
  bool unloadedAfterRelease = false;
  DWORD lifecycleWorkerWait = WAIT_FAILED;
  DWORD lifecycleReleaseWait = WAIT_FAILED;
  LRESULT lifecycleReleaseSent = 0;
  if (callbackLifecycle && waitResult == WAIT_OBJECT_0 &&
      shared->resultCode == 0) {
    const BOOL initialUnhooked = UnhookWindowsHookEx(hook);
    hook = nullptr;
    FreeLibrary(hookModule);
    hookModule = nullptr;
    if (initialUnhooked) {
      InterlockedExchange(
          &shared->callbackLifecycle.initialHookReleased, 1);
    }

    const ULONGLONG workerDeadline = GetTickCount64() + 5000;
    while (shared->callbackLifecycle.workerCompleted == 0 &&
           GetTickCount64() < workerDeadline) {
      Sleep(10);
    }
    lifecycleWorkerWait = shared->callbackLifecycle.workerCompleted == 1
        ? WAIT_OBJECT_0
        : WAIT_TIMEOUT;
    std::wstring retainedPath;
    retainedAfterInitialUnhook = FindModulePath(
        target.processId, L"qn_native_probe_hook.dll", &retainedPath);

    if (initialUnhooked && lifecycleWorkerWait == WAIT_OBJECT_0 &&
        retainedAfterInitialUnhook) {
      ResetEvent(doneEvent);
      shared->resultCode = -1;
      shared->operation = kProbeOperationCallbackLifecycleRelease;
      InterlockedExchange(&shared->state, kProbePending);

      hookModule = LoadLibraryW(hookPath.c_str());
      rawHookProcedure = hookModule == nullptr
          ? nullptr
          : GetProcAddress(hookModule, "QnProbeHook");
      hookProcedure = nullptr;
      memcpy(&hookProcedure, &rawHookProcedure, sizeof(hookProcedure));
      hook = hookProcedure == nullptr
          ? nullptr
          : SetWindowsHookExW(
                WH_CALLWNDPROC, hookProcedure, hookModule, target.threadId);
      if (hook != nullptr) {
        const ULONGLONG releaseDeadline = GetTickCount64() + 5000;
        do {
          ResetEvent(doneEvent);
          shared->resultCode = -1;
          InterlockedExchange(&shared->state, kProbePending);
          messageResult = 0;
          lifecycleReleaseSent = SendMessageTimeoutW(
              target.window, probeMessage, 0, 0,
              SMTO_ABORTIFHUNG | SMTO_BLOCK, 3000, &messageResult);
          lifecycleReleaseWait = lifecycleReleaseSent == 0
              ? WAIT_FAILED : WaitForSingleObject(doneEvent, 5000);
          if (lifecycleReleaseWait != WAIT_OBJECT_0 ||
              shared->callbackLifecycleReleaseResult != ERROR_BUSY) break;
          Sleep(10);
        } while (GetTickCount64() < releaseDeadline);
      }
      if (hook != nullptr) {
        UnhookWindowsHookEx(hook);
        hook = nullptr;
      }
      if (hookModule != nullptr) {
        FreeLibrary(hookModule);
        hookModule = nullptr;
      }
      for (DWORD attempt = 0; attempt < 50; ++attempt) {
        std::wstring remainingPath;
        bool enumerationOk = false;
        const bool present = FindModulePath(
                target.processId,
                L"qn_native_probe_hook.dll",
                &remainingPath, &enumerationOk);
        if (!present && enumerationOk) {
          unloadedAfterRelease = true;
          break;
        }
        Sleep(10);
      }
    }

    const CallbackLifecycleResult& result = shared->callbackLifecycle;
    callbackLifecycleValid = initialUnhooked &&
        lifecycleWorkerWait == WAIT_OBJECT_0 &&
        retainedAfterInitialUnhook &&
        lifecycleReleaseSent != 0 &&
        lifecycleReleaseWait == WAIT_OBJECT_0 &&
        shared->resultCode == 0 &&
        shared->callbackLifecycleStartResult == 0 &&
        shared->callbackLifecycleReleaseResult == 0 &&
        result.guiThreadId == target.threadId &&
        result.workerThreadId != 0 &&
        result.workerThreadId != result.guiThreadId &&
        result.workerStarted == 1 && result.workerCompleted == 1 &&
        result.initialHookReleased == 1 &&
        result.workerObservedInitialHookReleased == 1 &&
        result.invokeCount == 1 && result.destroyCount == 1 &&
        result.cancelledCount == 1 && result.destroyRefCount == 0 &&
        result.initialRefCount == 1 && result.refCountAfterAdopt == 1 &&
        result.refCountAfterCopy == 2 &&
        result.refCountAfterCallerRelease == 1 &&
        result.errorCode == 0 && result.workerExitConfirmed == 1 &&
        unloadedAfterRelease;
  }

  if (hook != nullptr) {
    UnhookWindowsHookEx(hook);
  }
  if (hookModule != nullptr) {
    FreeLibrary(hookModule);
  }

  int exitCode = 12;
  if (waitResult != WAIT_OBJECT_0) {
    fwprintf(stderr, L"ERROR probe did not complete (send=%lld wait=%lu error=%lu)\n",
             static_cast<long long>(sent), waitResult, GetLastError());
  } else if (callbackLifecycle) {
    const CallbackLifecycleResult& result = shared->callbackLifecycle;
    printf("%s", shared->report);
    printf("workerExitConfirmed=%ld\n",
           static_cast<long>(result.workerExitConfirmed));
    printf(
        "callback_target_lifecycle workerWait=%lu releaseSend=%lld "
        "releaseWait=%lu retainedAfterInitialUnhook=%d unloadedAfterRelease=%d\n",
        lifecycleWorkerWait,
        static_cast<long long>(lifecycleReleaseSent),
        lifecycleReleaseWait,
        retainedAfterInitialUnhook ? 1 : 0,
        unloadedAfterRelease ? 1 : 0);
    printf(
        "  guiThread=%lu workerThread=%lu workerStarted=%ld "
        "workerCompleted=%ld initialHookReleased=%ld observedRelease=%ld\n",
        result.guiThreadId,
        result.workerThreadId,
        static_cast<long>(result.workerStarted),
        static_cast<long>(result.workerCompleted),
        static_cast<long>(result.initialHookReleased),
        static_cast<long>(result.workerObservedInitialHookReleased));
    printf(
        "  invokeCalls=%ld cancelCalls=%ld destroyCalls=%ld "
        "destroyRefCount=%ld refs=%ld->%ld->%ld->%ld "
        "callbackError=%lu start=%lu release=%lu\n",
        static_cast<long>(result.invokeCount),
        static_cast<long>(result.cancelledCount),
        static_cast<long>(result.destroyCount),
        static_cast<long>(result.destroyRefCount),
        static_cast<long>(result.initialRefCount),
        static_cast<long>(result.refCountAfterAdopt),
        static_cast<long>(result.refCountAfterCopy),
        static_cast<long>(result.refCountAfterCallerRelease),
        result.errorCode,
        shared->callbackLifecycleStartResult,
        shared->callbackLifecycleReleaseResult);
    printf(
        "result=%s no_send_address_resolved=1 no_send_invoked=1\n",
        callbackLifecycleValid
            ? "callback_target_lifecycle_dry_run_ok"
            : "callback_target_lifecycle_dry_run_validation_failed");
    exitCode = callbackLifecycleValid ? 0 : 13;
  } else {
    printf("%s", shared->report);
    exitCode = shared->resultCode == 0 ? 0 : 13;
  }

  const HWND foregroundAfter = GetForegroundWindow();
  const bool minimizedAfter = IsIconic(target.window) != FALSE;
  wprintf(
      L"window_state_after minimized=%d foreground=0x%llx targetForeground=%d\n",
      minimizedAfter ? 1 : 0,
      reinterpret_cast<unsigned long long>(foregroundAfter),
      foregroundAfter == target.window ? 1 : 0);
  if (requireMinimized && (!minimizedAfter || foregroundAfter == target.window)) {
    fwprintf(stderr, L"ERROR minimized discovery changed the target window state\n");
    exitCode = 15;
  }

  CloseHandle(doneEvent);
  UnmapViewOfFile(shared);
  CloseHandle(mapping);
  return exitCode;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc == 3 && wcscmp(argv[1], L"--dry-run-callback-abi") == 0) {
    return RunCallbackAbiDryRun(argv[2]);
  }
  if (argc == 3 &&
      wcscmp(argv[1], L"--dry-run-callback-module-lifecycle") == 0) {
    return RunCallbackModuleLifecycleDryRun(argv[2]);
  }
  if (argc == 3 && wcscmp(argv[1], L"--dry-run-callback-release-race") == 0) {
    return RunCallbackModuleLifecycleDryRun(argv[2], true);
  }
  if (argc == 3 && wcscmp(argv[1], L"--dry-run-callback-unhook-timeout") == 0) {
    return RunCallbackModuleLifecycleDryRun(argv[2], false, true);
  }
  if (argc == 2 &&
      wcscmp(argv[1], L"--dry-run-callback-target-lifecycle") == 0) {
    return RunProbe(false, kProbeOperationCallbackLifecycleStart);
  }
  if (argc == 2 && wcscmp(argv[1], L"--enumerate-aim") == 0) {
    return RunProbe(false, kProbeOperationEnumerateAim);
  }
  if (argc == 2 &&
      wcscmp(argv[1], L"--enumerate-app-message-services") == 0) {
    return RunProbe(false, kProbeOperationEnumerateAppMessageServices);
  }
  if (argc == 2 && wcscmp(argv[1], L"--dry-run-send-arguments") == 0) {
    return RunProbe(false, kProbeOperationDryRunSendArguments);
  }
  if (argc == 3 &&
      wcscmp(argv[1], L"--locate-app-message-service") == 0) {
    const wchar_t* targetId = argv[2];
    if (wcsncmp(targetId, L"3#", 2) != 0 || targetId[2] == L'\0') {
      fwprintf(stderr, L"ERROR target ID must have the form 3#<digits>\n");
      return 1;
    }
    for (const wchar_t* current = targetId + 2; *current != L'\0'; ++current) {
      if (*current < L'0' || *current > L'9') {
        fwprintf(stderr, L"ERROR target ID must have the form 3#<digits>\n");
        return 1;
      }
    }
    return RunProbe(
        false, kProbeOperationLocateAppMessageService, nullptr, 0, targetId);
  }
  if (argc == 10 &&
      wcscmp(argv[1], L"--send-text-direct-minimized") == 0 &&
      wcscmp(argv[2], L"--target-id") == 0 &&
      wcscmp(argv[4], L"--cid") == 0 &&
      wcscmp(argv[6], L"--text") == 0 &&
      wcscmp(argv[8], L"--confirm") == 0 &&
      wcscmp(argv[9], L"QN_DIRECT_SEND_TEXT_ONCE") == 0) {
    fwprintf(
        stderr,
        L"ERROR direct send is disabled: Qianniu asynchronously invokes the "
        L"completion callback, and the empty callback used by this probe "
        L"caused std::bad_function_call in AppBiz.dll\n");
    return 1;
#if 0
    const wchar_t* targetId = argv[3];
    const wchar_t* cid = argv[5];
    const wchar_t* directText = argv[7];
    if (wcsncmp(targetId, L"3#", 2) != 0 || targetId[2] == L'\0') {
      fwprintf(stderr, L"ERROR target ID must have the form 3#<digits>\n");
      return 1;
    }
    for (const wchar_t* current = targetId + 2; *current != L'\0'; ++current) {
      if (*current < L'0' || *current > L'9') {
        fwprintf(stderr, L"ERROR target ID must have the form 3#<digits>\n");
        return 1;
      }
    }
    const size_t cidLength = wcslen(cid);
    constexpr wchar_t kCidSuffix[] = L"#11001@cntaobao";
    const size_t suffixLength = _countof(kCidSuffix) - 1;
    if (cidLength <= suffixLength || cidLength >= kProbeCidCapacity ||
        wcscmp(cid + cidLength - suffixLength, kCidSuffix) != 0) {
      fwprintf(stderr, L"ERROR cid must end with #11001@cntaobao\n");
      return 1;
    }
    for (const wchar_t* current = cid; *current != L'\0'; ++current) {
      const bool valid = (*current >= L'0' && *current <= L'9') ||
          *current == L'.' || *current == L'-' || *current == L'#' ||
          *current == L'@' || (*current >= L'a' && *current <= L'z');
      if (!valid) {
        fwprintf(stderr, L"ERROR cid contains an unsupported character\n");
        return 1;
      }
    }
    const size_t textLength = wcslen(directText);
    if (textLength == 0 || textLength >= 1024 ||
        wcschr(directText, L'\r') != nullptr ||
        wcschr(directText, L'\n') != nullptr) {
      fwprintf(stderr, L"ERROR text must be one plain-text line under 1024 characters\n");
      return 1;
    }
    return RunProbe(
        false,
        kProbeOperationDirectSendTextMinimized,
        nullptr,
        0,
        targetId,
        cid,
        directText);
#endif
  }
  if (argc == 3 && wcscmp(argv[1], L"--observe-aim-send") == 0) {
    wchar_t* end = nullptr;
    const unsigned long duration = wcstoul(argv[2], &end, 10);
    if (end == argv[2] || *end != L'\0' || duration < 100 || duration > 120000) {
      fwprintf(stderr, L"ERROR duration must be between 100 and 120000 ms\n");
      return 1;
    }
    return RunProbe(
        false,
        kProbeOperationObserveAimSendStart,
        nullptr,
        static_cast<DWORD>(duration));
  }
  if (argc == 2 && wcscmp(argv[1], L"--discover") == 0) {
    return RunProbe(false, kProbeOperationDiscover);
  }
  if (argc == 2 && wcscmp(argv[1], L"--discover-activate") == 0) {
    return RunProbe(true, kProbeOperationDiscover);
  }
  if (argc == 2 && wcscmp(argv[1], L"--discover-minimized") == 0) {
    return RunProbe(false, kProbeOperationDiscoverMinimized);
  }
  if (argc == 2 &&
      wcscmp(argv[1], L"--discover-focus-chain-minimized") == 0) {
    return RunProbe(false, kProbeOperationDiscoverFocusChainMinimized);
  }
  if (argc == 4 && wcscmp(argv[1], L"--reconcile-minimized") == 0 &&
      wcscmp(argv[2], L"--confirm") == 0 &&
      wcscmp(argv[3], L"QN_NATIVE_RECONCILE_MINIMIZED_ONCE") == 0) {
    return RunProbe(false, kProbeOperationReconcileMinimized);
  }
  if (argc == 4 && wcscmp(argv[1], L"--submit-onclick") == 0 &&
      wcscmp(argv[2], L"--confirm") == 0 &&
      wcscmp(argv[3], L"QN_NATIVE_SUBMIT_ONCE") == 0) {
    return RunProbe(true, kProbeOperationSubmit);
  }
  if (argc == 4 && wcscmp(argv[1], L"--submit-onclick-minimized") == 0 &&
      wcscmp(argv[2], L"--confirm") == 0 &&
      wcscmp(argv[3], L"QN_NATIVE_SUBMIT_MINIMIZED_ONCE") == 0) {
    return RunProbe(false, kProbeOperationSubmitMinimized);
  }
  if (argc == 4 &&
      wcscmp(argv[1], L"--submit-onclick-focus-chain-minimized") == 0 &&
      wcscmp(argv[2], L"--confirm") == 0 &&
      wcscmp(argv[3], L"QN_NATIVE_SUBMIT_FOCUS_CHAIN_MINIMIZED_ONCE") == 0) {
    return RunProbe(false, kProbeOperationSubmitFocusChainMinimized);
  }
  if (argc == 6 && wcscmp(argv[1], L"--write-draft-minimized") == 0 &&
      wcscmp(argv[2], L"--text") == 0 &&
      wcscmp(argv[4], L"--confirm") == 0 &&
      wcscmp(argv[5], L"QN_NATIVE_DRAFT_MINIMIZED_ONCE") == 0) {
    return RunProbe(false, kProbeOperationWriteDraftMinimized, argv[3]);
  }
  if (argc == 6 &&
      wcscmp(argv[1], L"--write-draft-focus-chain-minimized") == 0 &&
      wcscmp(argv[2], L"--text") == 0 &&
      wcscmp(argv[4], L"--confirm") == 0 &&
      wcscmp(argv[5], L"QN_NATIVE_DRAFT_FOCUS_CHAIN_MINIMIZED_ONCE") == 0) {
    return RunProbe(
        false, kProbeOperationWriteDraftFocusChainMinimized, argv[3]);
  }
  if (argc == 4 && wcscmp(argv[1], L"--clear-draft-minimized") == 0 &&
      wcscmp(argv[2], L"--confirm") == 0 &&
      wcscmp(argv[3], L"QN_NATIVE_CLEAR_DRAFT_MINIMIZED_ONCE") == 0) {
    return RunProbe(false, kProbeOperationClearDraftMinimized);
  }
  if (argc == 4 &&
      wcscmp(argv[1], L"--clear-draft-focus-chain-minimized") == 0 &&
      wcscmp(argv[2], L"--confirm") == 0 &&
      wcscmp(argv[3], L"QN_NATIVE_CLEAR_DRAFT_FOCUS_CHAIN_MINIMIZED_ONCE") == 0) {
    return RunProbe(false, kProbeOperationClearDraftFocusChainMinimized);
  }
  if (argc == 3 && wcscmp(argv[1], L"--check-appbiz") == 0) {
    return CheckAppBiz(argv[2]);
  }
  if (argc == 3 && wcscmp(argv[1], L"--watch-window-state") == 0) {
    wchar_t* end = nullptr;
    const unsigned long duration = wcstoul(argv[2], &end, 10);
    if (end == argv[2] || *end != L'\0' || duration < 100 || duration > 30000) {
      fwprintf(stderr, L"ERROR duration must be between 100 and 30000 ms\n");
      return 1;
    }
    return WatchWindowState(static_cast<DWORD>(duration));
  }
  if (argc == 3 &&
      (wcscmp(argv[1], L"--watch-cbt-minimized") == 0 ||
       wcscmp(argv[1], L"--suppress-cbt-minimized") == 0)) {
    wchar_t* end = nullptr;
    const unsigned long duration = wcstoul(argv[2], &end, 10);
    if (end == argv[2] || *end != L'\0' || duration < 100 || duration > 30000) {
      fwprintf(stderr, L"ERROR duration must be between 100 and 30000 ms\n");
      return 1;
    }
    return RunCbtProbe(
        wcscmp(argv[1], L"--suppress-cbt-minimized") == 0,
        static_cast<DWORD>(duration));
  }
  fwprintf(
      stderr,
      L"Usage:\n"
      L"  qn_native_submit_probe.exe --dry-run-callback-abi <prgbase.dll>\n"
      L"  qn_native_submit_probe.exe --dry-run-callback-module-lifecycle <prgbase.dll>\n"
      L"  qn_native_submit_probe.exe --dry-run-callback-release-race <prgbase.dll>\n"
      L"  qn_native_submit_probe.exe --dry-run-callback-unhook-timeout <prgbase.dll>\n"
      L"  qn_native_submit_probe.exe --dry-run-callback-target-lifecycle\n"
      L"  qn_native_submit_probe.exe --enumerate-aim\n"
      L"  qn_native_submit_probe.exe --enumerate-app-message-services\n"
      L"  qn_native_submit_probe.exe --dry-run-send-arguments\n"
      L"  qn_native_submit_probe.exe --locate-app-message-service <3#UID>\n"
      L"  qn_native_submit_probe.exe --send-text-direct-minimized --target-id <3#UID> --cid <cid> --text <text> --confirm QN_DIRECT_SEND_TEXT_ONCE\n"
      L"  qn_native_submit_probe.exe --observe-aim-send <duration-ms>\n"
      L"  qn_native_submit_probe.exe --discover\n"
      L"  qn_native_submit_probe.exe --discover-activate\n"
      L"  qn_native_submit_probe.exe --discover-minimized\n"
      L"  qn_native_submit_probe.exe --discover-focus-chain-minimized\n"
      L"  qn_native_submit_probe.exe --reconcile-minimized --confirm QN_NATIVE_RECONCILE_MINIMIZED_ONCE\n"
      L"  qn_native_submit_probe.exe --submit-onclick --confirm QN_NATIVE_SUBMIT_ONCE\n"
      L"  qn_native_submit_probe.exe --submit-onclick-minimized --confirm QN_NATIVE_SUBMIT_MINIMIZED_ONCE\n"
      L"  qn_native_submit_probe.exe --submit-onclick-focus-chain-minimized --confirm QN_NATIVE_SUBMIT_FOCUS_CHAIN_MINIMIZED_ONCE\n"
      L"  qn_native_submit_probe.exe --write-draft-minimized --text <text> --confirm QN_NATIVE_DRAFT_MINIMIZED_ONCE\n"
      L"  qn_native_submit_probe.exe --write-draft-focus-chain-minimized --text <text> --confirm QN_NATIVE_DRAFT_FOCUS_CHAIN_MINIMIZED_ONCE\n"
      L"  qn_native_submit_probe.exe --clear-draft-minimized --confirm QN_NATIVE_CLEAR_DRAFT_MINIMIZED_ONCE\n"
      L"  qn_native_submit_probe.exe --clear-draft-focus-chain-minimized --confirm QN_NATIVE_CLEAR_DRAFT_FOCUS_CHAIN_MINIMIZED_ONCE\n"
      L"  qn_native_submit_probe.exe --watch-window-state <duration-ms>\n"
      L"  qn_native_submit_probe.exe --watch-cbt-minimized <duration-ms>\n"
      L"  qn_native_submit_probe.exe --suppress-cbt-minimized <duration-ms>\n"
      L"  qn_native_submit_probe.exe --check-appbiz <path>\n"
      L"Submit modes invoke ChatContentView::OnClick(0) exactly once after all guards pass.\n"
      L"Draft write and clear modes never invoke OnClick.\n");
  return argc == 1 ? 0 : 1;
}
