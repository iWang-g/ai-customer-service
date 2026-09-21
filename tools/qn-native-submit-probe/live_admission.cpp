#include <windows.h>
#include <tlhelp32.h>
#include <bcrypt.h>
#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include "live_admission_api.h"
#include "native_layout.h"

namespace {
constexpr wchar_t kImage[] = L"D:\\qianniu\\AliWorkbench.exe";
constexpr wchar_t kAppBiz[] = L"D:\\qianniu\\9.97.80N\\AppBiz.dll";
constexpr wchar_t kHash[] = L"565AB778C7A5829B080E17551308254C0B9D7F1F4A2859782ADAC500C055E41C";
constexpr std::array<DWORD, 2> kEntries{0x4f0380, 0xa73a40};
constexpr SIZE_T kEntryBytes = 32;
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE v = nullptr) : value(v) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
};
struct Pe {
  IMAGE_NT_HEADERS64 nt{};
  DWORD ntOffset = 0;
  std::vector<IMAGE_SECTION_HEADER> sections;
};
struct WindowIdentity { HWND window; DWORD pid; DWORD tid; };
BOOL CALLBACK ReceptionWindow(HWND window, LPARAM parameter) {
  if (!IsWindowVisible(window)) return TRUE;
  wchar_t name[128]{}, title[256]{};
  if (!GetClassNameW(window, name, 128) || !GetWindowTextW(window, title, 256)) return TRUE;
  if (std::wcscmp(name, L"Qt5152QWindowIcon") ||
      std::wcscmp(title, L"\u5343\u725b\u63a5\u5f85\u53f0")) return TRUE;
  DWORD pid = 0; const DWORD tid = GetWindowThreadProcessId(window, &pid);
  reinterpret_cast<std::vector<WindowIdentity>*>(parameter)->push_back({window, pid, tid});
  return TRUE;
}
bool UniqueWindow(const std::vector<WindowIdentity>& windows, const std::vector<DWORD>& valid, WindowIdentity* result) {
  if (windows.size() != 1 || !windows[0].window || !windows[0].tid ||
      std::find(valid.begin(), valid.end(), windows[0].pid) == valid.end()) return false;
  *result = windows[0]; return true;
}
bool Span(SIZE_T offset, SIZE_T size, SIZE_T bound) { return offset <= bound && size <= bound - offset; }
template <typename T> bool Copy(const std::vector<BYTE>& bytes, SIZE_T offset, T* out) {
  if (!Span(offset, sizeof(T), bytes.size())) return false;
  std::memcpy(out, bytes.data() + offset, sizeof(T)); return true;
}
bool Parse(const std::vector<BYTE>& bytes, Pe* result) {
  IMAGE_DOS_HEADER dos{};
  if (!Copy(bytes, 0, &dos) || dos.e_magic != IMAGE_DOS_SIGNATURE || dos.e_lfanew < 0) return false;
  Pe pe; pe.ntOffset = static_cast<DWORD>(dos.e_lfanew);
  if (!Copy(bytes, pe.ntOffset, &pe.nt) || pe.nt.Signature != IMAGE_NT_SIGNATURE ||
      pe.nt.FileHeader.Machine != IMAGE_FILE_MACHINE_AMD64 ||
      pe.nt.FileHeader.SizeOfOptionalHeader != sizeof(IMAGE_OPTIONAL_HEADER64) ||
      !pe.nt.FileHeader.NumberOfSections || pe.nt.FileHeader.NumberOfSections > 96 ||
      pe.nt.OptionalHeader.Magic != IMAGE_NT_OPTIONAL_HDR64_MAGIC ||
      !pe.nt.OptionalHeader.SizeOfImage || pe.nt.OptionalHeader.SizeOfImage > 128 * 1024 * 1024 ||
      !pe.nt.OptionalHeader.SizeOfHeaders || pe.nt.OptionalHeader.SizeOfHeaders > 1024 * 1024 ||
      pe.nt.OptionalHeader.SizeOfHeaders > bytes.size()) return false;
  const SIZE_T sectionStart = pe.ntOffset + sizeof(IMAGE_NT_HEADERS64);
  if (!Span(sectionStart, pe.nt.FileHeader.NumberOfSections * sizeof(IMAGE_SECTION_HEADER),
      pe.nt.OptionalHeader.SizeOfHeaders)) return false;
  for (WORD i = 0; i < pe.nt.FileHeader.NumberOfSections; ++i) {
    IMAGE_SECTION_HEADER s{};
    if (!Copy(bytes, sectionStart + i * sizeof(s), &s) ||
        !Span(s.PointerToRawData, s.SizeOfRawData, bytes.size()) ||
        !Span(s.VirtualAddress, std::max(s.Misc.VirtualSize, s.SizeOfRawData), pe.nt.OptionalHeader.SizeOfImage)) return false;
    pe.sections.push_back(s);
  }
  *result = pe; return true;
}
bool ResolveCode(const Pe& pe, DWORD rva, SIZE_T size, SIZE_T* offset) {
  unsigned matches = 0;
  for (const auto& s : pe.sections) {
    if (rva < s.VirtualAddress || !Span(rva - s.VirtualAddress, size,
        std::max(s.Misc.VirtualSize, s.SizeOfRawData))) continue;
    if (!(s.Characteristics & IMAGE_SCN_MEM_EXECUTE) || (s.Characteristics & IMAGE_SCN_MEM_WRITE) ||
        !Span(rva - s.VirtualAddress, size, s.SizeOfRawData)) return false;
    *offset = static_cast<SIZE_T>(s.PointerToRawData) + rva - s.VirtualAddress;
    ++matches;
  }
  return matches == 1;
}
bool HeadersMatch(const std::vector<BYTE>& headers, const std::vector<BYTE>& file,
                  const Pe& pe, ULONG_PTR base, bool* rebased) {
  if (headers.size() != pe.nt.OptionalHeader.SizeOfHeaders || headers.size() > file.size()) return false;
  const SIZE_T imageBaseOffset = pe.ntOffset + offsetof(IMAGE_NT_HEADERS64, OptionalHeader) +
      offsetof(IMAGE_OPTIONAL_HEADER64, ImageBase);
  ULONGLONG actual = 0;
  if (!Copy(headers, imageBaseOffset, &actual) ||
      (actual != base && actual != pe.nt.OptionalHeader.ImageBase)) return false;
  *rebased = actual != pe.nt.OptionalHeader.ImageBase;
  auto normalized = headers;
  // Permit only the structured ImageBase field, and only a verified base.
  std::memcpy(normalized.data() + imageBaseOffset, file.data() + imageBaseOffset, sizeof(actual));
  return std::memcmp(normalized.data(), file.data(), normalized.size()) == 0;
}
bool Digest(const std::vector<BYTE>& bytes, std::wstring* out) {
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  BCRYPT_HASH_HANDLE hash = nullptr;
  bool ok = false;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
  do {
    DWORD size = 0, returned = 0;
    if (BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH, reinterpret_cast<PUCHAR>(&size), sizeof(size), &returned, 0) < 0) break;
    std::vector<BYTE> storage(size);
    if (BCryptCreateHash(algorithm, &hash, storage.data(), size, nullptr, 0, 0) < 0) break;
    std::array<BYTE, 32> digest{};
    ok = BCryptHashData(hash, const_cast<PUCHAR>(bytes.data()), static_cast<ULONG>(bytes.size()), 0) >= 0 &&
        BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0;
    BCryptDestroyHash(hash); hash = nullptr;
    if (ok) {
      out->clear();
      for (BYTE b : digest) { wchar_t hex[3]{}; std::swprintf(hex, 3, L"%02X", b); *out += hex; }
    }
  } while (false);
  if (hash) BCryptDestroyHash(hash);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return ok;
}
bool Read(HANDLE process, ULONG_PTR address, void* target, SIZE_T size) {
  SIZE_T actual = 0;
  return ReadProcessMemory(process, reinterpret_cast<void*>(address), target, size, &actual) && actual == size;
}
bool Modules(DWORD pid, MODULEENTRY32W* app, bool* researchPresent, const wchar_t* allowedResearchPath = nullptr,
             const wchar_t* secondAllowedPath = nullptr, const wchar_t* thirdAllowedPath = nullptr,
             const wchar_t* fourthAllowedPath = nullptr, const wchar_t* fifthAllowedPath = nullptr,
             const wchar_t* sixthAllowedPath = nullptr) {
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, pid));
  if (!snapshot) return false;
  MODULEENTRY32W m{}; m.dwSize = sizeof(m);
  BOOL more = Module32FirstW(snapshot.value, &m); unsigned found = 0;
  *researchPresent = false;
  if (!more) return false;
  while (more) {
    if (_wcsicmp(m.szModule, L"AppBiz.dll") == 0) { *app = m; ++found; }
    if (_wcsnicmp(m.szModule, L"qn_", 3) == 0 &&
        (!allowedResearchPath || _wcsicmp(m.szExePath, allowedResearchPath) != 0) &&
        (!secondAllowedPath || _wcsicmp(m.szExePath, secondAllowedPath) != 0) &&
        (!thirdAllowedPath || _wcsicmp(m.szExePath, thirdAllowedPath) != 0) &&
        (!fourthAllowedPath || _wcsicmp(m.szExePath, fourthAllowedPath) != 0) &&
        (!fifthAllowedPath || _wcsicmp(m.szExePath, fifthAllowedPath) != 0) &&
        (!sixthAllowedPath || _wcsicmp(m.szExePath, sixthAllowedPath) != 0)) *researchPresent = true;
    more = Module32NextW(snapshot.value, &m);
  }
  return GetLastError() == ERROR_NO_MORE_FILES && found == 1;
}
bool ExecutableImage(HANDLE process, ULONG_PTR base, ULONG_PTR address, SIZE_T bytes) {
  SIZE_T checked = 0;
  while (checked < bytes) {
    MEMORY_BASIC_INFORMATION m{};
    if (VirtualQueryEx(process, reinterpret_cast<void*>(address + checked), &m, sizeof(m)) != sizeof(m) ||
        m.State != MEM_COMMIT || m.Type != MEM_IMAGE || reinterpret_cast<ULONG_PTR>(m.AllocationBase) != base ||
        m.Protect != PAGE_EXECUTE_READ) return false;
    const auto start = reinterpret_cast<ULONG_PTR>(m.BaseAddress);
    if (address + checked < start || address + checked - start >= m.RegionSize) return false;
    checked += std::min(bytes - checked, m.RegionSize - (address + checked - start));
  }
  return true;
}
bool Validate(DWORD pid, const std::vector<BYTE>& file, const Pe& pe,
              const wchar_t* allowedResearchPath = nullptr, bool quiet = false, const wchar_t* secondAllowedPath = nullptr,
              const wchar_t* thirdAllowedPath = nullptr, const wchar_t* fourthAllowedPath = nullptr,
              const wchar_t* fifthAllowedPath = nullptr, const wchar_t* sixthAllowedPath = nullptr,
              const QnNativeLayout* layout = nullptr) {
  const auto gate = [&](bool ok, const wchar_t* reason) {
    if (!ok && !quiet) std::wprintf(L"REFUSE pid=%lu gate=%ls\n", pid, reason);
    return ok;
  };
  // No write, VM operation, thread creation, or debug-attach access rights.
  Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, pid));
  if (!gate(static_cast<bool>(process), L"query_read_handle")) return false;
  wchar_t path[32768]{}; DWORD length = 32768;
  FILETIME created{}, exited{}, kernel{}, user{};
  DWORD session = 0; BOOL debugger = TRUE;
  if (!gate(QueryFullProcessImageNameW(process.value, 0, path, &length) &&
      (layout ? (std::wcsrchr(path, L'\\') && !_wcsicmp(std::wcsrchr(path, L'\\') + 1, L"AliWorkbench.exe")) : _wcsicmp(path, kImage) == 0) &&
      GetProcessTimes(process.value, &created, &exited, &kernel, &user) &&
      ProcessIdToSessionId(pid, &session) && CheckRemoteDebuggerPresent(process.value, &debugger) && !debugger,
      L"image_identity_times_session_debugger")) return false;
  using IsWow64Process2Fn = BOOL (WINAPI*)(HANDLE, USHORT*, USHORT*);
  FARPROC raw = GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "IsWow64Process2");
  IsWow64Process2Fn machineFn = nullptr; static_assert(sizeof(raw) == sizeof(machineFn));
  std::memcpy(&machineFn, &raw, sizeof(raw));
  USHORT machine = 0, native = 0;
  if (!gate(machineFn && machineFn(process.value, &machine, &native) && machine == IMAGE_FILE_MACHINE_UNKNOWN &&
      native == IMAGE_FILE_MACHINE_AMD64, L"native_x64")) return false;
  MODULEENTRY32W module{}; bool research = false;
  if (!gate(Modules(pid, &module, &research, allowedResearchPath, secondAllowedPath, thirdAllowedPath, fourthAllowedPath, fifthAllowedPath, sixthAllowedPath) && !research && _wcsicmp(module.szExePath, layout ? layout->appPath : kAppBiz) == 0 &&
      module.modBaseSize == pe.nt.OptionalHeader.SizeOfImage, L"module_path_size_no_research_dll")) return false;
  const auto base = reinterpret_cast<ULONG_PTR>(module.modBaseAddr);
  if (!gate(base <= ~ULONG_PTR(0) - module.modBaseSize, L"address_overflow")) return false;
  std::vector<BYTE> headers(pe.nt.OptionalHeader.SizeOfHeaders);
  if (!gate(Read(process.value, base, headers.data(), headers.size()), L"runtime_pe_headers_read")) return false;
  bool rebased = false;
  if (!HeadersMatch(headers, file, pe, base, &rebased)) {
    if (quiet) return false;
    unsigned shown = 0; SIZE_T differences = 0;
    for (SIZE_T i = 0; i < headers.size(); ++i) if (headers[i] != file[i]) {
      ++differences;
      if (shown++ < 16) std::wprintf(L"HEADER_DIFF pid=%lu offset=0x%zx disk=%02x memory=%02x\n", pid, i, file[i], headers[i]);
    }
    std::wprintf(L"HEADER_DIFF_TOTAL pid=%lu changed_bytes=%zu\n", pid, differences);
    return gate(false, L"runtime_pe_headers_match");
  }
  if (!quiet) std::wprintf(L"HEADERS pid=%lu match=1 imagebase_equals_loaded_base=%d\n", pid, rebased ? 1 : 0);
  const std::array<DWORD, 2> checkedEntries = layout ?
      std::array<DWORD, 2>{layout->profile->identityEntry, layout->profile->entries[0]} : kEntries;
  for (DWORD rva : checkedEntries) {
    SIZE_T offset = 0; std::array<BYTE, kEntryBytes> actual{};
    if (!gate(ResolveCode(pe, rva, actual.size(), &offset) && Span(offset, actual.size(), file.size()) &&
        ExecutableImage(process.value, base, base + rva, actual.size()) &&
        Read(process.value, base + rva, actual.data(), actual.size()) &&
        std::memcmp(actual.data(), file.data() + offset, actual.size()) == 0, L"entry_section_page_bytes")) return false;
    if (!quiet) std::wprintf(L"ENTRY pid=%lu rva=0x%lx address=0x%llx bytes=%zu match=1 executable_readonly_image=1\n",
        pid, rva, static_cast<unsigned long long>(base + rva), actual.size());
  }
  MODULEENTRY32W after{}; FILETIME again{};
  if (!gate(WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT &&
      GetProcessTimes(process.value, &again, &exited, &kernel, &user) &&
      std::memcmp(&created, &again, sizeof(created)) == 0 && Modules(pid, &after, &research, allowedResearchPath, secondAllowedPath, thirdAllowedPath, fourthAllowedPath, fifthAllowedPath, sixthAllowedPath) && !research &&
      after.modBaseAddr == module.modBaseAddr && after.modBaseSize == module.modBaseSize &&
      _wcsicmp(after.szExePath, module.szExePath) == 0 &&
      CheckRemoteDebuggerPresent(process.value, &debugger) && !debugger, L"final_identity_liveness_module_recheck")) return false;
  const ULONGLONG creation = (static_cast<ULONGLONG>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
  if (!quiet) std::wprintf(L"PASS pid=%lu creation_filetime=%llu session=%lu native_x64=1 debugger_present=0 appbiz_base=0x%llx image_size=%lu\n",
      pid, creation, session, static_cast<unsigned long long>(base), module.modBaseSize);
  return true;
}
[[maybe_unused]] int Scan(bool bindWindow) {
  std::vector<WindowIdentity> windowsBefore;
  if (bindWindow && !EnumWindows(ReceptionWindow, reinterpret_cast<LPARAM>(&windowsBefore))) return 2;
  // Keep this handle open throughout the scan; deny new file writes/deletes.
  Handle file(CreateFileW(kAppBiz, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  LARGE_INTEGER size{};
  if (!file || !GetFileSizeEx(file.value, &size) || size.QuadPart <= 0 || size.QuadPart > 64 * 1024 * 1024) return 2;
  std::vector<BYTE> bytes(static_cast<SIZE_T>(size.QuadPart)); DWORD count = 0;
  Pe pe; std::wstring digest;
  if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) || count != bytes.size() ||
      !Digest(bytes, &digest) || digest != kHash || !Parse(bytes, &pe)) {
    std::wprintf(L"REFUSE gate=disk_hash_or_pe\n"); return 2;
  }
  std::wprintf(L"FILE path=%ls sha256=%ls\n", kAppBiz, digest.c_str());
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0));
  if (!snapshot) return 2;
  PROCESSENTRY32W item{}; item.dwSize = sizeof(item);
  BOOL more = Process32FirstW(snapshot.value, &item); unsigned candidates = 0, valid = 0;
  std::vector<DWORD> validPids;
  if (!more) return 2;
  while (more) {
    if (_wcsicmp(item.szExeFile, L"AliWorkbench.exe") == 0) {
      ++candidates; if (Validate(item.th32ProcessID, bytes, pe)) { ++valid; validPids.push_back(item.th32ProcessID); }
    }
    more = Process32NextW(snapshot.value, &item);
  }
  if (GetLastError() != ERROR_NO_MORE_FILES) return 2;
  bool unique = candidates == 1 && valid == 1;
  if (bindWindow) {
    std::vector<WindowIdentity> windowsAfter;
    WindowIdentity before{}, after{};
    unique = EnumWindows(ReceptionWindow, reinterpret_cast<LPARAM>(&windowsAfter)) && candidates == valid &&
        UniqueWindow(windowsBefore, validPids, &before) && UniqueWindow(windowsAfter, validPids, &after) &&
        before.window == after.window && before.pid == after.pid && before.tid == after.tid;
    if (unique) std::wprintf(L"WINDOW pid=%lu tid=%lu hwnd=0x%llx stable_before_after=1 activate=0 shop_binding=0\n",
        after.pid, after.tid, reinterpret_cast<unsigned long long>(after.window));
    else std::wprintf(L"REFUSE gate=unique_stable_reception_window before=%zu after=%zu\n", windowsBefore.size(), windowsAfter.size());
  }
  std::wprintf(L"result=%ls candidates=%u validated=%u unique_target=%d read_only=1 debug_attach=0 remote_write=0 "
      L"hook_install=0 sdk_calls=0 send_invoked=0 install_ready=0\n",
      unique ? L"read_only_identity_snapshot_ok" : valid == candidates && valid > 1 ? L"ambiguous_target" : L"admission_refused",
      candidates, valid, unique ? 1 : 0);
  return unique ? 0 : 3;
}
[[maybe_unused]] bool SelfTest() {
  std::vector<BYTE> fixture(0x600);
  IMAGE_DOS_HEADER dos{}; dos.e_magic = IMAGE_DOS_SIGNATURE; dos.e_lfanew = 0x80;
  IMAGE_NT_HEADERS64 nt{}; nt.Signature = IMAGE_NT_SIGNATURE; nt.FileHeader.Machine = IMAGE_FILE_MACHINE_AMD64;
  nt.FileHeader.NumberOfSections = 1; nt.FileHeader.SizeOfOptionalHeader = sizeof(IMAGE_OPTIONAL_HEADER64);
  nt.OptionalHeader.Magic = IMAGE_NT_OPTIONAL_HDR64_MAGIC; nt.OptionalHeader.SizeOfImage = 0x2000;
  nt.OptionalHeader.SizeOfHeaders = 0x200;
  nt.OptionalHeader.ImageBase = 0x180000000;
  IMAGE_SECTION_HEADER section{}; section.VirtualAddress = 0x1000; section.Misc.VirtualSize = 0x400;
  section.SizeOfRawData = 0x400; section.PointerToRawData = 0x200; section.Characteristics = IMAGE_SCN_MEM_EXECUTE | IMAGE_SCN_MEM_READ;
  std::memcpy(fixture.data(), &dos, sizeof(dos));
  std::memcpy(fixture.data() + 0x80, &nt, sizeof(nt));
  std::memcpy(fixture.data() + 0x80 + sizeof(nt), &section, sizeof(section));
  Pe pe; SIZE_T offset = 0;
  if (!Parse(fixture, &pe) || !ResolveCode(pe, 0x1000, 32, &offset) || offset != 0x200) return false;
  for (int test = 0; test < 9; ++test) {
    auto data = fixture; auto badDos = dos; auto badNt = nt; auto badSection = section;
    switch (test) {
      case 0: badDos.e_magic = 0; break;
      case 1: badDos.e_lfanew = -1; break;
      case 2: badDos.e_lfanew = 0x7fffffff; break;
      case 3: badNt.FileHeader.Machine = IMAGE_FILE_MACHINE_I386; break;
      case 4: badNt.FileHeader.NumberOfSections = 97; break;
      case 5: badNt.FileHeader.SizeOfOptionalHeader = 0; break;
      case 6: badNt.OptionalHeader.SizeOfHeaders = 0x100; break;
      case 7: badSection.PointerToRawData = 0xffffff00; break;
      case 8: badSection.VirtualAddress = 0xfffffff0; break;
    }
    std::memcpy(data.data(), &badDos, sizeof(badDos));
    std::memcpy(data.data() + 0x80, &badNt, sizeof(badNt));
    std::memcpy(data.data() + 0x80 + sizeof(nt), &badSection, sizeof(badSection));
    Pe invalid; if (Parse(data, &invalid)) return false;
  }
  if (ResolveCode(pe, 0xff0, 32, &offset) || ResolveCode(pe, 0x13ff, 32, &offset)) return false;
  auto writable = pe; writable.sections[0].Characteristics |= IMAGE_SCN_MEM_WRITE;
  if (ResolveCode(writable, 0x1000, 32, &offset)) return false;
  auto overlap = pe; overlap.sections.push_back(overlap.sections.front());
  if (ResolveCode(overlap, 0x1000, 32, &offset)) return false;
  auto tail = pe; tail.sections[0].SizeOfRawData = 0x100;
  if (ResolveCode(tail, 0x1200, 32, &offset)) return false;
  auto headers = fixture; headers.resize(0x200);
  bool rebased = true;
  constexpr ULONG_PTR actualBase = 0x7ffbb21c0000;
  if (!HeadersMatch(headers, fixture, pe, actualBase, &rebased) || rebased) return false;
  const SIZE_T baseOffset = 0x80 + offsetof(IMAGE_NT_HEADERS64, OptionalHeader) + offsetof(IMAGE_OPTIONAL_HEADER64, ImageBase);
  std::memcpy(headers.data() + baseOffset, &actualBase, sizeof(actualBase));
  if (!HeadersMatch(headers, fixture, pe, actualBase, &rebased) || !rebased) return false;
  const ULONG_PTR invalidBase = 0x77770000;
  auto altered = headers; std::memcpy(altered.data() + baseOffset, &invalidBase, sizeof(invalidBase));
  if (HeadersMatch(altered, fixture, pe, actualBase, &rebased)) return false;
  altered = headers; altered[0x80 + offsetof(IMAGE_NT_HEADERS64, FileHeader) + offsetof(IMAGE_FILE_HEADER, TimeDateStamp)] ^= 1;
  if (HeadersMatch(altered, fixture, pe, actualBase, &rebased)) return false;
  altered = headers; altered.pop_back();
  if (HeadersMatch(altered, fixture, pe, actualBase, &rebased)) return false;
  const WindowIdentity w{reinterpret_cast<HWND>(1), 123, 456}; WindowIdentity selected{};
  if (!UniqueWindow({w}, {123,999}, &selected) || UniqueWindow({}, {123}, &selected) ||
      UniqueWindow({w,w}, {123}, &selected) || UniqueWindow({w}, {999}, &selected) ||
      UniqueWindow({WindowIdentity{nullptr,123,456}}, {123}, &selected)) return false;
  std::wprintf(L"PASS pe_parser positive=1 malformed=9 code_span_rejections=5 header_positive=2 header_negative=3 target_access=0\n");
  std::wprintf(L"PASS window_selection positive=1 negative=4 target_access=0\n");
  return true;
}
}  // namespace

