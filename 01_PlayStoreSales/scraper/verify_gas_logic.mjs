/**
 * Code.gs 로직 로 검증 스크립트
 *
 * GAS 런타임 없이 doPost의 중복제거/이메일 드 로직을 확인한다.
 * GmailApp 대신 발송 내용을 콘솔/파일로 덤프한다.
 *
 * 사용:
 *   node verify_gas_logic.mjs [games.json 경로]
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// ---- GAS 전역 모킹 ----
const store = {};

globalThis.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => store[k] ?? null,
    setProperty: (k, v) => {
      store[k] = v;
    },
    deleteProperty: (k) => {
      delete store[k];
    },
  }),
};

const emailLog = [];
globalThis.GmailApp = {
  sendEmail: (to, subject, body, opts) => {
    emailLog.push({ to, subject, body, htmlBody: opts?.htmlBody || null });
  },
};

globalThis.ContentService = {
  MimeType: { JSON: "application/json" },
  createTextOutput: (text) => {
    const out = {
      _text: typeof text === "string" ? text : JSON.stringify(text),
      _mime: null,
      setMimeType(m) {
        out._mime = m;
        return out;
      },
      getContent: () => out._text,
    };
    return out;
  },
};

globalThis.ScriptApp = {
  newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => {} }) }) }) }),
  getProjectTriggers: () => [],
  deleteTrigger: () => {},
};

globalThis.UrlFetchApp = { fetch: () => ({ getResponseCode: () => 204, getContentText: () => "" }) };
globalThis.Utilities = {
  formatDate: (d, tz, fmt) => {
    // 실제 GAS는 tz 변환. 검증용으로 Dubai(ST+4) 고정 포맷만 흉내낸다.
    const shifted = new Date(new Date(d).getTime() + 4 * 3600 * 1000);
    const iso = shifted.toISOString();
    return `${iso.slice(5, 7)}.${iso.slice(8, 10)} ${iso.slice(11, 16)}`;
  },
};
globalThis.console = console;

// ---- Code.gs 로드 (전역 함수 주입) ----
const codeSrc = readFileSync(new URL("../Code.gs", import.meta.url), "utf8");
const loadCode = new Function(
  `${codeSrc}
   return { doPost, doGet, processGames, filterNewGamesOnly, normalizeGameKey,
            loadSentGames, buildEmailHTML, escapeHtml, clearSentGames };`
);
const gas = loadCode();

// ---- 테스트 ----
const gamesArg = process.argv.slice(2).find((a) => !a.startsWith("--"));
const gamesPath = gamesArg || new URL("./games.json", import.meta.url).pathname.replace(/^\//, "");
const payload = JSON.parse(readFileSync(gamesPath, "utf8"));
const games = payload.games || payload;

console.log(`[verify] 입력: ${games.length}개 게임`);

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name} ${detail}`);
  } else {
    fail += 1;
    console.error(`  FAIL  ${name} ${detail}`);
  }
}

// 1) 토큰 없이 호출 (SHARED_TOKEN 미설정 → 통과해야 함)
const res1 = JSON.parse(gas.doPost({ postData: { contents: JSON.stringify({ games }) } }).getContent());
check("첫 수신 성공", res1.ok === true, JSON.stringify(res1));
check("전부 신규", res1.newGames === games.length);
check("이메일 발송", emailLog.length === 1);
check("수신자 정확", emailLog[0]?.to === "lostempus06@gmail.com", emailLog[0]?.to);

// 2) 같은 데이터 재전송 → 중복 제거
const res2 = JSON.parse(gas.doPost({ postData: { contents: JSON.stringify({ games }) } }).getContent());
check("재전송 성공", res2.ok === true);
check("신규 0건", res2.newGames === 0, `newGames=${res2.newGames}`);
check("전부 기존", res2.alreadySent === games.length);
check("2번째 이메일 미발송", emailLog.length === 1, `emails=${emailLog.length}`);

// 3) 할인율 변경 시 재알림
const mutated = games.map((g, i) => (i === 0 ? { ...g, discountPercent: (g.discountPercent || 50) + 5 } : g));
const res3 = JSON.parse(gas.doPost({ postData: { contents: JSON.stringify({ games: mutated }) } }).getContent());
check("할인율 변경 감지", res3.newGames === 1, `newGames=${res3.newGames}`);
check("3번째 이메일 발송", emailLog.length === 2);

// 4)  body 방어
const res4 = JSON.parse(gas.doPost({ postData: { contents: "{}" } }).getContent());
check("빈 games 거부", res4.ok === false && res4.error === "no games", JSON.stringify(res4));

// 5) doGet 헬스체크
const health = JSON.parse(gas.doGet().getContent());
check("doGet ok", health.ok === true && health.version === "v3.0", JSON.stringify(health));

// 6) 이메일 HTML 구조 검증
const html = emailLog[0]?.htmlBody || "";
check("HTML에 이미지 태그", html.includes("<img src="));
check("HTML에 Play 스토어 링크", html.includes("Play 스토어에서 열기"));
check("HTML에 할인 배지", html.includes("background:#e94560") || html.includes("background:#4ade80"));
check("HTML에 절약 금액", html.includes("절약"));
check("HTML에 종료 시각", html.includes("종료"));
check("HTML에 할인 종료일", html.includes("⏳"));
check("HTML 이스케이프 적용", !html.includes("<script"));

// 디자인 확인용 미리보기 저장 (--dump-email)
if (process.argv.includes("--dump-email")) {
  const previewPath = new URL("../_debug/email_preview.html", import.meta.url);
  mkdirSync(new URL("../_debug", import.meta.url), { recursive: true });
  writeFileSync(previewPath, `<!DOCTYPE html><meta charset="utf-8">${html}`, "utf8");
  console.log(`[verify] 이메일 미리보기: ${previewPath.pathname}`);
}

// 7) 토큰 불일치 거부
store.SHARED_TOKEN = "expect-this";
const res5 = JSON.parse(
  gas.doPost({ postData: { contents: JSON.stringify({ token: "wrong", games }) } }).getContent()
);
check("토큰 불일치 거부", res5.ok === false && res5.error === "unauthorized");
const res6 = JSON.parse(
  gas.doPost({ postData: { contents: JSON.stringify({ token: "expect-this", games }) } }).getContent()
);
check("올바른 토큰 통과", res6.ok === true);

// 결과 저장
writeFileSync(
  new URL("./verify_result.json", import.meta.url),
  JSON.stringify(
    { pass, fail, sentGamesCount: Object.keys(gas.loadSentGames()).length, emailSubjects: emailLog.map((e) => e.subject) },
    null,
    2
  )
);

console.log(`\n[verify] PASS ${pass} / FAIL ${fail}`);
console.log(`[verify] 발송 기록 수: ${Object.keys(gas.loadSentGames()).length}`);
console.log(`[verify] 이메일 제목: ${emailLog.map((e) => e.subject).join(" | ")}`);

if (fail > 0) process.exit(1);