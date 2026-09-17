/**
 * Play Store 'Games on sale' 무한스크롤 스크래퍼 (Playwright / Node)
 *
 * 사용:
 *   node scrape.js --out games.json
 *   node scrape.js --channel chrome       (로컬 Chrome 사용, 브라우저 다운로드 불필요)
 *
 * 실측(2026-09, Python probe.py):
 *   ?hl=en&gl=US → 초기 20개 → 스크롤 7회 → 173개 (고유 packageId 173), 총 12.5초
 *   gl 미지정 시 할인 정보가 2/22만 채워짐 → gl=US 필수
 */

import { writeFileSync } from "node:fs";
import { chromium } from "playwright";
import {
  TARGET_URL,
  CARD,
  CARD_SELECTORS,
  FIELD_SELECTORS,
  SCROLL_DEFAULTS,
  USER_AGENT,
} from "./selectors.js";

const PRICE_PATTERN = "\\$\\s?\\d[\\d.,]*|€\\s?\\d[\\d.,]*|£\\s?\\d[\\d.,]*|[A-Z]{3}\\s?\\d[\\d.,]*";

export function parseArgs(argv) {
  const args = { out: "games.json", channel: null, verbose: false, headed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--out" && argv[i + 1]) args.out = argv[++i];
    else if (a === "--channel" && argv[i + 1]) args.channel = argv[++i];
    else if (a === "--headed") args.headed = true;
    else if (a === "--verbose") args.verbose = true;
  }
  return args;
}

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
      discountText: text(discountEl),
      originalPriceText: text(origEl),
      salePriceText: text(saleEl),
      priceTexts: cardText.match(priceRe) || [],
      imageUrl: thumbEl ? thumbEl.getAttribute("src") : null,
      productUrl: href ? `https://play.google.com${href}` : null,
    };
  });
}
/** 원시 DOM 값을 기존 GAS `game` 스키마로 정규화 */
export function normalizeGame(raw) {
  const rating = raw.ratingText ? parseFloat(raw.ratingText.replace(/[^\d.]/g, "")) : NaN;
  const discount = raw.discountText ? parseInt(raw.discountText.replace(/[^\d]/g, ""), 10) : NaN;

  let salePrice = raw.salePriceText;
  let originalPrice = raw.originalPriceText;

  // 셀렉터가 비었으면 카드 텍스트의 통화 패턴으로 백
  if (!salePrice && raw.priceTexts.length) {
    salePrice = raw.priceTexts[raw.priceTexts.length - 1];
    originalPrice = originalPrice || raw.priceTexts[0];
  }

  const isPaid = Boolean(originalPrice) && !/^free$/i.test(String(originalPrice).trim());

  return {
    packageId: raw.packageId,
    name: raw.name,
    genre: raw.genre,
    rating: Number.isFinite(rating) ? rating : null,
    discountPercent: Number.isFinite(discount) ? discount : null,
    originalPrice: originalPrice || null,
    salePrice: salePrice || null,
    imageUrl: raw.imageUrl,
    productUrl: raw.productUrl,
    saleEndDate: null,
    isPaid,
  };
}

/** 무한스크롤: scrollHeight/카드 수가 stableNeeded회 연속 동일하면 정지 */
async function scrollUntilStable(page, opts) {
  const timeline = [];
  let stable = 0;
  let lastH = -1;
  let lastN = -1;
  const started = Date.now();

  for (let step = 0; step <= opts.maxScrolls; step += 1) {
    const h = await page.evaluate(() => document.body.scrollHeight);
    const n = await page.locator(CARD).count();
    timeline.push({
      step,
      cards: n,
      scrollHeight: h,
      elapsedSec: Number(((Date.now() - started) / 1000).toFixed(2)),
    });

    if (h === lastH && n === lastN) stable += 1;
    else stable = 0;
    lastH = h;
    lastN = n;

    if (stable >= opts.stableNeeded) return { timeline, stopReason: "stable" };
    if ((Date.now() - started) / 1000 > opts.maxSeconds) return { timeline, stopReason: "time-limit" };

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(opts.settleMs);
  }
  return { timeline, stopReason: "max-scrolls" };
}
export async function scrape({ channel = null, headed = false, verbose = false, launchOptions = {} } = {}) {
  const opts = { ...SCROLL_DEFAULTS };
  const browser = await chromium.launch({
    headless: !headed,
    ...(channel ? { channel } : {}),
    ...launchOptions,
  });

  try {
    const context = await browser.newContext({
      locale: "en-US",
      viewport: opts.viewport,
      userAgent: USER_AGENT,
    });
    const page = await context.newPage();

    const t0 = Date.now();
    const response = await page.goto(TARGET_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    const status = response ? response.status() : 0;

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

    const { timeline, stopReason } = await scrollUntilStable(page, opts);
    const rawCards = await page.evaluate(extractInPage, {
      fieldSelectors: FIELD_SELECTORS,
      cardSelector: CARD,
      pricePattern: PRICE_PATTERN,
    });

    const games = rawCards
      .map((raw) => normalizeGame(raw))
      .filter((g) => g.name && g.packageId);

    // 할인 정보(가격/할인율)가 없는 항목은 무료 앱(F2P)이므로 제외
    const paidGames = games.filter((g) => g.originalPrice && g.discountPercent);
    if (verbose) {
      console.log(`[scrape] 전체 ${games.length}개 중 할인 유료게임 ${paidGames.length}개 (제외 ${games.length - paidGames.length}개)`);
    }

    return {
      scrapedAt: new Date().toISOString(),
      sourceUrl: TARGET_URL,
      httpStatus: status,
      initialCards,
      finalCards: await page.locator(CARD).count(),
      uniquePackages: new Set(paidGames.map((g) => g.packageId)).size,
      scroll: { stopReason, scrolls: timeline.length - 1, timeline },
      elapsedSec: Number(((Date.now() - t0) / 1000).toFixed(2)),
      games: paidGames,
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await scrape({ channel: args.channel, headed: args.headed, verbose: args.verbose });

  console.log(`[scrape] URL: ${result.sourceUrl}`);
  console.log(`[scrape] HTTP ${result.httpStatus} | 초기 ${result.initialCards} → 최종 ${result.finalCards} 카드`);
  console.log(`[scrape] 고유 패키지 ${result.uniquePackages} | 스크롤 ${result.scroll.scrolls}회 (${result.scroll.stopReason})`);
  console.log(`[scrape] 소요 ${result.elapsedSec}s`);

  const withDiscount = result.games.filter((g) => g.discountPercent).length;
  const paid = result.games.filter((g) => g.isPaid).length;
  console.log(`[scrape] 유료 ${paid}/${result.games.length} | 할인정보 보유 ${withDiscount}/${result.games.length}`);

  if (args.verbose) {
    for (const g of result.games.slice(0, 5)) {
      console.log(`  - ${g.name} | ${g.genre} | ${g.originalPrice} → ${g.salePrice} | ${g.discountPercent}%`);
    }
  }

  if (result.games.length === 0) {
    console.error("[scrape] 결과 0건 → 실패로 처리합니다.");
    process.exit(2);
  }

  writeFileSync(args.out, JSON.stringify(result, null, 2), "utf8");
  console.log(`[scrape] 저장: ${args.out}`);
}

main().catch((err) => {
  console.error(`[scrape] 실패: ${err.stack || err.message}`);
  process.exit(1);
});