const QnNativeProfile* QnMatchNativeProfile(const wchar_t* appHash, const wchar_t* prgHash) {
  if (!appHash || !prgHash) return nullptr;
  for (const auto& profile : kQnNativeProfiles)
    if (!_wcsicmp(appHash, profile.appHash) && !_wcsicmp(prgHash, profile.prgHash)) return &profile;
  return nullptr;
}

bool QnResolveNativeLayout(DWORD pid, QnNativeLayout* layout) {
  if (!layout) return false;
  QnNativeLayout found{};
  Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid));
  if (!snapshot) return false;
  MODULEENTRY32W item{}; item.dwSize = sizeof(item); unsigned apps = 0, prgs = 0;
  for (BOOL more = Module32FirstW(snapshot.value, &item); more; more = Module32NextW(snapshot.value, &item)) {
    if (!_wcsicmp(item.szModule, L"AppBiz.dll")) {
      wcscpy_s(found.appPath, item.szExePath); found.appBase = reinterpret_cast<ULONG_PTR>(item.modBaseAddr); ++apps;
    } else if (!_wcsicmp(item.szModule, L"prgbase.dll")) {
      wcscpy_s(found.prgPath, item.szExePath); found.prgBase = reinterpret_cast<ULONG_PTR>(item.modBaseAddr); ++prgs;
    }
  }
  if (GetLastError() != ERROR_NO_MORE_FILES || apps != 1 || prgs != 1) return false;
  const std::wstring app(found.appPath), prg(found.prgPath);
  const auto appDir = app.substr(0, app.find_last_of(L'\\') + 1);
  const auto prgDir = prg.substr(0, prg.find_last_of(L'\\') + 1);
  if (appDir.empty() || _wcsicmp(appDir.c_str(), prgDir.c_str())) return false;
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  wchar_t image[MAX_PATH]{}; DWORD length = MAX_PATH;
  if (!process || !QueryFullProcessImageNameW(process.value, 0, image, &length)) return false;
  const std::wstring executable(image);
  const auto slash = executable.find_last_of(L'\\');
  if (slash == std::wstring::npos || _wcsicmp(executable.substr(slash + 1).c_str(), L"AliWorkbench.exe")) return false;
  const auto root = executable.substr(0, slash + 1);
  if (_wcsnicmp(appDir.c_str(), root.c_str(), root.size()) || appDir.size() <= root.size()) return false;
  auto hashFile = [](const wchar_t* path, std::wstring* hash) {
    Handle file(CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr));
    LARGE_INTEGER size{}; DWORD read = 0;
    if (!file || !GetFileSizeEx(file.value, &size) || size.QuadPart <= 0 || size.QuadPart > 64 * 1024 * 1024) return false;
    std::vector<BYTE> bytes(static_cast<SIZE_T>(size.QuadPart));
    return ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &read, nullptr) &&
        read == bytes.size() && Digest(bytes, hash);
  };
  std::wstring appHash, prgHash;
  if (!hashFile(found.appPath, &appHash) || !hashFile(found.prgPath, &prgHash)) return false;
  found.profile = QnMatchNativeProfile(appHash.c_str(), prgHash.c_str());
  if (!found.profile) {
    std::printf("REFUSE unsupported_native_layout pid=%lu sdk_send=0\n", pid);
    return false;
  }
  *layout = found;
  return true;
}

