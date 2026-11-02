/**
 * PLAY STORE GAME SALE ALERT SYSTEM v3.0
 *
 * 아키텍처 (B안):
 *   [GAS 트리거 일 1회] --workflow_dispatch--> [GitHub Actions: Playwright 스크랩]
 *                                                        |
 *                                                        v POST {token, games[]}
 *                                            [GAS doPost] -> 중복제거 -> Gmail 발송
 *
 * GAS 역할: 스케줄러(워커 깨우기) + 수신(doPost) + 중복관리 + 이메일 발송
 * Playwright는 GAS에서 실행 불가하므로 GitHub Actions에서 수행한다.
 *
 * 필수 Script Properties:
 *   SHARED_TOKEN    - GitHub Actions와 공유하는 인증 토큰
 *   GITHUB_PAT      - workflow_dispatch 호출용 Fine-grained PAT (Actions: RW)
 *   GITHUB_REPO     - "owner/repo" 형식
 *   GITHUB_WORKFLOW - 워크플로 파일명 (예: play-store-sales.yml)
 *   GITHUB_REF      - 브랜치 (기본 main)
 */

const CONFIG = {
  EMAIL: "lostempus06@gmail.com",
  SENT_GAMES_KEY: "SENT_GAMES_V1",
  MAX_GAMES: 500,
  TOKEN_PROP: "SHARED_TOKEN",
  GITHUB: {
    PAT_PROP: "GITHUB_PAT",
    REPO_PROP: "GITHUB_REPO",
    WORKFLOW_PROP: "GITHUB_WORKFLOW",
    REF_PROP: "GITHUB_REF",
    DEFAULT_WORKFLOW: "play-store-sales.yml",
    DEFAULT_REF: "main",
  },
};

