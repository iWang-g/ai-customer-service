#pragma once

#include <windows.h>
#include <cstdint>

// Laboratory ABI only. No send entry, AppMessage parser, or target injection.
constexpr DWORD kReceiptLabVersion = 1;
constexpr DWORD kReceiptLabCapacity = 16;
struct ReceiptLabCallback { void* bindState; };
static_assert(sizeof(ReceiptLabCallback) == 8);

struct ReceiptLabSnapshot {
  DWORD version;
  DWORD requestId;
  DWORD callEntered;
  DWORD callReturned;
  DWORD timedOut;
  DWORD callbackCount;
  DWORD invalidResultCount;
  DWORD hasResultCode;
  std::int32_t firstResultCode;
  DWORD conflictingResultCount;
  DWORD destroyCount;
  DWORD callbacksBeforeReturn;
  DWORD lateCallbackCount;
};

extern "C" {
DWORD WINAPI QnReceiptLabInitialize(const wchar_t* prgBasePath);
DWORD WINAPI QnReceiptLabCreate(DWORD requestId, ReceiptLabCallback* callback);
DWORD WINAPI QnReceiptLabMarkEntered(DWORD requestId);
DWORD WINAPI QnReceiptLabMarkReturned(DWORD requestId);
DWORD WINAPI QnReceiptLabMarkTimeout(DWORD requestId);
DWORD WINAPI QnReceiptLabRead(DWORD requestId, ReceiptLabSnapshot* snapshot);
}
