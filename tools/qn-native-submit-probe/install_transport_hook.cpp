#include "install_transport_shared.h"

namespace {
using namespace install_lab;
Shared* gShared = nullptr;
HANDLE gMapping = nullptr;
volatile LONG gInstalled = 0;
DWORD gThread = 0;

DWORD Validate(const Request& r, const Shared& s, HWND window) {
  if (r.magic != kMagic || r.size != sizeof(Request) || r.version != kVersion)
    return ERROR_REVISION_MISMATCH;
  if (r.operation != 1 || r.delay > 1) return ERROR_INVALID_FUNCTION;
  FILETIME pc{}, tc{}, exited{}, kernel{}, user{};
  DWORD windowPid = 0;
  const DWORD windowTid = GetWindowThreadProcessId(window, &windowPid);
  if (!GetProcessTimes(GetCurrentProcess(), &pc, &exited, &kernel, &user) ||
      !GetThreadTimes(GetCurrentThread(), &tc, &exited, &kernel, &user))
    return GetLastError();
  if (!r.token || r.token != s.token || r.pid != GetCurrentProcessId() ||
      r.tid != GetCurrentThreadId() || windowPid != r.pid || windowTid != r.tid ||
      r.hwnd != reinterpret_cast<ULONG_PTR>(window) ||
      !Same(r.processCreated, pc) || !Same(r.threadCreated, tc) || IsDebuggerPresent())
    return ERROR_INVALID_DATA;
  if (Read(&gInstalled)) return ERROR_ALREADY_INITIALIZED;
  return ERROR_SUCCESS;
}
}

extern "C" __declspec(dllexport) LRESULT CALLBACK QnInstallFixtureHook(
    int code, WPARAM wparam, LPARAM lparam) {
  if (code != HC_ACTION || !FixtureProcess()) return CallNextHookEx(nullptr, code, wparam, lparam);
  const auto* message = reinterpret_cast<const CWPSTRUCT*>(lparam);
  if (!message || message->message != RegisterWindowMessageW(kMessage))
    return CallNextHookEx(nullptr, code, wparam, lparam);
  wchar_t name[96]{};
  MappingName(name, GetCurrentProcessId());
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  auto* s = mapping ? static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS,
      0, 0, sizeof(Shared))) : nullptr;
  if (!s) {
    if (mapping) CloseHandle(mapping);
    return CallNextHookEx(nullptr, code, wparam, lparam);
  }
  if (InterlockedCompareExchange(&s->state, Processing, Pending) == Pending) {
    // The trusted controller publishes once and never edits an in-flight request.
    const Request request = s->request;
    DWORD result = Validate(request, *s, message->hwnd);
    if (result == ERROR_SUCCESS) {
      HMODULE pinned = nullptr;
      if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
          GET_MODULE_HANDLE_EX_FLAG_PIN, reinterpret_cast<LPCWSTR>(&gThread), &pinned)) {
        result = GetLastError();
      } else {
        gShared = s;
        gMapping = mapping;
        gThread = GetCurrentThreadId();
        InterlockedExchange(&gInstalled, 1);
        InterlockedExchange(&s->installed, 1);
        InterlockedIncrement(&s->pinCount);
        InterlockedIncrement(&s->active);
        if (request.delay) {
          // Bounded fixture-only gate for timeout/unhook testing, never a client module.
          InterlockedExchange(&s->gate, 1);
          const ULONGLONG deadline = GetTickCount64() + 3000;
          while (!Read(&s->release) && GetTickCount64() < deadline) Sleep(1);
          if (!Read(&s->release)) result = ERROR_TIMEOUT;
        }
        InterlockedDecrement(&s->active);
      }
    }
    s->result = result;
    s->receiptPid = GetCurrentProcessId();
    s->receiptTid = GetCurrentThreadId();
    s->receiptToken = request.token;
    InterlockedExchange(&s->state, Complete);
  }
  if (s != gShared) UnmapViewOfFile(s);
  if (mapping != gMapping) CloseHandle(mapping);
  return CallNextHookEx(nullptr, code, wparam, lparam);
}

extern "C" __declspec(dllexport) DWORD QnInstallFixtureQuery() {
  if (!gShared || !Read(&gInstalled) || GetCurrentThreadId() != gThread)
    return ERROR_INVALID_STATE;
  gShared->queryInstalled = static_cast<DWORD>(Read(&gInstalled));
  gShared->queryActive = static_cast<DWORD>(Read(&gShared->active));
  gShared->queryPinCount = static_cast<DWORD>(Read(&gShared->pinCount));
  return ERROR_SUCCESS;
}
