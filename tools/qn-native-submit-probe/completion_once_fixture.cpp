#include "completion_once_shared.h"
#include <cstdio>
#include <cstring>
#include <string>
namespace {
using namespace completion_once;
using qn_debugger_lab::Load;
volatile LONG calls = 0;
__attribute__((noinline)) void Callback(void*, const void*, const void*) { InterlockedIncrement(&calls); }
void Check(bool ok, const char* label) {
  if (!ok) { std::printf("FAIL %s win32=%lu\n", label, GetLastError()); ExitProcess(1); }
}
}
int wmain(int argc, wchar_t** argv) {
  SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX);
  const bool hit = argc == 2 && std::wcscmp(argv[1], L"--hit") == 0;
  if (!hit && !(argc == 2 && std::wcscmp(argv[1], L"--timeout") == 0)) return 2;
  QnLiveIdentity id{}; id.pid = GetCurrentProcessId(); id.tid = GetCurrentThreadId();
  FILETIME exited{}, kernel{}, user{};
  Check(GetProcessTimes(GetCurrentProcess(), &id.processCreated, &exited, &kernel, &user) &&
      GetThreadTimes(GetCurrentThread(), &id.threadCreated, &exited, &kernel, &user), "identity");
  wchar_t name[128]{}; Name(name,id);
  HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE,nullptr,PAGE_READWRITE,0,sizeof(Shared),name);
  Check(mapping != nullptr && GetLastError() != ERROR_ALREADY_EXISTS,"mapping");
  auto* s = static_cast<Shared*>(MapViewOfFile(mapping,FILE_MAP_ALL_ACCESS,0,0,sizeof(Shared)));
  Check(s != nullptr,"view"); *s = {}; s->magic=kMagic; s->size=sizeof(*s); s->identity=id;
  s->token=17; s->durationMs=500;
  auto callback = &Callback; static_assert(sizeof(callback)==sizeof(s->entry)); std::memcpy(&s->entry,&callback,sizeof(callback));
  wchar_t executable[32768]{}; GetModuleFileNameW(nullptr,executable,32768);
  std::wstring path(executable); path.resize(path.find_last_of(L'\\')+1); path+=L"qn_completion_fixture_module.dll";
  HMODULE module=LoadLibraryW(path.c_str()); Check(module!=nullptr,"load");
  FARPROC raw=GetProcAddress(module,"QnCompletionFixtureInitialize"); InitializeFn init=nullptr;
  static_assert(sizeof(raw)==sizeof(init)); std::memcpy(&init,&raw,sizeof(init));
  Check(init && init(name)==0,"initialize");
  Check(FreeLibrary(module)!=0,"drop caller module reference");
  const ULONGLONG deadline=GetTickCount64()+5000;
  while (Load(&s->phase)<Armed && GetTickCount64()<deadline) Sleep(1);
  Check(Load(&s->phase)==Armed,"armed");
  unsigned char result[16]{},message[0x70]{};
  char messageId[]="4293759074497.PNM";
  std::uint64_t pointer=reinterpret_cast<std::uint64_t>(messageId), length=std::strlen(messageId), capacity=31;
  std::memcpy(message+0x30,&pointer,8); std::memcpy(message+0x40,&length,8); std::memcpy(message+0x48,&capacity,8);
  std::memcpy(message+0x50,"1234567890123",14); length=13; capacity=15;
  std::memcpy(message+0x60,&length,8); std::memcpy(message+0x68,&capacity,8);
  if(hit) { Callback(nullptr,result,message); Callback(nullptr,result,message); }
  while(!Load(&s->workerDone) && GetTickCount64()<deadline) Sleep(1);
  Check(Load(&s->workerDone)==1 && Load(&s->cleanupVerified)==1,"bounded cleanup");
  Check(Load(&s->hits)==(hit?1:0) && calls==(hit?2:0),"one shot and original callback continues");
  if(hit) Check(s->snapshot.status==qn_research::SnapshotStatus::Ok &&
      std::strcmp(s->snapshot.messageId.data(),messageId)==0 &&
      std::strcmp(s->snapshot.clientId.data(),"1234567890123")==0,"captured identities");
  std::printf("PASS mode=%s hits=%ld calls=%ld cleanup=%ld error=%lu debugger=0\n",hit?"hit":"timeout",s->hits,calls,s->cleanupVerified,s->error);
  UnmapViewOfFile(s); CloseHandle(mapping); return 0;
}