/** 워커가 밀어넣은 JSON을 받아 처리하는 Web App 엔드포인트 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse({ ok: false, error: "empty body" });
    }
    const body = JSON.parse(e.postData.contents);
    const expected = PropertiesService.getScriptProperties().getProperty(CONFIG.TOKEN_PROP);
    if (expected && body.token !== expected) {
      console.warn("doPost: 토큰 불일치");
      return jsonResponse({ ok: false, error: "unauthorized" });
    }

    const games = Array.isArray(body.games) ? body.games : [];
    console.log("doPost 수신: " + games.length + "개 (source=" + (body.sourceUrl || "-") + ")");
    if (games.length === 0) {
      return jsonResponse({ ok: false, error: "no games" });
    }

    const stats = processGames(games);
    console.log("doPost 완료: 신규 " + stats.newGames + " / 기존 " + stats.alreadySent);
    return jsonResponse({
      ok: true,
      received: games.length,
      newGames: stats.newGames,
      alreadySent: stats.alreadySent,
      emailed: stats.emailed,
    });
  } catch (error) {
    console.error("doPost 오류: " + error.message);
    return jsonResponse({ ok: false, error: error.message });
  }
}

/** 헬스체크 */
function doGet() {
  return jsonResponse({
    ok: true,
    version: "v3.0",
    endpoint: "play-store-sale-alert",
    hasToken: Boolean(PropertiesService.getScriptProperties().getProperty(CONFIG.TOKEN_PROP)),
    sentGamesCount: Object.keys(loadSentGames()).length,
  });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

/** GitHub Actions 워크플로를 workflow_dispatch로 깨운다 */
function triggerWorker() {
  const props = PropertiesService.getScriptProperties();
  const pat = props.getProperty(CONFIG.GITHUB.PAT_PROP);
  const repo = props.getProperty(CONFIG.GITHUB.REPO_PROP);
  const workflow =
    props.getProperty(CONFIG.GITHUB.WORKFLOW_PROP) || CONFIG.GITHUB.DEFAULT_WORKFLOW;
  const ref = props.getProperty(CONFIG.GITHUB.REF_PROP) || CONFIG.GITHUB.DEFAULT_REF;

  if (!pat || !repo) {
    throw new Error("GITHUB_PAT / GITHUB_REPO 스크립트 속성이 설정되지 않았습니다.");
  }

  const url =
    "https://api.github.com/repos/" + repo + "/actions/workflows/" + workflow + "/dispatches";
  const options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify({ ref: ref }),
    muteHttpExceptions: true,
    headers: {
      Authorization: "Bearer " + pat,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gas-play-store-sale-alert",
    },
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  console.log("workflow_dispatch 응답: " + code);
  if (code !== 204 && code !== 200) {
    throw new Error("workflow_dispatch 실패 HTTP " + code + ": " + response.getContentText());
  }
  return { ok: true, status: code };
}

/** 트리거 진입점: 워커를 깨운다 (결과는 워커가 doPost로 되돌려준다) */
function main() {
  console.log("=== Play Store Game Sale Alert v3.0 ===");
  try {
    console.log("워커 호출: " + JSON.stringify(triggerWorker()));
  } catch (error) {
    console.error("main 오류: " + error.message);
    sendErrorEmail(error.message);
  }
}
/** 수신한 게임 목록을 중복 제거 후 이메일 발송 */
function processGames(games) {
  const result = filterNewGamesOnly(games);
  const newGames = result.newGames;
  console.log("신규: " + newGames.length + " | 기존: " + result.alreadySent.length);

  let emailed = 0;
  if (newGames.length > 0) {
    const htmlBody = buildEmailHTML(newGames);
    sendEmail(newGames.length, htmlBody);
    updateSentGamesRecord(newGames);
    emailed = 1;
  } else {
    console.log("새로 알릴 게임이 없습니다.");
  }
  return { newGames: newGames.length, alreadySent: result.alreadySent.length, emailed: emailed };
}

function filterNewGamesOnly(games) {
  const sentGames = loadSentGames();
  const newGames = [];
  const alreadySent = [];
  games.forEach(function (game) {
    const key = normalizeGameKey(game);
    const discount = String(game.discountPercent || 0);
    if (sentGames[key] === discount) {
      alreadySent.push(game);
    } else {
      newGames.push(game);
    }
  });
  return { newGames: newGames, alreadySent: alreadySent };
}

/** 중복 판정 키: packageId 우선, 없으면 이름 */
function normalizeGameKey(game) {
  if (!game) return "";
  if (game.packageId) return String(game.packageId).trim().toLowerCase();
  return String(game.name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function loadSentGames() {
  const raw = PropertiesService.getScriptProperties().getProperty(CONFIG.SENT_GAMES_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveSentGames(sentGames) {
  PropertiesService.getScriptProperties().setProperty(
    CONFIG.SENT_GAMES_KEY,
    JSON.stringify(sentGames)
  );
}

/** 발송 기록 갱신: 키 -> 할인율 (할인율이 바뀌면 다시 알림) */
function updateSentGamesRecord(games) {
  const sentGames = loadSentGames();
  games.forEach(function (game) {
    sentGames[normalizeGameKey(game)] = String(game.discountPercent || 0);
  });
  pruneOldEntries(sentGames);
  saveSentGames(sentGames);
}

function sendEmail(count, htmlBody) {
  const subject = "구글 PlayStore 세일 " + count + "개";
  GmailApp.sendEmail(CONFIG.EMAIL, subject, "HTML 이메일을 볼 수 있는 클라이언트로 확인하세요.", {
    htmlBody: htmlBody,
    name: "Play Store Sale Alert",
  });
  console.log("이메일 발송: " + CONFIG.EMAIL);
}

function sendErrorEmail(errorMessage) {
  GmailApp.sendEmail(CONFIG.EMAIL, "Play Store Sale Checker Error", "오류 발생:\n\n" + errorMessage);
}

/** GitHub Pages 주소 (스크립트 속성 SITE_URL, 없으면 빈 문자열) */
function getSiteUrl() {
  try {
    const url = PropertiesService.getScriptProperties().getProperty("SITE_URL");
    return url ? String(url).trim() : "";
  } catch (e) {
    return "";
  }
}

/** "AED 10.99" → 10.99 */
function priceValue(text) {
  if (!text) return NaN;
  const m = String(text).replace(/\u00a0/g, " ").match(/\d[\d.,]*/);
  if (!m) return NaN;
  const num = parseFloat(m[0].replace(/,/g, ""));
  return isFinite(num) ? num : NaN;
}

/** 할인 종료일 내림차순 (종료일 없는 항목은 맨 뒤) */
function sortBySaleEndDesc(games) {
  return games.slice().sort(function (a, b) {
    const ta = a.saleEndDate ? new Date(a.saleEndDate).getTime() : NaN;
    const tb = b.saleEndDate ? new Date(b.saleEndDate).getTime() : NaN;
    if (isFinite(ta) && isFinite(tb)) return tb - ta;
    if (isFinite(ta)) return -1;
    if (isFinite(tb)) return 1;
    return (b.discountPercent || 0) - (a.discountPercent || 0);
  });
}

/** 할인 종료 시각 (Dubai 기준, Play 스토어와 동일) */
function formatSaleEnd(iso) {
  if (!iso) return "";
  try {
    return Utilities.formatDate(new Date(iso), "Asia/Dubai", "MM.dd HH:mm");
  } catch (e) {
    return "";
  }
}

function sortBySaleEndAsc(games) {
  return games.slice().sort(function (a, b) {
    const ta = a.saleEndDate ? Date.parse(a.saleEndDate) : NaN;
    const tb = b.saleEndDate ? Date.parse(b.saleEndDate) : NaN;
    if (isNaN(ta) && isNaN(tb)) return 0;
    if (isNaN(ta)) return 1;
    if (isNaN(tb)) return -1;
    return ta - tb;
  });
}

function buildEmailHTML(games) {
  const list = sortBySaleEndAsc(games);
  const freeCount = list.filter(function (g) {
    return priceValue(g.salePrice) === 0;
  }).length;
  const maxDiscount = list.reduce(function (max, g) {
    return Math.max(max, g.discountPercent || 0);
  }, 0);

  const html = [];
  html.push('<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">');
  html.push('<meta name="viewport" content="width=device-width,initial-scale=1"></head>');
  html.push('<body style="margin:0;padding:0;background:#0b0b0c;">');
  html.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="background:#0b0b0c;padding:24px 12px;"><tr><td align="center">');
  html.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="max-width:620px;width:100%;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,\'Noto Sans KR\',Arial,sans-serif;">');

  // 헤더
  html.push('<tr><td style="padding:0 0 18px;">');
  html.push('<div style="font-size:12px;letter-spacing:1.2px;color:#4ade80;font-weight:700;">PLAY STORE SALE</div>');
  html.push('<div style="margin-top:6px;font-size:26px;line-height:1.25;font-weight:800;color:#f5f5f7;">새로 할인하는 게임 ' +
    list.length + '개</div>');
  html.push('<div style="margin-top:8px;font-size:13px;color:#8e8e96;">한국어 UI · AED 가격 · 종료 임박순 정렬</div>');
  const siteUrl = getSiteUrl();
  if (siteUrl) {
    html.push('<div style="margin-top:14px;">' +
      '<a href="' + escapeHtml(siteUrl) + '" style="display:inline-block;background:#4ade80;color:#06230f;' +
      'font-size:13px;font-weight:700;text-decoration:none;padding:9px 15px;border-radius:10px;">' +
      '전체 목록 웹에서 보기 →</a></div>');
  }
  html.push('</td></tr>');

  // 요약 칩
  html.push('<tr><td style="padding:0 0 16px;">');
  html.push('<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>');
  const chips = [
    ["신규", list.length + "개", "#4ade80"],
    ["100% 할인", freeCount + "개", "#4ade80"],
    ["최대 할인", maxDiscount + "%", "#f5a524"],
  ];
  chips.forEach(function (chip) {
    html.push('<td style="padding-right:8px;">');
    html.push('<div style="background:#14161b;border:1px solid #232329;border-radius:12px;' +
      'padding:9px 13px;font-size:12px;color:#8e8e96;">' + chip[0] +
      ' <b style="color:' + chip[2] + ';font-size:14px;">' + chip[1] + '</b></div>');
    html.push('</td>');
  });
  html.push('</tr></table></td></tr>');

  // 게임 카드
  list.forEach(function (game) {
    html.push(buildGameCard(game));
  });

  // 푸터
  html.push('<tr><td style="padding:18px 2px 0;border-top:1px solid #232329;">');
  html.push('<div style="font-size:12px;line-height:1.7;color:#5d5d66;">' +
    '출처: play.google.com “Games on sale” 컬렉션 · 가격은 VAT 포함 표시가이며 계정 국가에 따라 달라질 수 있습니다.<br>' +
    '정렬: 할인 종료 임박순 · 시간은 Dubai 기준(ST+4).</div>');
  html.push('</td></tr>');

  html.push('</table></td></tr></table></body></html>');
  return html.join("");
}

function buildGameCard(game) {
  const orig = priceValue(game.originalPrice);
  const sale = priceValue(game.salePrice);
  const isFree = sale === 0;
  const currency = (String(game.originalPrice || game.salePrice || "").match(/[A-Z]{3}/) || [""])[0];
  const saved = isFinite(orig) && isFinite(sale) && orig > sale ? orig - sale : NaN;
  const endText = formatSaleEnd(game.saleEndDate);

  const html = [];
  html.push('<tr><td style="padding:0 0 10px;">');
  html.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" ' +
    'style="background:#14161b;border:1px solid #232329;border-radius:16px;"><tr>');

  // 아이콘
  html.push('<td width="76" valign="top" style="padding:14px 0 14px 14px;">');
  if (game.imageUrl) {
    html.push('<a href="' + escapeHtml(game.productUrl || "#") + '" style="text-decoration:none;">' +
      '<img src="' + escapeHtml(game.imageUrl) + '" width="64" height="64" alt="' +
      escapeHtml(game.name) + '" style="display:block;width:64px;height:64px;border-radius:16px;border:0;outline:none;">' +
      '</a>');
  }
  html.push('</td>');

  // 본문
  html.push('<td valign="top" style="padding:14px 14px 14px 12px;">');

  // 이름 + 할인 배지
  html.push('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>');
  html.push('<td style="font-size:16px;line-height:1.3;font-weight:700;color:#f5f5f7;">' +
    escapeHtml(game.name) + '</td>');
  if (game.discountPercent) {
    html.push('<td align="right" style="white-space:nowrap;padding-left:8px;">' +
      '<span style="display:inline-block;background:' + (isFree ? "#4ade80" : "#e94560") + ';color:' +
      (isFree ? "#06230f" : "#ffffff") + ';font-size:11px;font-weight:700;padding:3px 8px;border-radius:8px;">' +
      (isFree ? "FREE" : "-" + game.discountPercent + "%") + '</span></td>');
  }
  html.push('</tr></table>');

  // 메타 (장르 · 별점)
  const meta = [];
  if (game.genre) meta.push(escapeHtml(game.genre));
  if (game.rating) meta.push("★ " + game.rating);
  if (meta.length) {
    html.push('<div style="margin-top:5px;font-size:12px;color:#8e8e96;">' + meta.join(" · ") + '</div>');
  }

  // 가격
  html.push('<div style="margin-top:9px;font-size:15px;">');
  if (game.originalPrice) {
    html.push('<span style="color:#8e8e96;text-decoration:line-through;font-size:13px;">' +
      escapeHtml(game.originalPrice) + '</span> ');
  }
  if (game.salePrice) {
    html.push('<span style="color:' + (isFree ? "#4ade80" : "#f5f5f7") + ';font-weight:800;">' +
      escapeHtml(game.salePrice) + '</span>');
  }
  if (isFinite(saved) && saved > 0) {
    html.push('<span style="margin-left:8px;font-size:12px;color:#4ade80;">' +
      (currency ? currency + " " : "") + saved.toFixed(2) + ' 절약</span>');
  }
  html.push('</div>');

  // 종료 시각 + 링크
  html.push('<div style="margin-top:8px;font-size:12px;color:#8e8e96;">');
  if (endText) {
    html.push('⏳ ' + escapeHtml(endText) + ' 종료');
  }
  if (game.productUrl) {
    html.push((endText ? ' &nbsp;·&nbsp; ' : '') +
      '<a href="' + escapeHtml(game.productUrl) + '" style="color:#7fb2ff;text-decoration:none;font-weight:600;">' +
      'Play 스토어에서 열기 →</a>');
  }
  html.push('</div>');

  html.push('</td></tr></table>');
  html.push('</td></tr>');
  return html.join("");
}

function escapeHtml(text) {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 매일 09:00 KST에 워커를 깨우는 트리거 설치 */
function setupDailyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger("main").timeBased().everyDays(1).atHour(9).create();
  console.log("일일 트리거 설치 완료 (09:00)");
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    ScriptApp.deleteTrigger(t);
  });
  console.log("트리거 제거 완료");
}

/** 테스트: 샘플 게임으로 이메일 렌더링 확인 */
function testEmail() {
  var sample = [
    { packageId: "com.test.one", name: "Sample Game 1", genre: "액션", rating: 4.5,
      discountPercent: 50, originalPrice: "AED 9.99", salePrice: "AED 4.99",
      currency: "AED", imageUrl: null, productUrl: "https://play.google.com",
      saleEndDate: "2026-11-10T19:59:59.000Z" },
    { packageId: "com.test.two", name: "Sample Game 2", genre: "퍼즐", rating: 4.8,
      discountPercent: 100, originalPrice: "AED 4.99", salePrice: "AED 0.00",
      currency: "AED", imageUrl: null, productUrl: "https://play.google.com",
      saleEndDate: "2026-11-06T19:59:59.000Z" },
  ];
  sendEmail(sample.length, buildEmailHTML(sample));
}

/** 테스트: doPost 로직을 이메일 발송 없이 시뮬레이션 */
function testProcessGames() {
  var sample = [
    { packageId: "com.test.sim1", name: "Sim Game", genre: "Arcade", rating: 4.1,
      discountPercent: 25, originalPrice: "$3.99", salePrice: "$2.99", isPaid: true },
  ];
  var stats = processGames(sample);
  console.log("테스트 결과: " + JSON.stringify(stats));
  return stats;
}

/** 관리: 발송 기록 초기화 */
function clearSentGames() {
  PropertiesService.getScriptProperties().deleteProperty(CONFIG.SENT_GAMES_KEY);
  console.log("발송 기록 초기화 완료");
}

/** 관리: 현재 발송 기록 개수 확인 */
function showSentGamesCount() {
  console.log("기록된 게임 수: " + Object.keys(loadSentGames()).length);
}

/** 속성 크기 제한 대응: MAX_GAMES 초과분 제거 */
function pruneOldEntries(sentGames) {
  const keys = Object.keys(sentGames);
  if (keys.length <= CONFIG.MAX_GAMES) return;
  keys.slice(0, keys.length - CONFIG.MAX_GAMES).forEach(function (key) {
    delete sentGames[key];
  });
}
