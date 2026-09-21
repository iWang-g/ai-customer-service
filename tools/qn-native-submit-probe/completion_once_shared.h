#pragma once
#include "live_nosend_shared.h"
#include "debugger_lab_shared.h"
#include "message_identity_snapshot.h"

namespace completion_once {
constexpr DWORD kMagic = 0x514e4331;
#ifdef QN_COMPLETION_V3
constexpr wchar_t kMessage[] = L"QnCompletionOnce.v3";
constexpr wchar_t kDll[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_completion_once_v3.dll";
constexpr wchar_t kPriorDll[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_completion_once.dll";
constexpr wchar_t kSecondPriorDll[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_completion_once_v2.dll";
constexpr int kEpoch = 3;
#elif defined(QN_COMPLETION_V2)
constexpr wchar_t kMessage[] = L"QnCompletionOnce.v2";
constexpr wchar_t kDll[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_completion_once_v2.dll";
constexpr wchar_t kPriorDll[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_completion_once.dll";
constexpr int kEpoch = 2;
#else
constexpr wchar_t kMessage[] = L"QnCompletionOnce.v1";
constexpr wchar_t kDll[] = L"D:\\project-electron\\ai-customer-service\\tools\\qn-native-submit-probe\\build\\qn_completion_once.dll";
constexpr const wchar_t* kPriorDll = nullptr;
constexpr int kEpoch = 1;
#endif
#ifndef QN_COMPLETION_V3
constexpr const wchar_t* kSecondPriorDll = nullptr;
#endif
enum Phase : LONG { Pending, Installed, Armed, Finished, Refused };
struct Shared {
  DWORD magic, size;
  QnLiveIdentity identity;
  std::uint64_t token;
  DWORD64 entry;
  DWORD durationMs;
  volatile LONG phase, hits, snapshotReady, stop, workerDone, cleanupVerified, querySequence;
  DWORD error, workerTid, hitTid;
  DWORD64 bindState, resultPointer, messagePointer;
  qn_debugger_lab::ThreadRecord record;
  qn_research::MessageIdentitySnapshot snapshot;
};
inline void Name(wchar_t (&name)[128], const QnLiveIdentity& id) {
  swprintf_s(name, L"Local\\QnCompletionOnce-v%d-%lu-%08lx%08lx", kEpoch, id.pid,
      id.processCreated.dwHighDateTime, id.processCreated.dwLowDateTime);
}
using InitializeFn = DWORD (*)(const wchar_t*);
}
