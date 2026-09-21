from __future__ import annotations

import re


def profile_name(metadata: dict, local_account_id: str | None) -> str:
    uid = (local_account_id or '').removeprefix('qianniu-')
    main_uid = str(metadata.get('main_account_uid') or '')
    name = metadata.get('shop_name')
    if (metadata.get('shop_name_source') == 'qianniu_shop_info'
            and re.fullmatch(r'\d{1,30}', uid) and re.fullmatch(r'\d{1,30}', main_uid)
            and metadata.get('shop_profile_account_uid') == uid
            and metadata.get('shop_profile_main_uid') == main_uid
            and re.fullmatch(r'\d{1,30}', str(metadata.get('shop_id') or ''))
            and isinstance(name, str) and 0 < len(name.strip()) <= 128):
        return name.strip()
    return ''


def shop_name(account) -> str:
    if account is None:
        return ''
    if account.platform_code == 'qianniu':
        return profile_name(account.metadata_json or {}, account.local_account_id)
    return account.account_alias or account.account_name or ''


def conversation_shop_name(conversation) -> str:
    if conversation.platform_code == 'qianniu':
        return shop_name(conversation.platform_account)
    return str((conversation.metadata_json or {}).get('shop_name') or '')


def merge_profile_metadata(incoming: dict, existing: dict | None, local_account_id: str) -> dict:
    metadata = {**(existing or {}), **incoming}
    if not profile_name(metadata, local_account_id):
        for key in ('shop_id', 'shop_name', 'shop_name_source', 'shop_profile_observed_at',
                    'shop_profile_main_uid', 'shop_profile_account_uid'):
            metadata.pop(key, None)
    return metadata
