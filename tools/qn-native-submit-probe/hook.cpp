#include "probe_shared.h"

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace {

using FocusWidgetFn = void* (*)();
using FindWidgetFn = void* (*)(UINT_PTR);
using WidgetFocusFn = void* (*)(const void*);
using NextFocusWidgetFn = void* (*)(const void*);
using ParentFn = void* (*)(const void*);
using InheritsFn = bool (*)(const void*, const char*);
using ClassNameFn = const char* (*)(const void*);
using IndexOfMethodFn = int (*)(const void*, const char*);
using MetaCallFn = int (*)(void*, int, int, void**);
using WidgetStateFn = bool (*)(const void*);
using WidgetActionFn = void (*)(void*);
using MetaObjectVirtualFn = const void* (*)(const void*);
using TextEditDocumentFn = void* (*)(const void*);
using TextEditSetPlainTextFn = void (*)(void*, const void*);
using TextEditClearFn = void (*)(void*);
using QStringUtf16CtorFn = void* (*)(void*, const void*, int);
using QStringDtorFn = void (*)(void*);
using GetAIMEngineFn = void* (*)();
using AimSendMessageFn = void (*)(
    void*, const void*, const void*, const void*, const void*, const void*);
using AppSendTextMessageFn = void (*)(
    void*, const void*, const void*, const void*, const void*, const void*);
using MsvcStringAssignFn = void* (*)(void*, const void*, size_t);
using MsvcStringDestructorFn = void (*)(void*);
using ExtensionsConstructorFn = void* (*)(void*);
using ExtensionsDestructorFn = void (*)(void*);
using DirectSendTextFn = void (*)(
    void*, const void*, const void*, const void*, const void*, const void*);
using CallbackInvokeFn = void (*)(void*, const void*, const void*);
using BindStateDestroyFn = void (*)(const void*);
using BindStateCancelledFn = bool (*)(const void*);
using BindStateConstructorFn = void* (*)(
    void*, CallbackInvokeFn, BindStateDestroyFn, BindStateCancelledFn);
using CallbackFromBindStateFn = void* (*)(void*, void*);
using CallbackCopyConstructorFn = void* (*)(void*, const void*);
using CallbackDestructorFn = void (*)(void*);
using CallbackPolymorphicInvokeFn = CallbackInvokeFn (*)(const void*);

constexpr uintptr_t kAppMessageServiceVtableRva = 0x18afda8;
constexpr uintptr_t kAppMessageServiceSendTextRva = 0xa73a40;
constexpr size_t kAppMessageServiceSendTextSlot = 18;
constexpr uintptr_t kMsvcStringAssignRva = 0x17ccd0;
constexpr uintptr_t kMsvcStringDestructorRva = 0x14e2c0;
constexpr uintptr_t kExtensionsConstructorRva = 0x24dca0;
constexpr uintptr_t kExtensionsDestructorRva = 0x24ea10;
constexpr uintptr_t kMessageBizSendTextRva = 0xa54b40;
constexpr uintptr_t kAimEngineExVtableRva = 0x568798;
constexpr uintptr_t kAimManagerImplVtableRva = 0x569858;
constexpr uintptr_t kAimMsgServiceExVtableRva = 0x56bb10;
constexpr uintptr_t kAimMsgServiceExSendRva = 0x0b4920;
constexpr size_t kAimMsgServiceExSendSlot = 4;
constexpr size_t kMaxAimManagers = 10;
constexpr size_t kMaxObservedAimSends = 8;

AimSendMessageFn gAimOriginalSend = nullptr;
void** gAimSendVtableSlot = nullptr;
AppSendTextMessageFn gAppOriginalSendText = nullptr;
void** gAppSendTextVtableSlot = nullptr;
HMODULE gThisModule = nullptr;
HMODULE gCallbackLifecycleRetainedModule = nullptr;
HMODULE gCallbackLifecyclePrgBase = nullptr;
HANDLE gCallbackLifecycleDoneEvent = nullptr;
HANDLE gCallbackLifecycleWorker = nullptr;
HANDLE gCallbackLifecycleMapping = nullptr;
void* gCallbackLifecycleMappedView = nullptr;
CallbackLifecycleResult* gCallbackLifecycleResult = nullptr;
CallbackDestructorFn gCallbackLifecycleDestructor = nullptr;
CallbackPolymorphicInvokeFn gCallbackLifecyclePolymorphicInvoke = nullptr;
alignas(void*) unsigned char gCallbackLifecycleCopy[sizeof(void*)] = {};
volatile LONG gCallbackLifecycleActive = 0;

void RunCallbackLifecycleStart(ProbeShared* shared, HANDLE doneEvent);
void RunCallbackLifecycleRelease(ProbeShared* shared, HANDLE doneEvent);

constexpr char kFocusWidgetSymbol[] =
    "?focusWidget@QApplication@@SAPEAVQWidget@@XZ";
constexpr char kFindWidgetSymbol[] = "?find@QWidget@@SAPEAV1@_K@Z";
constexpr char kWidgetFocusSymbol[] =
    "?focusWidget@QWidget@@QEBAPEAV1@XZ";
constexpr char kNextFocusWidgetSymbol[] =
    "?nextInFocusChain@QWidget@@QEBAPEAV1@XZ";
constexpr char kParentSymbol[] = "?parent@QObject@@QEBAPEAV1@XZ";
constexpr char kInheritsSymbol[] = "?inherits@QObject@@QEBA_NPEBD@Z";
constexpr char kClassNameSymbol[] = "?className@QMetaObject@@QEBAPEBDXZ";
constexpr char kIndexOfMethodSymbol[] =
    "?indexOfMethod@QMetaObject@@QEBAHPEBD@Z";
constexpr char kMetaCallSymbol[] =
    "?metacall@QMetaObject@@SAHPEAVQObject@@W4Call@1@HPEAPEAX@Z";
constexpr char kIsVisibleSymbol[] = "?isVisible@QWidget@@QEBA_NXZ";
constexpr char kIsEnabledSymbol[] = "?isEnabled@QWidget@@QEBA_NXZ";
constexpr char kIsMinimizedSymbol[] = "?isMinimized@QWidget@@QEBA_NXZ";
constexpr char kShowMinimizedSymbol[] = "?showMinimized@QWidget@@QEAAXXZ";
constexpr char kTextEditDocumentSymbol[] =
    "?document@QTextEdit@@QEBAPEAVQTextDocument@@XZ";
constexpr char kTextEditIsReadOnlySymbol[] =
    "?isReadOnly@QTextEdit@@QEBA_NXZ";
constexpr char kTextDocumentIsEmptySymbol[] =
    "?isEmpty@QTextDocument@@QEBA_NXZ";
constexpr char kTextEditSetPlainTextSymbol[] =
    "?setPlainText@QTextEdit@@QEAAXAEBVQString@@@Z";
constexpr char kTextEditClearSymbol[] = "?clear@QTextEdit@@QEAAXXZ";
constexpr char kQStringUtf16CtorSymbol[] =
    "??0QString@@QEAA@PEBVQChar@@H@Z";
constexpr char kQStringDtorSymbol[] = "??1QString@@QEAA@XZ";

void AppendReport(ProbeShared* shared, const char* format, ...) {
  const size_t used = strnlen(shared->report, sizeof(shared->report));
  if (used >= sizeof(shared->report) - 1) {
    return;
  }
  va_list arguments;
  va_start(arguments, format);
  vsnprintf(
      shared->report + used,
      sizeof(shared->report) - used,
      format,
      arguments);
  va_end(arguments);
}

template <typename FunctionPointer>
FunctionPointer Resolve(HMODULE module, const char* symbol, ProbeShared* shared) {
  static_assert(sizeof(FunctionPointer) == sizeof(FARPROC));
  FARPROC raw = module == nullptr ? nullptr : GetProcAddress(module, symbol);
  if (raw == nullptr) {
    AppendReport(shared, "missing_export=%s\n", symbol);
  }
  FunctionPointer value = nullptr;
  memcpy(&value, &raw, sizeof(value));
  return value;
}

const void* GetDynamicMetaObject(const void* object) {
  if (object == nullptr) {
    return nullptr;
  }
  auto vtable = *reinterpret_cast<void* const* const*>(object);
  if (vtable == nullptr || vtable[0] == nullptr) {
    return nullptr;
  }
  auto metaObject = reinterpret_cast<MetaObjectVirtualFn>(vtable[0]);
  return metaObject(object);
}

void Complete(ProbeShared* shared, HANDLE doneEvent, int resultCode) {
  shared->resultCode = resultCode;
  InterlockedExchange(&shared->state, kProbeComplete);
  if (doneEvent != nullptr) {
    SetEvent(doneEvent);
  }
}

bool IsReadable(const void* address, size_t length) {
  if (address == nullptr || length == 0) {
    return false;
  }
  MEMORY_BASIC_INFORMATION information = {};
  if (VirtualQuery(address, &information, sizeof(information)) == 0 ||
      information.State != MEM_COMMIT ||
      (information.Protect & (PAGE_GUARD | PAGE_NOACCESS)) != 0) {
    return false;
  }
  const uintptr_t start = reinterpret_cast<uintptr_t>(address);
  const uintptr_t regionEnd =
      reinterpret_cast<uintptr_t>(information.BaseAddress) +
      information.RegionSize;
  return start <= regionEnd && length <= regionEnd - start;
}

bool ReadPointer(const void* address, const void** value) {
  if (!IsReadable(address, sizeof(*value))) {
    return false;
  }
  memcpy(value, address, sizeof(*value));
  return true;
}

bool ReadMsvcString(
    const void* object,
    char* output,
    size_t outputSize,
    size_t* outputLength = nullptr) {
  if (!IsReadable(object, 32) || outputSize == 0) {
    return false;
  }
  const auto* bytes = static_cast<const unsigned char*>(object);
  size_t length = 0;
  size_t capacity = 0;
  memcpy(&length, bytes + 16, sizeof(length));
  memcpy(&capacity, bytes + 24, sizeof(capacity));
  if (length > 4096 || capacity < length || capacity > 1024 * 1024) {
    return false;
  }
  const char* data = reinterpret_cast<const char*>(bytes);
  if (capacity > 15) {
    const void* heapData = nullptr;
    if (!ReadPointer(bytes, &heapData)) {
      return false;
    }
    data = static_cast<const char*>(heapData);
  }
  if (!IsReadable(data, length + 1)) {
    return false;
  }
  const size_t copied = length < outputSize - 1 ? length : outputSize - 1;
  for (size_t index = 0; index < copied; ++index) {
    const unsigned char character = static_cast<unsigned char>(data[index]);
    output[index] = character >= 0x20 && character != 0x7f
        ? static_cast<char>(character)
        : '?';
  }
  output[copied] = '\0';
  if (outputLength != nullptr) {
    *outputLength = length;
  }
  return copied == length;
}

bool FindAimAccountForMessageService(
    HMODULE aim,
    const void* messageService,
    char* uid,
    size_t uidSize) {
  FARPROC rawGetEngine = aim == nullptr
      ? nullptr
      : GetProcAddress(aim, "GetAIMEngine");
  GetAIMEngineFn getEngine = nullptr;
  memcpy(&getEngine, &rawGetEngine, sizeof(getEngine));
  if (getEngine == nullptr || messageService == nullptr) {
    return false;
  }
  void* engine = getEngine();
  const void* engineVtable = nullptr;
  const void* engineImpl = nullptr;
  if (!ReadPointer(engine, &engineVtable) ||
      engineVtable != reinterpret_cast<const unsigned char*>(aim) +
          kAimEngineExVtableRva ||
      !ReadPointer(static_cast<const unsigned char*>(engine) + 8, &engineImpl) ||
      engineImpl == nullptr) {
    return false;
  }
  const auto* impl = static_cast<const unsigned char*>(engineImpl);
  const void* head = nullptr;
  size_t managerCount = 0;
  if (!ReadPointer(impl + 0xd8, &head) ||
      !IsReadable(impl + 0xe0, sizeof(managerCount))) {
    return false;
  }
  memcpy(&managerCount, impl + 0xe0, sizeof(managerCount));
  if (head == nullptr || managerCount > kMaxAimManagers) {
    return false;
  }
  const void* root = nullptr;
  if (!ReadPointer(static_cast<const unsigned char*>(head) + 8, &root)) {
    return false;
  }
  const void* stack[32] = {};
  size_t stackSize = 0;
  size_t visited = 0;
  const void* current = root;
  while ((current != head || stackSize != 0) && visited < managerCount) {
    while (current != head) {
      if (!IsReadable(current, 0x90) || stackSize == _countof(stack)) {
        return false;
      }
      stack[stackSize++] = current;
      if (!ReadPointer(current, &current)) {
        return false;
      }
    }
    if (stackSize == 0) {
      break;
    }
    current = stack[--stackSize];
    const auto* node = static_cast<const unsigned char*>(current);
    const void* manager = nullptr;
    const void* service = nullptr;
    if (ReadPointer(node + 0x80, &manager) && manager != nullptr &&
        ReadPointer(static_cast<const unsigned char*>(manager) + 0x168, &service) &&
        service == messageService) {
      return ReadMsvcString(node + 0x20, uid, uidSize);
    }
    ++visited;
    if (!ReadPointer(node + 0x10, &current)) {
      return false;
    }
  }
  return false;
}

void AppendAimExtensions(ProbeShared* shared, const void* extensions) {
  const void* head = nullptr;
  size_t count = 0;
  if (!ReadPointer(extensions, &head) ||
      !IsReadable(static_cast<const unsigned char*>(extensions) + 8,
                  sizeof(count))) {
    AppendReport(shared, "  extensions=<unreadable>\n");
    return;
  }
  memcpy(&count, static_cast<const unsigned char*>(extensions) + 8,
         sizeof(count));
  AppendReport(shared, "  extensions count=%zu head=0x%llx\n", count,
               reinterpret_cast<unsigned long long>(head));
  if (head == nullptr || count > 32 || !IsReadable(head, 0x20)) {
    return;
  }
  const void* root = nullptr;
  ReadPointer(static_cast<const unsigned char*>(head) + 8, &root);
  const void* stack[40] = {};
  size_t stackSize = 0;
  size_t visited = 0;
  const void* current = root;
  while ((current != head || stackSize != 0) && visited < count) {
    while (current != head) {
      if (!IsReadable(current, 0x60) || stackSize == _countof(stack)) {
        AppendReport(shared, "  extension_error=invalid_node\n");
        return;
      }
      stack[stackSize++] = current;
      if (!ReadPointer(current, &current)) {
        return;
      }
    }
    if (stackSize == 0) {
      break;
    }
    current = stack[--stackSize];
    const auto* node = static_cast<const unsigned char*>(current);
    char key[512] = {};
    char value[1024] = {};
    const bool keyValid = ReadMsvcString(node + 0x20, key, sizeof(key));
    const bool valueValid = ReadMsvcString(node + 0x40, value, sizeof(value));
    AppendReport(shared, "  extension[%zu] key=%s value=%s\n", visited,
                 keyValid ? key : "<invalid>",
                 valueValid ? value : "<invalid>");
    ++visited;
    if (!ReadPointer(node + 0x10, &current)) {
      return;
    }
  }
}

void AppendAppExtensionsHeader(ProbeShared* shared, const void* extensions) {
  if (!IsReadable(extensions, 64)) {
    AppendReport(shared, "  app_extensions=<unreadable>\n");
    return;
  }
  const auto* bytes = static_cast<const unsigned char*>(extensions);
  unsigned int maxLoadFactorBits = 0;
  const void* listHead = nullptr;
  size_t count = 0;
  const void* bucketBegin = nullptr;
  const void* bucketEnd = nullptr;
  const void* bucketCapacity = nullptr;
  memcpy(&maxLoadFactorBits, bytes, sizeof(maxLoadFactorBits));
  memcpy(&listHead, bytes + 8, sizeof(listHead));
  memcpy(&count, bytes + 16, sizeof(count));
  memcpy(&bucketBegin, bytes + 24, sizeof(bucketBegin));
  memcpy(&bucketEnd, bytes + 32, sizeof(bucketEnd));
  memcpy(&bucketCapacity, bytes + 40, sizeof(bucketCapacity));
  AppendReport(
      shared,
      "  app_extensions count=%zu maxLoadFactorBits=0x%08x "
      "listHead=0x%llx buckets=0x%llx..0x%llx capacity=0x%llx\n",
      count,
      maxLoadFactorBits,
      reinterpret_cast<unsigned long long>(listHead),
      reinterpret_cast<unsigned long long>(bucketBegin),
      reinterpret_cast<unsigned long long>(bucketEnd),
      reinterpret_cast<unsigned long long>(bucketCapacity));
}

void AppendAimSendStack(ProbeShared* shared) {
  void* frames[16] = {};
  const USHORT frameCount = CaptureStackBackTrace(
      0, static_cast<DWORD>(_countof(frames)), frames, nullptr);
  AppendReport(shared, "  stack frames=%hu\n", frameCount);
  for (USHORT index = 0; index < frameCount; ++index) {
    MEMORY_BASIC_INFORMATION information = {};
    HMODULE module = nullptr;
    wchar_t modulePath[MAX_PATH] = {};
    if (VirtualQuery(frames[index], &information, sizeof(information)) != 0) {
      module = static_cast<HMODULE>(information.AllocationBase);
      GetModuleFileNameW(module, modulePath, _countof(modulePath));
    }
    const wchar_t* moduleName = wcsrchr(modulePath, L'\\');
    moduleName = moduleName == nullptr ? modulePath : moduleName + 1;
    char moduleUtf8[MAX_PATH * 3] = {};
    WideCharToMultiByte(
        CP_UTF8, 0, moduleName, -1, moduleUtf8,
        static_cast<int>(sizeof(moduleUtf8)), nullptr, nullptr);
    const uintptr_t rva = module == nullptr
        ? 0
        : reinterpret_cast<uintptr_t>(frames[index]) -
            reinterpret_cast<uintptr_t>(module);
    AppendReport(shared, "    [%hu] %s+0x%llx address=0x%llx\n", index,
                 moduleUtf8[0] == '\0' ? "<unknown>" : moduleUtf8,
                 static_cast<unsigned long long>(rva),
                 reinterpret_cast<unsigned long long>(frames[index]));
  }
}

void ObserveAimSend(
    void* self,
    const void* message,
    const void* progressCallback,
    const void* successCallback,
    const void* failureCallback,
    const void* extensions) {
  const DWORD processId = GetCurrentProcessId();
  wchar_t mappingName[128] = {};
  MakeProbeObjectName(
      mappingName, _countof(mappingName), kProbeMappingPrefix, processId);
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mappingName);
  ProbeShared* shared = nullptr;
  bool countedInFlight = false;
  if (mapping != nullptr) {
    shared = static_cast<ProbeShared*>(MapViewOfFile(
        mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ProbeShared)));
  }

  if (shared != nullptr && shared->magic == kProbeMagic &&
      shared->version == kProbeVersion && shared->aimObserverActive != 0) {
    InterlockedIncrement(&shared->aimObserverInFlight);
    countedInFlight = true;
    const LONG callIndex = InterlockedIncrement(&shared->aimObserverCalls);
    if (callIndex <= static_cast<LONG>(kMaxObservedAimSends) &&
        InterlockedCompareExchange(&shared->reportLock, 1, 0) == 0) {
      HMODULE aim = GetModuleHandleW(L"aim.dll");
      const void* wrapperVtable = nullptr;
      const void* messageService = nullptr;
      ReadPointer(self, &wrapperVtable);
      ReadPointer(static_cast<const unsigned char*>(self) + 8, &messageService);
      char uid[256] = {};
      const bool uidValid = FindAimAccountForMessageService(
          aim, messageService, uid, sizeof(uid));
      char cid[1024] = {};
      const bool cidValid = ReadMsvcString(message, cid, sizeof(cid));
      AppendReport(
          shared,
          "aim_send[%ld] thread=%lu this=0x%llx wrapperVtable=0x%llx "
          "msgServiceImpl=0x%llx uid=%s message=0x%llx cid=%s\n",
          callIndex,
          GetCurrentThreadId(),
          reinterpret_cast<unsigned long long>(self),
          reinterpret_cast<unsigned long long>(wrapperVtable),
          reinterpret_cast<unsigned long long>(messageService),
          uidValid ? uid : "<unmapped>",
          reinterpret_cast<unsigned long long>(message),
          cidValid ? cid : "<invalid>");
      AppendReport(
          shared,
          "  callbacks progress=0x%llx success=0x%llx failure=0x%llx "
          "extensions=0x%llx\n",
          reinterpret_cast<unsigned long long>(progressCallback),
          reinterpret_cast<unsigned long long>(successCallback),
          reinterpret_cast<unsigned long long>(failureCallback),
          reinterpret_cast<unsigned long long>(extensions));
      AppendAimSendStack(shared);

      if (IsReadable(message, 0x400)) {
        const auto* bytes = static_cast<const unsigned char*>(message);
        for (size_t offset = 0; offset < 0x100; offset += 0x20) {
          unsigned long long values[4] = {};
          memcpy(values, bytes + offset, sizeof(values));
          AppendReport(
              shared,
              "  raw+0x%03zx=%016llx %016llx %016llx %016llx\n",
              offset, values[0], values[1], values[2], values[3]);
        }
        for (size_t offset = 0; offset + 0x20 <= 0x400; offset += 8) {
          char value[1024] = {};
          size_t length = 0;
          if (ReadMsvcString(bytes + offset, value, sizeof(value), &length) &&
              length != 0) {
            AppendReport(shared, "  string+0x%03zx len=%zu value=%s\n",
                         offset, length, value);
          }
        }
      } else {
        AppendReport(shared, "  message_object=<unreadable_0x400>\n");
      }
      AppendAimExtensions(shared, extensions);
      InterlockedExchange(&shared->reportLock, 0);
    }
  }

  AimSendMessageFn original = gAimOriginalSend;
  if (original != nullptr) {
    original(self, message, progressCallback, successCallback, failureCallback,
             extensions);
  }

  if (countedInFlight && shared != nullptr && shared->magic == kProbeMagic &&
      shared->version == kProbeVersion) {
    InterlockedDecrement(&shared->aimObserverInFlight);
  }
  if (shared != nullptr) {
    UnmapViewOfFile(shared);
  }
  if (mapping != nullptr) {
    CloseHandle(mapping);
  }
}

