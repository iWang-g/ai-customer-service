#pragma once
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <cstdint>
#include <cwchar>

namespace install_lab {
static_assert(sizeof(void*) == 8, "This fixture requires native x64");
constexpr DWORD kMagic = 0x514e4931;
constexpr DWORD kVersion = 1;
constexpr wchar_t kExecutable[] = L"qn_install_transport_lab.exe";
constexpr wchar_t kDll[] = L"qn_install_transport_fixture.dll";
constexpr wchar_t kMessage[] = L"QnInstallTransportFixture.v1";
constexpr UINT kQuery = WM_APP + 17;
enum State : LONG { Idle, Pending, Processing, Complete };
struct Request {
  DWORD magic, size, version, operation;
  DWORD pid, tid;
  FILETIME processCreated, threadCreated;
  ULONG_PTR hwnd;
  std::uint64_t token;
  DWORD delay;
};
struct Shared {
  volatile LONG ready, state, gate, release;
  DWORD childPid, childTid;
  FILETIME processCreated, threadCreated;
  ULONG_PTR hwnd;
  std::uint64_t token;
  Request request;
  DWORD result, receiptPid, receiptTid;
  std::uint64_t receiptToken;
  volatile LONG installed, active, pinCount;
  DWORD queryInstalled, queryActive, queryPinCount;
};
inline LONG Read(volatile LONG* value) { return InterlockedCompareExchange(value, 0, 0); }
inline bool Same(FILETIME a, FILETIME b) {
  return a.dwLowDateTime == b.dwLowDateTime && a.dwHighDateTime == b.dwHighDateTime;
}
inline void MappingName(wchar_t (&name)[96], DWORD pid) {
  swprintf_s(name, L"Local\\QnInstallTransportFixture-%lu", pid);
}
inline bool FixtureProcess() {
  wchar_t path[32768]{};
  const DWORD n = GetModuleFileNameW(nullptr, path, 32768);
  if (!n || n >= 32768) return false;
  const wchar_t* leaf = std::wcsrchr(path, L'\\');
  return leaf && std::wcscmp(leaf + 1, kExecutable) == 0;
}
}  // namespace install_lab
