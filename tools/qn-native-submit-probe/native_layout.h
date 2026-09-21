#pragma once
#include <windows.h>

struct QnNativeProfile {
  const wchar_t* name;
  const wchar_t* appHash;
  const wchar_t* prgHash;
  DWORD entries[5];
  DWORD serviceVtable, identityVtable, identityEntry;
};

inline constexpr QnNativeProfile kQnNativeProfiles[] = {
  {L"9.97.80N", L"565AB778C7A5829B080E17551308254C0B9D7F1F4A2859782ADAC500C055E41C",
   L"4D50ACBCCEE823D5FE01B1CE7082ED1FC97070930110727CCDBFDA628247F0FC",
   {0xa73a40, 0x17ccd0, 0x14e2c0, 0x24dca0, 0x24ea10}, 0x18afda8, 0x18aff20, 0x4f0380},
  {L"9.97.81N", L"50A55E49FA22BF919DE5DCBE11E9D8F4BB76A0658F4083B9B86D24CD029DEBBC",
   L"E29D6CE816DD21B93C0829E4A40A668C8971583DF26D3DE5B2D269A68EA96404",
   {0xa85840, 0x17d2e0, 0x14e8d0, 0x24e2b0, 0x24f020}, 0x18c4c78, 0x18c4df0, 0x4f0990},
};

struct QnNativeLayout {
  wchar_t appPath[MAX_PATH]{}, prgPath[MAX_PATH]{};
  ULONG_PTR appBase = 0, prgBase = 0;
  const QnNativeProfile* profile = nullptr;
};

// Select by verified binary pair, never by folder name or newest installed directory.
const QnNativeProfile* QnMatchNativeProfile(const wchar_t* appHash, const wchar_t* prgHash);
bool QnResolveNativeLayout(DWORD pid, QnNativeLayout* layout);
