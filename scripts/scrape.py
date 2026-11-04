#!/usr/bin/env python3
"""m-league.jp の API から個人成績を取得して docs/data/ に JSON を書き出す。

- docs/data/stats.json   : 全選手の最新成績（毎回上書き）
- docs/data/history.json : 対局日ごとの各選手の累計ポイント・試合数（推移グラフ用。試合結果から毎回作り直す）

2026-11 のサイト改修で /stats/ の HTML には 0 しか入らなくなり、数字は JS が
/api/mleague/data?kind=stats|games から取って描画するようになったので、その API を直接読む。

標準ライブラリのみ使用（依存なし）。
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://m-league.jp/api/mleague/data?kind="
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
JST = timezone(timedelta(hours=9))

# API の指標名 -> JSON のキー
ROW_KEYS = {
    "試合数": "games",
    "総局数": "hands",
    "ポイント": "points",
    "平着": "avg_rank",
    "1位": "rank1",
    "2位": "rank2",
    "3位": "rank3",
    "4位": "rank4",
    "トップ率": "top_rate",
    "連対率": "rentai_rate",
    "ラス回避率": "last_avoid_rate",
    "ベストスコア": "best_score",
    "平均打点": "avg_agari",
    "副露率": "furo_rate",
    "リーチ率": "riichi_rate",
    "アガリ率": "agari_rate",
    "放銃率": "houjuu_rate",
    "放銃平均打点": "avg_houjuu",
}


def to_number(v, digits: int):
    """サイトの表示と同じ桁に丸める（ポイントは小数1桁、その他は2桁）。"""
    if v is None or v == "":
        return 0
    v = round(float(v), digits)
    return int(v) if v.is_integer() else v


def parse_stats(data: dict) -> dict:
    s = data["data"] if data.get("mode") == "manual" else data["stats"]
    players = []
    for team in s["teams"]:
        stats = [dict() for _ in team["players"]]
        for m in team["metrics"]:
            key = ROW_KEYS.get(m["name"])
            if not key:
                continue
            for st, v in zip(stats, m["values"]):
                st[key] = to_number(v, 1 if key == "points" else 2)
        for name, st in zip(team["players"], stats):
            players.append({"name": name, "team": team["team"], **st})
    found = re.search(r"20\d\d-\d\d", (data.get("season") or {}).get("name", ""))
    return {
        "season": found.group(0) if found else "",
        "source": API + "stats",
        "fetched_at": datetime.now(JST).isoformat(timespec="seconds"),
        "players": players,
    }


def build_history(games: list[dict], names: list[str]) -> dict:
    """終了した試合を対局日（JST）ごとにまとめ、その日までの累計を並べる。"""
    by_day: dict[str, list[dict]] = defaultdict(list)
    for g in games:
        if not g.get("complete"):
            continue
        day = datetime.fromisoformat(g["date"].replace("Z", "+00:00")).astimezone(JST).strftime("%Y-%m-%d")
        by_day[day].extend(g["players"])
    points = {n: 0.0 for n in names}
    counts = {n: 0 for n in names}
    days = []
    for day in sorted(by_day):
        for p in by_day[day]:
            points[p["name"]] = points.get(p["name"], 0.0) + p["point"]
            counts[p["name"]] = counts.get(p["name"], 0) + 1
        days.append({
            "date": day,
            "points": {n: to_number(v, 1) for n, v in points.items()},
            "games": dict(counts),
        })
    return {"days": days}


def fetch_json(kind: str) -> dict:
    req = urllib.request.Request(API + kind, headers={"User-Agent": "Mozilla/5.0 (mleague-bet-tracker)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main(argv: list[str]) -> int:
    # テスト用: scrape.py stats.json games.json で保存済みの API 応答を読む
    if len(argv) > 2:
        raw_stats, raw_games = (json.loads(Path(a).read_text(encoding="utf-8")) for a in argv[1:3])
    else:
        raw_stats, raw_games = fetch_json("stats"), fetch_json("games")
    stats = parse_stats(raw_stats)
    if len(stats["players"]) < 30:
        print(f"取得した選手数が少なすぎます: {len(stats['players'])}", file=sys.stderr)
        return 1
    # 取得がおかしくて成績が減って見えるときは上書きしない（全員 0 で上書きされた 2026-11-02 の再発防止）
    stats_path = DATA_DIR / "stats.json"
    if stats_path.exists():
        old = json.loads(stats_path.read_text(encoding="utf-8"))
        old_games = sum(p.get("games", 0) for p in old["players"])
        new_games = sum(p.get("games", 0) for p in stats["players"])
        if old.get("season") == stats["season"] and new_games < old_games:
            print(f"総試合数が前回より減っています: {old_games} -> {new_games}", file=sys.stderr)
            return 1
    history = build_history(raw_games["games"], [p["name"] for p in stats["players"]])
    last = history["days"][-1] if history["days"] else None
    for p in stats["players"]:
        if last and (last["games"].get(p["name"], 0) != p["games"] or abs(last["points"].get(p["name"], 0) - p["points"]) > 0.05):
            print(f"成績表と試合結果が合いません: {p['name']}", file=sys.stderr)
            return 1
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    stats_path.write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    (DATA_DIR / "history.json").write_text(json.dumps(history, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(stats['players'])} 選手 / season {stats['season']} / {len(history['days'])} 日分を保存しました")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
