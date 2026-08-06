from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.security import utcnow
from app.models import Conversation, Message, User
from app.services.message_queue_service import append_messages


def seed_demo_conversations(db: Session, user: User) -> None:
    existing_count = db.scalar(
        select(func.count()).select_from(Conversation).where(Conversation.user_id == user.id)
    )
    if existing_count:
        return

    now = utcnow()
    samples = [
        {
            "platform_code": "qianniu",
            "external_id": f"demo-qianniu-{user.id}",
            "customer_name": "张女士",
            "shop_name": "旗舰店 A",
            "status": "pending",
            "unread_count": 1,
            "messages": [
                ("customer", "张女士", "你好，这款商品今天下单什么时候能发货？", now - timedelta(minutes=8)),
                ("agent", user.display_name, "您好，今天 17 点前下单可以当天发出。", now - timedelta(minutes=6)),
                ("customer", "张女士", "好的，那我现在下单。", now - timedelta(minutes=4)),
            ],
        },
        {
            "platform_code": "douyin",
            "external_id": f"demo-douyin-{user.id}",
            "customer_name": "小林",
            "shop_name": "直播店 B",
            "status": "active",
            "unread_count": 0,
            "messages": [
                ("customer", "小林", "直播间的优惠券在哪里领取？", now - timedelta(minutes=24)),
                ("agent", user.display_name, "点击直播间左上角的优惠券图标即可领取。", now - timedelta(minutes=22)),
            ],
        },
    ]

    for sample in samples:
        latest_role, latest_sender, latest_content, latest_at = sample["messages"][-1]
        conversation = Conversation(
            user_id=user.id,
            platform_code=sample["platform_code"],
            external_conversation_id=sample["external_id"],
            customer_name=sample["customer_name"],
            title=sample["customer_name"],
            latest_message_text=latest_content,
            latest_message_at=latest_at,
            unread_count=sample["unread_count"],
            status=sample["status"],
            awaiting_reply=latest_role == "customer",
            metadata_json={"shop_name": sample["shop_name"], "demo": True},
        )
        db.add(conversation)
        db.flush()
        messages = []
        for sender_role, sender_name, content, sent_at in sample["messages"]:
            messages.append(
                Message(
                    conversation_id=conversation.id,
                    user_id=user.id,
                    platform_code=sample["platform_code"],
                    sender_role=sender_role,
                    sender_name=sender_name,
                    content=content,
                    message_status="sent",
                    source="demo",
                    collected_at=sent_at,
                    sent_at=sent_at,
                )
            )
        append_messages(db, messages)
    db.commit()