bool QnCheckNativeCode(DWORD pid, const wchar_t* path, const wchar_t* expectedHash,
                       ULONG_PTR base, const DWORD* entries, std::size_t entryCount) {
  if (!path || !expectedHash || !base || !entries || !entryCount || entryCount > 32) return false;
  Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, FALSE, pid));
  Handle file(CreateFileW(path, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  LARGE_INTEGER size{};
  if (!process || !file || !GetFileSizeEx(file.value, &size) || size.QuadPart <= 0 || size.QuadPart > 64 * 1024 * 1024) return false;
  std::vector<BYTE> bytes(static_cast<SIZE_T>(size.QuadPart)); DWORD got = 0;
  Pe pe; std::wstring hash;
  if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &got, nullptr) || got != bytes.size() ||
      !Digest(bytes, &hash) || hash != expectedHash || !Parse(bytes, &pe)) return false;
  Handle modules(CreateToolhelp32Snapshot(TH32CS_SNAPMODULE, pid));
  if (!modules) return false;
  MODULEENTRY32W module{}; module.dwSize = sizeof(module); unsigned found = 0;
  for (BOOL more = Module32FirstW(modules.value, &module); more; more = Module32NextW(modules.value, &module)) {
    if (reinterpret_cast<ULONG_PTR>(module.modBaseAddr) == base && _wcsicmp(module.szExePath, path) == 0 &&
        module.modBaseSize == pe.nt.OptionalHeader.SizeOfImage) ++found;
  }
  if (found != 1) return false;
  std::vector<BYTE> headers(pe.nt.OptionalHeader.SizeOfHeaders); bool rebased = false;
  if (!Read(process.value, base, headers.data(), headers.size()) || !HeadersMatch(headers, bytes, pe, base, &rebased)) return false;
  for (std::size_t i = 0; i < entryCount; ++i) {
    SIZE_T offset = 0; std::array<BYTE, 32> actual{};
    if (!ResolveCode(pe, entries[i], actual.size(), &offset) ||
        !ExecutableImage(process.value, base, base + entries[i], actual.size()) ||
        !Read(process.value, base + entries[i], actual.data(), actual.size()) ||
        std::memcmp(actual.data(), bytes.data() + offset, actual.size())) return false;
  }
  return true;
}

