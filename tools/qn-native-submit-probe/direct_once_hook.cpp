#include "direct_once_memory.h"
#include <string>

namespace {
using namespace direct_once;
Shared* gShared = nullptr;
Request gRequest{};
direct_receipt::Slot gReceipt;
#ifdef QN_DIRECT_GENERAL
direct_receipt::Slot gReceipts[16];
#endif
direct_receipt::Slot* gCurrentReceipt = &gReceipt;
HANDLE gMapping = nullptr;
HMODULE gPinned = nullptr, gPrg = nullptr;
direct_receipt::Api gApi{};

void Publish() {
  gShared->receipt = gCurrentReceipt->Read();
  gShared->actualPid = GetCurrentProcessId(); gShared->actualTid = GetCurrentThreadId();
  gShared->receiptToken = gRequest.token;
  InterlockedIncrement(&gShared->sequence);
}
void Reject(DWORD error) {
  gShared->error = error; InterlockedExchange(&gShared->phase, Rejected); Publish();
}
bool OnGui(HWND window, const QnLiveIdentity& id) {
  DWORD pid = 0; FILETIME pc{}, tc{}, exited{}, kernel{}, user{}; DWORD session = 0;
  return id.pid == GetCurrentProcessId() && id.tid == GetCurrentThreadId() &&
      id.hwnd == reinterpret_cast<ULONG_PTR>(window) &&
      GetWindowThreadProcessId(window, &pid) == id.tid && pid == id.pid &&
      ProcessIdToSessionId(pid, &session) && session == id.session &&
      GetProcessTimes(GetCurrentProcess(), &pc, &exited, &kernel, &user) &&
      GetThreadTimes(GetCurrentThread(), &tc, &exited, &kernel, &user) &&
      !std::memcmp(&pc, &id.processCreated, sizeof(pc)) && !std::memcmp(&tc, &id.threadCreated, sizeof(tc));
}

void Run() {
  const auto& r = gRequest;
#ifdef QN_DIRECT_GENERAL
  QnNativeLayout layout{};
  if (!QnResolveNativeLayout(GetCurrentProcessId(), &layout)) { Reject(ERROR_REVISION_MISMATCH); return; }
  const auto appPath = layout.appPath, prgPath = layout.prgPath;
  const auto& profile = *layout.profile;
  const auto account = std::string("3#") + r.shop;
#else
  const auto appPath = kApp, prgPath = kPrg;
  const auto& profile = kQnNativeProfiles[0];
  const std::string account = kAccount;
#endif
  Handle appFile(CreateFileW(appPath, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
  Handle prgFile(CreateFileW(prgPath, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
  ULONG_PTR biz = 0;
  if (!appFile || !prgFile || !Check(r.identity) || !NativeGuard(r.identity, r.prgBase) ||
      ModuleBase(GetCurrentProcessId(), prgPath) != r.prgBase ||
      !Service(GetCurrentProcess(), r.identity.appBase, r.service, &biz,
#ifdef QN_DIRECT_GENERAL
          (std::string("3#") + r.shop).c_str()
#else
          kAccount
#endif
          , profile) || biz != r.messageBiz ||
      GetTickCount64() > r.expires) { Reject(ERROR_INVALID_DATA); return; }
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      reinterpret_cast<LPCWSTR>(r.prgBase), &gPrg) || !gApi.Load(gPrg)) { Reject(ERROR_PROC_NOT_FOUND); return; }
  gShared->admitted = 1;
  using Assign = void* (*)(void*, const void*, SIZE_T);
  using Destructor = void (*)(void*);
  using Constructor = void* (*)(void*);
  using Send = void (*)(void*, const void*, const void*, const void*, const void*, const void*);
  const auto base = r.identity.appBase;
  const auto assign = reinterpret_cast<Assign>(base + profile.entries[1]);
  const auto destroyString = reinterpret_cast<Destructor>(base + profile.entries[2]);
  const auto constructMap = reinterpret_cast<Constructor>(base + profile.entries[3]);
  const auto destroyMap = reinterpret_cast<Destructor>(base + profile.entries[4]);
  alignas(16) unsigned char cid[32]{}, text[32]{}, source[32]{}, extensions[64]{};
  const SIZE_T capacity = 15;
  for (auto* s : {cid, text, source}) std::memcpy(s + 24, &capacity, 8);
  assign(cid, r.cid, std::strlen(r.cid)); assign(text, r.text, std::strlen(r.text));
  assign(source, kSource, sizeof(kSource) - 1); constructMap(extensions);
  char c[128]{}, t[kTextCapacity]{}, s[128]{}; DWORD loadFactor = 0;
  ULONG_PTR head = 0, begin = 0, end = 0, cap = 0; SIZE_T count = 1;
  std::memcpy(&loadFactor, extensions, 4); std::memcpy(&head, extensions + 8, 8);
  std::memcpy(&count, extensions + 16, 8); std::memcpy(&begin, extensions + 24, 8);
  std::memcpy(&end, extensions + 32, 8); std::memcpy(&cap, extensions + 40, 8);
  const bool arguments = String(GetCurrentProcess(), reinterpret_cast<ULONG_PTR>(cid), c, sizeof(c)) &&
      String(GetCurrentProcess(), reinterpret_cast<ULONG_PTR>(text), t, sizeof(t)) &&
      String(GetCurrentProcess(), reinterpret_cast<ULONG_PTR>(source), s, sizeof(s)) &&
      !std::strcmp(c, r.cid) && !std::strcmp(t, r.text) && !std::strcmp(s, kSource) &&
      loadFactor == 0x3f800000 && head && !count && begin && begin < end && end == cap;
  direct_receipt::Callback callback{};
  bool callbackValid = false;
#ifdef QN_DIRECT_GENERAL
  for (auto& slot : gReceipts) {
    slot.RecycleIfDestroyed();
    if (slot.Create(gApi, &callback)) { gCurrentReceipt = &slot; callbackValid = true; break; }
  }
#else
  callbackValid = arguments && gReceipt.Create(gApi, &callback);
#endif
  if (callbackValid) {
    gShared->callbackCreated = 1;
    LONG refs = 0; direct_receipt::Callback copy{};
    callbackValid = Read(GetCurrentProcess(), reinterpret_cast<ULONG_PTR>(callback.state), &refs) && refs == 1;
    gApi.copy(&copy, &callback);
    callbackValid = callbackValid && copy.state == callback.state &&
        Read(GetCurrentProcess(), reinterpret_cast<ULONG_PTR>(callback.state), &refs) && refs == 2;
    gApi.release(&copy);
    callbackValid = callbackValid && Read(GetCurrentProcess(), reinterpret_cast<ULONG_PTR>(callback.state), &refs) && refs == 1;
  }
  // No pointer is retained from a prior GUI request. Recheck after native allocation.
  const bool invoke = arguments && callbackValid && GetTickCount64() <= r.expires &&
      Service(GetCurrentProcess(), base, r.service, &biz, account.c_str(), profile) && biz == r.messageBiz && !IsDebuggerPresent()
#ifdef QN_DIRECT_V2
      && IsIconic(reinterpret_cast<HWND>(r.identity.hwnd))
#endif
      ;
  if (invoke) {
    gShared->argumentsValid = 1;
    gCurrentReceipt->Enter(); Publish();
    // Correct outer service owns the SDK context and adapts our 8-byte callback.
    reinterpret_cast<Send>(base + profile.entries[0])(reinterpret_cast<void*>(r.service), cid, text, source, extensions, &callback);
    gCurrentReceipt->Return();
  }
  if (callback.state) { gApi.release(&callback); gShared->callerReleased = 1; }
  destroyMap(extensions); destroyString(source); destroyString(text); destroyString(cid);
  if (!invoke) { Reject(ERROR_INVALID_STATE); return; }
  InterlockedExchange(&gShared->phase, Returned); Publish();
}
}

extern "C" __declspec(dllexport) LRESULT CALLBACK QnDirectOnceHook(int code, WPARAM wp, LPARAM lp) {
  if (code != HC_ACTION) return CallNextHookEx(nullptr, code, wp, lp);
  const auto* msg = reinterpret_cast<const CWPSTRUCT*>(lp);
  if (!msg || msg->message != RegisterWindowMessageW(kMessage)) return CallNextHookEx(nullptr, code, wp, lp);
  if (gShared) {
    if (OnGui(msg->hwnd, gRequest.identity) && static_cast<ULONGLONG>(msg->lParam) == gRequest.token &&
        (msg->wParam == 2 || msg->wParam == 3)) {
      if (msg->wParam == 3) gCurrentReceipt->Timeout();
      const auto receipt = gCurrentReceipt->Read();
      if (msg->wParam == 3)
        gShared->cleanupAcknowledged = CleanupEligible(gShared->callbackCreated, receipt) ? 1 : 0;
      Publish();
#ifdef QN_DIRECT_GENERAL
      if (msg->wParam == 3 && gShared->cleanupAcknowledged) {
        UnmapViewOfFile(gShared); CloseHandle(gMapping);
        gShared = nullptr; gMapping = nullptr;
      }
#endif
    }
    return CallNextHookEx(nullptr, code, wp, lp);
  }
  if (msg->wParam != 1) return CallNextHookEx(nullptr, code, wp, lp);
  QnLiveIdentity own{}; own.pid = GetCurrentProcessId();
  FILETIME exited{}, kernel{}, user{};
  if (!GetProcessTimes(GetCurrentProcess(), &own.processCreated, &exited, &kernel, &user))
    return CallNextHookEx(nullptr, code, wp, lp);
  wchar_t name[128]{}; Name(name, own);
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  auto* shared = mapping ? static_cast<Shared*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared))) : nullptr;
  if (!shared) { if (mapping) CloseHandle(mapping); return CallNextHookEx(nullptr, code, wp, lp); }
  const Request request = shared->request;
  const bool valid = request.magic == kMagic && request.size == sizeof(Shared) && request.token &&
      request.token == static_cast<ULONGLONG>(msg->lParam) && OnGui(msg->hwnd, request.identity) &&
      request.expires > GetTickCount64() && request.expires - GetTickCount64() <= 90000 &&
      request.shop[31] == 0 && request.cid[127] == 0 && ValidShop(request.shop, sizeof(request.shop)) &&
      ValidCid(request.cid, sizeof(request.cid)) && ValidText(request.text, sizeof(request.text)) &&
#ifndef QN_DIRECT_GENERAL
      !std::strcmp(request.shop, kShop) && !std::strcmp(request.cid, kCid) &&
#endif
      true;
  if (!valid || InterlockedCompareExchange(&shared->phase, Checking, Pending) != Pending) {
    UnmapViewOfFile(shared); CloseHandle(mapping); return CallNextHookEx(nullptr, code, wp, lp);
  }
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      reinterpret_cast<LPCWSTR>(&gRequest), &gPinned)) {
    shared->error = GetLastError(); InterlockedExchange(&shared->phase, Rejected);
    UnmapViewOfFile(shared); CloseHandle(mapping); return CallNextHookEx(nullptr, code, wp, lp);
  }
  // The request and receipt outlive the controller, including an ambiguous timeout.
  gRequest = request; gMapping = mapping; gShared = shared; gShared->resident = 1;
  wchar_t path[32768]{};
  if (!GetModuleFileNameW(gPinned, path, 32768) || _wcsicmp(path, kDll)) Reject(ERROR_INVALID_NAME);
  else {
    try { Run(); }
    catch (...) { Reject(ERROR_UNHANDLED_EXCEPTION); }
  }
  return CallNextHookEx(nullptr, code, wp, lp);
}
