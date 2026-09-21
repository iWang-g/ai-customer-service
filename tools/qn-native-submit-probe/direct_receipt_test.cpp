#include "direct_once_shared.h"
#include <array>
#include <cstdio>
#include <thread>
#include <vector>

namespace {
direct_receipt::Slot slots[5];
void Require(bool value, const char* what) { if (!value) { std::printf("FAIL %s\n", what); std::exit(1); } }
struct Result { unsigned char vptr[8]{}; int code = 0; };
struct Message {
  alignas(8) unsigned char bytes[0x70]{};
  std::array<char, 64> message{}, client{};
  Message() {
    strcpy_s(message.data(), message.size(), "4294167478215.PNM");
    strcpy_s(client.data(), client.size(), "7502604691893649504");
    const std::array<std::pair<SIZE_T, char*>, 2> entries{{{0x30, message.data()}, {0x50, client.data()}}};
    for (const auto& entry : entries) {
      SIZE_T size = std::strlen(entry.second), cap = 63;
      std::memcpy(bytes + entry.first, &entry.second, 8);
      std::memcpy(bytes + entry.first + 16, &size, 8); std::memcpy(bytes + entry.first + 24, &cap, 8);
    }
  }
};
}
int main() {
  HMODULE prg = LoadLibraryExW(direct_once::kPrg, nullptr, LOAD_WITH_ALTERED_SEARCH_PATH);
  direct_receipt::Api api{}; Require(prg && api.Load(prg), "native exports");
  Result result; Message message;
  direct_receipt::Callback cb{}, held{};
  Require(slots[0].Create(api, &cb), "create");
  Require(!slots[0].Create(api, &held), "slot not recycled");
  slots[0].Enter(); api.copy(&held, &cb); api.release(&cb); slots[0].Return(); slots[0].Timeout();
  std::thread worker([&] { api.polymorphic(&held)(held.state, &result, message.bytes); api.release(&held); });
  worker.join(); auto s = slots[0].Read();
  Require(s.callbacks == 1 && s.late == 1 && s.destroyed == 1 && !s.invalid && !s.conflicts &&
      s.first.status == qn_research::SnapshotStatus::Ok && !std::strcmp(s.first.clientId.data(), message.client.data()),
      "async after caller release + late identity");
  message.client.fill('x'); Require(slots[0].Read().first.clientId == s.first.clientId, "borrowed data copied");
  std::puts("PASS async_owned_identity_late_final_destroy");
  Require(slots[0].RecycleIfDestroyed(), "destroyed slot recycled");
  for (int cycle = 0; cycle < 32; ++cycle) {
    cb = {}; Require(slots[0].Create(api, &cb), "create after recycle");
    Require(!slots[0].RecycleIfDestroyed(), "live callback cannot be recycled");
    api.release(&cb); Require(slots[0].Read().destroyed == 1, "recycled slot has independent lifetime");
    Require(slots[0].RecycleIfDestroyed() && slots[0].Read().created == 0, "recycle leaves slot empty");
  }
  direct_receipt::Snapshot cleanup{};
  Require(direct_once::CleanupEligible(0, cleanup), "request without callback can clean up");
  Require(!direct_once::CleanupEligible(1, cleanup), "live callback blocks cleanup");
  cleanup.created = cleanup.destroyed = 1;
  Require(direct_once::CleanupEligible(1, cleanup), "destroyed callback allows cleanup");
  cb = {}; Require(slots[1].Create(api, &cb), "sync create"); slots[1].Enter(); result.code = 7;
  api.polymorphic(&cb)(cb.state, &result, nullptr); slots[1].Return(); api.release(&cb);
  s = slots[1].Read(); Require(s.beforeReturn == 1 && s.first.resultCode == 7 && !s.invalid && s.destroyed == 1, "sync failure");
  std::puts("PASS sync_failure_empty_message");
  cb = {}; Require(slots[2].Create(api, &cb), "concurrent create"); slots[2].Enter(); slots[2].Return();
  std::vector<std::thread> workers;
  for (int i = 0; i < 4; ++i) workers.emplace_back([&] {
    direct_receipt::Callback copy{}; api.copy(&copy, &cb);
    for (int n = 0; n < 100; ++n) api.polymorphic(&copy)(copy.state, &result, nullptr);
    api.release(&copy);
  });
  for (auto& t : workers) t.join();
  result.code = 8;
  api.polymorphic(&cb)(cb.state, &result, nullptr); api.release(&cb);
  s = slots[2].Read(); Require(s.callbacks == 401 && s.conflicts == 1 && s.first.resultCode == 7 && s.destroyed == 1, "concurrent conflict");
  std::puts("PASS concurrent_duplicates_conflict_retained");
  cb = {}; Require(slots[3].Create(api, &cb), "invalid create"); slots[3].Enter();
  api.polymorphic(&cb)(cb.state, nullptr, nullptr); slots[3].Return(); api.release(&cb);
  s = slots[3].Read(); Require(s.invalid == 1 && !s.first.resultCodeValid && s.destroyed == 1, "null is not success");
  cb = {}; Require(slots[4].Create(api, &cb), "missing create"); slots[4].Enter(); slots[4].Return(); api.release(&cb);
  s = slots[4].Read(); Require(s.callbacks == 0 && s.destroyed == 1, "destruction is not completion");
  std::puts("PASS invalid_missing_callbacks_never_success");
  Require(direct_once::ValidText("CodexDirectSend-20260907000000", 256) &&
      !direct_once::ValidText("hello", 256) && !direct_once::ValidText("CodexDirectSend-123456x", 256), "request text guard");
  FreeLibrary(prg); std::puts("PASS all new callback tests; no AppBiz loaded; no send entry called");
  return 0;
}
