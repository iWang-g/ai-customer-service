#include "receipt_lab.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace {
void Check(bool condition, const char* name) {
  if (!condition) {
    std::fprintf(stderr, "FAIL %s (win32=%lu)\n", name, GetLastError());
    ExitProcess(1);
  }
}
template <typename T>
T Resolve(HMODULE module, const char* name) {
  const FARPROC address = GetProcAddress(module, name);
  Check(address != nullptr, name);
  T result = nullptr;
  static_assert(sizeof(result) == sizeof(address));
  std::memcpy(&result, &address, sizeof(result));
  return result;
}
using InvokeFn = void (*)(void*, const void*, const void*);
using GetInvokeFn = InvokeFn (*)(const void*);
using CopyFn = void* (*)(void*, const void*);
using DestructFn = void (*)(void*);
GetInvokeFn gGetInvoke = nullptr;
DestructFn gDestruct = nullptr;

void Notify(ReceiptLabCallback& callback, std::int32_t code) {
  unsigned char result[0x70] = {};
  std::memcpy(result + 8, &code, sizeof(code));
  const auto invoke = gGetInvoke(&callback);
  Check(invoke != nullptr, "native invoke pointer");
  invoke(callback.bindState, result, nullptr);
  // These bytes are borrowed, not a real constructed ResultCode/AppMessage.
  std::memset(result, 0xcc, sizeof(result));
}
struct Work {
  ReceiptLabCallback callback{};
  HANDLE gate = nullptr;
  DWORD repeat = 1;
};
DWORD WINAPI Worker(void* parameter) {
  auto* work = static_cast<Work*>(parameter);
  if (work->gate != nullptr) {
    Check(WaitForSingleObject(work->gate, 5000) == WAIT_OBJECT_0, "worker gate");
  }
  for (DWORD i = 0; i < work->repeat; ++i) Notify(work->callback, 0);
  gDestruct(&work->callback);
  return 0;
}
void Join(HANDLE thread) {
  Check(thread != nullptr, "CreateThread");
  Check(WaitForSingleObject(thread, 10000) == WAIT_OBJECT_0, "thread exit");
  DWORD code = 1;
  Check(GetExitCodeThread(thread, &code) && code == 0, "worker success");
  CloseHandle(thread);
}
}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) {
    std::fprintf(stderr, "Usage: qn_receipt_lab_test.exe <absolute prgbase.dll path>\n");
    return 2;
  }
  wchar_t executable[32768] = {};
  const DWORD length = GetModuleFileNameW(nullptr, executable, 32768);
  Check(length != 0 && length < 32768, "executable path");
  std::wstring path(executable);
  path.resize(path.find_last_of(L"\\/") + 1);
  path += L"qn_receipt_lab_v1.dll";
  HMODULE lab = LoadLibraryW(path.c_str());
  Check(lab != nullptr, "load receipt lab");
  const auto init = Resolve<decltype(&QnReceiptLabInitialize)>(lab, "QnReceiptLabInitialize");
  const auto create = Resolve<decltype(&QnReceiptLabCreate)>(lab, "QnReceiptLabCreate");
  const auto entered = Resolve<decltype(&QnReceiptLabMarkEntered)>(lab, "QnReceiptLabMarkEntered");
  const auto returned = Resolve<decltype(&QnReceiptLabMarkReturned)>(lab, "QnReceiptLabMarkReturned");
  const auto timeout = Resolve<decltype(&QnReceiptLabMarkTimeout)>(lab, "QnReceiptLabMarkTimeout");
  const auto read = Resolve<decltype(&QnReceiptLabRead)>(lab, "QnReceiptLabRead");
  ReceiptLabCallback callback{};
  Check(create(1, &callback) == ERROR_INVALID_STATE, "uninitialized rejected");
  Check(init(argv[1]) == 0, "initialize pinned module");
  Check(init(argv[1]) == ERROR_ALREADY_INITIALIZED, "duplicate initialization rejected");
  HMODULE prg = LoadLibraryExW(argv[1], nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  Check(prg != nullptr, "load prgbase ABI");
  const auto copy = Resolve<CopyFn>(prg,
      "??0CallbackBaseCopyable@internal@base@@QEAA@AEBV012@@Z");
  gDestruct = Resolve<DestructFn>(prg,
      "??1CallbackBaseCopyable@internal@base@@IEAA@XZ");
  gGetInvoke = Resolve<GetInvokeFn>(prg,
      "?polymorphic_invoke@CallbackBase@internal@base@@IEBAP6AXXZXZ");
  const auto snapshot = [&](DWORD id) {
    ReceiptLabSnapshot value{};
    Check(read(id, &value) == 0 && value.version == kReceiptLabVersion, "read snapshot");
    return value;
  };

  Check(create(1, &callback) == 0, "sync create");
  Check(returned(1) == ERROR_INVALID_STATE, "return before entry rejected");
  Check(entered(1) == 0, "sync entered");
  Notify(callback, 7);
  auto value = snapshot(1);
  Check(value.firstResultCode == 7 && value.hasResultCode &&
        value.callbacksBeforeReturn == 1 && !value.callReturned, "synchronous result copied");
  Check(returned(1) == 0, "sync returned");
  gDestruct(&callback);
  callback = {};
  Check(snapshot(1).destroyCount == 1, "sync destroy");
  Check(create(1, &callback) == ERROR_ALREADY_EXISTS, "request reuse rejected");
  std::puts("PASS synchronous_error_and_borrowed_scalar_snapshot");

  Check(create(2, &callback) == 0 && entered(2) == 0 && returned(2) == 0,
        "async setup");
  Work async{};
  copy(&async.callback, &callback);
  gDestruct(&callback);
  callback = {};
  Check(snapshot(2).destroyCount == 0, "native copy retains bind state");
  Join(CreateThread(nullptr, 0, &Worker, &async, 0, nullptr));
  value = snapshot(2);
  Check(value.callbackCount == 1 && value.destroyCount == 1 &&
        !value.callbacksBeforeReturn && value.hasResultCode && value.firstResultCode == 0,
        "async copied result");
  std::puts("PASS async_native_callback_copy_and_final_destroy");

  Check(create(3, &callback) == 0 && entered(3) == 0 && returned(3) == 0,
        "duplicates setup");
  Work workers[4]{};
  HANDLE threads[4]{};
  for (DWORD i = 0; i < 4; ++i) {
    copy(&workers[i].callback, &callback);
    workers[i].repeat = 100;
    threads[i] = CreateThread(nullptr, 0, &Worker, &workers[i], 0, nullptr);
    Check(threads[i] != nullptr, "concurrent CreateThread");
  }
  for (HANDLE thread : threads) Join(thread);
  Notify(callback, 7);
  gDestruct(&callback);
  callback = {};
  value = snapshot(3);
  Check(value.callbackCount == 401 && value.firstResultCode == 0 &&
        value.conflictingResultCount == 1 && value.destroyCount == 1,
        "duplicate notification does not overwrite first result");
  std::puts("PASS concurrent_duplicates_and_conflicting_notification");

  Check(create(4, &callback) == 0 && entered(4) == 0 && returned(4) == 0,
        "late callback setup");
  Work late{};
  late.gate = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  Check(late.gate != nullptr, "late gate");
  copy(&late.callback, &callback);
  gDestruct(&callback);
  callback = {};
  HANDLE lateThread = CreateThread(nullptr, 0, &Worker, &late, 0, nullptr);
  Check(lateThread != nullptr && timeout(4) == 0, "controller timeout");
  Check(FreeLibrary(lab) != 0 && FreeLibrary(prg) != 0, "drop loader references");
  Check(GetModuleHandleW(path.c_str()) != nullptr, "lab still pinned");
  Check(snapshot(4).callbackCount == 0 && snapshot(4).destroyCount == 0,
        "timeout does not destroy native owner");
  Check(SetEvent(late.gate) != 0, "allow late callback");
  Join(lateThread);
  CloseHandle(late.gate);
  value = snapshot(4);
  Check(value.timedOut && value.lateCallbackCount == 1 &&
        value.callbackCount == 1 && value.destroyCount == 1,
        "late result retained after controller reference release");
  std::puts("PASS timeout_then_late_callback_with_module_pinned");

  Check(create(5, &callback) == 0 && entered(5) == 0 && returned(5) == 0 &&
        timeout(5) == 0, "missing callback setup");
  gDestruct(&callback);
  callback = {};
  value = snapshot(5);
  Check(value.timedOut && !value.callbackCount && !value.hasResultCode &&
        value.destroyCount == 1, "destroy without result stays unknown");
  std::puts("PASS missing_receipt_remains_unknown");

  Check(create(6, &callback) == 0 && entered(6) == 0, "null result setup");
  gGetInvoke(&callback)(callback.bindState, nullptr, nullptr);
  gDestruct(&callback);
  callback = {};
  value = snapshot(6);
  Check(value.invalidResultCount == 1 && !value.hasResultCode, "null is not success");
  std::puts("PASS null_result_not_success");

  for (DWORD id = 7; id <= kReceiptLabCapacity; ++id) {
    Check(create(id, &callback) == 0, "bounded slot allocation");
    gDestruct(&callback);
    callback = {};
  }
  Check(create(100, &callback) == ERROR_NOT_ENOUGH_QUOTA && !callback.bindState,
        "capacity exhausted fails closed");
  Check(snapshot(1).firstResultCode == 7 && snapshot(4).lateCallbackCount == 1,
        "old records remain stable");
  std::puts("PASS bounded_capacity_no_slot_reuse");
  std::puts("result=receipt_lab_no_send_ok module_policy=process_lifetime "
            "target_attached=0 send_address_resolved=0 send_invoked=0 "
            "real_resultcode_validated=0 business_delivery_confirmed=0");
  return 0;
}
