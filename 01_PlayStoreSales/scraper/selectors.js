/**
 * Play Store DOM 셀렉터 정의 + 폴백 체인
 *
 * 2026-09 실측(probe.py)으로 검증된 셀렉터입니다.
 * Play Store는 클래스명이 자주 바뀌므로 반드시 폴백을 함께 사용합니다.
 */

export const URL_BASE =
  "https://play.google.com/store/apps/collection/promotion_3002a18_gamesonsale";

// gl=US 필수: 없으면 할인 정보가 2/22만 채워짐 (실측 확인)
export const TARGET_URL = `${URL_BASE}?hl=en&gl=US`;

// 카드 컨테이너: ancestor이 jscontroller=tKHFxf 인 div (실측 173개)
export const CARD_SELECTORS = [
  'div[jscontroller="tKHFxf"]',
  'div[jscontroller] a[href*="/store/apps/details?id="]',
];

// 카드 셀터 (Playwright locator용, 첫 번째 것 사용)
export const CARD = CARD_SELECTORS[0];

// 필드별 폴백 체인 (querySelector 배열)
export const FIELD_SELECTORS = {
  name: ["span.sT93pb.DdYX5.OnEJge", "span.DdYX5", "div.cXFu1 span"],
  genre: ["span.sT93pb.w2kbF", "div.cXFu1 > div.ubGTjb span"],
  discount: ["span.W0agu"],
  ratingAria: ['[aria-label^="Rated "]'],
  originalPrice: ["span.sT93pb.JUF8md.ePXqnb", "span.JUF8md"],
  salePrice: ["span.sT93pb.w2kbF.Q64Ric", "span.Q64Ric"],
  thumbnail: ["img.T75of.stzEZd", "img.T75of", "img"],
  link: ['a[href*="/store/apps/details?id="]'],
};

// 정지 판정 기본값 (실측: 7회 스크롤, 8.5초에 173개 도달)
export const SCROLL_DEFAULTS = {
  maxScrolls: 80,
  stableNeeded: 3,
  settleMs: 1200,
  maxSeconds: 240,
  viewport: { width: 1440, height: 900 },
};

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";