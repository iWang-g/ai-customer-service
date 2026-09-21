#pragma once
#include "live_admission_api.h"
#include <cstdint>
#include <cwchar>

namespace live_nosend {
static_assert(sizeof(void*) == 8, "Native x64 only");
constexpr wchar_t kDllPath[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_live_nosend.dll";
constexpr wchar_t kMessage[] = L"QnLiveNoSend.Status.v1";
constexpr DWORD kMagic = 0x514e5331;
constexpr DWORD kVersion = 1;
enum Phase : LONG { Empty, Pending, Checking, Resident, Rejected };
struct Request {
  DWORD magic, version, size;
  QnLiveIdentity identity;
  std::uint64_t token;
  wchar_t dllHash[65];
};
struct Shared {
  Request request;
  volatile LONG phase, resident, admitted, querySequence;
  DWORD result, actualPid, actualTid;
  std::uint64_t receiptToken;
  ULONG_PTR moduleBase;
  DWORD queryPid, queryTid, queryResident, queryAdmitted;
  std::uint64_t queryToken;
};
inline LONG Load(volatile LONG* value) { return InterlockedCompareExchange(value, 0, 0); }
inline void Name(wchar_t (&name)[128], const QnLiveIdentity& id) {
  swprintf_s(name, L"Local\\QnLiveNoSend-v1-%lu-%08lx%08lx", id.pid,
      id.processCreated.dwHighDateTime, id.processCreated.dwLowDateTime);
}
inline bool SameIdentity(const QnLiveIdentity& a, const QnLiveIdentity& b) {
  return a.pid == b.pid && a.tid == b.tid && a.session == b.session && a.hwnd == b.hwnd &&
      a.appBase == b.appBase && a.appSize == b.appSize &&
      CompareFileTime(&a.processCreated, &b.processCreated) == 0 &&
      CompareFileTime(&a.threadCreated, &b.threadCreated) == 0;
}
}
