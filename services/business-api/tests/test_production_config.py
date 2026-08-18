from __future__ import annotations

import unittest

from pydantic import ValidationError

from app.core.config import Settings
from app.main import create_app


class ProductionConfigTests(unittest.TestCase):
    def test_public_registration_route_is_not_exposed(self) -> None:
        routes = [
            route for route in create_app().routes
            if getattr(route, "path", None) == "/api/v1/auth/register"
        ]
        self.assertEqual(routes, [])

    def test_production_rejects_development_defaults(self) -> None:
        with self.assertRaises(ValidationError):
            Settings(ENVIRONMENT="production")

    def test_production_accepts_explicit_secure_values(self) -> None:
        settings = Settings(
            ENVIRONMENT="production",
            JWT_SECRET_KEY="a-secure-production-secret-key-value-12345",
            DEFAULT_ADMIN_PASSWORD="a-secure-admin-password",
            SEED_DEMO_DATA=False,
        )
        self.assertEqual(settings.environment, "production")


if __name__ == "__main__":
    unittest.main()