bool QnCheckLiveIdentity(const QnLiveIdentity& identity, const wchar_t* allowedResearchPath, const wchar_t* secondAllowedPath,
                        const wchar_t* thirdAllowedPath, const wchar_t* fourthAllowedPath, const wchar_t* fifthAllowedPath,
                        const wchar_t* sixthAllowedPath) {
  Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, identity.pid));
  Handle thread(OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, identity.tid));
  FILETIME pc{}, tc{}, exited{}, kernel{}, user{};
  DWORD session = 0, windowPid = 0;
  if (!process || !thread || WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT ||
      WaitForSingleObject(thread.value, 0) != WAIT_TIMEOUT || GetProcessIdOfThread(thread.value) != identity.pid ||
      !GetProcessTimes(process.value, &pc, &exited, &kernel, &user) ||
      !GetThreadTimes(thread.value, &tc, &exited, &kernel, &user) ||
      std::memcmp(&pc, &identity.processCreated, sizeof(pc)) || std::memcmp(&tc, &identity.threadCreated, sizeof(tc)) ||
      !ProcessIdToSessionId(identity.pid, &session) || session != identity.session ||
      GetWindowThreadProcessId(reinterpret_cast<HWND>(identity.hwnd), &windowPid) != identity.tid ||
      windowPid != identity.pid) return false;
