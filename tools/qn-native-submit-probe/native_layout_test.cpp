#include "native_layout.h"
#include <cassert>
#include <cstdio>
int main() {
  for (const auto& profile : kQnNativeProfiles) {
    assert(QnMatchNativeProfile(profile.appHash, profile.prgHash) == &profile);
    assert(!QnMatchNativeProfile(profile.appHash, L"unknown"));
  }
  assert(!QnMatchNativeProfile(kQnNativeProfiles[0].appHash, kQnNativeProfiles[1].prgHash));
  assert(!QnMatchNativeProfile(nullptr, nullptr));
  QnNativeLayout layout{};
  assert(!QnResolveNativeLayout(GetCurrentProcessId(), &layout));
  assert(!QnResolveNativeLayout(0, &layout));
  std::puts("PASS native profiles: known pairs, mixed pair, unknown hashes, non-Qianniu process");
}