void ObserveAppSendText(
    void* self,
    const void* cidValue,
    const void* textValue,
    const void* sourceValue,
    const void* extensions,
    const void* callback) {
  const DWORD processId = GetCurrentProcessId();
  wchar_t mappingName[128] = {};
  MakeProbeObjectName(
      mappingName, _countof(mappingName), kProbeMappingPrefix, processId);
  HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mappingName);
  ProbeShared* shared = nullptr;
  bool countedInFlight = false;
  if (mapping != nullptr) {
    shared = static_cast<ProbeShared*>(MapViewOfFile(
        mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ProbeShared)));
  }

  if (shared != nullptr && shared->magic == kProbeMagic &&
      shared->version == kProbeVersion && shared->aimObserverActive != 0) {
    InterlockedIncrement(&shared->aimObserverInFlight);
    countedInFlight = true;
    if (InterlockedCompareExchange(&shared->reportLock, 1, 0) == 0) {
      char cid[1024] = {};
      char text[4096] = {};
      char source[2048] = {};
      const bool cidValid = ReadMsvcString(cidValue, cid, sizeof(cid));
      const bool textValid = ReadMsvcString(textValue, text, sizeof(text));
      const bool sourceValid = ReadMsvcString(sourceValue, source, sizeof(source));
      char accountTargetId[256] = {};
      const bool accountTargetIdValid = ReadMsvcString(
          static_cast<const unsigned char*>(self) + 0x3d0,
          accountTargetId,
          sizeof(accountTargetId));
      int accountTargetType = -1;
      if (IsReadable(static_cast<const unsigned char*>(self) + 0x3f0,
                     sizeof(accountTargetType))) {
        memcpy(&accountTargetType,
               static_cast<const unsigned char*>(self) + 0x3f0,
               sizeof(accountTargetType));
      }
      const void* convBiz = nullptr;
      ReadPointer(static_cast<const unsigned char*>(self) + 0x578, &convBiz);
      AppendReport(
          shared,
          "app_send_text thread=%lu this=0x%llx convBiz=0x%llx "
          "accountTargetId=%s accountTargetType=%d cid=%s text=%s source=%s "
          "extensions=0x%llx callback=0x%llx\n",
          GetCurrentThreadId(),
          reinterpret_cast<unsigned long long>(self),
          reinterpret_cast<unsigned long long>(convBiz),
          accountTargetIdValid ? accountTargetId : "<invalid>",
          accountTargetType,
          cidValid ? cid : "<invalid>",
          textValid ? text : "<invalid>",
          sourceValid ? source : "<invalid>",
          reinterpret_cast<unsigned long long>(extensions),
          reinterpret_cast<unsigned long long>(callback));
      const void* callbackBindState = nullptr;
      const bool callbackReadable =
          IsReadable(callback, sizeof(callbackBindState)) &&
          ReadPointer(callback, &callbackBindState);
      LONG callbackRefCount = -1;
      const void* callbackInvoke = nullptr;
      const void* callbackDestroy = nullptr;
      const void* callbackIsCancelled = nullptr;
      const bool bindStateReadable = callbackBindState != nullptr &&
          IsReadable(callbackBindState, 0x20);
      if (bindStateReadable) {
        const auto* bindBytes =
            static_cast<const unsigned char*>(callbackBindState);
        memcpy(&callbackRefCount, bindBytes, sizeof(callbackRefCount));
        ReadPointer(bindBytes + 8, &callbackInvoke);
        ReadPointer(bindBytes + 16, &callbackDestroy);
        ReadPointer(bindBytes + 24, &callbackIsCancelled);
      }
      AppendReport(
          shared,
          "  app_callback size=8 readable=%d bindState=0x%llx empty=%d "
          "bindReadable=%d refCount=%ld invoke=0x%llx destroy=0x%llx "
          "isCancelled=0x%llx\n",
          callbackReadable ? 1 : 0,
          reinterpret_cast<unsigned long long>(callbackBindState),
          callbackReadable && callbackBindState == nullptr ? 1 : 0,
          bindStateReadable ? 1 : 0,
          static_cast<long>(callbackRefCount),
          reinterpret_cast<unsigned long long>(callbackInvoke),
          reinterpret_cast<unsigned long long>(callbackDestroy),
          reinterpret_cast<unsigned long long>(callbackIsCancelled));
      AppendAppExtensionsHeader(shared, extensions);
      AppendAimSendStack(shared);
      InterlockedExchange(&shared->reportLock, 0);
    }
  }

  AppSendTextMessageFn original = gAppOriginalSendText;
  if (original != nullptr) {
    original(self, cidValue, textValue, sourceValue, extensions, callback);
  }

  if (countedInFlight && shared != nullptr && shared->magic == kProbeMagic &&
      shared->version == kProbeVersion) {
    InterlockedDecrement(&shared->aimObserverInFlight);
  }
  if (shared != nullptr) {
    UnmapViewOfFile(shared);
  }
  if (mapping != nullptr) {
    CloseHandle(mapping);
  }
}

