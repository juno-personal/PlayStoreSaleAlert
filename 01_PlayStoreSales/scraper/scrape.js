/**
 * Play Store 'Games on sale' 무한스크롤 스크래퍼 (Playwright / Node)
 *
 * 사용:
 *   node scrape.js --out games.json
 *   node scrape.js --channel chrome       (로컬 Chrome 사용, 브라우저 다운로드 불필요)
 *   node scrape.js --hl ko --gl AE        (기본값: 한국어 UI + AED 가격)
 *
 * 실측:
 *   2026-09 hl=en&gl=US → 초기 20개 → 스크롤 7회 → 173개 (12.5초)
 *   2026-11 hl=ko&gl=AE → 초기 20개 → 스크롤 7회 → 176개 (11초), 가격 표기 "AED 10.99"
 *
 * gl 미지정 시 할인 정보가 2/22만 채워짐 → gl 필수.
 *
 * 누락 방지 장치:
 *   1) 매 스크롤 단계마다 DOM 카드를 수집(harvest)해 packageId 기준으로 병합
 *      → 가상화/재렌더로 DOM에서 사라진 카드도 유실되지 않음
 *   2) 초기 HTML(AF_initDataCallback) 파싱
 *      → 첫 20개 카드는 DOM에 가격이 렌더되지 않으므로(실측) 여기서 가격을 확보
 *   3) batchexecute(qnKhOb) 응답 파싱 (F12 HAR 분석 결과, 응답 1건당 앱 50개)
 *      → 이름/별점/장르/정가/할인가/할인율/할인 종료일까지 구조화된 값으로 확보
 *   4) 최하단 도달 + 수집 수 3회 연속 증가 없음 → 종료 (끝까지 내려갔음을 확인)
 */

import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import {
  buildTargetUrl,
  DEFAULT_LOCALE,
  LOCALE_MAP,
  CARD,
  CARD_SELECTORS,
  FIELD_SELECTORS,
  SCROLL_DEFAULTS,
  USER_AGENT,
} from "./selectors.js";

// 통화 표기: "$9.99", "€9,99", "£9.99", "AED 10.99", "10.99 AED" 등
// (?<![A-Za-z]) : "SENTINEL 519" 같은 앱 이름 일부를 통화로 오인하지 않도록 앞에 글자가 오면 제외
const PRICE_PATTERN =
  "(?<![A-Za-z])(?:\\$|€|£)\\s?\\d[\\d.,]*|(?<![A-Za-z])[A-Z]{3}\\s?\\d[\\d.,]*|\\d[\\d.,]*\\s?(?:AED|USD|EUR|GBP)";

const EPOCH_SEC_RE = /\[(1[6-9]\d{8})\]/;

export function parseArgs(argv) {
  const args = {
    out: "games.json",
    channel: null,
    verbose: false,
    headed: false,
    hl: DEFAULT_LOCALE.hl,
    gl: DEFAULT_LOCALE.gl,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (a === "--channel" && argv[i + 1]) args.channel = argv[++i];
    else if (a === "--hl" && argv[i + 1]) args.hl = argv[++i];
    else if (a === "--gl" && argv[i + 1]) args.gl = argv[++i];
    else if (a === "--headed") args.headed = true;
    else if (a === "--verbose") args.verbose = true;
  }
  return args;
}

/* ------------------------------------------------------------------ *
 * 1) 네트워크/초기 데이터 파서
 * ------------------------------------------------------------------ */

/** "AED 10.99" 처럼 보이는 값을 숫자로 */
export function priceNumber(textValue) {
  if (!textValue) return NaN;
  const m = String(textValue).replace(/\u00a0/g, " ").match(/\d[\d.,]*/);
  if (!m) return NaN;
  const num = parseFloat(m[0].replace(/,/g, ""));
  return Number.isFinite(num) ? num : NaN;
}

function cleanText(value) {
  return typeof value === "string" ? value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() : null;
}

/**
 * 앱 1건(35칸 배열)을 구조화된 객체로 변환.
 * 인덱스는 F12 HAR 실측 기준:
 *   [0] ["packageId", 7]   [1] 아이콘   [3] 이름   [4] 별점   [5] 장르
 *   [8] 가격블록(할인가/정가/할인율/종료일)   [10] 상세 URL
 */
