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
  const subject = count + " New Game" + (count > 1 ? "s" : "") + " on Sale!";
  GmailApp.sendEmail(CONFIG.EMAIL, subject, "HTML 이메일을 볼 수 있는 클라이언트로 확인하세요.", {
    htmlBody: htmlBody,
    name: "Play Store Sale Alert",
  });
  console.log("이메일 발송: " + CONFIG.EMAIL);
}

function sendErrorEmail(errorMessage) {
  GmailApp.sendEmail(CONFIG.EMAIL, "Play Store Sale Checker Error", "오류 발생:\n\n" + errorMessage);
}

function buildEmailHTML(games) {
  var html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\"></head>";
  html += "<body style=\"margin:0;padding:20px;background:#1a1a2e;font-family:Arial,sans-serif;\">";
  html += "<div style=\"max-width:640px;margin:0 auto;background:#16213e;border-radius:12px;padding:20px;color:#fff;\">";
  html += "<h1 style=\"text-align:center;margin:0 0 4px;\">Games on Sale!</h1>";
  html += "<p style=\"text-align:center;color:#a8d8ea;margin:0 0 20px;\">" + games.length + " new games</p>";
  games.forEach(function (game) {
    html += buildGameCard(game);
  });
  html += "<p style=\"text-align:center;color:#666;font-size:12px;margin-top:20px;\">" +
    "Source: play.google.com games on sale collection</p>";
  html += "</div></body></html>";
  return html;
}

function buildGameCard(game) {
  var html = "<div style=\"background:#1a1a2e;border-radius:10px;padding:15px;margin-bottom:15px;\">";
  html += "<table style=\"border-collapse:collapse;width:100%;\"><tr>";

  if (game.imageUrl) {
    html += "<td style=\"width:72px;vertical-align:top;padding-right:12px;\">";
    html += "<img src=\"" + game.imageUrl + "\" width=\"64\" height=\"64\" " +
      "style=\"border-radius:12px;display:block;\" alt=\"icon\"/>";
    html += "</td>";
  }

  html += "<td style=\"vertical-align:top;\">";
  html += "<h3 style=\"color:#fff;margin:0 0 6px;font-size:16px;\">" + escapeHtml(game.name) + "</h3>";

  var meta = [];
  if (game.genre) meta.push(escapeHtml(game.genre));
  if (game.rating) meta.push("★ " + game.rating);
  if (meta.length) {
    html += "<p style=\"color:#a8d8ea;margin:0 0 8px;font-size:13px;\">" + meta.join(" · ") + "</p>";
  }

  html += "<p style=\"margin:0;font-size:14px;\">";
  if (game.originalPrice) {
    html += "<span style=\"color:#888;text-decoration:line-through;\">" +
      escapeHtml(game.originalPrice) + "</span> ";
  }
  if (game.salePrice) {
    html += "<span style=\"color:#4ade80;font-weight:bold;\">" + escapeHtml(game.salePrice) + "</span>";
  }
  html += "</p>";

  if (game.discountPercent) {
    html += "<span style=\"display:inline-block;margin-top:8px;background:#e94560;color:#fff;" +
      "padding:3px 10px;border-radius:15px;font-size:12px;\">-" + game.discountPercent + "%</span>";
  }
  if (game.productUrl) {
    html += " <a href=\"" + game.productUrl + "\" style=\"color:#a8d8ea;font-size:12px;" +
      "margin-left:8px;\">Open in Play Store</a>";
  }
  html += "</td></tr></table></div>";
  return html;
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
    { packageId: "com.test.one", name: "Sample Game 1", genre: "Action", rating: 4.5,
      discountPercent: 50, originalPrice: "$9.99", salePrice: "$4.99",
      imageUrl: null, productUrl: "https://play.google.com" },
    { packageId: "com.test.two", name: "Sample Game 2", genre: "Puzzle", rating: 4.8,
      discountPercent: 30, originalPrice: "$4.99", salePrice: "$3.49",
      imageUrl: null, productUrl: "https://play.google.com" },
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
