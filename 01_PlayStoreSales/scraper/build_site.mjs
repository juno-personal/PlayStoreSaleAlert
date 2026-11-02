/**
 * games.json → 정적 HTML 페이지 생성 (GitHub Pages 용)
 *
 * 사용:
 *   node build_site.mjs --in games.json --out ../../docs/index.html
 *   (인자 생략 시 games.json → <repo>/docs/index.html)
 *
 * 정렬: 할인 종료일(saleEndDate) 내림차순, 종료일 없는 항목은 맨 뒤.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const args = {
    in: fileURLToPath(new URL("./games.json", import.meta.url)),
    out: fileURLToPath(new URL("../../docs/index.html", import.meta.url)),
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--in" && argv[i + 1]) args.in = argv[++i];
    else if (argv[i] === "--out" && argv[i + 1]) args.out = argv[++i];
  }
  return args;
}

/** 할인 종료일 오름차순 (없는 항목은 뒤로) */
export function sortBySaleEndAsc(games) {
  return [...games].sort((a, b) => {
    const ta = a.saleEndDate ? Date.parse(a.saleEndDate) : NaN;
    const tb = b.saleEndDate ? Date.parse(b.saleEndDate) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb)) return ta - tb;
    if (Number.isFinite(ta)) return -1;
    if (Number.isFinite(tb)) return 1;
    return (b.discountPercent || 0) - (a.discountPercent || 0);
  });
}

const PAGE_CSS = `
:root{
  --bg:#0b0b0c; --panel:#121215; --line:#232329;
  --text:#f5f5f7; --muted:#8e8e96; --accent:#4ade80; --badge:#e94560;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{
  background:var(--bg);color:var(--text);
  font-family:system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans KR","Apple SD Gothic Neo",sans-serif;
  -webkit-font-smoothing:antialiased;
}
header{
  position:sticky;top:0;z-index:10;
  display:flex;flex-wrap:wrap;gap:10px 14px;align-items:center;
  padding:14px 20px;background:rgba(11,11,12,.86);
  backdrop-filter:blur(14px);border-bottom:1px solid var(--line);
}
.brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:17px;letter-spacing:-.2px}
.brand .dot{width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 12px var(--accent)}
.meta{color:var(--muted);font-size:12px;line-height:1.4}
.meta b{color:var(--text);font-weight:600}
.tools{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap}
input,select{
  background:#17171b;border:1px solid var(--line);color:var(--text);
  border-radius:10px;padding:8px 11px;font-size:13px;outline:none;
}
input:focus,select:focus{border-color:#3a3a44}
input{width:190px}
main{max-width:1180px;margin:0 auto;padding:20px}
.stats{color:var(--muted);font-size:12px;margin:0 0 16px;display:flex;gap:14px;flex-wrap:wrap}
.stats span b{color:var(--text)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(158px,1fr));gap:22px 16px}
.card{display:flex;flex-direction:column;gap:9px;text-decoration:none;color:inherit;min-width:0}
.thumb{position:relative;aspect-ratio:1/1;border-radius:20px;overflow:hidden;background:#1b1b20}
.thumb img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .18s ease}
.card:hover .thumb img{transform:scale(1.04)}
.badge{
  position:absolute;left:7px;top:7px;background:var(--badge);color:#fff;
  font-size:11px;font-weight:700;padding:3px 7px;border-radius:8px;letter-spacing:.2px;
}
.badge.free{background:var(--accent);color:#06230f}
.name{
  font-size:14px;line-height:1.32;font-weight:500;
  display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;
  height:2.64em;
}
.prices{display:flex;align-items:baseline;gap:7px;font-size:14px;flex-wrap:wrap}
.old{color:var(--muted);text-decoration:line-through;font-size:13px}
.new{font-weight:700}
.new.zero{color:var(--accent)}
.ends{font-size:11px;color:var(--muted);margin-top:-3px}
.ends.soon{color:#f5a524}
.empty{color:var(--muted);text-align:center;padding:60px 0}
footer{max-width:1180px;margin:0 auto;padding:8px 20px 48px;color:#5d5d66;font-size:12px;line-height:1.7}
a.plain{color:#8e8e96}
@media (max-width:520px){
  input{width:100%}
  .tools{width:100%;margin-left:0}
  .tools input{flex:1}
  main{padding:16px 14px}
  .grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:16px 10px}
  .thumb{border-radius:16px}
  .name{font-size:12.5px;height:2.64em}
  .prices{font-size:12.5px;gap:5px}
  .old{font-size:11.5px}
  .ends{font-size:10px}
  .badge{font-size:10px;padding:2px 6px;left:5px;top:5px}
}
`;

