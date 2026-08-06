from __future__ import annotations

import unittest

from app.services.message_sequence_service import (
    align_message_sequences,
    longest_tail_overlap,
    message_fingerprint,
    normalize_text,
)


def text(
    sender_role: str,
    content: str,
    platform_message_id: str | None = None,
) -> dict[str, object]:
    return {
        "sender_role": sender_role,
        "message_type": "text",
        "content": content,
        "platform_message_id": platform_message_id,
    }


def image(
    sender_role: str,
    *,
    platform_message_id: str | None = None,
    image_url: str | None = None,
    image_sha256: str | None = None,
) -> dict[str, object]:
    return {
        "sender_role": sender_role,
        "message_type": "image",
        "content": "[图片]",
        "platform_message_id": platform_message_id,
        "image_url": image_url,
        "image_sha256": image_sha256,
    }


class MessageSequenceServiceTests(unittest.TestCase):
    def test_normalization_is_minimal_and_direction_is_part_of_fingerprint(self) -> None:
        self.assertEqual(normalize_text("  你好\n  世界  "), "你好 世界")
        self.assertNotEqual(
            message_fingerprint(text("customer", "Hello")),
            message_fingerprint(text("agent", "Hello")),
        )
        self.assertNotEqual(
            message_fingerprint(text("customer", "Hello")),
            message_fingerprint(text("customer", "hello")),
        )

    def test_longest_tail_overlap_uses_occurrence_order(self) -> None:
        self.assertEqual(longest_tail_overlap(["a", "b", "b"], ["b", "b", "c"]), 2)

    def test_empty_history_bootstraps_full_visible_snapshot(self) -> None:
        current = [text("customer", "你好"), text("agent", "您好")]
        result = align_message_sequences([], current)
        self.assertEqual(result.status, "bootstrap")
        self.assertEqual(result.projected_append_count, 2)
        self.assertEqual(result.append_from, 0)

    def test_complete_overlap_is_duplicate(self) -> None:
        history = [text("customer", "你好"), text("agent", "您好")]
        result = align_message_sequences(history, history)
        self.assertEqual(result.status, "duplicate")
        self.assertEqual(result.overlap_size, 2)
        self.assertEqual(result.projected_append_count, 0)

    def test_partial_overlap_projects_only_new_tail(self) -> None:
        history = [text("customer", "A"), text("agent", "B"), text("customer", "C")]
        current = [text("agent", "B"), text("customer", "C"), text("agent", "D")]
        result = align_message_sequences(history, current)
        self.assertEqual(result.status, "aligned")
        self.assertEqual(result.overlap_size, 2)
        self.assertEqual(result.projected_append_count, 1)
        self.assertEqual(result.append_from, 2)

    def test_changed_or_missing_platform_ids_do_not_break_content_overlap(self) -> None:
        history = [
            text("customer", "我去", "old-1"),
            text("customer", "我没注意到", "old-2"),
            text("agent", "来两把", "old-3"),
        ]
        current = [
            text("customer", "我去", "new-1"),
            text("customer", "我没注意到", None),
            text("agent", "来两把", "new-3"),
            text("customer", "行", None),
        ]
        result = align_message_sequences(history, current)
        self.assertEqual((result.status, result.overlap_size, result.projected_append_count), (
            "aligned", 3, 1,
        ))

    def test_repeated_customer_and_agent_text_preserves_occurrence_count(self) -> None:
        for sender in ("customer", "agent"):
            one = [text(sender, "在吗")]
            two = [text(sender, "在吗"), text(sender, "在吗")]
            three = [*two, text(sender, "在吗")]
            self.assertEqual(align_message_sequences(one, two).projected_append_count, 1)
            self.assertEqual(align_message_sequences(two, three).projected_append_count, 1)

    def test_repeated_image_id_preserves_occurrence_count(self) -> None:
        one = [image("customer", platform_message_id="weak-id")]
        two = [*one, image("customer", platform_message_id="weak-id")]
        result = align_message_sequences(one, two)
        self.assertEqual(result.status, "aligned")
        self.assertEqual(result.projected_append_count, 1)

    def test_image_hash_survives_url_change(self) -> None:
        digest = "a" * 64
        history = [image("customer", image_url="https://a.invalid/old", image_sha256=digest)]
        current = [
            image("customer", image_url="https://b.invalid/new", image_sha256=digest),
            text("agent", "收到"),
        ]
        result = align_message_sequences(history, current)
        self.assertEqual((result.overlap_size, result.projected_append_count), (1, 1))

    def test_image_url_ignores_temporary_signature_parameters(self) -> None:
        left = image(
            "customer",
            image_url="HTTPS://CDN.INVALID/a.png?width=100&token=old&size=large",
        )
        right = image(
            "customer",
            image_url="https://cdn.invalid/a.png?size=large&token=new&width=100",
        )
        self.assertEqual(message_fingerprint(left), message_fingerprint(right))

    def test_trustworthy_platform_anchor_requires_unique_id_and_context(self) -> None:
        history = [
            text("customer", "old-A", "id-a"),
            text("agent", "stable-B", "id-b"),
            text("customer", "stable-C", "id-c"),
        ]
        current = [
            text("customer", "window-start", "id-x"),
            text("agent", "stable-B", "id-b"),
            text("customer", "stable-C", "id-c"),
            text("agent", "new-D", "id-d"),
        ]
        result = align_message_sequences(history, current)
        self.assertEqual(result.method, "platform_id_anchor")
        self.assertEqual(result.projected_append_count, 1)

    def test_repeated_or_isolated_platform_id_is_not_a_trustworthy_anchor(self) -> None:
        repeated = align_message_sequences(
            [text("customer", "old", "same"), text("agent", "tail", "same")],
            [text("customer", "different", "same"), text("agent", "new", "same")],
        )
        isolated = align_message_sequences(
            [text("customer", "old", "stable")],
            [text("customer", "different", "stable"), text("agent", "new")],
        )
        self.assertEqual(repeated.status, "unaligned")
        self.assertEqual(isolated.status, "unaligned")

    def test_no_overlap_is_unaligned_and_projects_nothing(self) -> None:
        result = align_message_sequences(
            [text("customer", "old")],
            [text("customer", "unrelated")],
        )
        self.assertEqual(result.status, "unaligned")
        self.assertEqual(result.projected_append_count, 0)
        self.assertIsNone(result.append_from)


if __name__ == "__main__":
    unittest.main()
