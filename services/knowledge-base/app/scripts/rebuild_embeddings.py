from __future__ import annotations

import argparse
import json

from app.db import init_db
from app.service import rebuild_document_embeddings


def main() -> None:
    parser = argparse.ArgumentParser(description="Rebuild product document chunk embeddings.")
    parser.add_argument("--base-id", default="", help="Only rebuild documents in one knowledge base.")
    parser.add_argument("--document-id", default="", help="Only rebuild one document.")
    args = parser.parse_args()

    init_db()
    result = rebuild_document_embeddings(base_id=args.base_id, document_id=args.document_id)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
