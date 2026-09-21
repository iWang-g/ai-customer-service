#pragma once
#include "message_identity_snapshot.h"
#include <windows.h>
#include <cstddef>
#include <cstring>

namespace direct_receipt {
struct Callback { void* state = nullptr; };
static_assert(sizeof(Callback) == 8);
using Invoke = void (*)(void*, const void*, const void*);
using Destroy = void (*)(const void*);
using Cancel = bool (*)(const void*);
using Construct = void* (*)(void*, Invoke, Destroy, Cancel);
using Adopt = void* (*)(void*, void*);
using Copy = void* (*)(void*, const void*);
using Release = void (*)(void*);
using Polymorphic = Invoke (*)(const void*);
inline constexpr const char* kExports[] = {
  "??0BindStateBase@internal@base@@AEAA@P6AXXZP6AXPEBV012@@ZP6A_N1@Z@Z",
  "??0CallbackBaseCopyable@internal@base@@IEAA@PEAVBindStateBase@12@@Z",
  "??0CallbackBaseCopyable@internal@base@@QEAA@AEBV012@@Z",
  "??1CallbackBaseCopyable@internal@base@@IEAA@XZ",
  "?polymorphic_invoke@CallbackBase@internal@base@@IEBAP6AXXZXZ"
};
template<class T> T Resolve(HMODULE m, const char* name) {
  FARPROC raw = GetProcAddress(m, name); T fn = nullptr;
  static_assert(sizeof(fn) == sizeof(raw)); std::memcpy(&fn, &raw, sizeof(fn)); return fn;
}
struct Api {
  Construct construct; Adopt adopt; Copy copy; Release release; Polymorphic polymorphic;
  bool Load(HMODULE m) {
    construct = Resolve<Construct>(m, kExports[0]); adopt = Resolve<Adopt>(m, kExports[1]);
    copy = Resolve<Copy>(m, kExports[2]); release = Resolve<Release>(m, kExports[3]);
    polymorphic = Resolve<Polymorphic>(m, kExports[4]);
    return construct && adopt && copy && release && polymorphic;
  }
};
struct Snapshot {
  DWORD created = 0, entered = 0, returned = 0, timedOut = 0;
  DWORD callbacks = 0, beforeReturn = 0, late = 0, destroyed = 0, invalid = 0, conflicts = 0;
  DWORD callbackTid = 0;
  qn_research::MessageIdentitySnapshot first{};
};
// Process-owned, never recycled. The host must pin code before creating a callback.
class Slot {
  struct State { alignas(8) unsigned char native[32]; Slot* owner; };
  static_assert(offsetof(State, owner) == 32);
  SRWLOCK lock_ = SRWLOCK_INIT;
  Snapshot data_{};
  static bool Read(void*, std::uint64_t p, void* dst, std::size_t n) {
    SIZE_T got = 0;
    return ReadProcessMemory(GetCurrentProcess(), reinterpret_cast<void*>(p), dst, n, &got) && got == n;
  }
  static void Notify(void* raw, const void* result, const void* message) {
    Slot* slot = static_cast<State*>(raw)->owner;
    const auto snapshot = qn_research::SnapshotMessageIdentity(Read, nullptr,
        reinterpret_cast<std::uint64_t>(result), reinterpret_cast<std::uint64_t>(message));
    AcquireSRWLockExclusive(&slot->lock_);
    auto& s = slot->data_;
    if (!s.callbacks) { s.first = snapshot; s.callbackTid = GetCurrentThreadId(); }
    else if (s.first.status != snapshot.status || s.first.resultCodeValid != snapshot.resultCodeValid ||
        s.first.resultCode != snapshot.resultCode || s.first.messageId != snapshot.messageId ||
        s.first.clientId != snapshot.clientId) ++s.conflicts;
    ++s.callbacks;
    if (!s.returned) ++s.beforeReturn;
    if (s.timedOut) ++s.late;
    if (snapshot.status != qn_research::SnapshotStatus::Ok &&
        snapshot.status != qn_research::SnapshotStatus::NonzeroResult) ++s.invalid;
    ReleaseSRWLockExclusive(&slot->lock_);
  }
  static void Dispose(const void* raw) {
    Slot* slot = static_cast<const State*>(raw)->owner;
    AcquireSRWLockExclusive(&slot->lock_); ++slot->data_.destroyed; ReleaseSRWLockExclusive(&slot->lock_);
    HeapFree(GetProcessHeap(), 0, const_cast<void*>(raw));
  }
  static bool Cancelled(const void*) { return false; }
public:
  bool RecycleIfDestroyed() {
    AcquireSRWLockExclusive(&lock_);
    const bool recyclable = data_.created == 1 && data_.destroyed == data_.created;
    if (recyclable) data_ = Snapshot{};
    ReleaseSRWLockExclusive(&lock_);
    return recyclable;
  }
  bool Create(const Api& api, Callback* cb) {
    AcquireSRWLockExclusive(&lock_);
    if (data_.created || !cb || cb->state) { ReleaseSRWLockExclusive(&lock_); return false; }
    auto* state = static_cast<State*>(HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(State)));
    if (!state) { ReleaseSRWLockExclusive(&lock_); return false; }
    data_.created = 1; state->owner = this;
    api.construct(state, &Notify, &Dispose, &Cancelled); api.adopt(cb, state);
    ReleaseSRWLockExclusive(&lock_); return true;
  }
  void Enter() { AcquireSRWLockExclusive(&lock_); data_.entered = 1; ReleaseSRWLockExclusive(&lock_); }
  void Return() { AcquireSRWLockExclusive(&lock_); data_.returned = 1; ReleaseSRWLockExclusive(&lock_); }
  void Timeout() { AcquireSRWLockExclusive(&lock_); data_.timedOut = 1; ReleaseSRWLockExclusive(&lock_); }
  Snapshot Read() { AcquireSRWLockShared(&lock_); auto s = data_; ReleaseSRWLockShared(&lock_); return s; }
};
}
