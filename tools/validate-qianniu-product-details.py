"""Local integration check: fixed shop/products, read-only collection and unsent AI preview."""
import argparse
import asyncio
import json
import sys
from datetime import timedelta
from pathlib import Path

import httpx
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/business-api'))
from app.core.config import get_settings
from app.core.security import create_token
from app.models import Conversation, PlatformAccount, User, AiProviderConfig, utcnow
from app.services.automation_service import _active_robot, _decide_reply
from app.services.qianniu_product_detail_service import prompt_details
from app.services.robot_service import serialize_robot

ACCOUNT = '7a584ee839a84441a1367b373e1c22f6'
CID = '2214525969878.1-2216058631944.1#11001@cntaobao'
PRODUCTS = ['730328029364', '835010203895', '730114688994']


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('phase', choices=['collect', 'preview'])
    args = parser.parse_args()
    engine = create_engine('sqlite:///' + (ROOT / 'services/business-api/data/business-api.db').as_posix())
    settings = get_settings()
    with Session(engine) as db:
        account = db.get(PlatformAccount, ACCOUNT)
        if not account or account.platform_code != 'qianniu' or account.local_account_id != 'qianniu-2222303856223':
            raise RuntimeError('Fixed test account mismatch')
        conversation = db.scalar(select(Conversation).where(Conversation.platform_account_id == ACCOUNT,
            Conversation.external_conversation_id == CID))
        if not conversation:
            raise RuntimeError('Test conversation missing')
        user = db.get(User, account.user_id)
        records = []
        if args.phase == 'collect':
            token = create_token(settings.jwt_secret_key, subject=user.id, token_type='access', expires_delta=timedelta(minutes=5))
            async with httpx.AsyncClient(base_url='http://127.0.0.1:8001/api/v1', timeout=10,
                trust_env=False, headers={'Authorization': 'Bearer ' + token}) as client:
                for pid in PRODUCTS:
                    started = utcnow()
                    route = f'/conversations/{conversation.id}/products/{pid}/detail'
                    response = await client.post(route + '/refresh')
                    response.raise_for_status()
                    task = response.json()
                    saved = None
                    for _ in range(40):
                        await asyncio.sleep(.5)
                        response = await client.get(route); response.raise_for_status()
                        snapshot = response.json()['snapshot']
                        if snapshot and snapshot['observed_at'] >= started.isoformat():
                            saved = snapshot; break
                    if saved is None:
                        raise RuntimeError('No fresh persisted detail for ' + pid + '; task ' + task['task_id'])
                    records.append({'product_id': pid, 'task_id': task['task_id'], 'snapshot': saved})
                    print(json.dumps({'product_id': pid, 'skus': len(saved['detail']['skus']),
                        'services': len(saved['detail']['services']), 'observed_at': saved['observed_at']}), flush=True)
                others = list(db.scalars(select(Conversation).where(Conversation.platform_account_id == ACCOUNT,
                    Conversation.id != conversation.id).limit(1)))
                if others:
                    response = await client.get(f'/conversations/{others[0].id}/products/{PRODUCTS[0]}/detail')
                    response.raise_for_status()
                    if response.json()['snapshot'] != records[0]['snapshot']:
                        raise RuntimeError('Cross-conversation snapshot mismatch')
                    print('Same-shop cross-conversation persisted detail verified', flush=True)
        else:
            robot = _active_robot(db, user, conversation)
            if robot is None:
                raise RuntimeError('No active robot for test account')
            config = db.scalar(select(AiProviderConfig).where(AiProviderConfig.user_id == user.id))
            for only_card, message in [(True, '[商品] 新分腿枕芯枕套套装or单枕套'), (False, '分腿单枕套包含枕芯吗？')]:
                details = prompt_details(db, conversation, ['835010203895'], message)
                if not details:
                    raise RuntimeError('No usable persisted test product detail')
                result = await _decide_reply(settings=settings, user=user, message=message,
                    history=[{'role': 'user', 'content': message}], platform='qianniu', shop_name=account.account_name,
                    customer_name='Test buyer', robot=robot, robot_read=serialize_robot(db, robot), ai_config=config,
                    auto_send_allowed=False, product_details=details, product_card_only=only_card,
                    platform_context=[{'type': 'product', 'sender_role': 'customer', 'data': {'product_id': '835010203895', 'title': details[0]['title']}}])
                records.append({'product_id': '835010203895', 'message': message, 'product_card_only': only_card,
                    'preview_only': True, 'text': result.get('text'), 'decision': result.get('decision'),
                    'provider': result.get('provider'), 'model_calls': result.get('model_calls'),
                    'retrieval_status': result.get('retrieval_status'), 'detail_observed_at': details[0]['observed_at']})
                print(json.dumps(records[-1], ensure_ascii=False), flush=True)
        output = ROOT / 'qianniu-test' / ('product-details-' + args.phase + '-' + utcnow().strftime('%Y%m%d-%H%M%S') + '.json')
        with output.open('x', encoding='utf-8') as stream:
            json.dump(records, stream, ensure_ascii=False, indent=2)
        print('Saved ' + str(output))


if __name__ == '__main__':
    asyncio.run(main())
