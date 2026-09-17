/* Mリーグ賭け途中経過 — 全ての計算はブラウザ側で行う。
   データ: data/stats.json (自動取得), data/bets.json (賭け設定), data/yakuman.json (手入力), data/history.json (推移) */
(async function () {
  const $ = (s, el = document) => el.querySelector(s);
  const h = (tag, attrs = {}, ...children) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") el.className = v;
      else if (k === "html") el.innerHTML = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  };
  const SERIES = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)", "var(--s5)"];
  const yen = (n) => { n = Math.round(n) || 0; return (n > 0 ? "+" : n < 0 ? "−" : "±") + Math.abs(n).toLocaleString("ja-JP") + "円"; };
  const pt = (n) => { n = Math.round(n * 10) / 10 || 0; return (n > 0 ? "+" : "") + n.toLocaleString("ja-JP", { minimumFractionDigits: 1, maximumFractionDigits: 1 }); };
  const pct = (n) => (Math.round(n * 1000) / 10).toFixed(1) + "%";
  const cls = (n) => (n > 0 ? "plus" : n < 0 ? "minus" : "");
  const bust = "?t=" + Math.floor(Date.now() / 60000);

  async function load(name) {
    const r = await fetch("data/" + name + bust, { cache: "no-store" });
    if (!r.ok) throw new Error(name + " の読み込みに失敗 (" + r.status + ")");
    return r.json();
  }

  let stats, bets, yakuman, history;
  try {
    [stats, bets, yakuman, history] = await Promise.all([
      load("stats.json"), load("bets.json"), load("yakuman.json"), load("history.json").catch(() => ({ days: [] })),
    ]);
  } catch (e) {
    $("#main").innerHTML = "<p class='minus'>" + e.message + "</p>";
    return;
  }

  const byName = Object.fromEntries(stats.players.map((p) => [p.name, p]));

  /* 1試合で獲得した最高ポイントを履歴の差分から求める。
     (公式サイトには「ベストスコア(素点)」しかなく、順位ウマ込みのポイントは載っていないため)
     試合数がちょうど1増えた区間の差分 = その1試合のポイント。2以上増えた区間は分けられないので無視。 */
  const bestGame = {};
  {
    const days = history.days || [];
    let prev = { points: {}, games: {} };
    for (const d of days) {
      for (const name of Object.keys(d.points || {})) {
        const dg = Number((d.games || {})[name] || 0) - Number(prev.games[name] || 0);
        if (dg === 1) {
          const dp = Number(d.points[name] || 0) - Number(prev.points[name] || 0);
          if (!bestGame[name] || dp > bestGame[name].pts) bestGame[name] = { pts: Math.round(dp * 10) / 10, date: d.date };
        } else if (dg >= 2) {
          bestGame[name] = { ...(bestGame[name] || { pts: -Infinity, date: "" }), gap: true };
        }
      }
      prev = d;
    }
  }
  const fetched = new Date(stats.fetched_at);
  $("#meta").textContent = `シーズン ${stats.season} ・ 最終更新 ${fetched.toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
  if (bets.repo) {
    $("#repoLink").append("設定・履歴: ", h("a", { href: "https://github.com/" + bets.repo, target: "_blank", rel: "noopener" }, "GitHub"));
  }

  /* ---------- 計算 ---------- */
  function compute(bet) {
    const owners = bet.teams.map((t, i) => ({ ...t, idx: i, color: SERIES[i % SERIES.length] }));
    const ownerOf = {};
    const picks = [];
    for (const o of owners) {
      o.players = o.players.map((p) => {
        const s = byName[p.name] || {};
        const raw = Number(s.points || 0);
        const bg = bestGame[p.name];
        const stat = { ...s, best_game: bg && bg.pts > -Infinity ? bg.pts : 0, best_game_date: bg ? bg.date : "", best_game_gap: !!(bg && bg.gap) };
        const pl = { ...p, stat, raw, adj: p.skull ? -raw : raw, owner: o.owner, ownerIdx: o.idx, color: o.color };
        ownerOf[p.name] = o;
        picks.push(pl);
        return pl;
      });
      o.total = o.players.reduce((a, p) => a + p.adj, 0);
      o.games = o.players.reduce((a, p) => a + Number(p.stat.games || 0), 0);
      o.money = { rank: 0, awards: 0, yakuman: 0 };
    }

    // 総得点順位（同点は順位金を平均で分ける）
    const sorted = [...owners].sort((a, b) => b.total - a.total);
    const rm = bet.rules.rank_money;
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1].total === sorted[i].total) j++;
      const share = rm.slice(i, j + 1).reduce((a, b) => a + b, 0) / (j - i + 1);
      for (let k = i; k <= j; k++) { sorted[k].rank = i + 1; sorted[k].money.rank = share; }
      i = j + 1;
    }

    // 個人賞（未出場は対象外）。ドクロが取ったらそのオーナーが全員に払う。
    const n = owners.length;
    const awardResults = bet.awards.map((aw) => {
      const cands = picks.filter((p) => Number(p.stat.games || 0) > 0);
      if (!cands.length) return { ...aw, winners: [], value: null };
      const max = Math.max(...cands.map((p) => Number(p.stat[aw.stat] || 0)));
      if (aw.min != null && max < aw.min) return { ...aw, winners: [], value: null, money: {} };  // 例: トップ0回では最多賞なし
      const winners = cands.filter((p) => Number(p.stat[aw.stat] || 0) === max);
      // 同率のとき: ドクロは薄めずに満額払う。ドクロ以外は人数で按分してもらう。
      const money = {};
      const normals = winners.filter((w) => !(w.skull && bet.rules.skull_inverts_awards));
      for (const w of winners) {
        const isSkull = w.skull && bet.rules.skull_inverts_awards;
        const unit = isSkull ? -bet.rules.award_money : bet.rules.award_money / normals.length;
        for (const o of owners) money[o.owner] = (money[o.owner] || 0) + (o.idx === w.ownerIdx ? unit * (n - 1) : -unit);
      }
      for (const o of owners) o.money.awards += money[o.owner] || 0;
      return { ...aw, winners, value: max, money };
    });

    // 役満賞
    const yaks = (bet.rules.yakuman_money ? (yakuman.entries || []) : []).filter((e) => !e.bet || e.bet === bet.id).map((e) => {
      const o = ownerOf[e.player];
      const pick = picks.find((p) => p.name === e.player);
      let money = 0;
      if (o) {
        const inv = pick.skull && bet.rules.skull_inverts_yakuman ? -1 : 1;
        money = bet.rules.yakuman_money * inv;
        for (const x of owners) x.money.yakuman += x.idx === o.idx ? money * (n - 1) : -money;
      }
      return { ...e, owner: o ? o.owner : null, skull: !!(pick && pick.skull), money };
    });

    for (const o of owners) o.money.total = o.money.rank + o.money.awards + o.money.yakuman;
    return { owners, sorted, picks, awardResults, yaks };
  }

  /* ---------- 描画 ---------- */
  function render(bet) {
    const { owners, sorted, picks, awardResults, yaks } = compute(bet);
    const main = $("#main");
    main.innerHTML = "";

    // 1. 現在の収支
    const tbl = h("table", { class: "standings" },
      h("thead", {}, h("tr", {},
        h("th", {}, "順位"), h("th", {}, "名前"), h("th", {}, "総得点"), h("th", {}, "順位金"),
        h("th", {}, "個人賞"), bet.rules.yakuman_money ? h("th", {}, "役満") : null, h("th", {}, "収支"))),
      h("tbody", {}, sorted.map((o) => h("tr", {},
        h("td", {}, h("span", { class: "rank", style: "background:" + o.color }, o.rank)),
        h("td", {}, o.owner),
        h("td", { class: "num total " + cls(o.total) }, pt(o.total)),
        h("td", { class: "num " + cls(o.money.rank) }, yen(o.money.rank)),
        h("td", { class: "num " + cls(o.money.awards) }, yen(o.money.awards)),
        bet.rules.yakuman_money ? h("td", { class: "num " + cls(o.money.yakuman) }, yen(o.money.yakuman)) : null,
        h("td", { class: "num total " + cls(o.money.total) }, yen(o.money.total)),
      ))));
    main.append(h("section", {},
      h("h2", {}, "現在の収支", h("small", {}, "今日シーズンが終わったらこの金額")),
      h("div", { class: "card table-scroll" }, tbl),
      h("p", { class: "note" }, `総得点はチーム${bet.teams[0].players.length}人のポイント合計（ドクロはマイナス換算）。順位金 ` + bet.rules.rank_money.map((m, i) => `${i + 1}位${yen(m)}`).join(" / ")),
    ));

    // 2. チーム別内訳
    main.append(h("section", {},
      h("h2", {}, "チーム別内訳"),
      h("div", { class: "grid" }, sorted.map((o) => h("div", { class: "card team-card" },
        h("h3", {}, h("span", {}, h("span", { class: "owner-dot", style: "background:" + o.color }), `${o.rank}位 ${o.owner}`),
          h("span", { class: "pts num " + cls(o.total) }, pt(o.total))),
        h("ul", { class: "plist" }, o.players.map((p) => h("li", { class: p.skull ? "skull" : "" },
          h("span", { class: "n" }, p.label || p.name, p.skull ? h("span", { class: "skull-tag" }, "ドクロ") : null,
            h("span", { class: "g" }, `${p.stat.games || 0}戦`)),
          h("span", { class: "num " + cls(p.adj) }, pt(p.adj), p.skull ? h("span", { class: "g" }, `(実 ${pt(p.raw)})`) : null),
        ))),
      ))),
    ));

    // 3. 個人賞
    main.append(h("section", {},
      h("h2", {}, "個人賞", h("small", {}, `各 ${bet.rules.award_money.toLocaleString()}円 × ${owners.length - 1}人。ドクロが取ったら払う側。同率はドクロ以外で按分`)),
      h("div", { class: "grid" }, awardResults.map((aw) => h("div", { class: "card award" + (aw.winners.length > 3 ? " many" : "") },
        h("div", { class: "name" }, aw.name, " ", h("span", { style: "font-weight:400" }, "— " + aw.desc)),
        aw.winners.length
          ? aw.winners.map((w) => h("div", {},
              h("div", { class: "who" }, h("span", { class: "owner-dot", style: "background:" + w.color }), w.label || w.name,
                w.skull ? h("span", { class: "skull-tag" }, "ドクロ") : null),
              h("div", { class: "val" }, `${w.owner} のチーム ・ ${fmtStat(aw.stat, aw.value)}${aw.winners.length > 1 ? "（同率）" : ""}`),
            ))
          : h("div", { class: "who" }, "まだ対象者なし"),
        aw.winners.length ? h("div", { class: "money" }, owners.map((o) => h("span", { style: "margin-right:10px" }, `${o.owner} `, h("span", { class: cls(aw.money[o.owner]) }, yen(aw.money[o.owner]))))) : null,
      ))),
    ));

    // 4. 役満賞（yakuman_money が 0 の賭けでは表示しない）
    if (bet.rules.yakuman_money) {
    const addUrl = bets.repo ? `https://github.com/${bets.repo}/actions/workflows/add-yakuman.yml` : null;
    main.append(h("section", {},
      h("h2", {}, "役満賞", h("small", {}, `1回につき ${bet.rules.yakuman_money.toLocaleString()}円 × ${owners.length - 1}人`)),
      h("div", { class: "card" },
        yaks.length
          ? h("ul", { class: "yak-list" }, yaks.map((y) => h("li", {},
              h("span", { class: "d" }, y.date),
              h("span", {}, h("b", {}, y.player_label || y.player), ` ${y.yakuman}`,
                y.owner ? ` ・ ${y.owner}${y.skull ? "（ドクロ）" : ""} ` : " ・ 対象外 ",
                y.owner ? h("span", { class: cls(y.money) }, yen(y.money * (owners.length - 1))) : null,
                y.note ? h("span", { class: "g" }, ` ${y.note}`) : null),
            )))
          : h("p", { class: "note", style: "margin:0" }, "まだ役満は出ていません。"),
        addUrl ? h("p", { style: "margin:10px 0 0" }, h("a", { class: "btn", href: addUrl, target: "_blank", rel: "noopener" }, "＋ 役満を登録する"),
          h("span", { class: "note", style: "margin-left:8px" }, "GitHub の「Run workflow」から入力")) : null,
      ),
    ));
    }

    // 5. 推移グラフ
    const chartSec = h("section", {}, h("h2", {}, "総得点の推移"));
    main.append(chartSec);
    renderChart(chartSec, bet, owners);

    // 6. 選手一覧
    main.append(renderPlayers(bet, picks, awardResults));
  }

  function fmtStat(stat, v) {
    if (stat === "points") return pt(v) + "pt";
    if (stat.endsWith("_rate")) return pct(v);
    if (stat === "best_score") return Number(v).toLocaleString() + "点";
    if (stat === "best_game") return pt(v) + "pt";
    if (stat === "rank1") return v + "回";
    return String(v);
  }

  function renderPlayers(bet, picks, awardResults) {
    const cols = [
      ["label", "選手", (p) => p.label || p.name, "s"],
      ["owner", "オーナー", (p) => p.owner, "s"],
      ["team", "所属", (p) => (p.stat.team || "").replace(/^(KADOKAWA|U-NEXT |渋谷|セガサミー|KONAMI |TEAM |EX)/, ""), "s"],
      ["games", "試合", (p) => p.stat.games || 0],
      ["adj", "換算pt", (p) => p.adj, "pt"],
      ["raw", "実pt", (p) => p.raw, "pt"],
      ["rank1", "トップ", (p) => p.stat.rank1 || 0],
      ["best_game", "最高pt", (p) => p.stat.best_game || 0, "pt"],
      ["best_score", "ベスト素点", (p) => p.stat.best_score || 0, "n"],
      ["last_avoid_rate", "ラス回避", (p) => p.stat.last_avoid_rate || 0, "pct"],
      ["avg_rank", "平着", (p) => p.stat.avg_rank || 0, "f"],
      ["rank4", "ラス", (p) => p.stat.rank4 || 0],
    ];
    const leaders = {};
    for (const aw of awardResults) for (const w of aw.winners) (leaders[w.name] ||= []).push(aw.stat);
    let sortKey = "adj", desc = true;
    const sec = h("section", {}, h("h2", {}, "選手一覧", h("small", {}, "見出しをタップで並べ替え。太字は個人賞トップ")));
    const wrap = h("div", { class: "card table-scroll" });
    sec.append(wrap);
    function draw() {
      const col = cols.find((c) => c[0] === sortKey);
      const rows = [...picks].sort((a, b) => {
        const va = col[2](a), vb = col[2](b);
        const r = typeof va === "string" ? va.localeCompare(vb, "ja") : va - vb;
        return desc ? -r : r;
      });
      wrap.innerHTML = "";
      wrap.append(h("table", { class: "players" },
        h("thead", {}, h("tr", {}, cols.map((c) => h("th", {
          "aria-sort": c[0] === sortKey ? (desc ? "descending" : "ascending") : null,
          onclick: () => { if (sortKey === c[0]) desc = !desc; else { sortKey = c[0]; desc = c[3] !== "s"; } draw(); },
        }, c[1], c[0] === sortKey ? (desc ? " ▼" : " ▲") : "")))),
        h("tbody", {}, rows.map((p) => h("tr", { class: p.skull ? "skull" : "" }, cols.map((c) => {
          const v = c[2](p);
          const isLead = (leaders[p.name] || []).includes(c[0] === "raw" ? "points" : c[0]);
          let txt = v;
          if (c[3] === "pt") txt = pt(v); else if (c[3] === "pct") txt = pct(v); else if (c[3] === "n") txt = Number(v).toLocaleString(); else if (c[3] === "f") txt = Number(v).toFixed(2);
          const classes = ["num"];
          if (c[3] === "pt") classes.push(cls(v));
          if (isLead) classes.push("lead");
          if (c[0] === "label") return h("td", {}, h("span", { class: "owner-dot", style: "background:" + p.color }), txt, p.skull ? h("span", { class: "skull-tag" }, "ドクロ") : null);
          return h("td", { class: classes.join(" ") }, txt);
        })))),
      ));
    }
    draw();
    return sec;
  }

  /* 折れ線グラフ（インラインSVG、ホバーで縦線＋ツールチップ） */
  function renderChart(sec, bet, owners) {
    const days = (history.days || []);
    const series = owners.map((o) => ({
      name: o.owner, color: o.color,
      values: days.map((d) => o.players.reduce((a, p) => a + (p.skull ? -1 : 1) * Number((d.points || {})[p.name] || 0), 0)),
    }));
    if (days.length < 2) {
      sec.append(h("p", { class: "note" }, "推移グラフは2日分以上のデータが貯まると表示されます。"));
      return;
    }
    const W = 800, H = 320, L = 44, R = 70, T = 12, B = 28;
    const all = series.flatMap((s) => s.values);
    let ymin = Math.min(0, ...all), ymax = Math.max(0, ...all);
    const pad = Math.max(10, (ymax - ymin) * 0.08); ymin -= pad; ymax += pad;
    const x = (i) => L + (i * (W - L - R)) / (days.length - 1);
    const y = (v) => T + ((ymax - v) * (H - T - B)) / (ymax - ymin);
    const svgNS = "http://www.w3.org/2000/svg";
    const s = (tag, attrs = {}, text) => { const el = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); if (text != null) el.textContent = text; return el; };
    const svg = s("svg", { class: "chart", viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "各チームの総得点の推移" });

    // 目盛り
    const step = niceStep((ymax - ymin) / 5);
    for (let v = Math.ceil(ymin / step) * step; v <= ymax; v += step) {
      svg.append(s("line", { class: v === 0 ? "axis-line" : "grid-line", x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      svg.append(s("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, v.toLocaleString()));
    }
    const tickEvery = Math.max(1, Math.ceil(days.length / 6));
    days.forEach((d, i) => { if (i % tickEvery === 0 || i === days.length - 1) svg.append(s("text", { x: x(i), y: H - 8, "text-anchor": "middle" }, d.date.slice(5).replace("-", "/"))); });

    // 線＋直接ラベル
    const endLabels = series.map((sr, i) => ({ i, y: y(sr.values[sr.values.length - 1]) })).sort((a, b) => a.y - b.y);
    for (let k = 1; k < endLabels.length; k++) if (endLabels[k].y - endLabels[k - 1].y < 14) endLabels[k].y = endLabels[k - 1].y + 14;
    series.forEach((sr, i) => {
      svg.append(s("path", { class: "series", stroke: sr.color, d: sr.values.map((v, j) => (j ? "L" : "M") + x(j).toFixed(1) + " " + y(v).toFixed(1)).join(" ") }));
      const ly = endLabels.find((e) => e.i === i).y;
      svg.append(s("text", { class: "dlabel", x: W - R + 8, y: ly + 4 }, sr.name + " " + pt(sr.values[sr.values.length - 1])));
    });

    // ホバー
    const cross = s("line", { class: "crosshair", y1: T, y2: H - B, visibility: "hidden" });
    svg.append(cross);
    const dots = series.map((sr) => { const c = s("circle", { class: "dot", r: 5, fill: sr.color, visibility: "hidden" }); svg.append(c); return c; });
    const tip = $("#tooltip");
    const hit = s("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
    svg.append(hit);
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(days.length - 1, Math.round(((px - L) / (W - L - R)) * (days.length - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
      series.forEach((sr, k) => { dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(sr.values[i])); dots[k].setAttribute("visibility", "visible"); });
      tip.innerHTML = "";
      tip.append(h("b", {}, days[i].date));
      [...series].sort((a, b) => b.values[i] - a.values[i]).forEach((sr) => tip.append(h("div", {}, h("span", {}, h("i", { style: "background:" + sr.color }), sr.name), h("span", { class: "num " + cls(sr.values[i]) }, pt(sr.values[i])))));
      tip.hidden = false;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.min(window.innerWidth - tw - 8, ev.clientX + 12) + "px";
      tip.style.top = Math.max(8, Math.min(window.innerHeight - th - 8, ev.clientY - th / 2)) + "px";
    };
    const leave = () => { cross.setAttribute("visibility", "hidden"); dots.forEach((d) => d.setAttribute("visibility", "hidden")); tip.hidden = true; };
    hit.addEventListener("pointermove", move); hit.addEventListener("pointerdown", move); hit.addEventListener("pointerleave", leave);

    sec.append(h("div", { class: "card chart-wrap" }, svg,
      h("div", { class: "legend" }, series.map((sr) => h("span", { style: "--c:" + sr.color }, sr.name)))));
  }
  function niceStep(raw) { const p = Math.pow(10, Math.floor(Math.log10(raw))); const m = raw / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

  /* ---------- タブ ---------- */
  const tabs = $("#tabs");
  const params = new URLSearchParams(location.search);
  let current = bets.bets.find((b) => b.id === params.get("bet")) || bets.bets[0];
  function drawTabs() {
    tabs.innerHTML = "";
    for (const b of bets.bets) tabs.append(h("button", {
      role: "tab", "aria-selected": String(b === current),
      onclick: () => { current = b; window.history.replaceState(null, "", "?bet=" + b.id); drawTabs(); render(b); },
    }, b.name));
  }
  drawTabs();
  render(current);
})();
