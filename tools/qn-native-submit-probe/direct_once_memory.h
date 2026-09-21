#pragma once
#include "direct_once_shared.h"
#include <tlhelp32.h>
#include <vector>
#include <algorithm>
#include <string>

namespace direct_once {
inline bool Read(HANDLE process, ULONG_PTR address, void* dst, SIZE_T size) {
  SIZE_T got = 0;
  return address && ReadProcessMemory(process, reinterpret_cast<void*>(address), dst, size, &got) && got == size;
}
template<class T> bool Read(HANDLE process, ULONG_PTR address, T* out) { return Read(process, address, out, sizeof(T)); }
inline bool String(HANDLE process, ULONG_PTR address, char* output, SIZE_T capacity) {
  unsigned char descriptor[32]{}; SIZE_T length = 0, allocated = 0; ULONG_PTR data = address;
  if (!Read(process, address, descriptor, 32)) return false;
  std::memcpy(&length, descriptor + 16, 8); std::memcpy(&allocated, descriptor + 24, 8);
  if (length >= capacity || allocated < length || allocated > 4096 || (allocated <= 15 && allocated != 15)) return false;
  if (allocated > 15) std::memcpy(&data, descriptor, 8);
  return Read(process, data, output, length + 1) && output[length] == 0 && std::strlen(output) == length;
}
inline bool Service(HANDLE process, ULONG_PTR base, ULONG_PTR service, ULONG_PTR* biz,
                    const char* expectedAccount = kAccount, const QnNativeProfile& profile = kQnNativeProfiles[0]) {
  ULONG_PTR vtable = 0, identifier = 0, entry = 0, ready = 0; int type = 0; char account[64]{};
  if (!Read(process, service, &vtable) || vtable != base + profile.serviceVtable ||
      !Read(process, vtable + 18 * 8, &entry) || entry != base + profile.entries[0] ||
      !Read(process, service + 0x378, &identifier) || identifier != base + profile.identityVtable ||
      !String(process, service + 0x3d0, account, sizeof(account)) || std::strcmp(account, expectedAccount) ||
      !Read(process, service + 0x3f0, &type) || type != 2 || !Read(process, service + 0x578, &ready) || !ready ||
      !Read(process, ready, &entry) || !entry) return false;
  *biz = ready; return true;
}
inline bool FindService(HANDLE process, ULONG_PTR base, ULONG_PTR* service, ULONG_PTR* biz,
                        const char* expectedAccount = kAccount, const QnNativeProfile& profile = kQnNativeProfiles[0]) {
  SYSTEM_INFO sys{}; GetSystemInfo(&sys); unsigned matches = 0;
  auto cursor = reinterpret_cast<ULONG_PTR>(sys.lpMinimumApplicationAddress);
  const auto maximum = reinterpret_cast<ULONG_PTR>(sys.lpMaximumApplicationAddress);
  std::vector<unsigned char> bytes(1024 * 1024); SIZE_T total = 0;
  const ULONGLONG deadline = GetTickCount64() + 20000;
  while (cursor < maximum) {
    MEMORY_BASIC_INFORMATION m{};
    if (!VirtualQueryEx(process, reinterpret_cast<void*>(cursor), &m, sizeof(m))) return false;
    const auto start = reinterpret_cast<ULONG_PTR>(m.BaseAddress), end = start + m.RegionSize;
    if (end <= cursor) return false;
    const DWORD p = m.Protect & 0xff;
    if (m.State == MEM_COMMIT && m.Type == MEM_PRIVATE && !(m.Protect & PAGE_GUARD) &&
        (p == PAGE_READONLY || p == PAGE_READWRITE || p == PAGE_WRITECOPY || p == PAGE_EXECUTE_READ || p == PAGE_EXECUTE_READWRITE)) {
      for (auto block = start; block < end; block += bytes.size()) {
        if (GetTickCount64() > deadline || total > SIZE_T(4) * 1024 * 1024 * 1024) return false;
        const SIZE_T count = std::min(bytes.size(), static_cast<SIZE_T>(end - block));
        if (!Read(process, block, bytes.data(), count)) return false;
        total += count;
        for (SIZE_T i = 0; i + 8 <= count; i += 8) {
          ULONG_PTR vtable = 0, ready = 0; std::memcpy(&vtable, bytes.data() + i, 8);
          if (vtable == base + profile.serviceVtable && Service(process, base, block + i, &ready, expectedAccount, profile)) {
            *service = block + i; *biz = ready; if (++matches > 1) return false;
          }
        }
      }
    }
    cursor = end;
  }
  return matches == 1;
}
inline ULONG_PTR ModuleBase(DWORD pid, const wchar_t* path) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid)); if (!snapshot) return 0;
  MODULEENTRY32W m{}; m.dwSize = sizeof(m); ULONG_PTR base = 0; unsigned count = 0;
  for (BOOL more = Module32FirstW(snapshot.value, &m); more; more = Module32NextW(snapshot.value, &m))
    if (!_wcsicmp(m.szExePath, path)) { base = reinterpret_cast<ULONG_PTR>(m.modBaseAddr); ++count; }
  return count == 1 ? base : 0;
}
inline bool NativeGuard(const QnLiveIdentity& id, ULONG_PTR prgBase) {
#ifdef QN_DIRECT_GENERAL
  QnNativeLayout layout{};
  if (!QnResolveNativeLayout(id.pid, &layout) || layout.appBase != id.appBase || layout.prgBase != prgBase) return false;
  const auto appPath = layout.appPath, prgPath = layout.prgPath;
  const auto& profile = *layout.profile;
#else
  const auto appPath = kApp, prgPath = kPrg;
  const auto& profile = kQnNativeProfiles[0];
#endif
  // DONT_RESOLVE gives export RVAs without invoking the vendor DLL in the controller.
  HMODULE image = LoadLibraryExW(prgPath, nullptr, DONT_RESOLVE_DLL_REFERENCES);
  if (!image) return false;
  DWORD entries[5]{}; bool valid = true;
  for (std::size_t i = 0; i < 5; ++i) {
    const auto p = reinterpret_cast<ULONG_PTR>(GetProcAddress(image, direct_receipt::kExports[i]));
    const auto b = reinterpret_cast<ULONG_PTR>(image);
    if (p <= b || p - b > 16 * 1024 * 1024) { valid = false; break; }
    entries[i] = static_cast<DWORD>(p - b);
  }
  FreeLibrary(image);
  return valid && QnCheckNativeCode(id.pid, appPath, profile.appHash, id.appBase, profile.entries, 5) &&
      QnCheckNativeCode(id.pid, prgPath, profile.prgHash, prgBase, entries, 5);
}

