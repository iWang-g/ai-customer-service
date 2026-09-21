#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>

namespace qn_research {
// Static 9.97.80N layout evidence only. This does not authorize live access.
constexpr std::size_t kMessageIdOffset = 0x30;
constexpr std::size_t kClientIdOffset = 0x50;
constexpr std::size_t kMaxIdentityBytes = 256;
using ReadMemory = bool (*)(void*, std::uint64_t, void*, std::size_t);

enum class SnapshotStatus {
  Ok, InvalidArguments, UnreadableResult, NonzeroResult,
  UnreadableMessage, InvalidStringLayout, UnreadableString,
  InvalidIdentity, ChangedDuringRead
};

struct MessageIdentitySnapshot {
  SnapshotStatus status = SnapshotStatus::InvalidArguments;
  bool resultCodeValid = false;
  std::int32_t resultCode = 0;
  std::array<char, kMaxIdentityBytes + 1> messageId{};
  std::array<char, kMaxIdentityBytes + 1> clientId{};
};

inline bool ReadAt(ReadMemory read, void* context, std::uint64_t base,
                   std::uint64_t offset, void* target, std::size_t length) {
  const auto limit = std::numeric_limits<std::uint64_t>::max();
  if (!read || !base || offset > limit - base || length > limit - (base + offset)) {
    return false;
  }
  return read(context, base + offset, target, length);
}

inline SnapshotStatus ReadIdentity(ReadMemory read, void* context,
    std::uint64_t address, const unsigned char* descriptor, bool digitsOnly,
    std::array<char, kMaxIdentityBytes + 1>& value) {
  std::uint64_t length = 0, capacity = 0, storage = address;
  std::memcpy(&length, descriptor + 16, 8);
  std::memcpy(&capacity, descriptor + 24, 8);
  if (!length || length > kMaxIdentityBytes || capacity < length ||
      capacity > 4096 || (capacity <= 15 && capacity != 15)) {
    return SnapshotStatus::InvalidStringLayout;
  }
  if (capacity > 15) std::memcpy(&storage, descriptor, 8);
  if (!ReadAt(read, context, storage, 0, value.data(), static_cast<std::size_t>(length + 1))) {
    return SnapshotStatus::UnreadableString;
  }
  if (value[length] != '\0') return SnapshotStatus::InvalidIdentity;
  for (std::size_t i = 0; i < length; ++i) {
    const auto ch = static_cast<unsigned char>(value[i]);
    const bool digit = ch >= '0' && ch <= '9';
    if (!digit && (digitsOnly || !((ch >= 'A' && ch <= 'Z') ||
        (ch >= 'a' && ch <= 'z') || ch == '.' || ch == '_' || ch == '-'))) {
      return SnapshotStatus::InvalidIdentity;
    }
  }
  return SnapshotStatus::Ok;
}

inline MessageIdentitySnapshot SnapshotMessageIdentity(
    ReadMemory read, void* context, std::uint64_t result, std::uint64_t message) {
  MessageIdentitySnapshot output;
  if (!read || !result) return output;
  if (!ReadAt(read, context, result, 8, &output.resultCode, sizeof(output.resultCode))) {
    output.status = SnapshotStatus::UnreadableResult;
    return output;
  }
  output.resultCodeValid = true;
  if (output.resultCode != 0) {
    // Native completion builds an empty AppMessage on failure; do not parse it.
    output.status = SnapshotStatus::NonzeroResult;
    return output;
  }
  std::array<unsigned char, 0x40> descriptors{};
  if (!ReadAt(read, context, message, kMessageIdOffset, descriptors.data(), descriptors.size())) {
    output.status = SnapshotStatus::UnreadableMessage;
    return output;
  }
  std::array<char, kMaxIdentityBytes + 1> messageId{}, clientId{};
  auto status = ReadIdentity(read, context, message + kMessageIdOffset,
      descriptors.data(), false, messageId);
  if (status == SnapshotStatus::Ok) {
    status = ReadIdentity(read, context, message + kClientIdOffset,
        descriptors.data() + 0x20, true, clientId);
  }
  if (status != SnapshotStatus::Ok) {
    output.status = status;
    return output;
  }
  // Detect some inconsistent snapshots. Live use still requires the target
  // stopped at callback entry or a valid, stable borrowed-reference lifetime.
  std::array<unsigned char, 0x40> again{};
  std::array<char, kMaxIdentityBytes + 1> messageAgain{}, clientAgain{};
  std::int32_t resultAgain = -1;
  if (!ReadAt(read, context, message, kMessageIdOffset, again.data(), again.size()) ||
      descriptors != again ||
      ReadIdentity(read, context, message + kMessageIdOffset, again.data(), false,
          messageAgain) != SnapshotStatus::Ok ||
      ReadIdentity(read, context, message + kClientIdOffset, again.data() + 0x20, true,
          clientAgain) != SnapshotStatus::Ok ||
      messageId != messageAgain || clientId != clientAgain ||
      !ReadAt(read, context, result, 8, &resultAgain, sizeof(resultAgain)) ||
      resultAgain != output.resultCode) {
    output.status = SnapshotStatus::ChangedDuringRead;
    return output;
  }
  output.messageId = messageId;
  output.clientId = clientId;
  output.status = SnapshotStatus::Ok;
  return output;
}
}  // namespace qn_research
