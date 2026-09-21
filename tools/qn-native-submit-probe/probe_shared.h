#pragma once

#include <windows.h>

#include <cwchar>

constexpr wchar_t kProbeMessageName[] = L"QnNativeSubmitProbe.Discover.v1";
constexpr wchar_t kProbeMappingPrefix[] = L"Local\\QnNativeSubmitProbeMap-";
constexpr wchar_t kProbeEventPrefix[] = L"Local\\QnNativeSubmitProbeDone-";
constexpr DWORD kProbeMagic = 0x514E5052;
constexpr DWORD kProbeVersion = 12;
constexpr LONG kProbePending = 1;
constexpr LONG kProbeRunning = 2;
constexpr LONG kProbeComplete = 3;
constexpr DWORD kProbeOperationDiscover = 1;
constexpr DWORD kProbeOperationSubmit = 2;
constexpr DWORD kProbeOperationDiscoverMinimized = 3;
constexpr DWORD kProbeOperationSubmitMinimized = 4;
constexpr DWORD kProbeOperationWriteDraftMinimized = 5;
constexpr DWORD kProbeOperationClearDraftMinimized = 6;
constexpr DWORD kProbeOperationWatchCbt = 7;
constexpr DWORD kProbeOperationSuppressCbt = 8;
constexpr DWORD kProbeOperationDiscoverFocusChainMinimized = 9;
constexpr DWORD kProbeOperationReconcileMinimized = 10;
constexpr DWORD kProbeOperationWriteDraftFocusChainMinimized = 11;
constexpr DWORD kProbeOperationClearDraftFocusChainMinimized = 12;
constexpr DWORD kProbeOperationSubmitFocusChainMinimized = 13;
constexpr DWORD kProbeOperationEnumerateAim = 14;
constexpr DWORD kProbeOperationObserveAimSendStart = 15;
constexpr DWORD kProbeOperationObserveAimSendStop = 16;
constexpr DWORD kProbeOperationEnumerateAppMessageServices = 17;
constexpr DWORD kProbeOperationDryRunSendArguments = 18;
constexpr DWORD kProbeOperationLocateAppMessageService = 19;
constexpr DWORD kProbeOperationDirectSendTextMinimized = 20;
constexpr DWORD kProbeOperationCallbackLifecycleStart = 21;
constexpr DWORD kProbeOperationCallbackLifecycleRelease = 22;
constexpr size_t kProbeDraftCapacity = 1024;
constexpr size_t kProbeTargetIdCapacity = 256;
constexpr size_t kProbeCidCapacity = 1024;
constexpr size_t kProbeTextCapacity = 4096;

constexpr DWORD kCallbackLifecycleResultVersion = 3;

struct CallbackLifecycleResult {
  DWORD version;
  DWORD guiThreadId;
  volatile LONG workerStarted;
  volatile LONG workerCompleted;
  volatile LONG workerExitConfirmed;
  volatile LONG holdWorkerExit;
  volatile LONG allowWorkerExit;
  volatile LONG initialHookReleased;
  volatile LONG workerObservedInitialHookReleased;
  volatile LONG invokeCount;
  volatile LONG destroyCount;
  volatile LONG cancelledCount;
  volatile LONG destroyRefCount;
  volatile LONG initialRefCount;
  volatile LONG refCountAfterAdopt;
  volatile LONG refCountAfterCopy;
  volatile LONG refCountAfterCallerRelease;
  DWORD workerThreadId;
  DWORD errorCode;
};

struct ProbeShared {
  DWORD magic;
  DWORD version;
  volatile LONG state;
  DWORD operation;
  DWORD processId;
  DWORD threadId;
  UINT_PTR windowHandle;
  UINT_PTR focusWidget;
  UINT_PTR chatContentView;
  int methodIndex;
  int chatContentViewCount;
  int chainLength;
  int resultCode;
  DWORD draftLength;
  wchar_t draft[kProbeDraftCapacity];
  char targetId[kProbeTargetIdCapacity];
  char cid[kProbeCidCapacity];
  char text[kProbeTextCapacity];
  UINT_PTR appMessageService;
  UINT_PTR messageBiz;
  volatile LONG cbtActivateCount;
  volatile LONG cbtMinMaxCount;
  volatile LONG cbtSuppressedCount;
  volatile LONG reportLock;
  volatile LONG aimObserverActive;
  volatile LONG aimObserverCalls;
  volatile LONG aimObserverInFlight;
  UINT_PTR aimOriginalSend;
  UINT_PTR aimVtableSlot;
  DWORD callbackLifecycleStartResult;
  DWORD callbackLifecycleReleaseResult;
  CallbackLifecycleResult callbackLifecycle;
  char report[32768];
};

inline void MakeProbeObjectName(
    wchar_t* destination,
    size_t destinationCount,
    const wchar_t* prefix,
    DWORD processId) {
  swprintf(destination, destinationCount, L"%ls%lu", prefix, processId);
}
