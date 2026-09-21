import unittest
from types import SimpleNamespace

from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models import Base, User, PlatformAccount, Conversation
from app.schemas.platform_account import PlatformAccountCreate
from app.services.platform_account_service import create_or_sync_platform_account
from app.services.message_service import _conversation_read
from app.services.qianniu_shop_profile import conversation_shop_name, shop_name


class ShopProfileTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite:///:memory:')
        Base.metadata.create_all(self.engine)
        self.db = Session(self.engine)
        self.user = User(username='shop-profile', password_hash='unused', display_name='Test')
        self.db.add(self.user)
        self.db.commit()
        self.identity = {'shop_uid': '123', 'main_account_uid': '789', 'service_account_name': 'Seller:Operator'}
        self.profile = {**self.identity, 'shop_id': '456', 'shop_name': 'Storefront',
                        'shop_profile_main_uid': '789', 'shop_profile_account_uid': '123',
                        'shop_name_source': 'qianniu_shop_info'}

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def sync(self, metadata):
        return create_or_sync_platform_account(self.db, self.user, PlatformAccountCreate(
            platform_code='qianniu', local_account_id='qianniu-123', external_account_id='qianniu:123',
            account_name='Seller:Operator', account_alias='待识别店铺', metadata_json=metadata))

    def test_sync_preserves_profile_until_identity_changes_without_rebinding(self):
        account = self.sync(self.profile)
        aid = account.id
        self.assertEqual(account.account_alias, 'Storefront')
        account = self.sync(self.identity)
        self.assertEqual(account.id, aid)
        self.assertEqual(shop_name(account), 'Storefront')
        self.assertEqual(account.account_name, 'Seller:Operator')
        account = self.sync({**self.identity, 'main_account_uid': '999'})
        self.assertEqual(account.id, aid)
        self.assertEqual(account.account_alias, '待识别店铺')
        self.assertNotIn('shop_name', account.metadata_json)

    def test_ui_and_ai_use_the_same_live_profile_instead_of_stale_conversation_name(self):
        account = self.sync(self.profile)
        conversation = Conversation(user_id=self.user.id, platform_code='qianniu', platform_account_id=account.id,
                                    metadata_json={'shop_name': 'Seller:Operator'})
        self.db.add(conversation)
        self.db.commit()
        result = _conversation_read(conversation)
        self.assertEqual(result.shop_name, 'Storefront')
        self.assertEqual(result.shop_service_username, 'Seller:Operator')
        self.assertEqual(conversation_shop_name(conversation), 'Storefront')
        self.assertEqual(self.db.query(PlatformAccount).count(), 1)

    def test_unknown_shop_does_not_invent_title_and_other_platforms_keep_existing_behavior(self):
        account = self.sync(self.identity)
        self.assertEqual(shop_name(account), '')
        pdd = SimpleNamespace(platform_code='pinduoduo', account_alias='Pdd Shop', account_name='Operator')
        self.assertEqual(shop_name(pdd), 'Pdd Shop')
        conversation = SimpleNamespace(platform_code='pinduoduo', metadata_json={'shop_name': 'Original'})
        self.assertEqual(conversation_shop_name(conversation), 'Original')


if __name__ == '__main__':
    unittest.main()
