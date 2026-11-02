/**
 * Play Store DOM 셀렉터 정의 + 폴백 체인
 *
 * 2026-09 실측(probe.py, hl=en&gl=US) / 2026-11 실측(hl=ko&gl=AE) 기준.
 * Play Store는 클래스명이 자주 바뀌므로 반드시 폴백을 함께 사용합니다.
 */

export const URL_BASE =
  "https://play.google.com/store/apps/collection/promotion_3002a18_gamesonsale";

/**
 * 기본 로케일: 한국어 UI + 아랍에미리트(AED) 가격
 *   hl=ko → UI 언어(한국어), gl=AE → 국가/통화(AED)
 *   가격 표기 실측: "AED 10.99"
 *
 * gl 을 지정하지 않으면 할인 정보가 일부만 채워지므로(실측) 반드시 지정합니다.
 */
export const DEFAULT_LOCALE = { hl: "ko", gl: "AE" };

/** hl 값에 대응하는 브라우저 locale (Accept-Language 등에 사용) */
export const LOCALE_MAP = {
  ko: "ko-KR",
  en: "en-US",
  ar: "ar-AE",
  ja: "ja-JP",
  zh: "zh-CN",
};

export function buildTargetUrl(hl = DEFAULT_LOCALE.hl, gl = DEFAULT_LOCALE.gl) {
  return `${URL_BASE}?hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}`;
}

export const TARGET_URL = buildTargetUrl();

// 카드 컨테이너: ancestor이 jscontroller=tKHFxf 인 div (ko/AE 실측 176개)
export const CARD_SELECTORS = [
  'div[jscontroller="tKHFxf"]',
  'div[jscontroller] a[href*="/store/apps/details?id="]',
];

// 카드 셀렉터 (Playwright locator용, 첫 번째 것 사용)
export const CARD = CARD_SELECTORS[0];

// 필드별 폴백 체인 (querySelector 배열)
export const FIELD_SELECTORS = {
  name: ["span.sT93pb.DdYX5.OnEJge", "span.DdYX5", "div.cXFu1 span"],
  genre: ["span.sT93pb.w2kbF:not(.Q64Ric)", "div.cXFu1 > div.ubGTjb span"],
  discount: ["span.W0agu"],
  // 별점: role="img" + aria-label (en: "Rated 4.5...", ko: "별표 5개 만점에 4.5개를 받았습니다.")
  ratingAria: [
    'div[role="img"][aria-label^="별표"]',
    '[aria-label^="Rated "]',
    'div[role="img"][aria-label]',
  ],
  // aria-label 이 없을 때 숫자만 뽑기 위한 폴백 (span.CKzsaf 안의 4.9)
  ratingValue: ["span.CKzsaf span.w2kbF", "span.CKzsaf"],
  originalPrice: ["span.sT93pb.JUF8md.ePXqnb", "span.JUF8md"],
  salePrice: ["span.sT93pb.w2kbF.Q64Ric", "span.Q64Ric"],
  thumbnail: ["img.T75of.stzEZd", "img.T75of", "img"],
  link: ['a[href*="/store/apps/details?id="]'],
};

// 정지 판정 기본값 (실측: ko/AE 176개, 스크롤 7회 / 11초)
export const SCROLL_DEFAULTS = {
  maxScrolls: 120,
  stableNeeded: 3,
  settleMs: 1200,
  maxSeconds: 300,
  viewport: { width: 1440, height: 900 },
  wheelDelta: 2400,
};

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
