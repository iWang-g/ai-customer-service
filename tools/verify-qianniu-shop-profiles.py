"""Read-only verification of persisted shop names and production projections."""
import json
from pathlib import Path
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'services/business-api'))

from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session
from app.models import PlatformAccount, Conversation
from app.services.message_service import _conversation_read
from app.services.qianniu_shop_profile import conversation_shop_name


def main():
    database = ROOT / 'services/business-api/data/business-api.db'
    engine = create_engine('sqlite:///file:' + database.as_posix() + '?mode=ro&uri=true')
    report = {'checked_at': datetime.now(timezone.utc).isoformat(), 'database_mode': 'read_only', 'accounts': []}
    with Session(engine) as db:
        for account in db.scalars(select(PlatformAccount).where(PlatformAccount.platform_code == 'qianniu')):
            meta = account.metadata_json or {}
            rows = list(db.scalars(select(Conversation).where(
                Conversation.platform_account_id == account.id, Conversation.deleted_at.is_(None))))
            projections = [_conversation_read(row) for row in rows]
            ai_names = sorted({conversation_shop_name(row) for row in rows})
            report['accounts'].append({
                'platform_account_id': account.id, 'local_account_id': account.local_account_id,
                'service_account_name': account.account_name, 'login_status': account.login_status,
                'shop_name': meta.get('shop_name'), 'account_alias': account.account_alias,
                'shop_id': meta.get('shop_id'), 'main_account_uid': meta.get('main_account_uid'),
                'source': meta.get('shop_name_source'), 'observed_at': meta.get('shop_profile_observed_at'),
                'conversation_count': len(rows), 'api_shop_names': sorted({r.shop_name for r in projections}),
                'api_service_names': sorted({r.shop_service_username or '' for r in projections}),
                'ai_shop_names': ai_names,
            })
    engine.dispose()
    output = ROOT / 'qianniu-test/shop-profiles-live-20260915.json'
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
