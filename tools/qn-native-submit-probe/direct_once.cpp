#include "direct_once_memory.h"
#include <bcrypt.h>
#include <chrono>
#include <iostream>
#include <string>
#include <unordered_map>
#ifdef QN_DIRECT_V2
#include "direct_window_watch.h"
#endif

namespace {
using namespace direct_once;
struct View { Shared* value; ~View() { if (value) UnmapViewOfFile(value); } };
#ifdef QN_DIRECT_GENERAL
struct AdmissionCache {
  std::string shop;
  QnLiveIdentity identity{};
  ULONG_PTR service = 0, biz = 0;
  bool valid = false;
};
std::unordered_map<std::string, AdmissionCache> gAdmissionCaches;
#endif
bool Transport(const QnLiveIdentity& id, Shared* s, unsigned command) {
  HMODULE module = LoadLibraryW(kDll);
  if (!module) return false;
  const auto procedure = direct_receipt::Resolve<HOOKPROC>(module, "QnDirectOnceHook");
  HHOOK hook = procedure ? SetWindowsHookExW(WH_CALLWNDPROC, procedure, module, id.tid) : nullptr;
  if (!hook) { FreeLibrary(module); return false; }
  DWORD_PTR response = 0; const LONG sequence = Load(&s->sequence);
  const auto sent = SendMessageTimeoutW(reinterpret_cast<HWND>(id.hwnd), RegisterWindowMessageW(kMessage),
      command, static_cast<LPARAM>(s->request.token), SMTO_BLOCK | SMTO_ABORTIFHUNG, 10000, &response);
  const auto error = sent ? 0 : GetLastError();
  const BOOL removed = UnhookWindowsHookEx(hook); FreeLibrary(module);
  std::printf("TRANSPORT command=%u sent=%d error=%lu unhooked=%d\n", command, !!sent, error, !!removed);
  return sent && removed && Load(&s->sequence) > sequence && s->actualPid == id.pid &&
      s->actualTid == id.tid && s->receiptToken == s->request.token;
}
bool RetireExisting(const QnLiveIdentity& id, const wchar_t* name) {
  Handle mapping(OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name));
  View view{mapping ? static_cast<Shared*>(MapViewOfFile(mapping.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared))) : nullptr};
  auto* s = view.value;
  if (!s || s->request.magic != kMagic || s->request.size != sizeof(Shared) || !s->request.token ||
      std::memcmp(&s->request.identity, &id, sizeof(id)) || !s->resident || !ModuleBase(id.pid, kDll)) {
    std::puts("RECOVERY existing=1 valid=0 retired=0 retry=0");
    return false;
  }
  const bool refreshed = Transport(id, s, 2);
  const bool eligible = refreshed && CleanupEligible(s->callbackCreated, s->receipt);
  const bool transported = eligible && Transport(id, s, 3);
  const bool acknowledged = transported && s->cleanupAcknowledged == 1;
  std::printf("RECOVERY existing=1 valid=1 refreshed=%d eligible=%d transport=%d acknowledged=%d retired=%d retry=0\n",
      refreshed, eligible, transported, acknowledged, acknowledged);
  return acknowledged;
}
void Print(Shared* s) {
  const auto r = s->receipt;
  std::printf("RESULT phase=%ld error=%lu resident=%lu admitted=%lu arguments=%lu caller_released=%lu "
      "entered=%lu returned=%lu callbacks=%lu before_return=%lu late=%lu timed_out=%lu destroyed=%lu "
      "invalid=%lu conflicts=%lu callback_created=%lu cleanup_ack=%lu snapshot_status=%d result_valid=%d "
      "result=%d messageId=%s clientId=%s callback_tid=%lu retry=0\n",
      Load(&s->phase), s->error, s->resident, s->admitted, s->argumentsValid, s->callerReleased,
      r.entered, r.returned, r.callbacks, r.beforeReturn, r.late, r.timedOut, r.destroyed, r.invalid, r.conflicts,
      s->callbackCreated, s->cleanupAcknowledged,
      static_cast<int>(r.first.status), r.first.resultCodeValid, r.first.resultCode,
      r.first.messageId.data(), r.first.clientId.data(), r.callbackTid);
}
int Run(const wchar_t* mode, const char* text, const char* shop = nullptr, const char* cid = nullptr) {
#ifndef QN_DIRECT_GENERAL
  (void)shop; (void)cid;
#endif
  const ULONGLONG timingStart = GetTickCount64();
  const bool preflight = !std::wcscmp(mode, L"--preflight"), status = !std::wcscmp(mode, L"--status");
  Handle dll(CreateFileW(kDll, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
  QnLiveIdentity id{};
  bool selected = false;
#ifdef QN_DIRECT_GENERAL
  ULONG_PTR selectedService = 0, selectedBiz = 0; bool cacheHit = false;
  const auto cached = shop ? gAdmissionCaches.find(shop) : gAdmissionCaches.end();
  if (cached != gAdmissionCaches.end() && cached->second.valid && Check(cached->second.identity)) {
    id = cached->second.identity; selectedService = cached->second.service;
    selectedBiz = cached->second.biz; selected = cacheHit = true;
  } else {
    if (cached != gAdmissionCaches.end()) gAdmissionCaches.erase(cached);
    selected = shop ? SelectForShop(&id, shop, &selectedService, &selectedBiz) : false;
  }
#else
  selected = Select(&id);
#endif
  const ULONGLONG selectedAt = GetTickCount64();
#ifdef QN_DIRECT_GENERAL
  QnNativeLayout layout{};
  if (!selected || !QnResolveNativeLayout(id.pid, &layout)) { std::puts("REFUSE native_layout_or_identity sdk_send=0"); return 2; }
  const auto appPath = layout.appPath, prgPath = layout.prgPath;
  const auto& profile = *layout.profile;
#else
  const auto appPath = kApp, prgPath = kPrg;
  const auto& profile = kQnNativeProfiles[0];
#endif
  Handle app(CreateFileW(appPath, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
  Handle prg(CreateFileW(prgPath, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
  if (!app || !prg || !dll || !selected) { std::puts("REFUSE identity_or_disk_handles"); return 2; }
  Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, id.pid));
  Handle thread(OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, id.tid));
  DWORD session = MAXDWORD;
  if (!process || !thread || !ProcessIdToSessionId(GetCurrentProcessId(), &session) || session != id.session) return 2;
  const auto prgBase = ModuleBase(id.pid, prgPath);
  if (!NativeGuard(id, prgBase)) { std::puts("REFUSE native_entry_hash_bytes"); return 3; }
  Request r{}; r.identity = id; r.prgBase = prgBase; r.size = sizeof(Shared);
#ifdef QN_DIRECT_GENERAL
  char account[64]{};
  if (!status && (!shop || !ValidShop(shop, 32) || (cid && !ValidCid(cid, 128)))) {
    std::puts("REFUSE invalid_shop_or_cid retry=0"); return 4;
  }
  if (!status) sprintf_s(account, "3#%s", shop);
#endif
  if (!status &&
#ifdef QN_DIRECT_GENERAL
      (!selectedService || !selectedBiz ||
       !Service(process.value, id.appBase, selectedService, &r.messageBiz, account, profile) ||
       r.messageBiz != selectedBiz)
#else
      !FindService(process.value, id.appBase, &r.service, &r.messageBiz,
#ifdef QN_DIRECT_GENERAL
      account
#else
      kAccount
#endif
      , profile)
#endif
      ) {
#ifdef QN_DIRECT_GENERAL
    if (shop) gAdmissionCaches.erase(shop);
#endif
    std::puts("REFUSE unique_ready_service"); return 4;
  }
#ifdef QN_DIRECT_GENERAL
  r.service = selectedService;
  if (!cacheHit) {
    if (gAdmissionCaches.size() >= 16) gAdmissionCaches.clear();
    gAdmissionCaches[shop] = {shop, id, r.service, r.messageBiz, true};
  }
#endif
  const ULONGLONG admittedAt = GetTickCount64();
  std::printf("ADMISSION pid=%lu tid=%lu created=%llu hwnd=0x%llx appbase=0x%llx prgbase=0x%llx "
      "service=0x%llx biz=0x%llx account=%s cache=%d\n", id.pid, id.tid, Created(id),
      static_cast<unsigned long long>(id.hwnd), static_cast<unsigned long long>(id.appBase),
      static_cast<unsigned long long>(prgBase), static_cast<unsigned long long>(r.service),
      static_cast<unsigned long long>(r.messageBiz),
#ifdef QN_DIRECT_GENERAL
      account
#else
      kAccount
#endif
      ,
#ifdef QN_DIRECT_GENERAL
      cacheHit ? 1 : 0
#else
      0
#endif
      );
  if (preflight) {
    std::printf("LAYOUT profile=%ls app=%ls prg=%ls send_rva=0x%lx\n", profile.name, appPath, prgPath, profile.entries[0]);
    std::printf("PREFLIGHT passed=1 hook=0 sdk_send=0 minimized=%d foreground=0x%llx\n",
        !!IsIconic(reinterpret_cast<HWND>(id.hwnd)), reinterpret_cast<unsigned long long>(GetForegroundWindow()));
    return 0;
  }
  wchar_t name[128]{}; Name(name, id);
  HANDLE mappingValue = nullptr;
  if (status) mappingValue = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name);
  else {
    SetLastError(ERROR_SUCCESS);
    mappingValue = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Shared), name);
    const DWORD mapError = GetLastError();
    if (mappingValue && mapError == ERROR_ALREADY_EXISTS) {
      CloseHandle(mappingValue); mappingValue = nullptr;
      if (RetireExisting(id, name)) {
        SetLastError(ERROR_SUCCESS);
        mappingValue = CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Shared), name);
        if (GetLastError() == ERROR_ALREADY_EXISTS) { CloseHandle(mappingValue); mappingValue = nullptr; }
      }
    }
  }
  Handle mapping(mappingValue);
  if (!mapping) {
    std::puts("REFUSE missing_or_consumed_epoch retry=0"); return 5;
  }
  View view{static_cast<Shared*>(MapViewOfFile(mapping.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)))};
  if (!view.value) return 5;
  auto* s = view.value;
  if (!status) {
    if (!ValidText(text, kTextCapacity)) return 5;
#ifdef QN_DIRECT_GENERAL
    strcpy_s(r.shop, shop); strcpy_s(r.cid, cid);
#else
    strcpy_s(r.shop, kShop); strcpy_s(r.cid, kCid);
#endif
    strcpy_s(r.text, text);
    r.expires = GetTickCount64() + 60000;
    if (BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&r.token), sizeof(r.token),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0 || !r.token) return 5;
    wchar_t journal[512]{};
