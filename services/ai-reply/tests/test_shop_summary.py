import json
import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from fastapi.testclient import TestClient
from app.main import app
from app.schemas import ShopSummaryRequest
from app.shop_summary import generate_shop_summary


def answer(intro='主营家居用品。', products='抱枕、枕套及挂画。'):
    return json.dumps({'shop_intro': intro, 'on_sale_products': products}, ensure_ascii=False), 'mock'


class ShopSummaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_small_catalog_deduplicates_and_omits_price_and_ids(self):
        request = ShopSummaryRequest(products=[{'title': ' 抱枕 ', 'goods_id': 'secret-id', 'price_label': '100'}, {'title': '抱枕'}])
        with patch('app.shop_summary.generate_with_provider', AsyncMock(return_value=answer())) as model:
            result = await generate_shop_summary(request)
        self.assertEqual(model.await_count, 1)
        data = json.loads(model.call_args.kwargs['user'])
        self.assertEqual(data['product_titles'], ['抱枕'])
        self.assertNotIn('secret-id', model.call_args.kwargs['user'])
        self.assertLessEqual(len(result.shop_intro), 60)
        self.assertLessEqual(len(result.on_sale_products), 160)

    async def test_large_catalog_covers_last_product_and_merges_batches(self):
        titles = [f'商品{i:04d}' + '主题抱枕' * 10 for i in range(501)]
        with patch('app.shop_summary.generate_with_provider', AsyncMock(return_value=answer())) as model:
            await generate_shop_summary(ShopSummaryRequest(products=[{'title': t} for t in titles]))
        covered = []
        for call in model.call_args_list:
            text = call.kwargs['user']
            if text.startswith('{'):
                covered.extend(json.loads(text)['product_titles'])
        self.assertEqual(covered, titles)
        self.assertIn('合并以下分组概览', model.call_args.kwargs['user'])

    async def test_oversize_is_regenerated_once_never_truncated(self):
        with patch('app.shop_summary.generate_with_provider', AsyncMock(side_effect=[answer('长' * 61), answer()])) as model:
            result = await generate_shop_summary(ShopSummaryRequest(products=[{'title': '抱枕'}]))
        self.assertEqual(result.shop_intro, '主营家居用品。')
        self.assertEqual(model.await_count, 2)
        self.assertEqual(model.call_args.kwargs['stage'], 'shop_summary_compress')

    async def test_bad_or_unavailable_model_does_not_join_titles(self):
        for response in [answer(products='长' * 161), ('[]', 'mock'), ('{"shop_intro":42}', 'mock'), ('', 'local')]:
            with self.subTest(response=response), patch('app.shop_summary.generate_with_provider', AsyncMock(return_value=response)) as model:
                with self.assertRaises(HTTPException):
                    await generate_shop_summary(ShopSummaryRequest(products=[{'title': '不能作为兜底清单'}]))
                self.assertLessEqual(model.await_count, 2)

    async def test_empty_catalog_does_not_call_model(self):
        with patch('app.shop_summary.generate_with_provider', AsyncMock()) as model:
            with self.assertRaises(HTTPException):
                await generate_shop_summary(ShopSummaryRequest(products=[]))
            model.assert_not_awaited()

    def test_route_returns_validated_short_summary(self):
        with patch('app.shop_summary.generate_with_provider', AsyncMock(return_value=answer())):
            result = TestClient(app).post('/api/v1/shop-summaries/generate', json={'products': [{'title': '抱枕'}]})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['on_sale_products'], '抱枕、枕套及挂画。')