// 클라이언트 렌더러 (템플릿 리터럴 회피: 문자열 연결 사용)
const PAGE_JS = `
(function () {
  var DATA = JSON.parse(document.getElementById("app-data").textContent);
  var grid = document.getElementById("grid");
  var stats = document.getElementById("stats");
  var search = document.getElementById("search");
  var sortSel = document.getElementById("sort");
  var TZ = "Asia/Dubai";

  function ts(g) { var t = Date.parse(g.saleEndDate || ""); return isNaN(t) ? null : t; }

  function fmtEnd(iso) {
    if (!iso) return "";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    try {
      var p = new Intl.DateTimeFormat("ko-KR", {
        timeZone: TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false
      }).formatToParts(d);
      var m = {};
      p.forEach(function (x) { m[x.type] = x.value; });
      return m.month + "." + m.day + " " + m.hour + ":" + m.minute;
    } catch (e) {
      return iso.slice(5, 10).replace("-", ".") + " " + iso.slice(11, 16);
    }
  }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function badge(g) {
    var sale = parseFloat(String(g.salePrice || "").replace(/[^0-9.]/g, ""));
    if (sale === 0) return '<span class="badge free">FREE</span>';
    if (g.discountPercent) return '<span class="badge">-' + g.discountPercent + "%</span>";
    return "";
  }

  function card(g) {
    var sale = parseFloat(String(g.salePrice || "").replace(/[^0-9.]/g, ""));
    var priceCls = sale === 0 ? "new zero" : "new";
    var t = ts(g);
    var soon = t !== null && t - Date.now() < 24 * 3600 * 1000;
    var html = '<a class="card" href="' + esc(g.productUrl || "#") + '" target="_blank" rel="noopener">';
    html += '<div class="thumb">' + badge(g);
    html += g.imageUrl
      ? '<img loading="lazy" src="' + esc(g.imageUrl) + '" alt="' + esc(g.name) + '">'
      : "";
    html += "</div>";
    html += '<div class="name">' + esc(g.name) + "</div>";
    html += '<div class="prices">';
    if (g.originalPrice) html += '<span class="old">' + esc(g.originalPrice) + "</span>";
    if (g.salePrice) html += '<span class="' + priceCls + '">' + esc(g.salePrice) + "</span>";
    html += "</div>";
    if (g.saleEndDate) {
      html += '<div class="ends' + (soon ? " soon" : "") + '">~' + esc(fmtEnd(g.saleEndDate)) + " 종료</div>";
    }
    html += "</a>";
    return html;
  }

  function sortGames(list, mode) {
    var arr = list.slice();
    if (mode === "endAsc") {
      arr.sort(function (a, b) {
        var ta = ts(a), tb = ts(b);
        if (ta === null && tb === null) return 0;
        if (ta === null) return 1;
        if (tb === null) return -1;
        return ta - tb;
      });
    } else if (mode === "discount") {
      arr.sort(function (a, b) { return (b.discountPercent || 0) - (a.discountPercent || 0); });
    } else if (mode === "name") {
      arr.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "ko"); });
    } else {
      arr.sort(function (a, b) {
        var ta = ts(a), tb = ts(b);
        if (ta === null && tb === null) return (b.discountPercent || 0) - (a.discountPercent || 0);
        if (ta === null) return 1;
        if (tb === null) return -1;
        return tb - ta;
      });
    }
    return arr;
  }

  function render() {
    var q = (search.value || "").trim().toLowerCase();
    var list = DATA.filter(function (g) {
      return !q || String(g.name || "").toLowerCase().indexOf(q) >= 0;
    });
    var sorted = sortGames(list, sortSel.value);
    grid.innerHTML = sorted.map(card).join("") || '<p class="empty">결과가 없습니다.</p>';
    var free = sorted.filter(function (g) {
      return parseFloat(String(g.salePrice || "").replace(/[^0-9.]/g, "")) === 0;
    }).length;
    stats.innerHTML =
      "<span><b>" + sorted.length + "</b>개 게임</span>" +
      "<span>100% 할인 <b>" + free + "</b>개</span>" +
      "<span>정렬: <b>" + (sortSel.options[sortSel.selectedIndex].text) + "</b></span>";
  }

  search.addEventListener("input", render);
  sortSel.addEventListener("change", render);
  render();
})();
`;

export function renderPage(games, meta = {}) {
  const sorted = sortBySaleEndAsc(games);
  const data = JSON.stringify(sorted).replace(/</g, "\\u003c");
  const updated = meta.scrapedAt
    ? new Intl.DateTimeFormat("ko-KR", {
        timeZone: "Asia/Dubai",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(new Date(meta.scrapedAt))
    : "";
  const freeCount = sorted.filter((g) => /^0([.,]0+)?$/.test(String(g.salePrice || "").replace(/[^0-9.,]/g, ""))).length;

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Play Store 세일 중인 게임 (${sorted.length})</title>
<meta name="description" content="Google Play에서 할인 중인 유료 게임 ${sorted.length}개 목록. 한국어 UI, AED 가격 기준.">
<style>${PAGE_CSS}</style>
</head>
<body>
<header>
  <div class="brand"><span class="dot"></span>Games on Sale</div>
  <div class="meta">
    <b>${sorted.length}</b>개 할인 중${freeCount ? ` · 100% 할인 <b>${freeCount}</b>개` : ""}<br>
    ${updated ? `업데이트 ${updated} (Dubai) · AED 가격 · Google Play` : "Google Play · AED 가격"}
  </div>
  <div class="tools">
    <input id="search" type="search" placeholder="게임 이름 검색">
    <select id="sort">
      <option value="endAsc" selected>할인 종료 임박 순</option>
      <option value="endDesc">할인 종료 늦은 순</option>
      <option value="discount">할인율 높은 순</option>
      <option value="name">이름순</option>
    </select>
  </div>
</header>
<main>
  <div class="stats" id="stats"></div>
  <div class="grid" id="grid"></div>
</main>
<footer>
  가격은 Google Play (hl=ko&amp;gl=AE) 기준이며 세금 포함가입니다. 실제 결제 통화·금액은 계정 국가에 따라 다를 수 있습니다.<br>
  데이터 출처: play.google.com — "Games on sale" 컬렉션 · 자동 갱신 (GitHub Actions)
</footer>
<script id="app-data" type="application/json">${data}</script>
<script>${PAGE_JS}</script>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const payload = JSON.parse(readFileSync(args.in, "utf8"));
  const games = Array.isArray(payload) ? payload : payload.games || [];
  const html = renderPage(games, {
    scrapedAt: Array.isArray(payload) ? null : payload.scrapedAt,
  });

  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, html, "utf8");
  console.log(`[site] ${games.length}개 게임 → ${args.out} (${(html.length / 1024).toFixed(1)}KB)`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
