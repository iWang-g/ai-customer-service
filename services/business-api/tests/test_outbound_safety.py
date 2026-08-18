from __future__ import annotations

import unittest

from app.services.outbound_safety import prohibited_outbound_reason


class OutboundSafetyTests(unittest.TestCase):
    def test_detects_links_and_personal_contacts(self) -> None:
        cases = {
            "请访问 https://example.com/help": "external_link",
            "查看 www.example.cn": "external_link",
            "邮箱 service@example.com": "email_address",
            "手机号 13800138000": "phone_number",
            "微信号：service_123": "wechat_id",
            "QQ号：12345678": "qq_id",
        }
        for text, reason in cases.items():
            with self.subTest(text=text):
                self.assertEqual(prohibited_outbound_reason(text), reason)

    def test_allows_normal_product_and_order_text(self) -> None:
        for text in (
            "这款商品型号是 K87，支持三种连接方式。",
            "订单尾号 38000 已经发货。",
            "亲亲，我先为您核实一下。",
        ):
            with self.subTest(text=text):
                self.assertIsNone(prohibited_outbound_reason(text))


if __name__ == "__main__":
    unittest.main()
