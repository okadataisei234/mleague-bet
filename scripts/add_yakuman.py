#!/usr/bin/env python3
"""環境変数 PLAYER / YAKUMAN / DATE / NOTE から docs/data/yakuman.json に1件追記する。
選手名は stats.json にある表記と一致している必要がある（スペース有無や姓のみは自動で補完を試みる）。"""
import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
JST = timezone(timedelta(hours=9))


def resolve_player(raw: str, names: list[str]) -> str:
    q = raw.strip()
    if q in names:
        return q
    compact = q.replace(" ", "").replace("　", "")
    hits = [n for n in names if n.replace(" ", "") == compact]
    if not hits:
        hits = [n for n in names if n.replace(" ", "").startswith(compact) or compact in n.replace(" ", "")]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        sys.exit(f"選手が見つかりません: {raw!r}。候補: {', '.join(names)}")
    sys.exit(f"候補が複数あります: {raw!r} -> {', '.join(hits)}")


def main() -> None:
    stats = json.loads((DATA / "stats.json").read_text(encoding="utf-8"))
    names = [p["name"] for p in stats["players"]]
    player = resolve_player(os.environ["PLAYER"], names)
    yakuman = os.environ["YAKUMAN"].strip()
    date = (os.environ.get("DATE") or "").strip() or datetime.now(JST).strftime("%Y-%m-%d")
    datetime.strptime(date, "%Y-%m-%d")  # 形式チェック
    note = (os.environ.get("NOTE") or "").strip()

    path = DATA / "yakuman.json"
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"entries": []}
    entry = {"date": date, "player": player, "yakuman": yakuman}
    if note:
        entry["note"] = note
    data["entries"].append(entry)
    data["entries"].sort(key=lambda e: e["date"])
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"追加: {entry}")


if __name__ == "__main__":
    main()