#ifdef QN_DIRECT_GENERAL
struct ShopWindowCandidate {
  HWND window = nullptr;
  DWORD pid = 0, tid = 0;
  bool visible = false;
  wchar_t title[256]{};
};
inline bool FindAppModule(DWORD pid, MODULEENTRY32W* result) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid));
  if (!snapshot) return false;
  MODULEENTRY32W item{}; item.dwSize = sizeof(item); unsigned matches = 0;
  for (BOOL more = Module32FirstW(snapshot.value, &item); more; more = Module32NextW(snapshot.value, &item)) {
    if (!_wcsicmp(item.szModule, L"AppBiz.dll")) { *result = item; ++matches; }
  }
  return GetLastError() == ERROR_NO_MORE_FILES && matches == 1;
}
inline BOOL CALLBACK FindShopWindow(HWND window, LPARAM parameter) {
  wchar_t className[128]{};
  if (!GetClassNameW(window, className, 128) || std::wcscmp(className, L"Qt5152QWindowIcon")) return TRUE;
  DWORD pid = 0; const DWORD tid = GetWindowThreadProcessId(window, &pid);
  if (pid) {
    ShopWindowCandidate candidate{}; candidate.window = window; candidate.pid = pid; candidate.tid = tid;
    candidate.visible = !!IsWindowVisible(window);
    GetWindowTextW(window, candidate.title, 256);
    static_cast<std::vector<ShopWindowCandidate>*>(reinterpret_cast<void*>(parameter))->push_back(candidate);
  }
  return TRUE;
}
inline int WindowScore(const ShopWindowCandidate& window) {
  int score = window.visible ? 100 : 0;
  if (!std::wcscmp(window.title, L"\u5343\u725b\u63a5\u5f85\u53f0")) score += 1000;
  else if (!std::wcscmp(window.title, L"\u5343\u725b\u5de5\u4f5c\u53f0")) score += 500;
  else if (!std::wcscmp(window.title, L"\u5343\u725b\u767b\u5f55")) score += 100;
  return score;
}
inline bool SelectProcessWindow(const std::vector<ShopWindowCandidate>& windows, DWORD pid, ShopWindowCandidate* result) {
  int bestScore = -1; unsigned ties = 0; ShopWindowCandidate selected{};
  for (const auto& window : windows) {
    if (window.pid != pid || !window.window || !window.tid) continue;
    const int score = WindowScore(window);
    if (score > bestScore) { bestScore = score; ties = 1; selected = window; }
    else if (score == bestScore) { ++ties; }
  }
  if (ties != 1 || bestScore < 0) return false;
  *result = selected; return true;
}
inline bool SelectForShop(QnLiveIdentity* identity, const char* shop, ULONG_PTR* selectedService,
                          ULONG_PTR* selectedBiz) {
  if (!identity || !ValidShop(shop, 32)) return false;
  const std::string account = std::string("3#") + shop;
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot) return false;
  std::vector<ShopWindowCandidate> windows;
  if (!EnumWindows(FindShopWindow, reinterpret_cast<LPARAM>(&windows))) return false;
  PROCESSENTRY32W entry{}; entry.dwSize = sizeof(entry); unsigned matches = 0;
  unsigned processes = 0, noWindow = 0, noHandles = 0, noModule = 0, noIdentity = 0, noService = 0, unsupported = 0;
  QnLiveIdentity selected{}; ULONG_PTR selectedServiceValue = 0, selectedBizValue = 0;
  for (BOOL more = Process32FirstW(snapshot.value, &entry); more; more = Process32NextW(snapshot.value, &entry)) {
    if (_wcsicmp(entry.szExeFile, L"AliWorkbench.exe")) continue;
    ++processes;
    QnLiveIdentity candidate{}; candidate.pid = entry.th32ProcessID;
    Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, candidate.pid));
    FILETIME exited{}, kernel{}, user{}; MODULEENTRY32W app{}; bool research = false;
    if (!process || !GetProcessTimes(process.value, &candidate.processCreated, &exited, &kernel, &user) ||
        !ProcessIdToSessionId(candidate.pid, &candidate.session)) { ++noHandles; continue; }
    if (!FindAppModule(candidate.pid, &app) || research) { ++noModule; continue; }
    candidate.appBase = reinterpret_cast<ULONG_PTR>(app.modBaseAddr); candidate.appSize = app.modBaseSize;
    QnNativeLayout layout{};
    if (!QnResolveNativeLayout(candidate.pid, &layout) || layout.appBase != candidate.appBase) { ++unsupported; continue; }
    ULONG_PTR service = 0, biz = 0;
    if (!FindService(process.value, candidate.appBase, &service, &biz, account.c_str(), *layout.profile)) { ++noService; continue; }
    ShopWindowCandidate processWindow{};
    if (!SelectProcessWindow(windows, candidate.pid, &processWindow)) { ++noWindow; continue; }
    candidate.tid = processWindow.tid;
    candidate.hwnd = reinterpret_cast<ULONG_PTR>(processWindow.window);
    Handle thread(OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, candidate.tid));
    if (!thread || !GetThreadTimes(thread.value, &candidate.threadCreated, &exited, &kernel, &user)) {
      ++noHandles; continue;
    }
    if (!QnCheckLiveIdentity(candidate, kDll, kNoSend, kV1, kV2, kV3, kDirectV1)) { ++noIdentity; continue; }
    selected = candidate; selectedServiceValue = service; selectedBizValue = biz;
    if (++matches > 1) return false;
  }
  if (GetLastError() != ERROR_NO_MORE_FILES || matches != 1) {
    std::printf("SELECT_DIAG processes=%u windows=%zu no_window=%u no_handles=%u no_module=%u no_identity=%u no_service=%u unsupported=%u matches=%u account=%s\n",
        processes, windows.size(), noWindow, noHandles, noModule, noIdentity, noService, unsupported, matches, account.c_str());
    return false;
  }
  *identity = selected;
  if (selectedService) *selectedService = selectedServiceValue;
  if (selectedBiz) *selectedBiz = selectedBizValue;
  return true;
}
#endif
}
