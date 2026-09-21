#include "completion_once_shared.h"
#include <bcrypt.h>
#include <cstdio>
#include <cstring>

namespace {
using namespace completion_once;
using qn_debugger_lab::Load;
struct Handle {
  HANDLE value;
  explicit Handle(HANDLE v) : value(v) {}
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  explicit operator bool() const { return value && value != INVALID_HANDLE_VALUE; }
  Handle(const Handle&) = delete;
};
struct View { Shared* value; ~View() { if (value) UnmapViewOfFile(value); } };
bool Dispatch(Shared* s, bool install) {
  HMODULE module = LoadLibraryW(kDll);
  if (!module) { std::printf("ERROR load=%lu\n", GetLastError()); return false; }
  FARPROC raw = GetProcAddress(module, "QnCompletionOnceHook"); HOOKPROC fn = nullptr;
  static_assert(sizeof(raw) == sizeof(fn)); std::memcpy(&fn, &raw, sizeof(fn));
  HHOOK hook = fn ? SetWindowsHookExW(WH_CALLWNDPROC, fn, module, s->identity.tid) : nullptr;
  if (!hook) { std::printf("ERROR hook=%lu\n", GetLastError()); FreeLibrary(module); return false; }
  DWORD_PTR output = 0;
  const LRESULT sent = SendMessageTimeoutW(reinterpret_cast<HWND>(s->identity.hwnd), RegisterWindowMessageW(kMessage),
      install ? 1 : 2, static_cast<LPARAM>(s->token), SMTO_ABORTIFHUNG | SMTO_BLOCK, 5000, &output);
  const BOOL unhooked = UnhookWindowsHookEx(hook);
  FreeLibrary(module);
  std::printf("TRANSPORT install=%d sent=%d unhooked=%d\n", install ? 1 : 0, sent ? 1 : 0, unhooked ? 1 : 0);
  return sent && unhooked;
}
void Print(const Shared* s) {
  std::printf("RESULT phase=%ld hits=%ld snapshot_ready=%ld snapshot_status=%d result_valid=%d result=%d "
      "messageId=%s clientId=%s hit_tid=%lu bind=0x%llx result_ptr=0x%llx message_ptr=0x%llx "
      "cleanup=%ld worker_done=%ld query_seq=%ld error=%lu debug_attach=0 sdk_send=0\n",
      s->phase,s->hits,s->snapshotReady,static_cast<int>(s->snapshot.status),s->snapshot.resultCodeValid ? 1 : 0,
      s->snapshot.resultCode,s->snapshot.messageId.data(),s->snapshot.clientId.data(),s->hitTid,
      s->bindState,s->resultPointer,s->messagePointer,s->cleanupVerified,s->workerDone,s->querySequence,s->error);
}
int Run(bool observe) {
  QnLiveIdentity id{};
  Handle dllFile(CreateFileW(kDll, GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  Handle appFile(CreateFileW(L"D:\\qianniu\\9.97.80N\\AppBiz.dll", GENERIC_READ, FILE_SHARE_READ,
      nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!dllFile || !appFile || !QnSelectLiveIdentity(&id, kDll, live_nosend::kDllPath, kPriorDll, kSecondPriorDll)) {
    std::puts("REFUSE admission"); return 3;
  }
  Handle process(OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ | SYNCHRONIZE, FALSE, id.pid));
  Handle thread(OpenThread(THREAD_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, id.tid));
  if (!process || !thread) return 3;
#if defined(QN_COMPLETION_V2) || defined(QN_COMPLETION_V3)
  if (observe) {
    for (int epoch=1;epoch<kEpoch;++epoch) {
    wchar_t priorName[128]{};
    swprintf_s(priorName,L"Local\\QnCompletionOnce-v%d-%lu-%08lx%08lx",epoch,id.pid,
        id.processCreated.dwHighDateTime,id.processCreated.dwLowDateTime);
    Handle priorMap(OpenFileMappingW(FILE_MAP_ALL_ACCESS,FALSE,priorName));
    if (!priorMap) return 4;
    View priorView{static_cast<Shared*>(MapViewOfFile(priorMap.value,FILE_MAP_ALL_ACCESS,0,0,sizeof(Shared)))};
    auto* prior=priorView.value;
    if (!prior || prior->magic!=kMagic || prior->size!=sizeof(*prior) ||
        !live_nosend::SameIdentity(prior->identity,id) || Load(&prior->phase)!=Finished ||
        Load(&prior->cleanupVerified)!=1 || Load(&prior->workerDone)!=1 || Load(&prior->querySequence)<1) return 4;
    DWORD_PTR barrier=0;
    if (!SendMessageTimeoutW(reinterpret_cast<HWND>(id.hwnd),WM_NULL,0,0,SMTO_ABORTIFHUNG|SMTO_BLOCK,3000,&barrier)) return 4;
    InterlockedOr(&prior->record.state,qn_debugger_lab::EventContinued);
    std::printf("PRIOR epoch=%d cleanup_verified=1 gui_barrier=1 recovery_record_retired=1\n",epoch);
    }
  }
#endif
  wchar_t name[128]{}; Name(name, id);
  Handle mapping(observe ? CreateFileMappingW(INVALID_HANDLE_VALUE, nullptr, PAGE_READWRITE, 0, sizeof(Shared), name) :
      OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, name));
  const DWORD error = GetLastError();
  if (!mapping || (observe && error == ERROR_ALREADY_EXISTS)) {
    std::printf("REFUSE mapping_or_already_used error=%lu retry=0\n", error); return 4;
  }
  View view{static_cast<Shared*>(MapViewOfFile(mapping.value, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(Shared)))};
  if (!view.value) return 4;
  auto* s = view.value;
  if (observe) {
    *s = {}; s->magic = kMagic; s->size = sizeof(*s); s->identity = id;
    s->entry = id.appBase + 0x4f0380; s->durationMs = 60000;
    if (BCryptGenRandom(nullptr, reinterpret_cast<PUCHAR>(&s->token), sizeof(s->token),
        BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0 || !s->token) return 4;
  } else if (s->magic != kMagic || s->size != sizeof(*s) || !live_nosend::SameIdentity(s->identity, id)) return 4;
  if (!QnCheckLiveIdentity(id, kDll, live_nosend::kDllPath, kPriorDll, kSecondPriorDll)) return 3;
  if (observe) {
    if (!Dispatch(s, true)) return 5;
    const ULONGLONG setupDeadline = GetTickCount64() + 5000;
    while (Load(&s->phase) < Armed && GetTickCount64() < setupDeadline) Sleep(10);
    if (Load(&s->phase) != Armed && Load(&s->phase) != Finished) { Print(s); return 5; }
    std::printf("ARMED pid=%lu tid=%lu entry=0x%llx duration_ms=60000 single_shot=1 debug_attach=0\n", id.pid,id.tid,s->entry);
    std::fflush(stdout);
    const ULONGLONG deadline = GetTickCount64() + 65000;
    while (!Load(&s->workerDone) && GetTickCount64() < deadline) {
      if (WaitForSingleObject(process.value, 0) != WAIT_TIMEOUT) { std::puts("ERROR target_exited"); return 6; }
      Sleep(100);
    }
  }
  const LONG sequence = Load(&s->querySequence);
  if (!Dispatch(s, false) || Load(&s->querySequence) != sequence + 1) { Print(s); return 6; }
  Print(s);
  return Load(&s->cleanupVerified) == 1 && Load(&s->workerDone) == 1 &&
      WaitForSingleObject(process.value, 0) == WAIT_TIMEOUT ? 0 : 6;
}
}
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc == 2 && std::wcscmp(argv[1], L"--status") == 0) return Run(false);
    if (argc == 3 && std::wcscmp(argv[1], L"--observe-once") == 0 &&
        std::wcscmp(argv[2], L"QN_COMPLETION_OBSERVE_ONCE") == 0) return Run(true);
  } catch (...) { std::puts("ERROR controller_exception retry=0"); return 7; }
  std::puts("Usage: --status | --observe-once QN_COMPLETION_OBSERVE_ONCE"); return 2;
}