bool ReplaceAimSendSlot(void** slot, void* replacement, void** previous) {
  DWORD oldProtection = 0;
  if (!VirtualProtect(slot, sizeof(*slot), PAGE_READWRITE, &oldProtection)) {
    return false;
  }
  *previous = InterlockedExchangePointer(
      reinterpret_cast<PVOID volatile*>(slot), replacement);
  DWORD ignored = 0;
  VirtualProtect(slot, sizeof(*slot), oldProtection, &ignored);
  return true;
}

void RunAimObserverStart(ProbeShared* shared, HANDLE doneEvent) {
  HMODULE aim = GetModuleHandleW(L"aim.dll");
  HMODULE appBiz = GetModuleHandleW(L"AppBiz.dll");
  if (aim == nullptr || appBiz == nullptr || gAimSendVtableSlot != nullptr ||
      gAimOriginalSend != nullptr || gAppSendTextVtableSlot != nullptr ||
      gAppOriginalSendText != nullptr) {
    AppendReport(shared, "error=aim_observer_start_state\n");
    Complete(shared, doneEvent, 36);
    return;
  }
  auto* slot = reinterpret_cast<void**>(
      reinterpret_cast<unsigned char*>(aim) + kAimMsgServiceExVtableRva +
      kAimMsgServiceExSendSlot * sizeof(void*));
  void* expected = reinterpret_cast<unsigned char*>(aim) +
      kAimMsgServiceExSendRva;
  auto* appSlot = reinterpret_cast<void**>(
      reinterpret_cast<unsigned char*>(appBiz) +
      kAppMessageServiceVtableRva +
      kAppMessageServiceSendTextSlot * sizeof(void*));
  void* appExpected = reinterpret_cast<unsigned char*>(appBiz) +
      kAppMessageServiceSendTextRva;
  const void* current = nullptr;
  const void* appCurrent = nullptr;
  if (!ReadPointer(slot, &current) || current != expected ||
      !ReadPointer(appSlot, &appCurrent) || appCurrent != appExpected) {
    AppendReport(
        shared,
        "error=send_slot_mismatch aimSlot=0x%llx aimCurrent=0x%llx "
        "aimExpected=0x%llx appSlot=0x%llx appCurrent=0x%llx "
        "appExpected=0x%llx\n",
        reinterpret_cast<unsigned long long>(slot),
        reinterpret_cast<unsigned long long>(current),
        reinterpret_cast<unsigned long long>(expected),
        reinterpret_cast<unsigned long long>(appSlot),
        reinterpret_cast<unsigned long long>(appCurrent),
        reinterpret_cast<unsigned long long>(appExpected));
    Complete(shared, doneEvent, 37);
    return;
  }
  AimSendMessageFn observerFunction = &ObserveAimSend;
  void* observerAddress = nullptr;
  memcpy(&observerAddress, &observerFunction, sizeof(observerAddress));
  void* previous = nullptr;
  AimSendMessageFn originalFunction = nullptr;
  memcpy(&originalFunction, &expected, sizeof(originalFunction));
  gAimOriginalSend = originalFunction;
  gAimSendVtableSlot = slot;
  const bool aimReplaced =
      ReplaceAimSendSlot(slot, observerAddress, &previous);
  if (!aimReplaced || previous != expected) {
    if (aimReplaced) {
      void* ignored = nullptr;
      ReplaceAimSendSlot(slot, previous, &ignored);
    }
    gAimSendVtableSlot = nullptr;
    gAimOriginalSend = nullptr;
    AppendReport(shared, "error=aim_send_slot_patch_failed win32=%lu\n",
                 GetLastError());
    Complete(shared, doneEvent, 38);
    return;
  }
  AppSendTextMessageFn appObserverFunction = &ObserveAppSendText;
  void* appObserverAddress = nullptr;
  memcpy(&appObserverAddress, &appObserverFunction, sizeof(appObserverAddress));
  void* appPrevious = nullptr;
  AppSendTextMessageFn appOriginalFunction = nullptr;
  memcpy(&appOriginalFunction, &appExpected, sizeof(appOriginalFunction));
  gAppOriginalSendText = appOriginalFunction;
  gAppSendTextVtableSlot = appSlot;
  const bool appReplaced =
      ReplaceAimSendSlot(appSlot, appObserverAddress, &appPrevious);
  if (!appReplaced || appPrevious != appExpected) {
    if (appReplaced) {
      void* ignored = nullptr;
      ReplaceAimSendSlot(appSlot, appPrevious, &ignored);
    }
    void* ignored = nullptr;
    ReplaceAimSendSlot(slot, expected, &ignored);
    gAimSendVtableSlot = nullptr;
    gAimOriginalSend = nullptr;
    gAppSendTextVtableSlot = nullptr;
    gAppOriginalSendText = nullptr;
    AppendReport(shared, "error=app_send_text_slot_patch_failed win32=%lu\n",
                 GetLastError());
    Complete(shared, doneEvent, 43);
    return;
  }
  shared->aimOriginalSend = reinterpret_cast<UINT_PTR>(expected);
  shared->aimVtableSlot = reinterpret_cast<UINT_PTR>(slot);
  InterlockedExchange(&shared->aimObserverActive, 1);
  AppendReport(
      shared,
      "send_chain_observer installed=1 aimSlot=0x%llx aimOriginal=0x%llx "
      "aimHook=0x%llx appSlot=0x%llx appOriginal=0x%llx appHook=0x%llx "
      "maxAimEvents=%zu\n",
      reinterpret_cast<unsigned long long>(slot),
      reinterpret_cast<unsigned long long>(expected),
      reinterpret_cast<unsigned long long>(observerAddress),
      reinterpret_cast<unsigned long long>(appSlot),
      reinterpret_cast<unsigned long long>(appExpected),
      reinterpret_cast<unsigned long long>(appObserverAddress),
      kMaxObservedAimSends);
  Complete(shared, doneEvent, 0);
}

void RunAimObserverStop(ProbeShared* shared, HANDLE doneEvent) {
  InterlockedExchange(&shared->aimObserverActive, 0);
  if (gAimSendVtableSlot == nullptr || gAimOriginalSend == nullptr ||
      gAppSendTextVtableSlot == nullptr || gAppOriginalSendText == nullptr) {
    AppendReport(shared, "error=aim_observer_not_installed\n");
    Complete(shared, doneEvent, 39);
    return;
  }
  void* originalAddress = nullptr;
  memcpy(&originalAddress, &gAimOriginalSend, sizeof(originalAddress));
  AimSendMessageFn observerFunction = &ObserveAimSend;
  void* observerAddress = nullptr;
  memcpy(&observerAddress, &observerFunction, sizeof(observerAddress));
  const void* current = nullptr;
  AppSendTextMessageFn appObserverFunction = &ObserveAppSendText;
  void* appObserverAddress = nullptr;
  memcpy(&appObserverAddress, &appObserverFunction, sizeof(appObserverAddress));
  const void* appCurrent = nullptr;
  if (!ReadPointer(gAimSendVtableSlot, &current) || current != observerAddress ||
      !ReadPointer(gAppSendTextVtableSlot, &appCurrent) ||
      appCurrent != appObserverAddress) {
    AppendReport(shared,
                 "error=send_observer_slot_changed aimCurrent=0x%llx "
                 "appCurrent=0x%llx\n",
                 reinterpret_cast<unsigned long long>(current),
                 reinterpret_cast<unsigned long long>(appCurrent));
    Complete(shared, doneEvent, 41);
    return;
  }
  void* appOriginalAddress = nullptr;
  memcpy(&appOriginalAddress, &gAppOriginalSendText, sizeof(appOriginalAddress));
  void* appPrevious = nullptr;
  if (!ReplaceAimSendSlot(
          gAppSendTextVtableSlot, appOriginalAddress, &appPrevious) ||
      appPrevious != appObserverAddress) {
    AppendReport(shared, "error=app_send_text_slot_restore_failed win32=%lu\n",
                 GetLastError());
    Complete(shared, doneEvent, 44);
    return;
  }
  gAppSendTextVtableSlot = nullptr;
  gAppOriginalSendText = nullptr;
  void* previous = nullptr;
  if (!ReplaceAimSendSlot(gAimSendVtableSlot, originalAddress, &previous) ||
      previous != observerAddress) {
    AppendReport(shared, "error=aim_send_slot_restore_failed win32=%lu\n",
                 GetLastError());
    Complete(shared, doneEvent, 40);
    return;
  }
  gAimSendVtableSlot = nullptr;
  gAimOriginalSend = nullptr;
  for (int attempt = 0; attempt < 200 && shared->aimObserverInFlight != 0;
       ++attempt) {
    Sleep(10);
  }
  AppendReport(shared,
               "send_chain_observer installed=0 observedAimCalls=%ld inFlight=%ld\n",
               shared->aimObserverCalls, shared->aimObserverInFlight);
  if (shared->aimObserverInFlight != 0) {
    AppendReport(shared, "error=aim_observer_calls_still_in_flight\n");
    Complete(shared, doneEvent, 42);
    return;
  }
  AppendReport(shared, "result=send_chain_observation_complete no_send_initiated=1\n");
  Complete(shared, doneEvent, 0);
}

