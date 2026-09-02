import json
import sqlite3
import sys
from pathlib import Path


root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(r"D:\AliWorkbenchData")
tokens = sys.argv[2:] or [
    "2214525969878.1-2216058631944.1#11001@cntaobao",
    "7500120314823573625",
    "4274152052610.PNM",
    "1788168028624",
    "测试",
    "消息1",
]


def quote_ident(name):
    return '"' + name.replace('"', '""') + '"'


def connect(path):
    return sqlite3.connect(str(path))


dbs = []
for pattern in ("*.db", "*.sqlite", "*.db_fts", "*.sqlite_fts"):
    dbs.extend(root.rglob(pattern))

for path in sorted(set(dbs), key=lambda p: str(p).lower()):
    print(f"\nDB\t{path}")
    try:
        con = connect(path)
        con.row_factory = sqlite3.Row
        tables = con.execute(
            "select name, sql from sqlite_master where type='table' order by name"
        ).fetchall()
        print(f"tables\t{len(tables)}")
        for table in tables:
            name = table["name"]
            cols = con.execute(f"pragma table_info({quote_ident(name)})").fetchall()
            col_summary = ", ".join(f"{c['name']}:{c['type']}" for c in cols)
            print(f"table\t{name}\t{col_summary}")

            count = None
            try:
                count = con.execute(f"select count(*) from {quote_ident(name)}").fetchone()[0]
            except Exception:
                pass
            if count is not None:
                print(f"rows\t{name}\t{count}")

            searchable = [
                c["name"]
                for c in cols
                if (c["type"] or "").upper() in ("TEXT", "VARCHAR", "CHAR", "CLOB", "")
            ]
            for token in tokens:
                for col in searchable:
                    try:
                        sql = (
                            f"select rowid, {quote_ident(col)} as value "
                            f"from {quote_ident(name)} "
                            f"where cast({quote_ident(col)} as text) like ? limit 3"
                        )
                        hits = con.execute(sql, (f"%{token}%",)).fetchall()
                    except Exception:
                        continue
                    for hit in hits:
                        value = str(hit["value"])
                        print(
                            "hit\t"
                            + json.dumps(
                                {
                                    "table": name,
                                    "column": col,
                                    "rowid": hit["rowid"],
                                    "token": token,
                                    "valuePreview": value[:300],
                                },
                                ensure_ascii=False,
                            )
                        )
        con.close()
    except Exception as exc:
        print(f"error\t{type(exc).__name__}\t{exc}")