export function mapNetworkApp(entry) {
  const a = Array.isArray(entry) ? entry : null;
  if (!a) return null;

  const packageId = typeof a[0] === "string" ? a[0] : Array.isArray(a[0]) ? a[0][0] : null;
  if (!packageId || typeof packageId !== "string") return null;

  const name = cleanText(a[3]);
  const genre = cleanText(a[5]);

  // a[4] = ["4.5", 4.5142856] (별점 없으면 [])
  let rating = null;
  if (Array.isArray(a[4])) {
    const num = Number(a[4][1]);
    const txt = Number.parseFloat(String(a[4][0] ?? "").replace(",", "."));
    const value = Number.isFinite(num) ? num : Number.isFinite(txt) ? txt : NaN;
    rating = Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
  }

  // a[8] = [null, [ [할인가...], [정가...], ?, [할인%,…,"50% 할인"] ], …]
  const priceBlock = Array.isArray(a[8]) ? a[8] : null;
  const prices = priceBlock && Array.isArray(priceBlock[1]) ? priceBlock[1] : null;
  const saleEntry = prices && Array.isArray(prices[0]) ? prices[0] : null;
  const origEntry = prices && Array.isArray(prices[1]) ? prices[1] : null;

  const salePrice = cleanText(saleEntry && saleEntry[2]);
  const originalPrice = cleanText(origEntry && origEntry[2]);
  const currency = cleanText((origEntry && origEntry[1]) || (saleEntry && saleEntry[1]));
  const discountPercent =
    prices && Array.isArray(prices[3]) && Number.isFinite(Number(prices[3][0])) ? Number(prices[3][0]) : null;

  // 할인 종료일: 가격 블록 안의 [epochSec] 배열
  let saleEndDate = null;
  if (priceBlock) {
    const m = String(JSON.stringify(priceBlock)).match(EPOCH_SEC_RE);
    if (m) {
      const d = new Date(Number(m[1]) * 1000);
      if (!Number.isNaN(d.getTime())) saleEndDate = d.toISOString();
    }
  }

  const iconInfo = Array.isArray(a[1]) ? a[1] : null;
  const imageUrl = cleanText(iconInfo && iconInfo[3] && iconInfo[3][2]);

  const urlInfo = Array.isArray(a[10]) ? a[10] : null;
  const relUrl = cleanText(urlInfo && urlInfo[4] && urlInfo[4][2]);
  const productUrl = relUrl
    ? relUrl.startsWith("http")
      ? relUrl
      : `https://play.google.com${relUrl}`
    : `https://play.google.com/store/apps/details?id=${packageId}`;

  return {
    packageId,
    name,
    genre,
    rating,
    discountPercent,
    originalPrice,
    salePrice,
    currency,
    imageUrl,
    productUrl,
    saleEndDate,
  };
}

/** 앱 데이터 배열인지 판별 (다른 중첩 배열과 구분) */
function isAppEntry(node) {
  return (
    Array.isArray(node) &&
    node.length >= 20 &&
    Array.isArray(node[0]) &&
    typeof node[0][0] === "string" &&
    node[0][0].includes(".") &&
    typeof node[3] === "string" &&
    typeof node[5] === "string"
  );
}

/** 트리 어디에 있든 앱 배열을 모두 수집 */
function collectApps(node, out) {
  if (!Array.isArray(node)) return;
  if (isAppEntry(node)) {
    const app = mapNetworkApp(node);
    if (app) out.push(app);
    return;
  }
  for (const child of node) collectApps(child, out);
}

/**
 * batchexecute 응답 텍스트에서 앱 목록을 뽑는다.
 * 형식: )]}'\n\n<len>\n[["wrb.fr","qnKhOb","<escaped json>",…]]\n…
 */
export function parseCollectionResponse(text) {
  const apps = [];
  if (typeof text !== "string") return apps;

  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith('[["wrb.fr"')) continue;

    let outer;
    try {
      outer = JSON.parse(s);
    } catch {
      continue;
    }
    const payloadText = outer && outer[0] && outer[0][2];
    if (typeof payloadText !== "string") continue;

    let payload;
    try {
      payload = JSON.parse(payloadText);
    } catch {
      continue;
    }
    collectApps(payload, apps);
  }
  return apps;
}