void RunAimEnumeration(ProbeShared* shared, HANDLE doneEvent) {
  HMODULE aim = GetModuleHandleW(L"aim.dll");
  AppendReport(
      shared,
      "aim_enumeration pid=%lu thread=%lu aim=0x%llx\n",
      GetCurrentProcessId(),
      GetCurrentThreadId(),
      reinterpret_cast<unsigned long long>(aim));
  auto getEngine = Resolve<GetAIMEngineFn>(aim, "GetAIMEngine", shared);
  if (aim == nullptr || getEngine == nullptr) {
    Complete(shared, doneEvent, 30);
    return;
  }

  void* engine = getEngine();
  const void* engineVtable = nullptr;
  const void* engineImpl = nullptr;
  if (!ReadPointer(engine, &engineVtable) ||
      engineVtable != reinterpret_cast<const unsigned char*>(aim) +
          kAimEngineExVtableRva ||
      !ReadPointer(static_cast<const unsigned char*>(engine) + 8, &engineImpl) ||
      engineImpl == nullptr) {
    AppendReport(
        shared,
        "error=invalid_engine engine=0x%llx vtable=0x%llx impl=0x%llx\n",
        reinterpret_cast<unsigned long long>(engine),
        reinterpret_cast<unsigned long long>(engineVtable),
        reinterpret_cast<unsigned long long>(engineImpl));
    Complete(shared, doneEvent, 31);
    return;
  }

  const auto* implBytes = static_cast<const unsigned char*>(engineImpl);
  const void* head = nullptr;
  size_t managerCount = 0;
  if (!ReadPointer(implBytes + 0xd8, &head) ||
      !IsReadable(implBytes + 0xe0, sizeof(managerCount))) {
    AppendReport(shared, "error=invalid_manager_tree_header\n");
    Complete(shared, doneEvent, 32);
    return;
  }
  memcpy(&managerCount, implBytes + 0xe0, sizeof(managerCount));
  if (head == nullptr || !IsReadable(head, 0x20) || managerCount > kMaxAimManagers) {
    AppendReport(
        shared,
        "error=invalid_manager_tree head=0x%llx count=%zu\n",
        reinterpret_cast<unsigned long long>(head),
        managerCount);
    Complete(shared, doneEvent, 33);
    return;
  }

  const auto* headBytes = static_cast<const unsigned char*>(head);
  const void* root = nullptr;
  ReadPointer(headBytes + 8, &root);
  AppendReport(
      shared,
      "engine=0x%llx impl=0x%llx managerTree=0x%llx managerCount=%zu\n",
      reinterpret_cast<unsigned long long>(engine),
      reinterpret_cast<unsigned long long>(engineImpl),
      reinterpret_cast<unsigned long long>(head),
      managerCount);

  const void* stack[32] = {};
  size_t stackSize = 0;
  size_t visited = 0;
  const void* current = root;
  while ((current != head || stackSize != 0) && visited < managerCount) {
    while (current != head) {
      if (!IsReadable(current, 0x90) || stackSize == _countof(stack)) {
        AppendReport(shared, "error=invalid_manager_node_or_depth\n");
        Complete(shared, doneEvent, 34);
        return;
      }
      stack[stackSize++] = current;
      const void* left = nullptr;
      ReadPointer(current, &left);
      current = left;
    }
    if (stackSize == 0) {
      break;
    }
    current = stack[--stackSize];
    const auto* node = static_cast<const unsigned char*>(current);
    char key0[256] = {};
    char key1[256] = {};
    char key2[256] = {};
    char manager0[256] = {};
    char manager1[256] = {};
    char manager2[256] = {};
    const void* manager = nullptr;
    const void* managerControl = nullptr;
    const void* managerVtable = nullptr;
    const void* messageService = nullptr;
    const void* messageServiceControl = nullptr;
    const void* messageServiceVtable = nullptr;
    const bool keysValid =
        ReadMsvcString(node + 0x20, key0, sizeof(key0)) &&
        ReadMsvcString(node + 0x40, key1, sizeof(key1)) &&
        ReadMsvcString(node + 0x60, key2, sizeof(key2));
    ReadPointer(node + 0x80, &manager);
    ReadPointer(node + 0x88, &managerControl);
    const bool managerValid =
        manager != nullptr &&
        ReadPointer(manager, &managerVtable) &&
        managerVtable == reinterpret_cast<const unsigned char*>(aim) +
            kAimManagerImplVtableRva &&
        ReadMsvcString(static_cast<const unsigned char*>(manager) + 0x18,
                       manager0, sizeof(manager0)) &&
        ReadMsvcString(static_cast<const unsigned char*>(manager) + 0x38,
                       manager1, sizeof(manager1)) &&
        ReadMsvcString(static_cast<const unsigned char*>(manager) + 0x58,
                       manager2, sizeof(manager2));
    if (managerValid) {
      ReadPointer(static_cast<const unsigned char*>(manager) + 0x168,
                  &messageService);
      ReadPointer(static_cast<const unsigned char*>(manager) + 0x170,
                  &messageServiceControl);
      if (messageService != nullptr) {
        ReadPointer(messageService, &messageServiceVtable);
      }
    }
    const bool identityMatches = managerValid && keysValid &&
        strcmp(key0, manager0) == 0 && strcmp(key1, manager1) == 0 &&
        strcmp(key2, manager2) == 0;
    AppendReport(
        shared,
        "manager[%zu] key0=%s key1=%s key2=%s manager=0x%llx control=0x%llx "
        "identityMatch=%d msgServiceImpl=0x%llx msgControl=0x%llx msgVtable=0x%llx\n",
        visited,
        keysValid ? key0 : "<invalid>",
        keysValid ? key1 : "<invalid>",
        keysValid ? key2 : "<invalid>",
        reinterpret_cast<unsigned long long>(manager),
        reinterpret_cast<unsigned long long>(managerControl),
        identityMatches ? 1 : 0,
        reinterpret_cast<unsigned long long>(messageService),
        reinterpret_cast<unsigned long long>(messageServiceControl),
        reinterpret_cast<unsigned long long>(messageServiceVtable));
    ++visited;
    const void* right = nullptr;
    ReadPointer(node + 0x10, &right);
    current = right;
  }

  if (visited != managerCount) {
    AppendReport(
        shared,
        "error=manager_count_mismatch visited=%zu expected=%zu\n",
        visited,
        managerCount);
    Complete(shared, doneEvent, 35);
    return;
  }
  AppendReport(shared, "result=aim_enumeration_ok no_send_invoked=1\n");
  Complete(shared, doneEvent, 0);
}

void RunAppMessageServiceEnumeration(ProbeShared* shared, HANDLE doneEvent) {
  HMODULE appBiz = GetModuleHandleW(L"AppBiz.dll");
  if (appBiz == nullptr) {
    AppendReport(shared, "error=appbiz_not_loaded\n");
    Complete(shared, doneEvent, 45);
    return;
  }
  const void* expectedVtable =
      reinterpret_cast<const unsigned char*>(appBiz) +
      kAppMessageServiceVtableRva;
  const void* expectedIdentifierVtable =
      reinterpret_cast<const unsigned char*>(appBiz) + 0x18aff20;
  SYSTEM_INFO systemInfo = {};
  GetSystemInfo(&systemInfo);
  uintptr_t cursor = reinterpret_cast<uintptr_t>(
      systemInfo.lpMinimumApplicationAddress);
  const uintptr_t maximum = reinterpret_cast<uintptr_t>(
      systemInfo.lpMaximumApplicationAddress);
  size_t regionCount = 0;
  size_t privateBytes = 0;
  size_t serviceCount = 0;
  while (cursor < maximum) {
    MEMORY_BASIC_INFORMATION information = {};
    if (VirtualQuery(
            reinterpret_cast<const void*>(cursor),
            &information,
            sizeof(information)) == 0) {
      break;
    }
    const uintptr_t regionStart = reinterpret_cast<uintptr_t>(
        information.BaseAddress);
    const uintptr_t regionEnd = regionStart + information.RegionSize;
    const bool readable = information.State == MEM_COMMIT &&
        information.Type == MEM_PRIVATE &&
        (information.Protect & (PAGE_GUARD | PAGE_NOACCESS)) == 0;
    if (readable && information.RegionSize >= 0x598) {
      ++regionCount;
      privateBytes += information.RegionSize;
      uintptr_t candidateAddress = (regionStart + 7) & ~uintptr_t{7};
      const uintptr_t lastCandidate = regionEnd - 0x598;
      for (; candidateAddress <= lastCandidate; candidateAddress += 8) {
        const auto* candidate = reinterpret_cast<const unsigned char*>(
            candidateAddress);
        const void* vtable = nullptr;
        memcpy(&vtable, candidate, sizeof(vtable));
        if (vtable != expectedVtable) {
          continue;
        }
        const void* identifierVtable = nullptr;
        const void* convBiz = nullptr;
        if (!ReadPointer(candidate + 0x378, &identifierVtable) ||
            identifierVtable != expectedIdentifierVtable ||
            !ReadPointer(candidate + 0x578, &convBiz)) {
          continue;
        }
        char targetId[256] = {};
        if (!ReadMsvcString(candidate + 0x3d0, targetId, sizeof(targetId))) {
          continue;
        }
        int targetType = -1;
        memcpy(&targetType, candidate + 0x3f0, sizeof(targetType));
        AppendReport(
            shared,
            "app_message_service[%zu] this=0x%llx targetId=%s "
            "targetType=%d convBiz=0x%llx ready=%d\n",
            serviceCount,
            static_cast<unsigned long long>(candidateAddress),
            targetId,
            targetType,
            reinterpret_cast<unsigned long long>(convBiz),
            convBiz != nullptr ? 1 : 0);
        ++serviceCount;
      }
    }
    if (regionEnd <= cursor) {
      break;
    }
    cursor = regionEnd;
  }
  AppendReport(
      shared,
      "app_message_service_scan regions=%zu privateBytes=%zu count=%zu\n",
      regionCount,
      privateBytes,
      serviceCount);
  AppendReport(shared,
               "result=app_message_service_enumeration_ok no_send_invoked=1\n");
  Complete(shared, doneEvent, 0);
}

void InitializeEmptyMsvcString(void* storage) {
  auto* bytes = static_cast<unsigned char*>(storage);
  ZeroMemory(bytes, 32);
  const size_t capacity = 15;
  memcpy(bytes + 24, &capacity, sizeof(capacity));
}

void RunSendArgumentDryRun(ProbeShared* shared, HANDLE doneEvent) {
  HMODULE appBiz = GetModuleHandleW(L"AppBiz.dll");
  if (appBiz == nullptr) {
    AppendReport(shared, "error=appbiz_not_loaded\n");
    Complete(shared, doneEvent, 46);
    return;
  }

  auto stringAssign = reinterpret_cast<MsvcStringAssignFn>(
      reinterpret_cast<unsigned char*>(appBiz) + kMsvcStringAssignRva);
  auto stringDestructor = reinterpret_cast<MsvcStringDestructorFn>(
      reinterpret_cast<unsigned char*>(appBiz) + kMsvcStringDestructorRva);
  auto extensionsConstructor = reinterpret_cast<ExtensionsConstructorFn>(
      reinterpret_cast<unsigned char*>(appBiz) + kExtensionsConstructorRva);
  auto extensionsDestructor = reinterpret_cast<ExtensionsDestructorFn>(
      reinterpret_cast<unsigned char*>(appBiz) + kExtensionsDestructorRva);

  alignas(16) unsigned char cid[32] = {};
  alignas(16) unsigned char text[32] = {};
  alignas(16) unsigned char source[32] = {};
  alignas(16) unsigned char extensions[64] = {};
  alignas(16) unsigned char callback[64] = {};
  constexpr char kCid[] =
      "2214525969878.1-2216058631944.1#11001@cntaobao";
  constexpr char kText[] = "QN send argument dry run";
  constexpr char kSource[] = "QnNativeSubmitProbe::DryRun";

  InitializeEmptyMsvcString(cid);
  InitializeEmptyMsvcString(text);
  InitializeEmptyMsvcString(source);
  stringAssign(cid, kCid, sizeof(kCid) - 1);
  stringAssign(text, kText, sizeof(kText) - 1);
  stringAssign(source, kSource, sizeof(kSource) - 1);
  extensionsConstructor(extensions);

  char readCid[128] = {};
  char readText[128] = {};
  char readSource[128] = {};
  const bool stringsValid =
      ReadMsvcString(cid, readCid, sizeof(readCid)) &&
      ReadMsvcString(text, readText, sizeof(readText)) &&
      ReadMsvcString(source, readSource, sizeof(readSource)) &&
      strcmp(readCid, kCid) == 0 && strcmp(readText, kText) == 0 &&
      strcmp(readSource, kSource) == 0;

  const void* listHead = nullptr;
  const void* bucketBegin = nullptr;
  const void* bucketEnd = nullptr;
  const void* bucketCapacity = nullptr;
  size_t elementCount = 1;
  unsigned int maxLoadFactorBits = 0;
  memcpy(&maxLoadFactorBits, extensions, sizeof(maxLoadFactorBits));
  memcpy(&listHead, extensions + 8, sizeof(listHead));
  memcpy(&elementCount, extensions + 16, sizeof(elementCount));
  memcpy(&bucketBegin, extensions + 24, sizeof(bucketBegin));
  memcpy(&bucketEnd, extensions + 32, sizeof(bucketEnd));
  memcpy(&bucketCapacity, extensions + 40, sizeof(bucketCapacity));
  const bool extensionsValid = maxLoadFactorBits == 0x3f800000 &&
      listHead != nullptr && elementCount == 0 && bucketBegin != nullptr &&
      bucketEnd != nullptr && bucketCapacity != nullptr &&
      bucketBegin < bucketEnd && bucketEnd == bucketCapacity;

  const void* callbackManager = nullptr;
  memcpy(&callbackManager, callback + 0x38, sizeof(callbackManager));
  const bool callbackValid = callbackManager == nullptr;
  AppendReport(
      shared,
      "send_argument_dry_run stringsValid=%d cid=%s text=%s source=%s\n",
      stringsValid ? 1 : 0,
      stringsValid ? readCid : "<invalid>",
      stringsValid ? readText : "<invalid>",
      stringsValid ? readSource : "<invalid>");
  AppendReport(
      shared,
      "  extensions size=64 maxLoadFactorBits=0x%08x listHead=0x%llx "
      "elementCount=%zu buckets=0x%llx..0x%llx capacity=0x%llx valid=%d\n",
      maxLoadFactorBits,
      reinterpret_cast<unsigned long long>(listHead),
      elementCount,
      reinterpret_cast<unsigned long long>(bucketBegin),
      reinterpret_cast<unsigned long long>(bucketEnd),
      reinterpret_cast<unsigned long long>(bucketCapacity),
      extensionsValid ? 1 : 0);
  AppendReport(
      shared,
      "  callback size=64 manager=0x%llx empty=%d\n",
      reinterpret_cast<unsigned long long>(callbackManager),
      callbackValid ? 1 : 0);

  extensionsDestructor(extensions);
  stringDestructor(source);
  stringDestructor(text);
  stringDestructor(cid);

  if (!stringsValid || !extensionsValid || !callbackValid) {
    AppendReport(shared, "error=send_argument_dry_run_validation_failed\n");
    Complete(shared, doneEvent, 47);
    return;
  }
  AppendReport(
      shared,
      "result=send_argument_dry_run_ok no_send_address_resolved=1 "
      "no_send_invoked=1\n");
  Complete(shared, doneEvent, 0);
}

