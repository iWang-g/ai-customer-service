from __future__ import annotations

import unittest
from datetime import datetime, timezone

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

from app.models import Base, Conversation, PlatformAccount, StoreProduct, User
from app.services.product_service import apply_store_products_snapshot, match_store_products


class ProductServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.engine = create_engine("sqlite:///:memory:")
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username="product-test", display_name="Product Test", password_hash="unused")
        self.db.add(self.user)
        self.db.flush()
        self.account = PlatformAccount(
            user_id=self.user.id,
            platform_code="pinduoduo",
            platform_name="拼多多",
            local_account_id="local-product-test",
            account_name="测试店铺",
        )
        self.db.add(self.account)
        self.db.flush()

    def tearDown(self) -> None:
        self.db.close()
        self.engine.dispose()

    def test_store_snapshot_is_persisted_without_customer_conversation(self) -> None:
        observed_at = datetime.now(timezone.utc)
        saved = apply_store_products_snapshot(
            self.db,
            self.account,
            {
                "collection_status": "success",
                "observed_at": observed_at.isoformat(),
                "products": [
                    {
                        "goods_id": "1001",
                        "product_id": "1001",
                        "title": "明日方舟缪尔赛思抱枕",
                        "image_url": "https://example.test/image.jpg",
                        "link_url": "https://example.test/goods/1001",
                    },
                ],
                "page_summary": {"total_count": 1, "has_more": False},
            },
            observed_at,
        )
        self.db.commit()

        self.assertEqual(saved, 1)
        self.assertEqual(self.db.query(Conversation).count(), 0)
        product = self.db.scalar(select(StoreProduct))
        self.assertIsNotNone(product)
        self.assertEqual(product.goods_id, "1001")
        self.assertEqual(product.platform_account_id, self.account.id)
        self.assertEqual(
            match_store_products(self.db, Conversation(
                user_id=self.user.id,
                platform_account_id=self.account.id,
                platform_code="pinduoduo",
                external_conversation_id="customer-1",
                customer_name="客户",
            ), "有明日方舟的吗", limit=2)[0]["goods_id"],
            "1001",
        )

    def test_store_recommendation_is_limited_to_two_products(self) -> None:
        apply_store_products_snapshot(
            self.db,
            self.account,
            {
                "collection_status": "success",
                "products": [
                    {"goods_id": str(index), "product_id": str(index), "title": f"测试款式{index}"}
                    for index in range(1, 4)
                ],
                "page_summary": {"total_count": 3, "has_more": False},
            },
            datetime.now(timezone.utc),
        )
        conversation = Conversation(
            user_id=self.user.id,
            platform_account_id=self.account.id,
            platform_code="pinduoduo",
            external_conversation_id="customer-2",
            customer_name="客户",
        )
        self.db.add(conversation)
        self.db.commit()

        self.assertEqual(len(match_store_products(self.db, conversation, "给我推荐几个款式", limit=2)), 2)


if __name__ == "__main__":
    unittest.main()
