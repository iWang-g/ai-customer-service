from __future__ import annotations

import unittest

from app.api.routes.collector_rules import DEFAULT_PDD_RULES, pinduoduo_collector_rules
from app.core.config import get_settings


class CollectorRulesTests(unittest.TestCase):
    def test_default_collector_rules_are_versioned_and_non_executable(self) -> None:
        get_settings.cache_clear()
        rules = pinduoduo_collector_rules(_user=object())
        self.assertEqual(rules["platform"], "pinduoduo")
        self.assertTrue(rules["version"])
        self.assertIn("classification", rules)
        self.assertIn("ignored_text_patterns", rules["classification"])
        self.assertNotIn("script", str(DEFAULT_PDD_RULES).lower())
