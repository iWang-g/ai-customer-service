from __future__ import annotations

import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from fastapi import HTTPException

from app.api.routes.robots import delete_unused_knowledge_base


class RobotRouteTests(unittest.TestCase):
    def test_delete_bound_knowledge_base_is_blocked_before_remote_delete(self) -> None:
        db = Mock()
        relation_query = Mock()
        relation_query.filter.return_value.all.return_value = [("robot-1",)]
        robot_query = Mock()
        robot_query.filter.return_value.order_by.return_value.all.return_value = [
            SimpleNamespace(id="robot-1", name="售前机器人")
        ]
        db.query.side_effect = [relation_query, relation_query, relation_query, robot_query]
        user = SimpleNamespace(id="user-1")

        with self.assertRaises(HTTPException) as raised:
            delete_unused_knowledge_base("tone-1", user, db)

        self.assertEqual(raised.exception.status_code, 409)
        self.assertIn("售前机器人", str(raised.exception.detail))


if __name__ == "__main__":
    unittest.main()