#ifdef QN_DIRECT_GENERAL
  QnNativeLayout layout{};
  if (!QnResolveNativeLayout(identity.pid, &layout) || layout.appBase != identity.appBase) return false;
  const wchar_t* checkedPath = layout.appPath;
  const wchar_t* checkedHash = layout.profile->appHash;
#else
  const wchar_t* checkedPath = kAppBiz;
  const wchar_t* checkedHash = kHash;
#endif
  Handle file(CreateFileW(checkedPath, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  LARGE_INTEGER size{};
  if (!file || !GetFileSizeEx(file.value, &size) || size.QuadPart <= 0 || size.QuadPart > 64 * 1024 * 1024) return false;
  std::vector<BYTE> bytes(static_cast<SIZE_T>(size.QuadPart));
  DWORD count = 0; Pe pe; std::wstring hash;
  if (!ReadFile(file.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) ||
      count != bytes.size() || !Digest(bytes, &hash) || hash != checkedHash || !Parse(bytes, &pe) ||
      !Validate(identity.pid, bytes, pe, allowedResearchPath, true, secondAllowedPath, thirdAllowedPath, fourthAllowedPath, fifthAllowedPath, sixthAllowedPath
#ifdef QN_DIRECT_GENERAL
          , &layout
#endif
      )) return false;
  MODULEENTRY32W app{}; bool research = false;
  return Modules(identity.pid, &app, &research, allowedResearchPath, secondAllowedPath, thirdAllowedPath, fourthAllowedPath, fifthAllowedPath, sixthAllowedPath) && !research &&
      reinterpret_cast<ULONG_PTR>(app.modBaseAddr) == identity.appBase && app.modBaseSize == identity.appSize &&
      WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT && WaitForSingleObject(thread.value, 0) == WAIT_TIMEOUT;
}

bool QnSelectLiveIdentity(QnLiveIdentity* identity, const wchar_t* allowedResearchPath, const wchar_t* secondAllowedPath,
                         const wchar_t* thirdAllowedPath, const wchar_t* fourthAllowedPath, const wchar_t* fifthAllowedPath,
                         const wchar_t* sixthAllowedPath) {
  std::vector<WindowIdentity> windows;
  if (!identity || !EnumWindows(ReceptionWindow, reinterpret_cast<LPARAM>(&windows)) || windows.size() != 1) return false;
  QnLiveIdentity selected{};
  selected.pid = windows[0].pid; selected.tid = windows[0].tid;
  selected.hwnd = reinterpret_cast<ULONG_PTR>(windows[0].window);
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, selected.pid));
  Handle thread(OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, selected.tid));
  FILETIME exited{}, kernel{}, user{};
  MODULEENTRY32W app{}; bool research = false;
  if (!process || !thread || !GetProcessTimes(process.value, &selected.processCreated, &exited, &kernel, &user) ||
      !GetThreadTimes(thread.value, &selected.threadCreated, &exited, &kernel, &user) ||
      !ProcessIdToSessionId(selected.pid, &selected.session) ||
      !Modules(selected.pid, &app, &research, allowedResearchPath, secondAllowedPath, thirdAllowedPath, fourthAllowedPath, fifthAllowedPath, sixthAllowedPath) || research) return false;
  selected.appBase = reinterpret_cast<ULONG_PTR>(app.modBaseAddr); selected.appSize = app.modBaseSize;
  if (!QnCheckLiveIdentity(selected, allowedResearchPath, secondAllowedPath, thirdAllowedPath, fourthAllowedPath, fifthAllowedPath, sixthAllowedPath)) return false;
  std::vector<WindowIdentity> after;
  if (!EnumWindows(ReceptionWindow, reinterpret_cast<LPARAM>(&after)) || after.size() != 1 ||
      after[0].window != windows[0].window || after[0].pid != selected.pid || after[0].tid != selected.tid) return false;
  *identity = selected;
  return true;
}

#ifndef QN_ADMISSION_LIBRARY
int wmain(int argc, wchar_t** argv) {
  if (argc == 2 && std::wcscmp(argv[1], L"--self-test") == 0) return SelfTest() ? 0 : 1;
  if (argc == 2 && std::wcscmp(argv[1], L"--scan") == 0) return Scan(false);
  if (argc == 2 && std::wcscmp(argv[1], L"--scan-window") == 0) return Scan(true);
  std::wprintf(L"Only --self-test, --scan or --scan-window is supported. No installation mode.\n");
  return 2;
}
#endif
