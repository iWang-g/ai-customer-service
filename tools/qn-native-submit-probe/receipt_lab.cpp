#include "receipt_lab.h"

#include <cstddef>
#include <cstring>

namespace {
using InvokeFn = void (*)(void*, const void*, const void*);
using DestroyFn = void (*)(const void*);
using CancelFn = bool (*)(const void*);
using ConstructFn = void* (*)(void*, InvokeFn, DestroyFn, CancelFn);
using AdoptFn = void* (*)(void*, void*);

struct BindState {
  alignas(8) unsigned char native[32];
  DWORD slot;
};
static_assert(offsetof(BindState, slot) == 32);
SRWLOCK gLock = SRWLOCK_INIT;
ReceiptLabSnapshot gSlots[kReceiptLabCapacity] = {};
HMODULE gPrgBase = nullptr;
ConstructFn gConstruct = nullptr;
AdoptFn gAdopt = nullptr;

template <typename T>
T Resolve(HMODULE module, const char* name) {
  const FARPROC address = GetProcAddress(module, name);
  T result = nullptr;
  static_assert(sizeof(result) == sizeof(address));
  std::memcpy(&result, &address, sizeof(result));
  return result;
}

ReceiptLabSnapshot* Find(DWORD id) {
  for (auto& slot : gSlots) {
    if (slot.requestId == id && id != 0) return &slot;
  }
  return nullptr;
}

void Invoke(void* raw, const void* result, const void*) {
  const auto* state = static_cast<const BindState*>(raw);
  // The caller must provide a live ResultCode reference. Copy only +8, and
  // never retain native pointers or infer delivery success from this value.
  std::int32_t code = 0;
  if (result != nullptr) {
    std::memcpy(&code, static_cast<const unsigned char*>(result) + 8, sizeof(code));
  }
  AcquireSRWLockExclusive(&gLock);
  auto& slot = gSlots[state->slot];
  ++slot.callbackCount;
  if (!slot.callReturned) ++slot.callbacksBeforeReturn;
  if (slot.timedOut) ++slot.lateCallbackCount;
  if (result == nullptr) {
    ++slot.invalidResultCount;
  } else if (!slot.hasResultCode) {
    slot.firstResultCode = code;
    slot.hasResultCode = 1;
  } else if (slot.firstResultCode != code) {
    ++slot.conflictingResultCount;
  }
  ReleaseSRWLockExclusive(&gLock);
}

void Destroy(const void* raw) {
  const auto* state = static_cast<const BindState*>(raw);
  AcquireSRWLockExclusive(&gLock);
  ++gSlots[state->slot].destroyCount;
  ReleaseSRWLockExclusive(&gLock);
  HeapFree(GetProcessHeap(), 0, const_cast<void*>(raw));
  // The DLL stays pinned: this notification does not establish code quiescence.
}

bool Cancelled(const void*) { return false; }

enum class Mark { Entered, Returned, Timeout };
DWORD SetMark(DWORD id, Mark mark) {
  AcquireSRWLockExclusive(&gLock);
  auto* slot = Find(id);
  DWORD status = ERROR_SUCCESS;
  if (slot == nullptr) {
    status = ERROR_NOT_FOUND;
  } else if (mark == Mark::Entered) {
    if (slot->callEntered || slot->destroyCount || slot->timedOut) {
      status = ERROR_INVALID_STATE;
    } else {
      slot->callEntered = 1;
    }
  } else if (!slot->callEntered) {
    status = ERROR_INVALID_STATE;
  } else if (mark == Mark::Returned) {
    slot->callReturned = 1;
  } else {
    slot->timedOut = 1;
  }
  ReleaseSRWLockExclusive(&gLock);
  return status;
}
}  // namespace