#ifdef QN_DIRECT_GENERAL
    swprintf_s(journal, L"D:\\project-electron\\ai-customer-service\\.tmp\\qn-native-submit-probe\\direct-%ls-consumed-%lu-%llu-%llu.bin", kEpoch, id.pid, Created(id), r.token);
#else
    swprintf_s(journal, L"D:\\project-electron\\ai-customer-service\\.tmp\\qn-native-submit-probe\\direct-%ls-consumed-%lu-%llu.bin", kEpoch, id.pid, Created(id));
#endif
    Handle intent(CreateFileW(journal, GENERIC_WRITE, FILE_SHARE_READ, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    DWORD written = 0;
    if (!intent || !WriteFile(intent.value, &r, sizeof(r), &written, nullptr) || written != sizeof(r) || !FlushFileBuffers(intent.value)) {
      std::puts("REFUSE intent_already_consumed_or_not_durable retry=0"); return 5;
    }
    *s = Shared{}; s->request = r;
    std::printf("INTENT consumed=1 expires_tick=%llu token=%llu text_bytes=%zu\n",
        r.expires, r.token, std::strlen(r.text));
  } else if (s->request.magic != kMagic || s->request.size != sizeof(Shared) || !s->request.token ||
      std::memcmp(&s->request.identity, &id, sizeof(id)) || !s->resident || !ModuleBase(id.pid, kDll)) return 5;
  if (!Check(id) || WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT ||
      WaitForSingleObject(thread.value, 0) != WAIT_TIMEOUT) return 6;
  const HWND foreground = GetForegroundWindow(); const BOOL minimized = IsIconic(reinterpret_cast<HWND>(id.hwnd));
#ifdef QN_DIRECT_V2
  DirectWindowWatch watch(reinterpret_cast<HWND>(id.hwnd));
  if (!watch.Start() || (!status && !minimized)) {
    std::puts("REFUSE minimized_window_observation_not_ready retry=0"); return 6;
  }
#endif
  bool ok = Transport(id, s, status ? 2 : 1);
  if (ok && !status && Load(&s->phase) == Returned) {
    const ULONGLONG deadline = GetTickCount64() + 20000;
    while (GetTickCount64() < deadline && (!s->receipt.callbacks || !s->receipt.destroyed)) {
      Sleep(100);
      if (WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT || !Transport(id, s, 2)) { ok = false; break; }
    }
  }
  bool cleanupAttempted = false, cleanupTransport = false, cleanupAcknowledged = false;
#ifdef QN_DIRECT_GENERAL
  if (!status && s->resident && WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT) {
    cleanupAttempted = true;
    cleanupTransport = Transport(id, s, 3);
    cleanupAcknowledged = cleanupTransport && s->cleanupAcknowledged == 1;
  }
#endif
  if (ok) Print(s); else std::puts("OUTCOME unknown fresh_receipt=0 retry=0");
  if (!status) std::printf("CLEANUP attempted=%d transport=%d acknowledged=%d retry=0\n",
      cleanupAttempted, cleanupTransport, cleanupAcknowledged);
  const bool alive = WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT;
#ifdef QN_DIRECT_V2
  // Keep observing briefly after completion for delayed window activation.
  if (!status && ok) Sleep(2000);
  watch.Stop(); watch.Print();
#endif
  std::printf("POSTCHECK alive=%d identity=%d foreground_endpoints_unchanged=%d minimized_endpoints_unchanged=%d "
      "activation_calls=0 editor_calls=0 enter_calls=0\n", alive, alive && Check(id), foreground == GetForegroundWindow(),
      minimized == IsIconic(reinterpret_cast<HWND>(id.hwnd)));
  const int result = ok && alive && Load(&s->phase) == Returned && !s->error
#ifdef QN_DIRECT_GENERAL
      && cleanupAcknowledged
#endif
      ? 0 : 6;
#ifdef QN_DIRECT_GENERAL
  if (result && shop) gAdmissionCaches.erase(shop);
#endif
  std::printf("NATIVE_TIMING select_ms=%llu admit_ms=%llu execute_ms=%llu total_ms=%llu cache=%d\n",
      selectedAt - timingStart, admittedAt - selectedAt, GetTickCount64() - admittedAt,
      GetTickCount64() - timingStart,
#ifdef QN_DIRECT_GENERAL
      cacheHit ? 1 : 0
#else
      0
#endif
      );
  return result;
}
#ifdef QN_DIRECT_GENERAL
bool RpcId(const std::string& value) {
  if (value.empty() || value.size() > 128) return false;
  for (const unsigned char c : value)
    if (!std::isalnum(c) && c != '-' && c != '_' && c != '.') return false;
  return true;
}
bool HexText(const std::string& value, std::string* output) {
  if (!output || value.empty() || value.size() % 2 || value.size() >= kTextCapacity * 2) return false;
  output->clear(); output->reserve(value.size() / 2);
  auto digit = [](const unsigned char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  for (std::size_t i = 0; i < value.size(); i += 2) {
    const int high = digit(static_cast<unsigned char>(value[i]));
    const int low = digit(static_cast<unsigned char>(value[i + 1]));
    if (high < 0 || low < 0) return false;
    output->push_back(static_cast<char>((high << 4) | low));
  }
  if (output->empty() || output->size() >= kTextCapacity) return false;
  for (const unsigned char c : *output) if (c == 0 || c == '\r') return false;
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, output->data(),
      static_cast<int>(output->size()), nullptr, 0) > 0;
}
int Rpc() {
  std::printf("RPC_READY pid=%lu protocol=1\n", GetCurrentProcessId());
  std::string line;
  while (std::getline(std::cin, line)) {
    if (!line.empty() && line.back() == '\r') line.pop_back();
    if (line == "QUIT") { std::puts("RPC_BYE"); return 0; }
    std::string fields[5]; std::size_t start = 0; bool valid = true;
    for (std::size_t i = 0; i < 4; ++i) {
      const auto tab = line.find('\t', start);
      if (tab == std::string::npos) { valid = false; break; }
      fields[i] = line.substr(start, tab - start); start = tab + 1;
    }
    fields[4] = line.substr(start);
    std::string text;
    const std::string requestId = RpcId(fields[1]) ? fields[1] : "invalid";
    char shop[32]{}, cid[128]{}, textBuffer[kTextCapacity]{};
    if (fields[2].size() < sizeof(shop)) strcpy_s(shop, fields[2].c_str());
    if (fields[3].size() < sizeof(cid)) strcpy_s(cid, fields[3].c_str());
    if (!valid || fields[0] != "SEND" || !RpcId(fields[1]) ||
        !ValidShop(shop, sizeof(shop)) || !ValidCid(cid, sizeof(cid)) ||
        !HexText(fields[4], &text)) {
      std::printf("RPC_RESULT id=%s code=2 duration_ms=0 retry=0\n", requestId.c_str());
      continue;
    }
    strcpy_s(textBuffer, text.c_str());
    const auto started = std::chrono::steady_clock::now();
    const int code = Run(L"--send-once", textBuffer, shop, cid);
    const auto duration = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started).count();
    std::printf("RPC_RESULT id=%s code=%d duration_ms=%lld retry=0\n",
        requestId.c_str(), code, static_cast<long long>(duration));
  }
  return 0;
}
#endif
}
int wmain(int argc, wchar_t** argv) {
  std::setvbuf(stdout, nullptr, _IONBF, 0);
  try {
#ifdef QN_DIRECT_GENERAL
    if (argc == 2 && !std::wcscmp(argv[1], L"--stdio-rpc")) return Rpc();
    if (argc == 3 && !std::wcscmp(argv[1], L"--validate-text")) {
      char text[kTextCapacity]{};
      if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[2], -1, text, sizeof(text), nullptr, nullptr) ||
          !ValidText(text, sizeof(text))) { std::puts("TEXT valid=0 sdk_send=0"); return 2; }
      std::printf("TEXT valid=1 bytes=%zu capacity=%zu shared_size=%zu sdk_send=0\n", std::strlen(text), kTextCapacity, sizeof(Shared));
      return 0;
    }
    if (argc == 3 && !std::wcscmp(argv[1], L"--preflight")) {
      char shop[32]{};
      if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[2], -1, shop, sizeof(shop), nullptr, nullptr) ||
          !ValidShop(shop, sizeof(shop))) return 2;
      return Run(argv[1], "", shop, nullptr);
    }
