#pragma once
#include <windows.h>
#include <cstddef>

struct QnLiveIdentity {
  DWORD pid, tid, session;
  FILETIME processCreated, threadCreated;
  ULONG_PTR hwnd, appBase;
  DWORD appSize;
};
bool QnSelectLiveIdentity(QnLiveIdentity* identity, const wchar_t* allowedResearchPath, const wchar_t* secondAllowedPath = nullptr,
                         const wchar_t* thirdAllowedPath = nullptr, const wchar_t* fourthAllowedPath = nullptr,
                         const wchar_t* fifthAllowedPath = nullptr, const wchar_t* sixthAllowedPath = nullptr);
bool QnCheckLiveIdentity(const QnLiveIdentity& identity, const wchar_t* allowedResearchPath, const wchar_t* secondAllowedPath = nullptr,
                        const wchar_t* thirdAllowedPath = nullptr, const wchar_t* fourthAllowedPath = nullptr,
                        const wchar_t* fifthAllowedPath = nullptr, const wchar_t* sixthAllowedPath = nullptr);
bool QnCheckNativeCode(DWORD pid, const wchar_t* path, const wchar_t* expectedHash,
                       ULONG_PTR base, const DWORD* entries, std::size_t count);
