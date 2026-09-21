from datetime import datetime
from typing import Literal

from pydantic import BaseModel


class MessageNoticeItem(BaseModel):
    conversation_id: str
    platform_code: str
    customer_name: str
    shop_name: str
    message_id: str
    message_text: str
    latest_message_sender: Literal['customer', 'ai', 'manual']
    customer_message_at: datetime
    reply_kind: Literal['ai', 'manual'] | None = None
    replied_at: datetime | None = None


class MessageNoticeSnapshot(BaseModel):
    since: datetime
    server_time: datetime
    items: list[MessageNoticeItem]
