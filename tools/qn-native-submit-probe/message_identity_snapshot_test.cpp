#include "message_identity_snapshot.h"

#include <cstdio>
#include <cstdlib>
#include <string>

namespace {
using namespace qn_research;
constexpr std::uint64_t kBase = 0x1000;
constexpr std::uint64_t kMessage = 0x1100;
struct Memory {
  std::array<unsigned char, 0x2000> bytes{};
  int reads = 0;
  int mutateOn = 0;
  std::size_t mutation = 0;
};
bool Read(void* context, std::uint64_t address, void* target, std::size_t length) {
  auto& memory = *static_cast<Memory*>(context);
  ++memory.reads;
  if (memory.reads == memory.mutateOn) ++memory.bytes[memory.mutation];
  if (address < kBase || address - kBase > memory.bytes.size() ||
      length > memory.bytes.size() - (address - kBase)) return false;
  std::memcpy(target, memory.bytes.data() + address - kBase, length);
  return true;
}
void Number(Memory& m, std::size_t offset, std::uint64_t value) {
  std::memcpy(m.bytes.data() + offset, &value, sizeof(value));
}
void String(Memory& m, std::size_t descriptor, const std::string& text, std::size_t heap) {
  const bool small = text.size() <= 15;
  const std::size_t data = small ? descriptor : heap;
  if (!small) Number(m, descriptor, kBase + heap);
  std::memcpy(m.bytes.data() + data, text.c_str(), text.size() + 1);
  Number(m, descriptor + 16, text.size());
  Number(m, descriptor + 24, small ? 15 : 255);
}
Memory Fixture(const std::string& message = "4293759074497.PNM",
               const std::string& client = "7502548731028308036") {
  Memory m;
  String(m, 0x130, message, 0x400);
  String(m, 0x150, client, 0x600);
  return m;
}
void Check(bool condition, const char* name) {
  if (!condition) { std::fprintf(stderr, "FAIL %s\n", name); std::exit(1); }
}
void Expect(Memory& m, SnapshotStatus status) {
  const auto result = SnapshotMessageIdentity(&Read, &m, kBase, kMessage);
  Check(result.status == status, "expected snapshot status");
  if (status != SnapshotStatus::Ok) {
    Check(result.clientId[0] == 0 && result.messageId[0] == 0, "no partial identity published");
  }
}
}  // namespace

int main() {
  using namespace qn_research;
  auto m = Fixture();
  auto result = SnapshotMessageIdentity(&Read, &m, kBase, kMessage);
  Check(result.status == SnapshotStatus::Ok, "heap strings");
  Check(std::string(result.clientId.data()) == "7502548731028308036", "exact long client ID");
  Check(std::string(result.messageId.data()) == "4293759074497.PNM", "message/client order");
  m.bytes.fill(0);
  Check(std::string(result.clientId.data()) == "7502548731028308036", "snapshot owns bytes");
  std::puts("PASS heap_strings_exact_ids_and_owned_snapshot");

  m = Fixture("short.PNM", "123456789012345"); Expect(m, SnapshotStatus::Ok);
  m = Fixture(std::string(256, 'a'), "123"); Number(m, 0x148, 256);
  Expect(m, SnapshotStatus::Ok);
  std::puts("PASS inline_strings_and_maximum_length");

  m = Fixture(); Number(m, 8, 7);
  result = SnapshotMessageIdentity(&Read, &m, kBase, 0);
  Check(result.status == SnapshotStatus::NonzeroResult && result.resultCode == 7 &&
        m.reads == 1, "failure result does not inspect AppMessage");
  std::puts("PASS_nonzero_result_skips_message");

  for (const auto length : {std::uint64_t{0}, std::uint64_t{257}, UINT64_MAX}) {
    m = Fixture(); Number(m, 0x160, length); Expect(m, SnapshotStatus::InvalidStringLayout);
  }
  for (const auto capacity : {std::uint64_t{0}, std::uint64_t{15}, std::uint64_t{4097}}) {
    m = Fixture(); Number(m, 0x168, capacity); Expect(m, SnapshotStatus::InvalidStringLayout);
  }
  std::puts("PASS invalid_lengths_capacities_fail_closed");

  m = Fixture(); Number(m, 0x150, 0); Expect(m, SnapshotStatus::UnreadableString);
  m = Fixture(); Number(m, 0x150, UINT64_MAX - 2); Expect(m, SnapshotStatus::UnreadableString);
  m = Fixture(); Number(m, 0x150, 0x9000); Expect(m, SnapshotStatus::UnreadableString);
  result = SnapshotMessageIdentity(&Read, &m, UINT64_MAX - 2, kMessage);
  Check(result.status == SnapshotStatus::UnreadableResult, "overflowing result address");
  result = SnapshotMessageIdentity(&Read, &m, kBase, UINT64_MAX - 2);
  Check(result.status == SnapshotStatus::UnreadableMessage, "overflowing message address");
  std::puts("PASS null_unmapped_overflowing_addresses");

  m = Fixture(); m.bytes[0x600 + 18] = 'x'; Expect(m, SnapshotStatus::InvalidIdentity);
  m = Fixture(); m.bytes[0x601] = 0; Expect(m, SnapshotStatus::InvalidIdentity);
  m = Fixture(); m.bytes[0x601] = 'a'; Expect(m, SnapshotStatus::InvalidIdentity);
  m = Fixture(); m.bytes[0x401] = '\n'; Expect(m, SnapshotStatus::InvalidIdentity);
  std::puts("PASS invalid_identity_characters_and_terminator");

  for (const auto offset : {std::size_t{0x160}, std::size_t{0x601}, std::size_t{8}}) {
    m = Fixture(); m.mutateOn = 5; m.mutation = offset;
    Expect(m, SnapshotStatus::ChangedDuringRead);
  }
  std::puts("PASS descriptor_content_and_result_mutation");

  result = SnapshotMessageIdentity(nullptr, nullptr, kBase, kMessage);
  Check(result.status == SnapshotStatus::InvalidArguments, "missing read provider");
  std::puts("PASS invalid_read_provider");
  std::puts("result=identity_snapshot_fixture_ok target_access=0 send_invoked=0 "
            "real_layout_dynamically_validated=0");
  return 0;
}
