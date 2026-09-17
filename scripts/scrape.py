#!/usr/bin/env python3
"""m-league.jp/stats/ から個人成績を取得して docs/data/ に JSON を書き出す。

- docs/data/stats.json   : 全選手の最新成績（毎回上書き）
- docs/data/history.json : 日付ごとの各選手ポイント（推移グラフ用。同じ日は上書き）

標準ライブラリのみ使用（依存なし）。
"""
from __future__ import annotations

import json
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

URL = "https://m-league.jp/stats/"
ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "docs" / "data"
JST = timezone(timedelta(hours=9))

# サイト上の行ラベル -> JSON のキー
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


class StatsParser(HTMLParser):
    """section.p-stats__team ごとに h2(チーム名) と table を拾う。"""

    def __init__(self) -> None:
        super().__init__()
        self.teams: list[dict] = []
        self._in_team_name = False
        self._in_table = False
        self._in_cell = False
        self._cell_tag = ""
        self._cell_text = ""
        self._row: list[tuple[str, str]] = []
        self._rows: list[list[tuple[str, str]]] = []
        self._season = ""
        self._in_season = False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get("class", "")
        if tag == "section" and "p-stats__team" in cls:
            self.teams.append({"id": a.get("id", ""), "name": "", "rows": []})
        elif tag == "h2" and "p-stats__teamName" in cls:
            self._in_team_name = True
        elif tag == "table" and "p-stats__table" in cls:
            self._in_table = True
            self._rows = []
        elif self._in_table and tag == "tr":
            self._row = []
        elif self._in_table and tag in ("th", "td"):
            self._in_cell = True
            self._cell_tag = tag
            self._cell_text = ""
        elif tag == "p" and "p-stats__season" in cls or (tag == "h1" and "p-stats" in cls):
            self._in_season = True

    def handle_endtag(self, tag):
        if tag == "h2" and self._in_team_name:
            self._in_team_name = False
            self.teams[-1]["name"] = re.sub(r"\s+", " ", self.teams[-1]["name"]).strip()
        elif tag in ("th", "td") and self._in_cell:
            self._in_cell = False
            self._row.append((self._cell_tag, re.sub(r"\s+", " ", self._cell_text).strip()))
        elif tag == "tr" and self._in_table:
            if self._row:
                self._rows.append(self._row)
        elif tag == "table" and self._in_table:
            self._in_table = False
            if self.teams:
                self.teams[-1]["rows"] = self._rows
        elif self._in_season and tag in ("p", "h1"):
            self._in_season = False

    def handle_data(self, data):
        if self._in_team_name and self.teams:
            self.teams[-1]["name"] += data
        if self._in_cell:
            self._cell_text += data
        if self._in_season:
            self._season += data


def to_number(text: str):
    t = text.replace(",", "").replace("%", "").strip()
    if t in ("", "-", "－"):
        return 0
    try:
        return int(t)
    except ValueError:
        try:
            return float(t)
        except ValueError:
            return text


def parse(html: str) -> dict:
    p = StatsParser()
    p.feed(html)
    players = []
    for team in p.teams:
        rows = team["rows"]
        if not rows:
            continue
        header = rows[0]
        names = [txt for tag, txt in header[1:]]  # 先頭は「選手名」
        stats = [dict() for _ in names]
        for row in rows[1:]:
            label = row[0][1]
            key = ROW_KEYS.get(label)
            if not key:
                continue
            for i, (_, txt) in enumerate(row[1:]):
                if i < len(stats):
                    stats[i][key] = to_number(txt)
        for name, st in zip(names, stats):
            players.append({"name": name, "team": team["name"], **st})
    season = ""
    for a, b in re.findall(r"(20\d\d)-(\d\d)", html):
        if int(b) == int(a[2:]) + 1:  # 2026-27 のような形だけ採用
            season = f"{a}-{b}"
            break
    return {
        "season": season,
        "source": URL,
        "fetched_at": datetime.now(JST).isoformat(timespec="seconds"),
        "players": players,
    }


def fetch_html() -> str:
    req = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0 (mleague-bet-tracker)"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read().decode("utf-8", errors="replace")


def update_history(stats: dict) -> None:
    path = DATA_DIR / "history.json"
    history = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"days": []}
    today = datetime.now(JST).strftime("%Y-%m-%d")
    snapshot = {
        "date": today,
        "points": {pl["name"]: pl.get("points", 0) for pl in stats["players"]},
        "games": {pl["name"]: pl.get("games", 0) for pl in stats["players"]},
    }
    days = [d for d in history["days"] if d["date"] != today]
    # 前日と全く同じ（試合がなかった）日は追加しない
    if days and days[-1]["points"] == snapshot["points"]:
        return
    days.append(snapshot)
    history["days"] = days
    path.write_text(json.dumps(history, ensure_ascii=False, indent=1), encoding="utf-8")


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] != "-":
        html = Path(argv[1]).read_text(encoding="utf-8")
    else:
        html = fetch_html()
    stats = parse(html)
    if len(stats["players"]) < 30:
        print(f"取得した選手数が少なすぎます: {len(stats['players'])}", file=sys.stderr)
        return 1
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    (DATA_DIR / "stats.json").write_text(json.dumps(stats, ensure_ascii=False, indent=1), encoding="utf-8")
    update_history(stats)
    print(f"{len(stats['players'])} 選手 / season {stats['season']} を保存しました")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
