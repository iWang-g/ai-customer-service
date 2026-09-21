#include "live_nosend_shared.h"

namespace {
using namespace live_nosend;
Shared* gShared = nullptr;
HANDLE gMapping = nullptr;
Request gRequest{};
DWORD gAnchor = 0;
bool OwnIdentity(QnLiveIdentity* id, HWND window) {
  id->pid = GetCurrentProcessId(); id->tid = GetCurrentThreadId();
  id->hwnd = reinterpret_cast<ULONG_PTR>(window);
  FILETIME exited{}, kernel{}, user{};
  DWORD windowPid = 0;
  wchar_t path[32768]{};
  const DWORD length = GetModuleFileNameW(nullptr, path, 32768);
  return length && length < 32768 && _wcsicmp(path, L"D:\\qianniu\\AliWorkbench.exe") == 0 &&
      !IsDebuggerPresent() && GetWindowThreadProcessId(window, &windowPid) == id->tid && windowPid == id->pid &&
      ProcessIdToSessionId(id->pid, &id->session) &&
      GetProcessTimes(GetCurrentProcess(), &id->processCreated, &exited, &kernel, &user) &&
      GetThreadTimes(GetCurrentThread(), &id->threadCreated, &exited, &kernel, &user);
}
void Query() {
  gShared->queryPid = GetCurrentProcessId(); gShared->queryTid = GetCurrentThreadId();
  gShared->queryResident = static_cast<DWORD>(Load(&gShared->resident));
  gShared->queryAdmitted = static_cast<DWORD>(Load(&gShared->admitted));
  gShared->queryToken = gRequest.token;
  InterlockedIncrement(&gShared->querySequence);
}
}

extern "C" __declspec(dllexport) LRESULT CALLBACK QnLiveNoSendHook(int code, WPARAM wp, LPARAM lp) {
  if (code != HC_ACTION) return CallNextHookEx(nullptr, code, wp, lp);
  const auto* msg = reinterpret_cast<const CWPSTRUCT*>(lp);
  if (!msg || msg->message != RegisterWindowMessageW(kMessage) || (msg->wParam != 1 && msg->wParam != 2))
    return CallNextHookEx(nullptr, code, wp, lp);
  QnLiveIdentity own{};
  if (!OwnIdentity(&own, msg->hwnd)) return CallNextHookEx(nullptr, code, wp, lp);
  if (gShared) {
    own.appBase = gRequest.identity.appBase; own.appSize = gRequest.identity.appSize;
    if (msg->wParam == 2 && SameIdentity(own, gRequest.identity) &&
        static_cast<std::uint64_t>(msg->lParam) == gRequest.token) Query();
    return CallNextHookEx(nullptr, code, wp, lp);
  }
  if (msg->wParam != 1) return CallNextHookEx(nullptr, code, wp, lp);
  wchar_t name[128]{}; Name(name, own);
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  auto* shared = mapping ? static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared))) : nullptr;
  if (!shared) {
    if (mapping) CloseHandle(mapping);
    return CallNextHookEx(nullptr, code, wp, lp);
  }
  const Request request = shared->request;
  own.appBase = request.identity.appBase; own.appSize = request.identity.appSize;
  if (request.magic != kMagic || request.version != kVersion || request.size != sizeof(Shared) ||
      !request.token || static_cast<std::uint64_t>(msg->lParam) != request.token ||
      !SameIdentity(own, request.identity) ||
      InterlockedCompareExchange(&shared->phase, Checking, Pending) != Pending) {
    UnmapViewOfFile(shared); CloseHandle(mapping);
    return CallNextHookEx(nullptr, code, wp, lp);
  }
  HMODULE pinned = nullptr;
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      reinterpret_cast<LPCWSTR>(&gAnchor), &pinned)) {
    shared->result = GetLastError(); InterlockedExchange(&shared->phase, Rejected);
    UnmapViewOfFile(shared); CloseHandle(mapping);
    return CallNextHookEx(nullptr, code, wp, lp);
  }
  // The inert module remains resident even if the expensive admission recheck fails.
  gRequest = request; gMapping = mapping; gShared = shared;
  InterlockedExchange(&shared->resident, 1);
  shared->actualPid = own.pid; shared->actualTid = own.tid;
  shared->receiptToken = request.token; shared->moduleBase = reinterpret_cast<ULONG_PTR>(pinned);
  wchar_t modulePath[32768]{};
  const DWORD length = GetModuleFileNameW(pinned, modulePath, 32768);
  bool admitted = false;
  DWORD result = ERROR_INVALID_DATA;
  try {
    admitted = length && length < 32768 && _wcsicmp(modulePath, kDllPath) == 0 &&
        QnCheckLiveIdentity(request.identity, kDllPath);
    result = admitted ? ERROR_SUCCESS : ERROR_INVALID_DATA;
  } catch (...) {
    // Never propagate a C++ allocation/runtime exception into the client's GUI stack.
    result = ERROR_NOT_ENOUGH_MEMORY;
  }
  shared->result = result;
  InterlockedExchange(&shared->admitted, admitted ? 1 : 0);
  InterlockedExchange(&shared->phase, admitted ? Resident : Rejected);
  return CallNextHookEx(nullptr, code, wp, lp);
}