struct AppMessageServiceMatch {
  const void* service = nullptr;
  void* messageBiz = nullptr;
  size_t count = 0;
};

AppMessageServiceMatch FindReadyAppMessageService(ProbeShared* shared) {
  AppMessageServiceMatch result;
  HMODULE appBiz = GetModuleHandleW(L"AppBiz.dll");
  if (appBiz == nullptr || shared->targetId[0] == '\0') {
    AppendReport(shared, "error=invalid_service_lookup_input\n");
    return result;
  }
  const void* expectedVtable =
      reinterpret_cast<const unsigned char*>(appBiz) +
      kAppMessageServiceVtableRva;
  const void* expectedIdentifierVtable =
      reinterpret_cast<const unsigned char*>(appBiz) + 0x18aff20;
  SYSTEM_INFO systemInfo = {};
  GetSystemInfo(&systemInfo);
  uintptr_t cursor = reinterpret_cast<uintptr_t>(
      systemInfo.lpMinimumApplicationAddress);
  const uintptr_t maximum = reinterpret_cast<uintptr_t>(
      systemInfo.lpMaximumApplicationAddress);
  while (cursor < maximum) {
    MEMORY_BASIC_INFORMATION information = {};
    if (VirtualQuery(
            reinterpret_cast<const void*>(cursor),
            &information,
            sizeof(information)) == 0) {
      break;
    }
    const uintptr_t regionStart = reinterpret_cast<uintptr_t>(
        information.BaseAddress);
    const uintptr_t regionEnd = regionStart + information.RegionSize;
    const bool readable = information.State == MEM_COMMIT &&
        information.Type == MEM_PRIVATE &&
        (information.Protect & (PAGE_GUARD | PAGE_NOACCESS)) == 0;
    if (readable && information.RegionSize >= 0x598) {
      uintptr_t candidateAddress = (regionStart + 7) & ~uintptr_t{7};
      const uintptr_t lastCandidate = regionEnd - 0x598;
      for (; candidateAddress <= lastCandidate; candidateAddress += 8) {
        const auto* candidate = reinterpret_cast<const unsigned char*>(
            candidateAddress);
        const void* vtable = nullptr;
        memcpy(&vtable, candidate, sizeof(vtable));
        if (vtable != expectedVtable) {
          continue;
        }
        const void* identifierVtable = nullptr;
        if (!ReadPointer(candidate + 0x378, &identifierVtable) ||
            identifierVtable != expectedIdentifierVtable) {
          continue;
        }
        char targetId[256] = {};
        int targetType = -1;
        if (!ReadMsvcString(candidate + 0x3d0, targetId, sizeof(targetId))) {
          continue;
        }
        memcpy(&targetType, candidate + 0x3f0, sizeof(targetType));
        if (targetType != 2 || strcmp(targetId, shared->targetId) != 0) {
          continue;
        }
        const void* messageBiz = nullptr;
        ReadPointer(candidate + 0x578, &messageBiz);
        AppendReport(
            shared,
            "app_message_service_match[%zu] targetId=%s targetType=%d "
            "this=0x%llx messageBiz=0x%llx ready=%d\n",
            result.count,
            targetId,
            targetType,
            static_cast<unsigned long long>(candidateAddress),
            reinterpret_cast<unsigned long long>(messageBiz),
            messageBiz != nullptr ? 1 : 0);
        ++result.count;
        result.service = candidate;
        result.messageBiz = const_cast<void*>(messageBiz);
      }
    }
    if (regionEnd <= cursor) {
      break;
    }
    cursor = regionEnd;
  }

  return result;
}

void RunAppMessageServiceLookup(ProbeShared* shared, HANDLE doneEvent) {
  const AppMessageServiceMatch match = FindReadyAppMessageService(shared);
  if (match.count != 1 || match.messageBiz == nullptr) {
    AppendReport(
        shared,
        "error=service_lookup_not_unique_or_not_ready targetId=%s matches=%zu\n",
        shared->targetId,
        match.count);
    Complete(shared, doneEvent, 49);
    return;
  }
  shared->appMessageService = reinterpret_cast<UINT_PTR>(match.service);
  shared->messageBiz = reinterpret_cast<UINT_PTR>(match.messageBiz);
  AppendReport(
      shared,
      "result=app_message_service_lookup_ok targetId=%s unique=1 "
      "no_registry_invoked=1 no_send_invoked=1\n",
      shared->targetId);
  Complete(shared, doneEvent, 0);
}

void RunDirectSendTextMinimized(ProbeShared* shared, HANDLE doneEvent) {
  AppendReport(shared, "error=direct_send_disabled_at_hook no_send_invoked=1\n");
  Complete(shared, doneEvent, 63);
#if 0
  HMODULE appBiz = GetModuleHandleW(L"AppBiz.dll");
  const size_t cidLength = strnlen(shared->cid, sizeof(shared->cid));
  const size_t textLength = strnlen(shared->text, sizeof(shared->text));
  if (appBiz == nullptr || cidLength == 0 || cidLength == sizeof(shared->cid) ||
      textLength == 0 || textLength == sizeof(shared->text)) {
    AppendReport(shared, "error=invalid_direct_send_input\n");
    Complete(shared, doneEvent, 50);
    return;
  }

  const AppMessageServiceMatch match = FindReadyAppMessageService(shared);
  if (match.count != 1 || match.messageBiz == nullptr ||
      !IsReadable(match.messageBiz, sizeof(void*))) {
    AppendReport(
        shared,
        "error=direct_send_service_not_unique_or_not_ready targetId=%s "
        "matches=%zu\n",
        shared->targetId,
        match.count);
    Complete(shared, doneEvent, 51);
    return;
  }

  constexpr char kSource[] =
      "SendMsg@D:\\jenkins\\workspace\\ci.NewCef.dabao.test\\"
      "qtc_9.97.0xN_xnet\\SourceCode\\src\\biz\\chat\\sub_biz\\"
      "subchat\\sub_biz\\chatcontent\\presenter\\"
      "ChatContentPresenter.cpp:1700";
  auto stringAssign = reinterpret_cast<MsvcStringAssignFn>(
      reinterpret_cast<unsigned char*>(appBiz) + kMsvcStringAssignRva);
  auto stringDestructor = reinterpret_cast<MsvcStringDestructorFn>(
      reinterpret_cast<unsigned char*>(appBiz) + kMsvcStringDestructorRva);
  auto extensionsConstructor = reinterpret_cast<ExtensionsConstructorFn>(
      reinterpret_cast<unsigned char*>(appBiz) + kExtensionsConstructorRva);
  auto extensionsDestructor = reinterpret_cast<ExtensionsDestructorFn>(
      reinterpret_cast<unsigned char*>(appBiz) + kExtensionsDestructorRva);
  auto sendText = reinterpret_cast<DirectSendTextFn>(
      reinterpret_cast<unsigned char*>(appBiz) + kMessageBizSendTextRva);

  alignas(16) unsigned char cid[32] = {};
  alignas(16) unsigned char text[32] = {};
  alignas(16) unsigned char source[32] = {};
  alignas(16) unsigned char extensions[64] = {};
  alignas(16) unsigned char callback[64] = {};
  InitializeEmptyMsvcString(cid);
  InitializeEmptyMsvcString(text);
  InitializeEmptyMsvcString(source);
  stringAssign(cid, shared->cid, cidLength);
  stringAssign(text, shared->text, textLength);
  stringAssign(source, kSource, sizeof(kSource) - 1);
  extensionsConstructor(extensions);

  char verifiedCid[kProbeCidCapacity] = {};
  char verifiedText[kProbeTextCapacity] = {};
  char verifiedSource[512] = {};
  const bool argumentsValid =
      ReadMsvcString(cid, verifiedCid, sizeof(verifiedCid)) &&
      ReadMsvcString(text, verifiedText, sizeof(verifiedText)) &&
      ReadMsvcString(source, verifiedSource, sizeof(verifiedSource)) &&
      strcmp(verifiedCid, shared->cid) == 0 &&
      strcmp(verifiedText, shared->text) == 0 &&
      strcmp(verifiedSource, kSource) == 0;
  const void* listHead = nullptr;
  size_t extensionCount = 1;
  const void* callbackManager = nullptr;
  memcpy(&listHead, extensions + 8, sizeof(listHead));
  memcpy(&extensionCount, extensions + 16, sizeof(extensionCount));
  memcpy(&callbackManager, callback + 0x38, sizeof(callbackManager));
  const bool emptyArgumentsValid = listHead != nullptr &&
      extensionCount == 0 && callbackManager == nullptr;
  if (!argumentsValid || !emptyArgumentsValid) {
    AppendReport(
        shared,
        "error=direct_send_argument_validation_failed strings=%d empty=%d\n",
        argumentsValid ? 1 : 0,
        emptyArgumentsValid ? 1 : 0);
    extensionsDestructor(extensions);
    stringDestructor(source);
    stringDestructor(text);
    stringDestructor(cid);
    Complete(shared, doneEvent, 52);
    return;
  }

  shared->appMessageService = reinterpret_cast<UINT_PTR>(match.service);
  shared->messageBiz = reinterpret_cast<UINT_PTR>(match.messageBiz);
  AppendReport(
      shared,
      "direct_send_ready targetId=%s service=0x%llx messageBiz=0x%llx "
      "cid=%s text=%s extensions=empty callback=empty\n",
      shared->targetId,
      reinterpret_cast<unsigned long long>(match.service),
      reinterpret_cast<unsigned long long>(match.messageBiz),
      verifiedCid,
      verifiedText);
  sendText(match.messageBiz, cid, text, source, extensions, callback);
  AppendReport(shared, "direct_send_invoked count=1 rva=0x%llx\n",
               static_cast<unsigned long long>(kMessageBizSendTextRva));

  extensionsDestructor(extensions);
  stringDestructor(source);
  stringDestructor(text);
  stringDestructor(cid);
  AppendReport(
      shared,
      "result=direct_send_text_invoked_once receipt_pending=1\n");
  Complete(shared, doneEvent, 0);
#endif
}

