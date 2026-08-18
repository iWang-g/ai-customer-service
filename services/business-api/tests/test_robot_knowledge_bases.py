from __future__ import annotations

import unittest
from unittest.mock import Mock, patch

import httpx
from fastapi import HTTPException

from app.services.robot_service import _knowledge_base, _validate_knowledge_bases


class RobotKnowledgeBaseValidationTests(unittest.TestCase):
    user = type("User", (), {"id": "user-1", "username": "tester", "role": "agent"})()
    @patch("app.services.robot_service.httpx.get")
    def test_missing_knowledge_base_is_reported_as_invalid_relation(self, get: Mock) -> None:
        get.return_value = httpx.Response(
            404,
            request=httpx.Request("GET", "http://knowledge-base/api/v1/knowledge-bases/missing"),
        )

        with self.assertRaises(HTTPException) as raised:
            _knowledge_base(self.user, "missing")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertTrue(get.call_args.kwargs["headers"]["Authorization"].startswith("Bearer "))

    @patch("app.services.robot_service._knowledge_base")
    def test_accepts_matching_enabled_knowledge_bases(self, get_base: Mock) -> None:
        values = {
            "qa-1": {"kind": "qa", "enabled": True},
            "product-1": {"kind": "product", "enabled": True},
            "tone-1": {"kind": "tone", "enabled": True},
        }
        get_base.side_effect = lambda _user, base_id: values[base_id]

        _validate_knowledge_bases(self.user, ["qa-1"], ["product-1"], "tone-1")

    @patch("app.services.robot_service._knowledge_base")
    def test_accepts_public_cross_user_knowledge_base(self, get_base: Mock) -> None:
        get_base.return_value = {
            "id": "qa-public",
            "kind": "qa",
            "enabled": True,
            "is_public": True,
            "read_only": True,
        }

        _validate_knowledge_bases(self.user, ["qa-public"], [], None)

    @patch("app.services.robot_service._knowledge_base")
    def test_rejects_wrong_tone_kind(self, get_base: Mock) -> None:
        get_base.return_value = {"kind": "product", "enabled": True}

        with self.assertRaises(HTTPException) as raised:
            _validate_knowledge_bases(self.user, [], [], "tone-1")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("must be of kind tone", str(raised.exception.detail))

    @patch("app.services.robot_service._knowledge_base")
    def test_rejects_disabled_knowledge_base(self, get_base: Mock) -> None:
        get_base.return_value = {"kind": "tone", "enabled": False}

        with self.assertRaises(HTTPException) as raised:
            _validate_knowledge_bases(self.user, [], [], "tone-1")

        self.assertEqual(raised.exception.status_code, 400)
        self.assertIn("disabled", str(raised.exception.detail))


if __name__ == "__main__":
    unittest.main()
