#pragma once
#include "live_admission_api.h"
#include "direct_receipt.h"
#include "native_layout.h"
#include <cstdio>

namespace direct_once {
inline constexpr wchar_t kRoot[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\";
inline constexpr wchar_t kDirectV1[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_direct_once_v1.dll";
#ifdef QN_DIRECT_LONG_TEXT
inline constexpr wchar_t kDll[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_direct_general_v3.dll";
inline constexpr wchar_t kEpoch[] = L"general-v3";
inline constexpr std::size_t kTextCapacity = 4096;
#elif defined(QN_DIRECT_GENERAL)
inline constexpr wchar_t kDll[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_direct_general_v1.dll";
inline constexpr wchar_t kEpoch[] = L"general-v1";
#elif defined(QN_DIRECT_V2)
inline constexpr wchar_t kDll[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_direct_once_v2.dll";
inline constexpr wchar_t kEpoch[] = L"v2";
#else
inline constexpr const wchar_t* kDll = kDirectV1;
inline constexpr wchar_t kEpoch[] = L"v1";
#endif
#ifndef QN_DIRECT_LONG_TEXT
inline constexpr std::size_t kTextCapacity = 256;
#endif
inline constexpr wchar_t kNoSend[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_live_nosend.dll";
inline constexpr wchar_t kV1[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_completion_once.dll";
inline constexpr wchar_t kV2[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_completion_once_v2.dll";
inline constexpr wchar_t kV3[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_completion_once_v3.dll";
inline constexpr wchar_t kApp[] = L"D:\\qianniu\\9.97.80N\\AppBiz.dll";
inline constexpr wchar_t kPrg[] = L"D:\\qianniu\\9.97.80N\\prgbase.dll";
inline constexpr wchar_t kAppHash[] = L"565AB778C7A5829B080E17551308254C0B9D7F1F4A2859782ADAC500C055E41C";
inline constexpr wchar_t kPrgHash[] = L"4D50ACBCCEE823D5FE01B1CE7082ED1FC97070930110727CCDBFDA628247F0FC";
inline constexpr char kShop[] = "2222303856223";
inline constexpr char kAccount[] = "3#2222303856223";
inline constexpr char kCid[] = "2214525969878.1-2216058631944.1#11001@cntaobao";
inline constexpr char kSource[] = "QnNativeSubmitProbe::DirectSendReview";
#ifdef QN_DIRECT_LONG_TEXT
inline constexpr wchar_t kMessage[] = L"QnNativeSubmitProbe.DirectSendGeneral.v3";
inline constexpr DWORD kMagic = 0x514e4449;
#elif defined(QN_DIRECT_GENERAL)
inline constexpr wchar_t kMessage[] = L"QnNativeSubmitProbe.DirectSendGeneral.v1";
inline constexpr DWORD kMagic = 0x514e4447;
#elif defined(QN_DIRECT_V2)
inline constexpr wchar_t kMessage[] = L"Codex.QnDirectOnce.v2.20260907";
inline constexpr DWORD kMagic = 0x514e4432;
#else
inline constexpr wchar_t kMessage[] = L"Codex.QnDirectOnce.v1.20260907";
inline constexpr DWORD kMagic = 0x514e4431;
#endif
inline constexpr DWORD kRvas[] = {0xa73a40, 0x17ccd0, 0x14e2c0, 0x24dca0, 0x24ea10};
enum Phase : LONG { Pending = 1, Checking, Ready, Returned, Rejected };
struct Request {
  DWORD magic = kMagic, size = 0;
  QnLiveIdentity identity{};
  ULONGLONG token = 0, expires = 0;
  ULONG_PTR service = 0, messageBiz = 0, prgBase = 0;
  char shop[32]{}, cid[128]{}, text[kTextCapacity]{};
};
struct Shared {
  Request request{};
  volatile LONG phase = Pending, sequence = 0;
  DWORD error = 0, resident = 0, admitted = 0, argumentsValid = 0, callerReleased = 0;
  DWORD callbackCreated = 0, cleanupAcknowledged = 0;
  DWORD actualPid = 0, actualTid = 0;
  ULONGLONG receiptToken = 0;
  direct_receipt::Snapshot receipt{};
};
inline bool CleanupEligible(DWORD callbackCreated, const direct_receipt::Snapshot& receipt) {
  return !callbackCreated || (receipt.created == 1 && receipt.destroyed == receipt.created);
}
inline ULONGLONG Created(const QnLiveIdentity& id) {
  return (static_cast<ULONGLONG>(id.processCreated.dwHighDateTime) << 32) | id.processCreated.dwLowDateTime;
}
inline void Name(wchar_t (&name)[128], const QnLiveIdentity& id) {
  swprintf_s(name, L"Local\\Codex.QnDirectOnce.%ls.%lu.%llu", kEpoch, id.pid, Created(id));
}
inline bool Check(const QnLiveIdentity& id) {
  return QnCheckLiveIdentity(id, kDll, kNoSend, kV1, kV2, kV3,
#ifdef QN_DIRECT_V2
      kDirectV1
#else
      nullptr
#endif
  );
}
inline bool Select(QnLiveIdentity* id) {
#ifdef QN_DIRECT_GENERAL
  (void)id;
  return false;
#else
  return QnSelectLiveIdentity(id, kDll, kNoSend, kV1, kV2, kV3,
#ifdef QN_DIRECT_V2
      kDirectV1
#else
      nullptr
#endif
  );
#endif
}
#ifdef QN_DIRECT_GENERAL
bool SelectForShop(QnLiveIdentity* id, const char* shop, ULONG_PTR* service = nullptr, ULONG_PTR* biz = nullptr);
inline bool Select(QnLiveIdentity* id, const char* shop) { return SelectForShop(id, shop); }
#endif
inline LONG Load(volatile LONG* p) { return InterlockedCompareExchange(p, 0, 0); }
inline bool ValidShop(const char* shop, std::size_t capacity) {
  const auto n = strnlen(shop, capacity);
  if (n == 0 || n >= capacity) return false;
  for (std::size_t i = 0; i < n; ++i) if (shop[i] < '0' || shop[i] > '9') return false;
  return true;
}
inline bool ValidCid(const char* cid, std::size_t capacity) {
  const auto n = strnlen(cid, capacity);
  constexpr char suffix[] = ".1-";
  constexpr char tail[] = ".1#11001@cntaobao";
  if (n <= sizeof(tail) - 1 || n >= capacity || std::strncmp(cid + n - (sizeof(tail) - 1), tail, sizeof(tail) - 1)) return false;
  const auto middle = std::strstr(cid, suffix);
  if (!middle || middle == cid || middle + sizeof(suffix) - 1 >= cid + n) return false;
  for (const char* p = cid; p < cid + n; ++p) {
    if ((*p >= '0' && *p <= '9') || (*p >= 'a' && *p <= 'z') ||
        *p == '.' || *p == '-' || *p == '#' || *p == '@') continue;
    return false;
  }
  return true;
}
inline bool ValidText(const char* text, std::size_t capacity) {
#ifdef QN_DIRECT_GENERAL
  const auto n = strnlen(text, capacity);
  if (n == 0 || n >= capacity) return false;
  for (std::size_t i = 0; i < n; ++i) if (text[i] == '\r') return false;
  return true;
#else
  constexpr char prefix[] = "CodexDirectSend-";
  const auto n = strnlen(text, capacity);
  if (n < sizeof(prefix) + 5 || n >= capacity || std::strncmp(text, prefix, sizeof(prefix) - 1)) return false;
  for (std::size_t i = sizeof(prefix) - 1; i < n; ++i)
    if (text[i] < '0' || text[i] > '9') return false;
  return true;
#endif
}
struct Handle {
  HANDLE value = nullptr;
  explicit Handle(HANDLE v) : value(v) {}
  ~Handle() { if (*this) CloseHandle(value); }
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
  Handle(const Handle&) = delete;
};
}
