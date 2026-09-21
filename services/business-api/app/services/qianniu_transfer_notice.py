"""Platform transfer notices may trigger a reply without becoming buyer speech."""
from datetime import datetime, timezone


def notice_time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
        return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None


def is_transfer_reply_source(message):
    raw = message.raw_payload or {}
    return (message.platform_code == 'qianniu' and message.sender_role == 'platform'
            and raw.get('message_type') == 'system' and raw.get('template_id') == 101
            and raw.get('qianniu_transfer_notice_accepted') is True
            and raw.get('automation_mode') == 'trigger')


def transfer_prompt(message):
    return ('[千牛平台转接通知，并非买家发言] ' + message.content
            + '\n该会话现由当前客服接待。请结合已有买家聊天记录继续服务；'
              '如果没有待解答的问题，可以简短告知已接手。不要把通知当作买家的问题。')