void RunDiscovery(ProbeShared* shared, HANDLE doneEvent) {
  HMODULE qtCore = GetModuleHandleW(L"Qt5Core.dll");
  HMODULE qtGui = GetModuleHandleW(L"Qt5Gui.dll");
  HMODULE qtWidgets = GetModuleHandleW(L"Qt5Widgets.dll");
  HMODULE appBiz = GetModuleHandleW(L"AppBiz.dll");
  AppendReport(
      shared,
      "pid=%lu thread=%lu hwnd=0x%llx qtCore=0x%llx qtGui=0x%llx qtWidgets=0x%llx appBiz=0x%llx\n",
      GetCurrentProcessId(),
      GetCurrentThreadId(),
      static_cast<unsigned long long>(shared->windowHandle),
      reinterpret_cast<unsigned long long>(qtCore),
      reinterpret_cast<unsigned long long>(qtGui),
      reinterpret_cast<unsigned long long>(qtWidgets),
      reinterpret_cast<unsigned long long>(appBiz));

  if (shared->operation == kProbeOperationEnumerateAim) {
    RunAimEnumeration(shared, doneEvent);
    return;
  }
  if (shared->operation == kProbeOperationEnumerateAppMessageServices) {
    RunAppMessageServiceEnumeration(shared, doneEvent);
    return;
  }
  if (shared->operation == kProbeOperationDryRunSendArguments) {
    RunSendArgumentDryRun(shared, doneEvent);
    return;
  }
  if (shared->operation == kProbeOperationLocateAppMessageService) {
    RunAppMessageServiceLookup(shared, doneEvent);
    return;
  }
  if (shared->operation == kProbeOperationDirectSendTextMinimized) {
    RunDirectSendTextMinimized(shared, doneEvent);
    return;
  }
  if (shared->operation == kProbeOperationObserveAimSendStart) {
    RunAimObserverStart(shared, doneEvent);
    return;
  }
  if (shared->operation == kProbeOperationObserveAimSendStop) {
    RunAimObserverStop(shared, doneEvent);
    return;
  }
  if (shared->operation == kProbeOperationCallbackLifecycleStart) {
    RunCallbackLifecycleStart(shared, doneEvent);
    return;
  }
  if (shared->operation == kProbeOperationCallbackLifecycleRelease) {
    RunCallbackLifecycleRelease(shared, doneEvent);
    return;
  }

  auto focusWidget = Resolve<FocusWidgetFn>(
      qtWidgets, kFocusWidgetSymbol, shared);
  auto parent = Resolve<ParentFn>(qtCore, kParentSymbol, shared);
  auto inherits = Resolve<InheritsFn>(qtCore, kInheritsSymbol, shared);
  auto className = Resolve<ClassNameFn>(qtCore, kClassNameSymbol, shared);
  auto indexOfMethod = Resolve<IndexOfMethodFn>(
      qtCore, kIndexOfMethodSymbol, shared);
  auto metaCall = Resolve<MetaCallFn>(qtCore, kMetaCallSymbol, shared);
  auto isVisible = Resolve<WidgetStateFn>(
      qtWidgets, kIsVisibleSymbol, shared);
  auto isEnabled = Resolve<WidgetStateFn>(
      qtWidgets, kIsEnabledSymbol, shared);
  if (focusWidget == nullptr || parent == nullptr || inherits == nullptr ||
      className == nullptr || indexOfMethod == nullptr || metaCall == nullptr ||
      isVisible == nullptr || isEnabled == nullptr || appBiz == nullptr) {
    Complete(shared, doneEvent, 10);
    return;
  }

  void* current = nullptr;
  void* topLevelWidget = nullptr;
  const bool reconcileMinimized =
      shared->operation == kProbeOperationReconcileMinimized;
  const bool useFocusChain =
      shared->operation == kProbeOperationDiscoverFocusChainMinimized ||
      shared->operation == kProbeOperationWriteDraftFocusChainMinimized ||
      shared->operation == kProbeOperationClearDraftFocusChainMinimized ||
      shared->operation == kProbeOperationSubmitFocusChainMinimized;
  if (shared->operation == kProbeOperationDiscoverMinimized ||
      shared->operation == kProbeOperationSubmitMinimized ||
      shared->operation == kProbeOperationWriteDraftMinimized ||
      shared->operation == kProbeOperationClearDraftMinimized ||
      useFocusChain || reconcileMinimized) {
    auto findWidget = Resolve<FindWidgetFn>(qtWidgets, kFindWidgetSymbol, shared);
    auto widgetFocus = Resolve<WidgetFocusFn>(
        qtWidgets, kWidgetFocusSymbol, shared);
    auto isMinimized = Resolve<WidgetStateFn>(
        qtWidgets, kIsMinimizedSymbol, shared);
    if (findWidget == nullptr || widgetFocus == nullptr || isMinimized == nullptr) {
      Complete(shared, doneEvent, 11);
      return;
    }
    topLevelWidget = findWidget(shared->windowHandle);
    const bool qtMinimizedBefore =
        topLevelWidget != nullptr && isMinimized(topLevelWidget);
    AppendReport(
        shared,
        "topLevelWidget=0x%llx qtIsMinimized=%d\n",
        reinterpret_cast<unsigned long long>(topLevelWidget),
        topLevelWidget == nullptr ? -1 : (qtMinimizedBefore ? 1 : 0));
    if (topLevelWidget == nullptr) {
      AppendReport(shared, "error=top_level_widget_missing\n");
      Complete(shared, doneEvent, 12);
      return;
    }
    if (reconcileMinimized) {
      auto showMinimized = Resolve<WidgetActionFn>(
          qtWidgets, kShowMinimizedSymbol, shared);
      const HWND targetWindow = reinterpret_cast<HWND>(shared->windowHandle);
      const bool win32MinimizedBefore = IsIconic(targetWindow) != FALSE;
      const bool foregroundBefore = GetForegroundWindow() == targetWindow;
      AppendReport(
          shared,
          "reconcile_guard win32MinimizedBefore=%d qtMinimizedBefore=%d foregroundBefore=%d\n",
          win32MinimizedBefore ? 1 : 0,
          qtMinimizedBefore ? 1 : 0,
          foregroundBefore ? 1 : 0);
      if (showMinimized == nullptr || !win32MinimizedBefore ||
          foregroundBefore) {
        AppendReport(shared, "error=reconcile_guard_failed\n");
        Complete(shared, doneEvent, 26);
        return;
      }
      showMinimized(topLevelWidget);
      const bool qtMinimizedAfter = isMinimized(topLevelWidget);
      const bool win32MinimizedAfter = IsIconic(targetWindow) != FALSE;
      const bool foregroundAfter = GetForegroundWindow() == targetWindow;
      AppendReport(
          shared,
          "reconcile_result win32MinimizedAfter=%d qtMinimizedAfter=%d foregroundAfter=%d\n",
          win32MinimizedAfter ? 1 : 0,
          qtMinimizedAfter ? 1 : 0,
          foregroundAfter ? 1 : 0);
      if (!win32MinimizedAfter || !qtMinimizedAfter || foregroundAfter) {
        AppendReport(shared, "error=reconcile_not_observed\n");
        Complete(shared, doneEvent, 27);
        return;
      }
      AppendReport(shared, "result=minimized_state_reconciled_once\n");
      Complete(shared, doneEvent, 0);
      return;
    }
    if (!qtMinimizedBefore) {
      AppendReport(shared, "error=expected_minimized_top_level_widget\n");
      Complete(shared, doneEvent, 12);
      return;
    }
    current = widgetFocus(topLevelWidget);
    AppendReport(shared, "focusSource=QWidget::focusWidget\n");
  } else {
    current = focusWidget();
    AppendReport(shared, "focusSource=QApplication::focusWidget\n");
  }
  shared->focusWidget = reinterpret_cast<UINT_PTR>(current);
  AppendReport(shared, "focusWidget=0x%llx\n",
               reinterpret_cast<unsigned long long>(current));
  if (current == nullptr) {
    AppendReport(shared, "error=no_focus_widget\n");
    Complete(shared, doneEvent, 13);
    return;
  }

  if (useFocusChain) {
    auto nextFocusWidget = Resolve<NextFocusWidgetFn>(
        qtWidgets, kNextFocusWidgetSymbol, shared);
    if (nextFocusWidget == nullptr || topLevelWidget == nullptr) {
      Complete(shared, doneEvent, 24);
      return;
    }

    void* candidate = nullptr;
    void* widget = topLevelWidget;
    int textEditCount = 0;
    int eligibleCount = 0;
    int visited = 0;
    do {
      if (inherits(widget, "QTextEdit")) {
        ++textEditCount;
        int ancestorChatCount = 0;
        void* ancestorChat = nullptr;
        void* ancestor = widget;
        for (int depth = 0; ancestor != nullptr && depth < 64; ++depth) {
          if (inherits(ancestor, "ChatContentView")) {
            ++ancestorChatCount;
            ancestorChat = ancestor;
          }
          ancestor = parent(ancestor);
        }
        const bool visible = isVisible(widget);
        const bool enabled = isEnabled(widget);
        const bool eligible =
            visible && enabled && ancestorChatCount == 1;
        AppendReport(
            shared,
            "focusChainTextEdit[%d]=0x%llx visible=%d enabled=%d chatCount=%d chat=0x%llx eligible=%d\n",
            textEditCount - 1,
            reinterpret_cast<unsigned long long>(widget),
            visible ? 1 : 0,
            enabled ? 1 : 0,
            ancestorChatCount,
            reinterpret_cast<unsigned long long>(ancestorChat),
            eligible ? 1 : 0);
        if (eligible) {
          ++eligibleCount;
          candidate = widget;
        }
      }
      widget = nextFocusWidget(widget);
      ++visited;
    } while (widget != nullptr && widget != topLevelWidget && visited < 4096);

    AppendReport(
        shared,
        "focusChainSummary visited=%d textEditCount=%d eligibleCount=%d closedCycle=%d\n",
        visited,
        textEditCount,
        eligibleCount,
        widget == topLevelWidget ? 1 : 0);
    if (widget != topLevelWidget || eligibleCount != 1 || candidate == nullptr) {
      AppendReport(shared, "error=expected_one_focus_chain_editor\n");
      Complete(shared, doneEvent, 25);
      return;
    }
    current = candidate;
    shared->focusWidget = reinterpret_cast<UINT_PTR>(current);
    AppendReport(
        shared,
        "focusSource=QWidget::nextInFocusChain uniqueCandidate=0x%llx\n",
        reinterpret_cast<unsigned long long>(current));
  }

  void* chatContentView = nullptr;
  int chainLength = 0;
  int chatCount = 0;
  for (; current != nullptr && chainLength < 64; ++chainLength) {
    const void* metaObject = GetDynamicMetaObject(current);
    const char* name = metaObject == nullptr ? nullptr : className(metaObject);
    const bool isChatContentView = inherits(current, "ChatContentView");
    AppendReport(
        shared,
        "chain[%d]=0x%llx class=%s isChatContentView=%d\n",
        chainLength,
        reinterpret_cast<unsigned long long>(current),
        name == nullptr ? "<null>" : name,
        isChatContentView ? 1 : 0);
    if (isChatContentView) {
      ++chatCount;
      chatContentView = current;
    }
    current = parent(current);
  }

  shared->chainLength = chainLength;
  shared->chatContentViewCount = chatCount;
  shared->chatContentView = reinterpret_cast<UINT_PTR>(chatContentView);
  if (chatCount != 1 || chatContentView == nullptr) {
    AppendReport(shared, "error=expected_one_chat_content_view actual=%d\n", chatCount);
    Complete(shared, doneEvent, 14);
    return;
  }

  const void* chatMetaObject = GetDynamicMetaObject(chatContentView);
  if (chatMetaObject == nullptr) {
    AppendReport(shared, "error=chat_meta_object_missing\n");
    Complete(shared, doneEvent, 15);
    return;
  }
  const int methodIndex = indexOfMethod(chatMetaObject, "OnClick(int)");
  shared->methodIndex = methodIndex;
  AppendReport(
      shared,
      "chatContentView=0x%llx method=OnClick(int) methodIndex=%d\n",
      reinterpret_cast<unsigned long long>(chatContentView),
      methodIndex);
  if (methodIndex < 0) {
    AppendReport(shared, "error=method_not_found\n");
    Complete(shared, doneEvent, 16);
    return;
  }

  if (shared->operation == kProbeOperationWriteDraftMinimized ||
      shared->operation == kProbeOperationWriteDraftFocusChainMinimized) {
    static_assert(sizeof(wchar_t) == 2);
    auto document = Resolve<TextEditDocumentFn>(
        qtWidgets, kTextEditDocumentSymbol, shared);
    auto isReadOnly = Resolve<WidgetStateFn>(
        qtWidgets, kTextEditIsReadOnlySymbol, shared);
    auto documentIsEmpty = Resolve<WidgetStateFn>(
        qtGui, kTextDocumentIsEmptySymbol, shared);
    auto setPlainText = Resolve<TextEditSetPlainTextFn>(
        qtWidgets, kTextEditSetPlainTextSymbol, shared);
    auto qStringCtor = Resolve<QStringUtf16CtorFn>(
        qtCore, kQStringUtf16CtorSymbol, shared);
    auto qStringDtor = Resolve<QStringDtorFn>(
        qtCore, kQStringDtorSymbol, shared);
    if (document == nullptr || isReadOnly == nullptr ||
        documentIsEmpty == nullptr || setPlainText == nullptr ||
        qStringCtor == nullptr || qStringDtor == nullptr) {
      Complete(shared, doneEvent, 18);
      return;
    }

    void* editor = reinterpret_cast<void*>(shared->focusWidget);
    void* textDocument = document(editor);
    const bool editorIsTextEdit = inherits(editor, "QTextEdit");
    const bool editorVisible = isVisible(editor);
    const bool editorEnabled = isEnabled(editor);
    const bool editorReadOnly = isReadOnly(editor);
    const bool draftEmptyBefore =
        textDocument == nullptr ? false : documentIsEmpty(textDocument);
    const size_t actualLength = wcsnlen(
        shared->draft, kProbeDraftCapacity);
    AppendReport(
        shared,
        "draft_guard editorIsTextEdit=%d editorVisible=%d editorEnabled=%d editorReadOnly=%d document=0x%llx emptyBefore=%d requestedLength=%lu actualLength=%zu\n",
        editorIsTextEdit ? 1 : 0,
        editorVisible ? 1 : 0,
        editorEnabled ? 1 : 0,
        editorReadOnly ? 1 : 0,
        reinterpret_cast<unsigned long long>(textDocument),
        draftEmptyBefore ? 1 : 0,
        shared->draftLength,
        actualLength);
    if (!editorIsTextEdit || !editorVisible || !editorEnabled ||
        editorReadOnly || textDocument == nullptr || !draftEmptyBefore ||
        shared->draftLength == 0 ||
        shared->draftLength >= kProbeDraftCapacity ||
        actualLength != shared->draftLength) {
      AppendReport(shared, "error=draft_guard_failed\n");
      Complete(shared, doneEvent, 19);
      return;
    }

    alignas(void*) unsigned char qStringStorage[sizeof(void*)] = {};
    qStringCtor(
        qStringStorage,
        shared->draft,
        static_cast<int>(shared->draftLength));
    setPlainText(editor, qStringStorage);
    qStringDtor(qStringStorage);

    const bool draftEmptyAfter = documentIsEmpty(textDocument);
    AppendReport(
        shared,
        "draft_result emptyAfter=%d wroteLength=%lu onclickInvoked=0\n",
        draftEmptyAfter ? 1 : 0,
        shared->draftLength);
    if (draftEmptyAfter) {
      AppendReport(shared, "error=draft_write_not_observed\n");
      Complete(shared, doneEvent, 20);
      return;
    }
    AppendReport(shared, "result=draft_written_once no_submit=1\n");
    Complete(shared, doneEvent, 0);
    return;
  }

  if (shared->operation == kProbeOperationClearDraftMinimized ||
      shared->operation == kProbeOperationClearDraftFocusChainMinimized) {
    auto document = Resolve<TextEditDocumentFn>(
        qtWidgets, kTextEditDocumentSymbol, shared);
    auto isReadOnly = Resolve<WidgetStateFn>(
        qtWidgets, kTextEditIsReadOnlySymbol, shared);
    auto documentIsEmpty = Resolve<WidgetStateFn>(
        qtGui, kTextDocumentIsEmptySymbol, shared);
    auto clear = Resolve<TextEditClearFn>(
        qtWidgets, kTextEditClearSymbol, shared);
    if (document == nullptr || isReadOnly == nullptr ||
        documentIsEmpty == nullptr || clear == nullptr) {
      Complete(shared, doneEvent, 21);
      return;
    }

    void* editor = reinterpret_cast<void*>(shared->focusWidget);
    void* textDocument = document(editor);
    const bool editorIsTextEdit = inherits(editor, "QTextEdit");
    const bool editorVisible = isVisible(editor);
    const bool editorEnabled = isEnabled(editor);
    const bool editorReadOnly = isReadOnly(editor);
    const bool draftEmptyBefore =
        textDocument == nullptr ? true : documentIsEmpty(textDocument);
    AppendReport(
        shared,
        "clear_guard editorIsTextEdit=%d editorVisible=%d editorEnabled=%d editorReadOnly=%d document=0x%llx emptyBefore=%d\n",
        editorIsTextEdit ? 1 : 0,
        editorVisible ? 1 : 0,
        editorEnabled ? 1 : 0,
        editorReadOnly ? 1 : 0,
        reinterpret_cast<unsigned long long>(textDocument),
        draftEmptyBefore ? 1 : 0);
    if (!editorIsTextEdit || !editorVisible || !editorEnabled ||
        editorReadOnly || textDocument == nullptr || draftEmptyBefore) {
      AppendReport(shared, "error=clear_guard_failed\n");
      Complete(shared, doneEvent, 22);
      return;
    }

    clear(editor);
    const bool draftEmptyAfter = documentIsEmpty(textDocument);
    AppendReport(
        shared,
        "clear_result emptyAfter=%d onclickInvoked=0\n",
        draftEmptyAfter ? 1 : 0);
    if (!draftEmptyAfter) {
      AppendReport(shared, "error=draft_clear_not_observed\n");
      Complete(shared, doneEvent, 23);
      return;
    }
    AppendReport(shared, "result=draft_cleared_once no_submit=1\n");
    Complete(shared, doneEvent, 0);
    return;
  }

  if (shared->operation == kProbeOperationSubmit ||
      shared->operation == kProbeOperationSubmitMinimized ||
      shared->operation == kProbeOperationSubmitFocusChainMinimized) {
    const void* editor = reinterpret_cast<const void*>(shared->focusWidget);
    const bool editorIsTextEdit = inherits(editor, "QTextEdit");
    const bool editorVisible = isVisible(
        editor);
    const bool editorEnabled = isEnabled(
        editor);
    const bool chatVisible = isVisible(chatContentView);
    const bool chatEnabled = isEnabled(chatContentView);
    AppendReport(
        shared,
        "submit_guard editorIsTextEdit=%d editorVisible=%d editorEnabled=%d chatVisible=%d chatEnabled=%d\n",
        editorIsTextEdit ? 1 : 0,
        editorVisible ? 1 : 0,
        editorEnabled ? 1 : 0,
        chatVisible ? 1 : 0,
        chatEnabled ? 1 : 0);
    if (!editorIsTextEdit || !editorVisible || !editorEnabled ||
        !chatVisible || !chatEnabled) {
      AppendReport(shared, "error=submit_guard_failed\n");
      Complete(shared, doneEvent, 17);
      return;
    }

    int clickType = 0;
    void* arguments[] = {nullptr, &clickType};
    const int metaCallResult = metaCall(
        chatContentView, 0, methodIndex, arguments);
    AppendReport(shared, "metacallResult=%d clickType=0\n", metaCallResult);
    AppendReport(shared, "result=submit_invoked_once\n");
    Complete(shared, doneEvent, 0);
    return;
  }

  AppendReport(shared, "result=discover_ok no_method_invoked=1\n");
  Complete(shared, doneEvent, 0);
}

