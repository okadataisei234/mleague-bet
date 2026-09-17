# Mリーグ賭け 途中経過

Mリーグ 2026-27 の公式成績をもとに、友人間の賭けの途中経過を自動更新で表示するサイト。
仕様は [仕様書.md](仕様書.md) を参照。

## 使い方

- サイト: GitHub Pages で `docs/` を公開
- 成績の更新: 自動（毎日 JST 01:00 / 12:00）。手動で更新したいときは Actions → 「成績を自動更新」→ Run workflow
- 役満の登録: Actions → 「役満を登録」→ Run workflow で選手名・役満・日付を入力
- 賭けの設定変更: `docs/data/bets.json` を編集

## ローカルで確認

```bash
python scripts/scrape.py
python -m http.server 8765 --directory docs
```
