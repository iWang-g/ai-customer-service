from __future__ import annotations

import re
import unicodedata

QIANNIU_BLOCK_WORDS = ('微信', 'v', 'qq', '手机号', '电话', '加我', '私聊', '私下',
                       '支付宝', '二维码', '别的平台', '网盘', '非淘宝链接')


def qianniu_outbound_reason(text: str) -> str | None:
    text = unicodedata.normalize('NFKC', text).casefold()
    text = ''.join(c for c in text if unicodedata.category(c) != 'Cf')
    return next(('qianniu_block_word:' + word for word in QIANNIU_BLOCK_WORDS if word in text), None)


PROHIBITED_OUTBOUND_PATTERNS = (
    ("external_link", re.compile(r"(?i)(?:https?://|ftp://|www\.)\S+")),
    ("external_link", re.compile(
        r"(?i)(?<![@\w])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
        r"(?:com|cn|net|org|top|shop|vip|link|xyz|cc|me|io|co)(?:[/?:#]\S*)?"
    )),
    ("email_address", re.compile(r"(?i)\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+\b")),
    ("phone_number", re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)")),
    ("phone_number", re.compile(
        r"(?:联系电话|联系号码|手机号|手机|电话)\s*[:：]?\s*(?:0\d{2,3}[- ]?)?\d{7,8}"
    )),
    ("wechat_id", re.compile(
        r"(?i)(?:微信|微\s*信|v信|vx|wechat)(?:号)?\s*[:：]?\s*[a-z][-_a-z0-9]{5,19}"
    )),
    ("qq_id", re.compile(r"(?i)(?:qq|扣扣)(?:号)?\s*[:：]?\s*[1-9]\d{4,11}")),
)


def prohibited_outbound_reason(text: str) -> str | None:
    return next((name for name, pattern in PROHIBITED_OUTBOUND_PATTERNS if pattern.search(text)), None)