void CallbackLifecycleInvoke(
    void*, const void*, const void*) {
  if (gCallbackLifecycleResult != nullptr) {
    InterlockedIncrement(&gCallbackLifecycleResult->invokeCount);
  }
}

void CallbackLifecycleDestroy(const void* bindState) {
  if (gCallbackLifecycleResult != nullptr) {
    if (bindState != nullptr) {
      gCallbackLifecycleResult->destroyRefCount =
          *static_cast<const volatile LONG*>(bindState);
    }
    InterlockedIncrement(&gCallbackLifecycleResult->destroyCount);
  }
  if (bindState != nullptr) {
    HeapFree(GetProcessHeap(), 0, const_cast<void*>(bindState));
  }
}

bool CallbackLifecycleIsCancelled(const void*) {
  if (gCallbackLifecycleResult != nullptr) {
    InterlockedIncrement(&gCallbackLifecycleResult->cancelledCount);
  }
  return false;
}

template <typename FunctionPointer>
FunctionPointer ResolveLifecycleExport(HMODULE module, const char* name) {
  static_assert(sizeof(FunctionPointer) == sizeof(FARPROC));
  const FARPROC raw = module == nullptr ? nullptr : GetProcAddress(module, name);
  FunctionPointer function = nullptr;
  memcpy(&function, &raw, sizeof(function));
  return function;
}

DWORD WINAPI CallbackLifecycleWorker(void*) {
  CallbackLifecycleResult* result = gCallbackLifecycleResult;
  if (result == nullptr || gCallbackLifecycleDestructor == nullptr ||
      gCallbackLifecyclePolymorphicInvoke == nullptr) {
    return 1;
  }
  result->workerThreadId = GetCurrentThreadId();
  InterlockedExchange(&result->workerStarted, 1);
  const ULONGLONG unhookDeadline = GetTickCount64() + 5000;
  while (result->initialHookReleased == 0 && GetTickCount64() < unhookDeadline) {
    Sleep(10);
  }
  if (result->initialHookReleased == 0) {
    result->errorCode = 12;
  } else {
    InterlockedExchange(&result->workerObservedInitialHookReleased, 1);
  }

  const void* bindState = nullptr;
  memcpy(&bindState, gCallbackLifecycleCopy, sizeof(bindState));
  if (result->errorCode != 0) {
    // The copied callback still needs to be destroyed on timeout.
  } else if (bindState == nullptr || !IsReadable(bindState, 0x20)) {
    result->errorCode = 10;
  } else {
    BindStateCancelledFn isCancelled = nullptr;
    memcpy(
        &isCancelled,
        static_cast<const unsigned char*>(bindState) + 24,
        sizeof(isCancelled));
    const bool cancelled =
        isCancelled == nullptr ? true : isCancelled(bindState);
    CallbackInvokeFn invoke =
        gCallbackLifecyclePolymorphicInvoke(gCallbackLifecycleCopy);
    alignas(16) unsigned char syntheticResult[32] = {};
    alignas(16) unsigned char syntheticMessage[64] = {};
    if (cancelled || invoke == nullptr) {
      result->errorCode = 11;
    } else {
      invoke(const_cast<void*>(bindState), syntheticResult, syntheticMessage);
    }
  }

  gCallbackLifecycleDestructor(gCallbackLifecycleCopy);
  ZeroMemory(gCallbackLifecycleCopy, sizeof(gCallbackLifecycleCopy));
  InterlockedExchange(&result->workerCompleted, 1);
  if (gCallbackLifecycleDoneEvent != nullptr) {
    SetEvent(gCallbackLifecycleDoneEvent);
  }
  // Deterministically exercise completion notification before thread exit.
  const ULONGLONG exitDeadline = GetTickCount64() + 3000;
  while (result->holdWorkerExit != 0 && result->allowWorkerExit == 0 &&
         GetTickCount64() < exitDeadline) {
    Sleep(10);
  }
  return result->errorCode == 0 ? 0 : 1;
}

DWORD StartCallbackLifecycleDryRun(
    const wchar_t* prgBasePath,
    HANDLE doneEvent,
    CallbackLifecycleResult* result) {
  if (prgBasePath == nullptr || doneEvent == nullptr || result == nullptr ||
      result->version != kCallbackLifecycleResultVersion) {
    return 2;
  }
  if (InterlockedCompareExchange(&gCallbackLifecycleActive, 1, 0) != 0) {
    return 3;
  }

  wchar_t modulePath[32768] = {};
  if (gThisModule == nullptr ||
      GetModuleFileNameW(gThisModule, modulePath, _countof(modulePath)) == 0) {
    InterlockedExchange(&gCallbackLifecycleActive, 0);
    return 4;
  }
  HMODULE retainedModule = LoadLibraryW(modulePath);
  if (retainedModule == nullptr) {
    InterlockedExchange(&gCallbackLifecycleActive, 0);
    return 5;
  }
  HMODULE prgBase =
      LoadLibraryExW(prgBasePath, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  if (prgBase == nullptr) {
    FreeLibrary(retainedModule);
    InterlockedExchange(&gCallbackLifecycleActive, 0);
    return 6;
  }

  constexpr char kBindStateConstructor[] =
      "??0BindStateBase@internal@base@@AEAA@P6AXXZP6AXPEBV012@@ZP6A_N1@Z@Z";
  constexpr char kCallbackFromBindState[] =
      "??0CallbackBaseCopyable@internal@base@@IEAA@PEAVBindStateBase@12@@Z";
  constexpr char kCallbackCopyConstructor[] =
      "??0CallbackBaseCopyable@internal@base@@QEAA@AEBV012@@Z";
  constexpr char kCallbackDestructor[] =
      "??1CallbackBaseCopyable@internal@base@@IEAA@XZ";
  constexpr char kCallbackPolymorphicInvoke[] =
      "?polymorphic_invoke@CallbackBase@internal@base@@IEBAP6AXXZXZ";
  const auto bindStateConstructor = ResolveLifecycleExport<BindStateConstructorFn>(
      prgBase, kBindStateConstructor);
  const auto callbackFromBindState =
      ResolveLifecycleExport<CallbackFromBindStateFn>(
          prgBase, kCallbackFromBindState);
  const auto callbackCopyConstructor =
      ResolveLifecycleExport<CallbackCopyConstructorFn>(
          prgBase, kCallbackCopyConstructor);
  const auto callbackDestructor = ResolveLifecycleExport<CallbackDestructorFn>(
      prgBase, kCallbackDestructor);
  const auto callbackPolymorphicInvoke =
      ResolveLifecycleExport<CallbackPolymorphicInvokeFn>(
          prgBase, kCallbackPolymorphicInvoke);
  if (bindStateConstructor == nullptr || callbackFromBindState == nullptr ||
      callbackCopyConstructor == nullptr || callbackDestructor == nullptr ||
      callbackPolymorphicInvoke == nullptr) {
    FreeLibrary(prgBase);
    FreeLibrary(retainedModule);
    InterlockedExchange(&gCallbackLifecycleActive, 0);
    return 7;
  }

  void* bindState = HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 0x20);
  if (bindState == nullptr) {
    FreeLibrary(prgBase);
    FreeLibrary(retainedModule);
    InterlockedExchange(&gCallbackLifecycleActive, 0);
    return 8;
  }
  bindStateConstructor(
      bindState,
      &CallbackLifecycleInvoke,
      &CallbackLifecycleDestroy,
      &CallbackLifecycleIsCancelled);
  result->initialRefCount =
      *static_cast<const volatile LONG*>(bindState);
  alignas(void*) unsigned char callback[sizeof(void*)] = {};
  callbackFromBindState(callback, bindState);
  result->refCountAfterAdopt =
      *static_cast<const volatile LONG*>(bindState);
  callbackCopyConstructor(gCallbackLifecycleCopy, callback);
  result->refCountAfterCopy =
      *static_cast<const volatile LONG*>(bindState);
  callbackDestructor(callback);
  result->refCountAfterCallerRelease =
      *static_cast<const volatile LONG*>(bindState);

  gCallbackLifecycleRetainedModule = retainedModule;
  gCallbackLifecyclePrgBase = prgBase;
  gCallbackLifecycleDoneEvent = doneEvent;
  gCallbackLifecycleResult = result;
  gCallbackLifecycleDestructor = callbackDestructor;
  gCallbackLifecyclePolymorphicInvoke = callbackPolymorphicInvoke;

  HANDLE worker = CreateThread(
      nullptr, 0, &CallbackLifecycleWorker, nullptr, 0, nullptr);
  if (worker == nullptr) {
    result->errorCode = GetLastError();
    callbackDestructor(gCallbackLifecycleCopy);
    ZeroMemory(gCallbackLifecycleCopy, sizeof(gCallbackLifecycleCopy));
    gCallbackLifecycleRetainedModule = nullptr;
    gCallbackLifecyclePrgBase = nullptr;
    gCallbackLifecycleDoneEvent = nullptr;
    gCallbackLifecycleResult = nullptr;
    gCallbackLifecycleDestructor = nullptr;
    gCallbackLifecyclePolymorphicInvoke = nullptr;
    FreeLibrary(prgBase);
    FreeLibrary(retainedModule);
    InterlockedExchange(&gCallbackLifecycleActive, 0);
    return 9;
  }
  gCallbackLifecycleWorker = worker;
  return 0;
}