/** start 인덱스의 "[" 부터 짝이 맞는 "]" 까지 잘라낸다 (문자열/이스케이프 고려) */
function sliceBalanced(text, start) {
  if (start < 0 || text[start] !== "[") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth += 1;
    else if (ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * 초기 문서 HTML에 심어진 AF_initDataCallback 데이터에서 앱 목록을 뽑는다.
 * 첫 화면 20개 카드는 DOM에 가격이 렌더되지 않지만, 이 데이터에는 가격이 들어있다.
 */
export function parseEmbeddedApps(html) {
  const apps = [];
  if (typeof html !== "string" || !html.includes("AF_initDataCallback")) return apps;

  const marker = "AF_initDataCallback(";
  let cursor = 0;
  while ((cursor = html.indexOf(marker, cursor)) !== -1) {
    const start = cursor + marker.length;
    const end = html.indexOf("});", start);
    if (end === -1) break;
    cursor = end + 3;

    const chunk = html.slice(start, end);
    const dataIdx = chunk.indexOf("data:");
    if (dataIdx === -1) continue;
    const arrStart = chunk.indexOf("[", dataIdx);
    const arrText = sliceBalanced(chunk, arrStart);
    if (!arrText) continue;

    try {
      collectApps(JSON.parse(arrText), apps);
    } catch {
      /* JSON 이 아닌 블록은 건너뜀 */
    }
  }
  return apps;
}

/* ------------------------------------------------------------------ *
 * 2) 페이지 내부 수집기 (fetch/XHR 응답 캡처)
 * ------------------------------------------------------------------ */

/**
 * batchexecute 응답 본문을 window.__playCollectionResponses 에 적재.
 * (Playwright의 response.text()는 SPA에서 "No data found"로 실패하는 경우가 있어 fetch/XHR 패치 사용)
 */
function captureScript() {
  if (window.__playCollectionCapture) return;
  window.__playCollectionCapture = true;
  window.__playCollectionResponses = [];

  const push = (url, text) => {
    if (!url || !String(url).includes("batchexecute") || typeof text !== "string" || !text) return;
    try {
      window.__playCollectionResponses.push(text);
    } catch {
      /* 무시 */
    }
  };

  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function patchedFetch(...args) {
      const req = args[0];
      const url = typeof req === "string" ? req : req && req.url;
      return origFetch.apply(this, args).then((res) => {
        try {
          if (url && String(url).includes("batchexecute")) {
            res
              .clone()
              .text()
              .then((t) => push(url, t))
              .catch(() => {});
          }
        } catch {
          /* 무시 */
        }
        return res;
      });
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    try {
      this.addEventListener("load", () => {
        try {
          push(url, this.responseText);
        } catch {
          /* binary 응답 등 */
        }
      });
    } catch {
      /* 무시 */
    }
    return origOpen.apply(this, [method, url, ...rest]);
  };
}

/** 브라우저에 쌓인 batchexecute 응답을 비우면서 파싱해 networkApps 에 병합 */
async function drainNetwork(page, networkApps) {
  const texts = await page
    .evaluate(() => {
      const arr = window.__playCollectionResponses || [];
      window.__playCollectionResponses = [];
      return arr;
    })
    .catch(() => []);

  for (const text of texts) {
    for (const app of parseCollectionResponse(text)) {
      const prev = networkApps.get(app.packageId);
      networkApps.set(app.packageId, prev ? { ...prev, ...app } : app);
    }
  }
  return texts.length;
}

/* ------------------------------------------------------------------ *
 * 3) DOM 추출
 * ------------------------------------------------------------------ */

/** 페이지 컨텍스트에서 실행되는 카드 추출기 (셀렉터는 인자로 전달) */
function extractInPage(args) {
  const fieldSelectors = args.fieldSelectors;
  const cardSelector = args.cardSelector;
  const priceRe = new RegExp(args.pricePattern, "g");

  const pick = (root, list) => {
    for (const sel of list) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  const clean = (s) => (s ? s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim() : null);
  const text = (el) => (el ? clean(el.textContent) : null);

  return Array.from(document.querySelectorAll(cardSelector)).map((card) => {
    const nameEl = pick(card, fieldSelectors.name);
    const genreEl = pick(card, fieldSelectors.genre);
    const discountEl = pick(card, fieldSelectors.discount);
    const ratingEl = pick(card, fieldSelectors.ratingAria);
    const ratingValEl = pick(card, fieldSelectors.ratingValue);
    const origEl = pick(card, fieldSelectors.originalPrice);
    const saleEl = pick(card, fieldSelectors.salePrice);
    const thumbEl = pick(card, fieldSelectors.thumbnail);
    const linkEl = pick(card, fieldSelectors.link);

    const href = linkEl ? linkEl.getAttribute("href") : null;
    const pkgMatch = href ? href.match(/[?&]id=([^&]+)/) : null;
    const cardText = clean(card.textContent) || "";

    return {
      packageId: pkgMatch ? decodeURIComponent(pkgMatch[1]) : null,
      name: text(nameEl),
      genre: text(genreEl),
      ratingText: ratingEl ? ratingEl.getAttribute("aria-label") : null,
      ratingValueText: text(ratingValEl),
      discountText: text(discountEl),
      originalPriceText: text(origEl),
      salePriceText: text(saleEl),
      priceTexts: cardText.match(priceRe) || [],
      imageUrl: thumbEl ? thumbEl.getAttribute("src") : null,
      productUrl: href ? `https://play.google.com${href}` : null,
    };
  });
}

/** 별점: aria-label("별표 5개 만점에 4.9개…", "Rated 4.5…") 또는 숫자 스팬에서 추출 */
export function parseRating(raw) {
  const direct = raw.ratingValueText ? parseFloat(String(raw.ratingValueText).replace(",", ".")) : NaN;
  if (Number.isFinite(direct)) return direct;
  if (!raw.ratingText) return null;
  const nums = String(raw.ratingText).match(/\d+(?:[.,]\d+)?/g);
  if (!nums || !nums.length) return null;
  const value = parseFloat(nums[nums.length - 1].replace(",", "."));
  return Number.isFinite(value) ? value : null;
}

/** 원시 DOM 값을 기존 GAS `game` 스키마로 정규화 */
export function normalizeGame(raw) {
  const rating = parseRating(raw);
  let discount = raw.discountText ? parseInt(String(raw.discountText).replace(/[^\d]/g, ""), 10) : NaN;

  let salePrice = raw.salePriceText;
  let originalPrice = raw.originalPriceText;

  // 셀렉터가 비었으면 카드 텍스트의 통화 패턴으로 백
  if (!salePrice && raw.priceTexts.length) {
    salePrice = raw.priceTexts[raw.priceTexts.length - 1];
    originalPrice = originalPrice || raw.priceTexts[0];
  }

  const origNum = priceNumber(originalPrice);
  const saleNum = priceNumber(salePrice);
  const hasPrices = Number.isFinite(origNum) && Number.isFinite(saleNum);

  // 할인율 배지가 없으면 가격에서 역산
  if (!Number.isFinite(discount) && hasPrices && origNum > 0 && saleNum < origNum) {
    discount = Math.round(((origNum - saleNum) / origNum) * 100);
  }

  const isPaid = Number.isFinite(origNum)
    ? origNum > 0
    : Boolean(originalPrice) && !/^(free|무료)$/i.test(String(originalPrice).trim());

  return {
    packageId: raw.packageId,
    name: raw.name,
    genre: raw.genre,
    rating: Number.isFinite(rating) ? rating : null,
    discountPercent: Number.isFinite(discount) ? discount : null,
    originalPrice: originalPrice || null,
    salePrice: salePrice || null,
    currency: (String(originalPrice || salePrice || "").match(/[A-Z]{3}/) || [null])[0],
    imageUrl: raw.imageUrl,
    productUrl: raw.productUrl,
    saleEndDate: raw.saleEndDate || null,
    isPaid,
  };
}

/** 이번 컬렉션에서 실제로 "할인 중인 유료 게임"인지 */
export function isSaleGame(game) {
  if (!game || !game.originalPrice || !game.salePrice) return false;
  const orig = priceNumber(game.originalPrice);
  const sale = priceNumber(game.salePrice);
  if (!Number.isFinite(orig) || orig <= 0) return false;
  if (game.discountPercent && game.discountPercent > 0) return true;
  return Number.isFinite(sale) && sale < orig;
}

/** 할인 종료일 내림차순 정렬 (종료일 없는 항목은 맨 뒤) */
export function sortBySaleEndDesc(games) {
  return [...games].sort((a, b) => {
    const ta = a.saleEndDate ? Date.parse(a.saleEndDate) : NaN;
    const tb = b.saleEndDate ? Date.parse(b.saleEndDate) : NaN;
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    if (Number.isFinite(ta)) return -1;
    if (Number.isFinite(tb)) return 1;
    return (b.discountPercent || 0) - (a.discountPercent || 0);
  });
}

/* ------------------------------------------------------------------ *
 * 4) 수집 / 스크롤
 * ------------------------------------------------------------------ */

/**
 * 현재 DOM의 카드를 수집해 seen(Map)에 병합.
 * 이후 스크롤로 DOM에서 사라지는 카드가 있어도 누락되지 않는다.
 */
async function harvest(page, seen, args) {
  const rawCards = await page.evaluate(extractInPage, args);
  for (const raw of rawCards) {
    const key = raw.packageId || (raw.name ? `name:${raw.name.toLowerCase()}` : null);
    if (!key) continue;

    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { ...raw, priceTexts: [...raw.priceTexts] });
      continue;
    }
    // 이미 본 카드: 비어 있던 필드만 보강 (가격/별점은 늦게 렌더되는 경우가 있음)
    for (const [field, value] of Object.entries(raw)) {
      if (field === "priceTexts") continue;
      const prevValue = prev[field];
      if (value && (prevValue === null || prevValue === undefined || prevValue === "")) {
        prev[field] = value;
      }
    }
    if (raw.priceTexts.length && (!prev.priceTexts || prev.priceTexts.length === 0)) {
      prev.priceTexts = [...raw.priceTexts];
    }
  }
  return seen.size;
}

/** 스크롤 한 단계: 마지막 카드 노출 → 휠 스크롤 → 최하단 점프 */
async function nudge(page, opts) {
  await page.evaluate((cardSelector) => {
    const cards = document.querySelectorAll(cardSelector);
    const last = cards[cards.length - 1];
    if (last) last.scrollIntoView({ block: "end" });
  }, CARD);
  await page.waitForTimeout(150);

  await page.mouse.move(opts.viewport.width / 2, opts.viewport.height / 2);
  await page.mouse.wheel(0, opts.wheelDelta);

  await page.evaluate(() => {
    const el = document.scrollingElement || document.body;
    window.scrollTo(0, el.scrollHeight);
  });
  await page.waitForTimeout(opts.settleMs);
}

/**
 * 끝까지 스크롤: 최하단 도달 + 수집 수가 stableNeeded회 연속 증가 없음 → 종료.
 * 각 단계에서 harvest 하므로 스크롤 중 사라진 카드도 보존된다.
 */
async function scrollToEnd(page, opts, seen, args, network) {
  const { networkApps, networkTotal } = network;
  const timeline = [];
  let stable = 0;
  let lastTotal = -1;
  let stopReason = "max-scrolls";
  const started = Date.now();

  for (let step = 0; step <= opts.maxScrolls; step += 1) {
    await drainNetwork(page, networkApps);
    const domTotal = await harvest(page, seen, args);
    const netTotal = networkTotal();
    const total = Math.max(domTotal, netTotal);
    const domCards = await page.locator(CARD).count();
    const state = await page.evaluate(() => {
      const el = document.scrollingElement || document.body;
      return { scrollHeight: el.scrollHeight, scrollY: window.scrollY, viewportHeight: window.innerHeight };
    });
    const atBottom = state.scrollY + state.viewportHeight >= state.scrollHeight - 24;

    timeline.push({
      step,
      domCards,
      domHarvested: domTotal,
      networkApps: netTotal,
      scrollHeight: state.scrollHeight,
      atBottom,
      elapsedSec: Number(((Date.now() - started) / 1000).toFixed(2)),
    });

    if (total === lastTotal) stable += 1;
    else stable = 0;
    lastTotal = total;

    if (atBottom && stable >= opts.stableNeeded) {
      stopReason = "end-of-list";
      break;
    }
    if ((Date.now() - started) / 1000 > opts.maxSeconds) {
      stopReason = "time-limit";
      break;
    }
    if (step === opts.maxScrolls) {
      stopReason = "max-scrolls";
      break;
    }

    await nudge(page, opts);
  }

  // 렌더/응답 지연으로 마지막 카드가 늦게 붙는 경우 대비
  await page.waitForTimeout(opts.settleMs);
  await drainNetwork(page, networkApps);
  await harvest(page, seen, args);

  return { timeline, stopReason, scrolls: Math.max(0, timeline.length - 1) };
}

/* ------------------------------------------------------------------ *
 * 5) 메인
 * ------------------------------------------------------------------ */

export async function scrape({
  channel = null,
  headed = false,
  verbose = false,
  hl = DEFAULT_LOCALE.hl,
  gl = DEFAULT_LOCALE.gl,
  launchOptions = {},
} = {}) {
  const opts = { ...SCROLL_DEFAULTS };
  const targetUrl = buildTargetUrl(hl, gl);
  const browser = await chromium.launch({
    headless: !headed,
    ...(channel ? { channel } : {}),
    ...launchOptions,
  });

  try {
    const context = await browser.newContext({
      locale: LOCALE_MAP[hl] || `${hl}-${gl}`,
      viewport: opts.viewport,
      userAgent: USER_AGENT,
      extraHTTPHeaders: { "Accept-Language": `${hl},${hl};q=0.9,en;q=0.8` },
    });
    await context.addInitScript(captureScript);
    const page = await context.newPage();

    // 네트워크(초기 HTML + batchexecute)에서 확보한 앱
    const rpcApps = new Map(); // batchexecute 응답
    const embeddedApps = new Map(); // 초기 HTML(AF_initDataCallback)
    const addApp = (map, app) => {
      const prev = map.get(app.packageId);
      map.set(app.packageId, prev ? { ...prev, ...app } : app);
    };
    const addNetworkApps = (map, apps) => {
      for (const app of apps) addApp(map, app);
    };
    const networkTotal = () => new Set([...rpcApps.keys(), ...embeddedApps.keys()]).size;

    const t0 = Date.now();
    const response = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    const status = response ? response.status() : 0;

    // 초기 HTML 에 심어진 앱 데이터(첫 20개) — DOM 에는 가격이 안 그려지는 카드가 있음
    let embeddedCount = 0;
    try {
      const html = await response.text();
      const embedded = parseEmbeddedApps(html);
      embeddedCount = embedded.length;
      addNetworkApps(embeddedApps, embedded);
      if (verbose) console.log(`[scrape] 초기 HTML 앱 데이터: ${embeddedCount}개`);
    } catch (err) {
      if (verbose) console.warn(`[scrape] 초기 HTML 파싱 실패: ${err.message}`);
    }

    // 카드 대기 (셀렉터 폴백)
    let matched = null;
    for (const sel of CARD_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: 12000 });
        matched = sel;
        break;
      } catch {
        /* 다음 폴백 */
      }
    }
    if (!matched) throw new Error("카드 셀렉터를 찾지 못했습니다. DOM 구조 변경 가능성.");
    if (verbose) console.log(`[scrape] 카드 셀렉터: ${matched}`);

    await page.waitForTimeout(2500); // hydration 대기
    const initialCards = await page.locator(CARD).count();

    const seen = new Map();
    const extractArgs = {
      fieldSelectors: FIELD_SELECTORS,
      cardSelector: CARD,
      pricePattern: PRICE_PATTERN,
    };
    const { timeline, stopReason, scrolls } = await scrollToEnd(page, opts, seen, extractArgs, {
      networkApps: rpcApps,
      networkTotal,
    });

    await page.waitForTimeout(800);
    await drainNetwork(page, rpcApps);

    // 병합: 네트워크(정확한 구조화 데이터) 우선, DOM은 보강/폴백
    const merged = new Map();
    const domIds = new Set(seen.keys());

    for (const [pkg, app] of rpcApps) {
      const origNum = priceNumber(app.originalPrice);
      merged.set(pkg, {
        packageId: app.packageId,
        name: app.name,
        genre: app.genre,
        rating: app.rating,
        discountPercent: app.discountPercent,
        originalPrice: app.originalPrice,
        salePrice: app.salePrice,
        currency: app.currency,
        imageUrl: app.imageUrl,
        productUrl: app.productUrl,
        saleEndDate: app.saleEndDate,
        isPaid: Number.isFinite(origNum) ? origNum > 0 : true,
      });
    }

    // 초기 HTML 앱 중 컬렉션에 실제로 존재하는 것만 채택 (다른 섹션 데이터 혼입 방지)
    let strayEmbedded = 0;
    for (const [pkg, app] of embeddedApps) {
      const inCollection = domIds.has(pkg) || rpcApps.has(pkg);
      if (!inCollection) {
        strayEmbedded += 1;
        continue;
      }
      if (!merged.has(pkg)) merged.set(pkg, { ...app, isPaid: true });
    }

    let domOnly = 0;
    for (const raw of seen.values()) {
      const game = normalizeGame(raw);
      if (!game.packageId) continue;
      const existing = merged.get(game.packageId);
      if (!existing) {
        merged.set(game.packageId, game);
        domOnly += 1;
        continue;
      }
      for (const [field, value] of Object.entries(game)) {
        if (field === "packageId") continue;
        if (value && (!existing[field] && existing[field] !== 0)) existing[field] = value;
      }
    }

    const games = Array.from(merged.values()).filter((g) => g.name && g.packageId);
    const paidGames = sortBySaleEndDesc(games.filter(isSaleGame));
    const excluded = games.filter((g) => !isSaleGame(g));

    if (verbose) {
      console.log(
        `[scrape] 네트워크 ${networkTotal()}개(batchexecute ${rpcApps.size} + 초기HTML ${embeddedApps.size}, 제외된 HTML ${strayEmbedded}) | DOM ${seen.size}개 (DOM만 존재 ${domOnly}개) → 할인 유료게임 ${paidGames.length}개`
      );
      const last = timeline[timeline.length - 1];
      console.log(
        `[scrape] 스크롤 ${scrolls}회 | 종료=${stopReason} | 최하단도달=${last ? last.atBottom : false} | DOM 최종 ${last ? last.domCards : 0}장`
      );
      if (networkTotal() === 0) {
        console.warn("[scrape] 경고: 네트워크 응답 파싱 0건 (DOM 수집값만 사용). 구조 변경 가능성.");
      }
      if (excluded.length) {
        console.log(`[scrape] 제외 ${excluded.length}개 (가격/할인 정보 없음):`);
        for (const g of excluded.slice(0, 30)) {
          console.log(`  - ${g.name} | ${g.originalPrice || "-"} → ${g.salePrice || "-"} | ${g.discountPercent ?? "-"}%`);
        }
      }
    }

    return {
      scrapedAt: new Date().toISOString(),
      sourceUrl: targetUrl,
      locale: { hl, gl },
      httpStatus: status,
      initialCards,
      finalCards: await page.locator(CARD).count(),
      collectedCards: games.length,
      networkCards: networkTotal(),
      embeddedCards: embeddedCount,
      domCards: seen.size,
      uniquePackages: new Set(paidGames.map((g) => g.packageId)).size,
      scroll: { stopReason, scrolls, timeline },
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
      games: paidGames,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await scrape({
    channel: args.channel,
    headed: args.headed,
    verbose: args.verbose,
    hl: args.hl,
    gl: args.gl,
  });

  console.log(`[scrape] URL: ${result.sourceUrl}`);
  console.log(
    `[scrape] HTTP ${result.httpStatus} | 초기 ${result.initialCards} → 최종 ${result.finalCards} 카드 | 수집 ${result.collectedCards}개 (네트워크 ${result.networkCards} / DOM ${result.domCards})`
  );
  console.log(`[scrape] 고유 패키지 ${result.uniquePackages} | 스크롤 ${result.scroll.scrolls}회 (${result.scroll.stopReason})`);
  console.log(`[scrape] 소요 ${result.elapsedSec}s`);

  const currencies = result.games.reduce((acc, g) => {
    const c = g.currency || "-";
    acc[c] = (acc[c] || 0) + 1;
    return acc;
  }, {});
  const withDiscount = result.games.filter((g) => g.discountPercent).length;
  const withEnd = result.games.filter((g) => g.saleEndDate).length;
  console.log(`[scrape] 할인정보 보유 ${withDiscount}/${result.games.length} | 종료일 보유 ${withEnd}/${result.games.length}`);
  console.log(`[scrape] 통화: ${JSON.stringify(currencies)}`);

  if (args.verbose) {
    for (const g of result.games.slice(0, 5)) {
      console.log(
        `  - ${g.name} | ${g.genre} | ${g.originalPrice} → ${g.salePrice} | ${g.discountPercent}% | ★${g.rating} | ~${g.saleEndDate}`
      );
    }
  }

  if (result.games.length === 0) {
    console.error("[scrape] 결과 0건 → 실패로 처리합니다.");
    process.exit(2);
  }

  writeFileSync(args.out, JSON.stringify(result, null, 2), "utf8");
  console.log(`[scrape] 저장: ${args.out}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((err) => {
    console.error(`[scrape] 실패: ${err.stack || err.message}`);
    process.exit(1);
  });
}
