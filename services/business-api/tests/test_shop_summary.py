import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, User, PlatformAccount, StoreProduct
from app.schemas.platform_account import ShopSummaryUpdate
from app.services.platform_account_service import _summary_products, generate_shop_summary, update_shop_summary


class ShopSummaryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='summary', password_hash='unused', display_name='Summary')
        self.db.add(self.user); self.db.flush()
        self.time = datetime.now(timezone.utc)
        self.original = {'shop_intro': '人工简介', 'on_sale_products': '原有资料', 'edited_at': 'manual'}
        self.account = PlatformAccount(user_id=self.user.id, platform_code='qianniu', platform_name='千牛', account_name='Seller:Operator',
                                       metadata_json={'shop_summary': self.original, 'store_products': {
                                           'collection_status': 'success', 'product_ids': ['1']}})
        self.db.add(self.account); self.db.flush()
        self.add_product('1', '抱枕')
        self.db.commit()
        self.settings = SimpleNamespace(ai_provider_api_key='fake', ai_provider='mock', ai_provider_base_url='http://mock',
                                        ai_reply_base_url='http://ai')

    def tearDown(self):
        self.db.close(); self.engine.dispose()

    def add_product(self, pid, title, observed=None):
        self.db.add(StoreProduct(user_id=self.user.id, platform_account_id=self.account.id, goods_id=pid,
                                 platform_product_id=pid, title=title, first_observed_at=self.time,
                                 last_observed_at=observed or self.time))

    async def generate(self, value, side_effect=None):
        response = httpx.Response(200, json=value, request=httpx.Request('POST', 'http://ai'))
        client = AsyncMock()
        client.__aenter__.return_value = client
        client.post.return_value = response
        client.post.side_effect = side_effect
        with patch('app.services.platform_account_service.get_settings', return_value=self.settings), \
                patch('app.services.platform_account_service.httpx.AsyncClient', return_value=client):
            return await generate_shop_summary(self.db, self.user, self.account.id)

    def test_snapshot_ids_exclude_old_products_and_preserve_all_501_current_rows(self):
        self.add_product('old', '已下架商品', self.time - timedelta(days=1))
        for i in range(2, 502):
            self.add_product(str(i), f'当前商品{i}')
        self.account.metadata_json = {'store_products': {'product_ids': [str(i) for i in range(1, 502)]}}
        self.db.commit()
        titles = [r['title'] for r in _summary_products(self.db, self.account)]
        self.assertEqual(len(titles), 501)
        self.assertNotIn('已下架商品', titles)
        self.assertIn('当前商品501', titles)

    def test_timestamp_scope_and_empty_snapshot_apply_to_every_platform(self):
        self.add_product('old', '旧商品', self.time - timedelta(days=1)); self.db.commit()
        for platform in ['pinduoduo', 'qianniu', 'douyin']:
            self.account.platform_code = platform
            self.account.metadata_json = {'store_products': {'collection_status': 'success', 'observed_at': self.time.isoformat()}}
            self.assertEqual(_summary_products(self.db, self.account), [{'title': '抱枕'}])
            self.account.metadata_json = {'store_products': {'collection_status': 'empty'}}
            self.assertEqual(_summary_products(self.db, self.account), [])

    async def test_valid_result_saved_with_same_limits_across_platforms(self):
        for platform in ['pinduoduo', 'qianniu', 'douyin']:
            self.account.platform_code = platform; self.db.commit()
            result = await self.generate({'shop_intro': '主营家居用品。', 'on_sale_products': '抱枕、枕套。'})
            self.assertEqual(result.metadata_json['shop_summary']['shop_intro'], '主营家居用品。')
            self.assertIsNone(result.metadata_json['shop_summary']['edited_at'])

    async def test_failure_empty_and_invalid_outputs_preserve_existing_summary(self):
        for value in [{}, [], {'shop_intro': '长' * 61, 'on_sale_products': '正常'},
                      {'shop_intro': '正常', 'on_sale_products': '长' * 161}, {'shop_intro': 42, 'on_sale_products': '正常'}]:
            with self.assertRaises(HTTPException):
                await self.generate(value)
            self.db.refresh(self.account)
            self.assertEqual(self.account.metadata_json['shop_summary'], self.original)
        with self.assertRaises(HTTPException):
            await self.generate({}, side_effect=httpx.ReadTimeout('offline'))
        self.assertEqual(self.account.metadata_json['shop_summary'], self.original)

    async def test_missing_data_or_model_does_not_save_fake_fallback(self):
        self.settings.ai_provider_api_key = ''
        with self.assertRaises(HTTPException):
            await self.generate({})
        self.account.metadata_json = {'shop_summary': self.original, 'store_products': {'collection_status': 'empty'}}
        self.db.commit()
        with self.assertRaises(HTTPException):
            await self.generate({})
        self.assertEqual(self.account.metadata_json['shop_summary'], self.original)

    async def test_manual_edit_during_generation_is_not_overwritten(self):
        async def edit(*args, **kwargs):
            update_shop_summary(self.db, self.user, self.account.id, ShopSummaryUpdate(shop_intro='刚修改的简介', on_sale_products='人工内容'))
            return httpx.Response(200, json={'shop_intro': '生成简介', 'on_sale_products': '生成内容'}, request=httpx.Request('POST', 'http://ai'))
        with self.assertRaises(HTTPException) as raised:
            await self.generate({}, side_effect=edit)
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(self.account.metadata_json['shop_summary']['shop_intro'], '刚修改的简介')