DWORD ReleaseCallbackLifecycleDryRun() {
  if (gCallbackLifecycleActive == 0 || gCallbackLifecycleWorker == nullptr) {
    return ERROR_INVALID_STATE;
  }
  // A completion flag does not prove that the DLL's worker has returned.
  const DWORD workerWait = WaitForSingleObject(gCallbackLifecycleWorker, 0);
  if (workerWait != WAIT_OBJECT_0) {
    return workerWait == WAIT_TIMEOUT ? ERROR_BUSY : GetLastError();
  }
  const void* callbackBindState = nullptr;
  memcpy(
      &callbackBindState,
      gCallbackLifecycleCopy,
      sizeof(callbackBindState));
  if (gCallbackLifecycleActive == 0 ||
      gCallbackLifecycleResult == nullptr ||
      gCallbackLifecycleResult->workerCompleted == 0 ||
      callbackBindState != nullptr) {
    return 2;
  }
  InterlockedExchange(&gCallbackLifecycleResult->workerExitConfirmed, 1);
  CloseHandle(gCallbackLifecycleWorker);
  gCallbackLifecycleWorker = nullptr;

  HMODULE retainedModule = gCallbackLifecycleRetainedModule;
  HMODULE prgBase = gCallbackLifecyclePrgBase;
  HANDLE mapping = gCallbackLifecycleMapping;
  void* mappedView = gCallbackLifecycleMappedView;
  HANDLE doneEvent = mapping == nullptr ? nullptr : gCallbackLifecycleDoneEvent;
  gCallbackLifecycleRetainedModule = nullptr;
  gCallbackLifecyclePrgBase = nullptr;
  gCallbackLifecycleDoneEvent = nullptr;
  gCallbackLifecycleMapping = nullptr;
  gCallbackLifecycleMappedView = nullptr;
  gCallbackLifecycleResult = nullptr;
  gCallbackLifecycleDestructor = nullptr;
  gCallbackLifecyclePolymorphicInvoke = nullptr;
  InterlockedExchange(&gCallbackLifecycleActive, 0);
  if (mappedView != nullptr) {
    UnmapViewOfFile(mappedView);
  }
  if (mapping != nullptr) {
    CloseHandle(mapping);
  }
  if (doneEvent != nullptr) {
    CloseHandle(doneEvent);
  }
  if (prgBase != nullptr) {
    FreeLibrary(prgBase);
  }
  if (retainedModule != nullptr) {
    FreeLibrary(retainedModule);
  }
  return 0;
}

void RunCallbackLifecycleStart(ProbeShared* shared, HANDLE doneEvent) {
  if (gCallbackLifecycleActive != 0) {
    AppendReport(shared, "error=callback_lifecycle_already_active\n");
    Complete(shared, doneEvent, 61);
    return;
  }
  HMODULE prgBase = GetModuleHandleW(L"prgbase.dll");
  wchar_t prgBasePath[32768] = {};
  if (prgBase == nullptr ||
      GetModuleFileNameW(prgBase, prgBasePath, _countof(prgBasePath)) == 0) {
    AppendReport(shared, "error=target_prgbase_not_found\n");
    Complete(shared, doneEvent, 60);
    return;
  }

  ZeroMemory(&shared->callbackLifecycle, sizeof(shared->callbackLifecycle));
  shared->callbackLifecycle.version = kCallbackLifecycleResultVersion;
  shared->callbackLifecycle.guiThreadId = GetCurrentThreadId();
  shared->callbackLifecycle.destroyRefCount = -1;
  const DWORD startResult = StartCallbackLifecycleDryRun(
      prgBasePath, doneEvent, &shared->callbackLifecycle);
  shared->callbackLifecycleStartResult = startResult;
  AppendReport(
      shared,
      "callback_lifecycle_start guiThread=%lu start=%lu "
      "initialRefCount=%ld afterAdopt=%ld afterCopy=%ld "
      "afterCallerRelease=%ld no_send_address_resolved=1 "
      "no_send_invoked=1\n",
      shared->callbackLifecycle.guiThreadId,
      startResult,
      static_cast<long>(shared->callbackLifecycle.initialRefCount),
      static_cast<long>(shared->callbackLifecycle.refCountAfterAdopt),
      static_cast<long>(shared->callbackLifecycle.refCountAfterCopy),
      static_cast<long>(shared->callbackLifecycle.refCountAfterCallerRelease));
  Complete(shared, doneEvent, startResult == 0 ? 0 : 61);
}

void RunCallbackLifecycleRelease(ProbeShared* shared, HANDLE doneEvent) {
  const DWORD releaseResult = ReleaseCallbackLifecycleDryRun();
  shared->callbackLifecycleReleaseResult = releaseResult;
  AppendReport(
      shared,
      "callback_lifecycle_release guiThread=%lu release=%lu "
      "no_send_address_resolved=1 no_send_invoked=1\n",
      GetCurrentThreadId(),
      releaseResult);
  Complete(shared, doneEvent, releaseResult == 0 ? 0 : 62);
}

}  // namespace

extern "C" __declspec(dllexport) DWORD QnCallbackLifecycleDryRun(
    const wchar_t* prgBasePath,
    HANDLE doneEvent,
    CallbackLifecycleResult* result) {
  return StartCallbackLifecycleDryRun(prgBasePath, doneEvent, result);
}

extern "C" __declspec(dllexport) DWORD QnCallbackLifecycleRelease() {
  return ReleaseCallbackLifecycleDryRun();
}

extern "C" __declspec(dllexport) LRESULT CALLBACK QnProbeHook(
    int code,
    WPARAM wParam,
    LPARAM lParam) {
  if (code >= 0 && lParam != 0) {
    const auto* message = reinterpret_cast<const CWPSTRUCT*>(lParam);
    const UINT probeMessage = RegisterWindowMessageW(kProbeMessageName);
    if (message->message == probeMessage) {
      const DWORD processId = GetCurrentProcessId();
      wchar_t mappingName[128] = {};
      wchar_t eventName[128] = {};
      MakeProbeObjectName(
          mappingName, _countof(mappingName), kProbeMappingPrefix, processId);
      MakeProbeObjectName(eventName, _countof(eventName), kProbeEventPrefix, processId);

      HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mappingName);
      HANDLE doneEvent = OpenEventW(EVENT_MODIFY_STATE, FALSE, eventName);
      if (mapping != nullptr) {
        auto* shared = static_cast<ProbeShared*>(MapViewOfFile(
            mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ProbeShared)));
        bool startedLifecycleHere = false;
        if (shared != nullptr && shared->magic == kProbeMagic &&
            shared->version == kProbeVersion &&
            (shared->operation == kProbeOperationDiscover ||
             shared->operation == kProbeOperationDiscoverMinimized ||
             shared->operation == kProbeOperationSubmit ||
             shared->operation == kProbeOperationSubmitMinimized ||
              shared->operation == kProbeOperationWriteDraftMinimized ||
              shared->operation == kProbeOperationClearDraftMinimized ||
              shared->operation == kProbeOperationDiscoverFocusChainMinimized ||
              shared->operation == kProbeOperationReconcileMinimized ||
              shared->operation == kProbeOperationWriteDraftFocusChainMinimized ||
              shared->operation == kProbeOperationClearDraftFocusChainMinimized ||
              shared->operation == kProbeOperationSubmitFocusChainMinimized ||
              shared->operation == kProbeOperationEnumerateAim ||
              shared->operation == kProbeOperationEnumerateAppMessageServices ||
              shared->operation == kProbeOperationDryRunSendArguments ||
              shared->operation == kProbeOperationLocateAppMessageService ||
              shared->operation == kProbeOperationDirectSendTextMinimized ||
              shared->operation == kProbeOperationObserveAimSendStart ||
              shared->operation == kProbeOperationObserveAimSendStop ||
              shared->operation == kProbeOperationCallbackLifecycleStart ||
              shared->operation == kProbeOperationCallbackLifecycleRelease) &&
            shared->processId == processId &&
            shared->threadId == GetCurrentThreadId() &&
            InterlockedCompareExchange(
                &shared->state, kProbeRunning, kProbePending) == kProbePending) {
          RunDiscovery(shared, doneEvent);
          startedLifecycleHere =
              shared->operation == kProbeOperationCallbackLifecycleStart &&
              shared->resultCode == 0 && gCallbackLifecycleActive != 0;
        }
        const bool transferLifecycleIpc =
            startedLifecycleHere && gCallbackLifecycleMappedView == nullptr;
        if (transferLifecycleIpc) {
          gCallbackLifecycleMapping = mapping;
          gCallbackLifecycleMappedView = shared;
          mapping = nullptr;
          shared = nullptr;
          doneEvent = nullptr;
        }
        if (shared != nullptr) {
          UnmapViewOfFile(shared);
        }
        if (mapping != nullptr) {
          CloseHandle(mapping);
        }
      }
      if (doneEvent != nullptr) {
        CloseHandle(doneEvent);
      }
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

extern "C" __declspec(dllexport) LRESULT CALLBACK QnCbtProbeHook(
    int code,
    WPARAM wParam,
    LPARAM lParam) {
  if (code >= 0) {
    const DWORD processId = GetCurrentProcessId();
    wchar_t mappingName[128] = {};
    MakeProbeObjectName(
        mappingName, _countof(mappingName), kProbeMappingPrefix, processId);
    HANDLE mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, mappingName);
    if (mapping != nullptr) {
      auto* shared = static_cast<ProbeShared*>(MapViewOfFile(
          mapping, FILE_MAP_ALL_ACCESS, 0, 0, sizeof(ProbeShared)));
      if (shared != nullptr && shared->magic == kProbeMagic &&
          shared->version == kProbeVersion &&
          (shared->operation == kProbeOperationWatchCbt ||
           shared->operation == kProbeOperationSuppressCbt) &&
          shared->processId == processId &&
          shared->threadId == GetCurrentThreadId()) {
        const bool targetEvent =
            static_cast<UINT_PTR>(wParam) == shared->windowHandle;
        if (code == HCBT_ACTIVATE) {
          InterlockedIncrement(&shared->cbtActivateCount);
          AppendReport(
              shared,
              "cbt code=HCBT_ACTIVATE target=%d hwnd=0x%llx\n",
              targetEvent ? 1 : 0,
              static_cast<unsigned long long>(wParam));
        } else if (code == HCBT_MINMAX) {
          InterlockedIncrement(&shared->cbtMinMaxCount);
          AppendReport(
              shared,
              "cbt code=HCBT_MINMAX target=%d hwnd=0x%llx showCommand=%lld\n",
              targetEvent ? 1 : 0,
              static_cast<unsigned long long>(wParam),
              static_cast<long long>(lParam));
        }

        const bool suppress =
            shared->operation == kProbeOperationSuppressCbt && targetEvent &&
            (code == HCBT_ACTIVATE || code == HCBT_MINMAX);
        if (suppress) {
          InterlockedIncrement(&shared->cbtSuppressedCount);
          AppendReport(shared, "cbt action=suppressed code=%d\n", code);
          UnmapViewOfFile(shared);
          CloseHandle(mapping);
          return 1;
        }
      }
      if (shared != nullptr) {
        UnmapViewOfFile(shared);
      }
      CloseHandle(mapping);
    }
  }
  return CallNextHookEx(nullptr, code, wParam, lParam);
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    gThisModule = instance;
  } else if (reason == DLL_PROCESS_DETACH) {
    gThisModule = nullptr;
  }
  return TRUE;
}