#endif
    if (argc == 2 && (!std::wcscmp(argv[1], L"--preflight") || !std::wcscmp(argv[1], L"--status"))) return Run(argv[1], "");
    if (
#ifdef QN_DIRECT_GENERAL
        argc == 6 &&
#else
        argc == 4 &&
#endif
        !std::wcscmp(argv[1], L"--send-once") && !std::wcscmp(argv[2], L"QN_DIRECT_SEND_ONCE")) {
#ifdef QN_DIRECT_GENERAL
      char shop[32]{}, cid[128]{}, text[kTextCapacity]{};
      if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[3], -1, shop, sizeof(shop), nullptr, nullptr) ||
          !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[4], -1, cid, sizeof(cid), nullptr, nullptr) ||
          !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[5], -1, text, sizeof(text), nullptr, nullptr) ||
          !ValidShop(shop, sizeof(shop)) || !ValidCid(cid, sizeof(cid)) || !ValidText(text, sizeof(text))) return 2;
      return Run(argv[1], text, shop, cid);
#else
      char text[256]{};
      if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[3], -1, text, sizeof(text), nullptr, nullptr) ||
          !ValidText(text, sizeof(text))) return 2;
      return Run(argv[1], text);
#endif
    }
    std::puts("Usage: --preflight | --status | --stdio-rpc | --send-once QN_DIRECT_SEND_ONCE [shopUid cid text]");
    return 2;
  } catch (...) { std::puts("OUTCOME controller_exception unknown retry=0"); return 7; }
}
