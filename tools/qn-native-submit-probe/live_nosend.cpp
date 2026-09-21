#include "live_nosend_shared.h"
#include <bcrypt.h>
#include <tlhelp32.h>
#include <array>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

namespace {
using namespace live_nosend;
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE v) : value(v) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
  Handle(const Handle&) = delete;
};
struct View { Shared* value; ~View() { if (value) UnmapViewOfFile(value); } };
bool Hash(HANDLE file, std::wstring* hash) {
  LARGE_INTEGER size{};
  if (!GetFileSizeEx(file, &size) || size.QuadPart <= 0 || size.QuadPart > 64 * 1024 * 1024) return false;
  std::vector<BYTE> bytes(static_cast<SIZE_T>(size.QuadPart)); DWORD count = 0;
  if (!ReadFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) || count != bytes.size()) return false;
  BCRYPT_ALG_HANDLE alg = nullptr; BCRYPT_HASH_HANDLE h = nullptr;
  if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  DWORD n = 0, returned = 0; bool ok = false;
  if (BCryptGetProperty(alg, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&n), sizeof(n), &returned, 0) >= 0) {
    std::vector<BYTE> storage(n); std::array<BYTE, 32> digest{};
    if (BCryptCreateHash(alg, &h, storage.data(), n, nullptr, 0, 0) >= 0) {
      ok = BCryptHashData(h, bytes.data(), static_cast<ULONG>(bytes.size()), 0) >= 0 &&
          BCryptFinishHash(h, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0;
      BCryptDestroyHash(h);
      if (ok) for (BYTE b : digest) { wchar_t hex[3]{}; swprintf_s(hex, L"%02X", b); *hash += hex; }
    }
  }
  BCryptCloseAlgorithmProvider(alg, 0); return ok;
}
bool ResidentModule(DWORD pid, ULONG_PTR base) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid));
  if (!snapshot) return false;
  MODULEENTRY32W m{}; m.dwSize = sizeof(m);
  for (BOOL more = Module32FirstW(snapshot.value, &m); more; more = Module32NextW(snapshot.value, &m))
    if (_wcsicmp(m.szExePath, kDllPath) == 0 && reinterpret_cast<ULONG_PTR>(m.modBaseAddr) == base) return true;
  return false;
}
int Run(bool install) {
  Handle file(CreateFileW(kDllPath, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  Handle appFile(CreateFileW(L"D:\\qianniu\\9.97.80N\\AppBiz.dll", GENERIC_READ, FILE_SHARE_READ,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  std::wstring hash;
  if (!file || !appFile || !Hash(file.value, &hash)) { std::puts("REFUSE disk_handles_or_module_hash"); return 2; }
  QnLiveIdentity id{};
  if (!QnSelectLiveIdentity(&id, kDllPath)) { std::puts("REFUSE live_identity_admission"); return 3; }
  Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, id.pid));
  Handle thread(OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, id.tid));
  DWORD callerSession = MAXDWORD;
  if (!process || !thread || !ProcessIdToSessionId(GetCurrentProcessId(), &callerSession) ||
      callerSession != id.session) { std::puts("REFUSE retained_handles_or_session"); return 3; }
  std::wprintf(L"ADMISSION pid=%lu tid=%lu hwnd=0x%llx appbase=0x%llx session=%lu retained_handles=1 dll_sha256=%ls\n",
      id.pid, id.tid, static_cast<unsigned long long>(id.hwnd), static_cast<unsigned long long>(id.appBase), id.session, hash.c_str());
  wchar_t name[128]{}; Name(name, id);
  Handle mapping(install ? CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Shared), name) :
      OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name));
  const DWORD mapError = GetLastError();
  if (!mapping || (install && mapError == ERROR_ALREADY_EXISTS)) {
    std::printf("REFUSE mapping_or_existing_install win32=%lu retry=0\n", mapError); return 4;
  }
  View view{static_cast<Shared*>(MapViewOfFile(mapping.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)))};
  if (!view.value) return 4;
  auto* s = view.value;
  if (install) {
    *s = {}; s->request.magic = kMagic; s->request.version = kVersion; s->request.size = sizeof(Shared);
    s->request.identity = id;
    if (BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&s->request.token), sizeof(s->request.token),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0 || !s->request.token) return 4;
    wcscpy_s(s->request.dllHash, hash.c_str());
  } else if (s->request.magic != kMagic || s->request.version != kVersion || s->request.size != sizeof(Shared) ||
      !SameIdentity(s->request.identity, id) || !s->request.token || s->request.dllHash[64] != 0 ||
      std::wcscmp(s->request.dllHash, hash.c_str()) != 0 || Load(&s->resident) != 1 || !ResidentModule(id.pid, s->moduleBase)) {
    std::puts("REFUSE resident_identity_or_binary_changed retry=0"); return 4;
  }
  // Recheck with the original handles still open immediately before hook transport.
  if (WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT || WaitForSingleObject(thread.value, 0) != WAIT_TIMEOUT ||
      !QnCheckLiveIdentity(id, kDllPath)) { std::puts("REFUSE installation_boundary_recheck"); return 3; }
  HWND window = reinterpret_cast<HWND>(id.hwnd);
  HWND foreground = GetForegroundWindow(); const BOOL minimized = IsIconic(window);
  HMODULE module = LoadLibraryW(kDllPath);
  if (!module) { std::printf("ERROR local_load win32=%lu\n", GetLastError()); return 5; }
  FARPROC raw = GetProcAddress(module, "QnLiveNoSendHook"); HOOKPROC procedure = nullptr;
  static_assert(sizeof(raw) == sizeof(procedure)); std::memcpy(&procedure, &raw, sizeof(procedure));
  HHOOK hook = procedure ? SetWindowsHookExW(WH_CALLWNDPROC, procedure, module, id.tid) : nullptr;
  if (!hook) { std::printf("ERROR hook_transport win32=%lu\n", GetLastError()); FreeLibrary(module); return 5; }
  const LONG sequence = Load(&s->querySequence);
  if (install) InterlockedExchange(&s->phase, Pending);
  const UINT message = RegisterWindowMessageW(kMessage);
  DWORD_PTR response = 0;
  const LRESULT sent = message ? SendMessageTimeoutW(window, message, install ? 1 : 2,
      static_cast<LPARAM>(s->request.token), SMTO_ABORTIFHUNG | SMTO_BLOCK, 5000, &response) : 0;
  const DWORD sendError = sent ? 0 : GetLastError();
  const BOOL unhooked = UnhookWindowsHookEx(hook);
  const DWORD unhookError = unhooked ? 0 : GetLastError();
  FreeLibrary(module);
  const LONG phase = Load(&s->phase);
  const bool complete = phase == Resident || phase == Rejected;
  const bool receipt = complete && s->actualPid == id.pid && s->actualTid == id.tid &&
      s->receiptToken == s->request.token && s->result == 0 && Load(&s->resident) == 1 && Load(&s->admitted) == 1;
  const bool query = install || (Load(&s->querySequence) == sequence + 1 && s->queryPid == id.pid &&
      s->queryTid == id.tid && s->queryToken == s->request.token && s->queryResident == 1 && s->queryAdmitted == 1);
  const bool alive = WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT && WaitForSingleObject(thread.value, 0) == WAIT_TIMEOUT;
  const bool identity = alive && QnCheckLiveIdentity(id, kDllPath) && ResidentModule(id.pid, s->moduleBase);
  const bool unchanged = foreground == GetForegroundWindow() && minimized == IsIconic(window);
  std::printf("RESULT mode=%s transport=%d transport_error=%lu unhooked=%d unhook_error=%lu phase=%ld "
      "resident=%ld admitted=%ld receipt_complete=%d result=%lu query_sequence=%ld query_ok=%d "
      "alive=%d identity_rechecked=%d window_endpoints_unchanged=%d protection_ready=0 sdk_calls=0 send=0 retry=0\n",
      install ? "install" : "status", sent ? 1 : 0, sendError, unhooked ? 1 : 0, unhookError, phase,
      Load(&s->resident), Load(&s->admitted), complete ? 1 : 0, complete ? s->result : ERROR_IO_PENDING,
      Load(&s->querySequence), !install && query ? 1 : 0, alive ? 1 : 0, identity ? 1 : 0, unchanged ? 1 : 0);
  return sent && unhooked && receipt && query && identity && unchanged ? 0 : 6;
}
}
int wmain(int argc, wchar_t** argv) {
  try {
  if (argc == 2 && std::wcscmp(argv[1], L"--status") == 0) return Run(false);
  if (argc == 3 && std::wcscmp(argv[1], L"--install") == 0 &&
      std::wcscmp(argv[2], L"QN_NO_SEND_INSTALL_ONCE") == 0) return Run(true);
  std::puts("Usage: --status | --install QN_NO_SEND_INSTALL_ONCE. Resident until client restart; no SDK or send.");
  return 2;
  } catch (...) {
    std::puts("ERROR controller_exception installation_state=unknown retry=0");
    return 7;
  }
}
