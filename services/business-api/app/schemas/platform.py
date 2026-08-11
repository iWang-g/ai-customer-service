from __future__ import annotations

from typing import Literal


PlatformCode = Literal["pinduoduo", "wechat"]

PLATFORM_DISPLAY_NAMES = {
    "pinduoduo": "拼多多",
    "wechat": "个人微信",
}


def platform_display_name(platform_code: str) -> str:
    return PLATFORM_DISPLAY_NAMES.get(platform_code, platform_code)
