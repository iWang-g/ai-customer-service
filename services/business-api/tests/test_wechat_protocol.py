from app.schemas.platform_account import PlatformAccountCreate
from app.schemas.rpa import RpaEventCreate, SnapshotMessage
from app.schemas.platform import platform_display_name


def test_wechat_platform_contract_accepts_account_and_event() -> None:
    account = PlatformAccountCreate(
        platform_code="wechat",
        local_account_id="wx-local-1",
        account_name="微信账号 1",
    )
    event = RpaEventCreate(
        event_id="wechat-event-1",
        event_type="message_snapshot",
        platform_code="wechat",
        platform_account_id="account-1",
        conversation_external_id="conversation-1",
    )

    assert account.platform_code == "wechat"
    assert event.platform_code == "wechat"
    assert platform_display_name("wechat") == "个人微信"


def test_wechat_snapshot_supports_multimedia_types() -> None:
    message = SnapshotMessage(
        dom_sequence=0,
        sender_role="customer",
        message_type="video",
        content="",
        media_resource_id="media-1",
    )

    assert message.message_type == "video"
    assert message.media_resource_id == "media-1"