extern "C" __declspec(dllexport)
DWORD WINAPI QnReceiptLabInitialize(const wchar_t* path) {
  if (path == nullptr || path[0] == L'\0') return ERROR_INVALID_PARAMETER;
  AcquireSRWLockExclusive(&gLock);
  if (gPrgBase != nullptr) {
    ReleaseSRWLockExclusive(&gLock);
    return ERROR_ALREADY_INITIALIZED;
  }
  HMODULE prg = LoadLibraryExW(path, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (prg == nullptr) {
    const DWORD error = GetLastError();
    ReleaseSRWLockExclusive(&gLock);
    return error;
  }
  const auto construct = Resolve<ConstructFn>(prg,
      "??0BindStateBase@internal@base@@AEAA@P6AXXZP6AXPEBV012@@ZP6A_N1@Z@Z");
  const auto adopt = Resolve<AdoptFn>(prg,
      "??0CallbackBaseCopyable@internal@base@@IEAA@PEAVBindStateBase@12@@Z");
  HMODULE pinned = nullptr;
  DWORD error = ERROR_SUCCESS;
  if (construct == nullptr || adopt == nullptr) {
    error = ERROR_PROC_NOT_FOUND;
  } else if (!GetModuleHandleExW(
      GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      reinterpret_cast<LPCWSTR>(&gLock), &pinned)) {
    error = GetLastError();
  }
  if (error != ERROR_SUCCESS) {
    FreeLibrary(prg);
  } else {
    // Deliberately retain this dependency and the pinned DLL until process exit.
    gPrgBase = prg;
    gConstruct = construct;
    gAdopt = adopt;
  }
  ReleaseSRWLockExclusive(&gLock);
  return error;
}

extern "C" __declspec(dllexport)
DWORD WINAPI QnReceiptLabCreate(DWORD id, ReceiptLabCallback* callback) {
  if (id == 0 || callback == nullptr || callback->bindState != nullptr) {
    return ERROR_INVALID_PARAMETER;
  }
  AcquireSRWLockExclusive(&gLock);
  if (gPrgBase == nullptr || Find(id) != nullptr) {
    const DWORD error = gPrgBase == nullptr ? ERROR_INVALID_STATE : ERROR_ALREADY_EXISTS;
    ReleaseSRWLockExclusive(&gLock);
    return error;
  }
  DWORD index = 0;
  while (index < kReceiptLabCapacity && gSlots[index].requestId != 0) ++index;
  if (index == kReceiptLabCapacity) {
    ReleaseSRWLockExclusive(&gLock);
    return ERROR_NOT_ENOUGH_QUOTA;
  }
  auto* state = static_cast<BindState*>(HeapAlloc(
      GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(BindState)));
  if (state == nullptr) {
    ReleaseSRWLockExclusive(&gLock);
    return ERROR_NOT_ENOUGH_MEMORY;
  }
  // Slots are never recycled: late notifications cannot target a new request.
  auto& slot = gSlots[index];
  slot.version = kReceiptLabVersion;
  slot.requestId = id;
  state->slot = index;
  gConstruct(state, &Invoke, &Destroy, &Cancelled);
  gAdopt(callback, state);
  ReleaseSRWLockExclusive(&gLock);
  return ERROR_SUCCESS;
}

extern "C" __declspec(dllexport)
DWORD WINAPI QnReceiptLabMarkEntered(DWORD id) { return SetMark(id, Mark::Entered); }
extern "C" __declspec(dllexport)
DWORD WINAPI QnReceiptLabMarkReturned(DWORD id) { return SetMark(id, Mark::Returned); }
extern "C" __declspec(dllexport)
DWORD WINAPI QnReceiptLabMarkTimeout(DWORD id) { return SetMark(id, Mark::Timeout); }
extern "C" __declspec(dllexport)
DWORD WINAPI QnReceiptLabRead(DWORD id, ReceiptLabSnapshot* snapshot) {
  if (snapshot == nullptr) return ERROR_INVALID_PARAMETER;
  AcquireSRWLockShared(&gLock);
  const auto* slot = Find(id);
  const DWORD error = slot == nullptr ? ERROR_NOT_FOUND : ERROR_SUCCESS;
  if (slot != nullptr) *snapshot = *slot;
  ReleaseSRWLockShared(&gLock);
  return error;
}
