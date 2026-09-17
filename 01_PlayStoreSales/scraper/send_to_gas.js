/**
 * 스크랩 결과(games.json)를 GAS Web App으로 POST 전송
 *
 * 환경변수:
 *   GAS_WEBAPP_URL  - GAS Web App 배포 URL (.../exec)
 *   GAS_TOKEN       - GAS Script Property의 SHARED_TOKEN과 동일한 값
 *
 * 사용:
 *   node send_to_gas.js [--in games.json] [--dry-run]
 */

import { readFileSync } from "node:fs";

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 5000;

function parseArgs(argv) {
  const args = { file: "games.json", dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--in" && argv[i + 1]) args.file = argv[++i];
    else if (argv[i] === "--dry-run") args.dryRun = true;
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function postOnce(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...body }),
    redirect: "follow",
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`JSON 파싱 실패 (Apps Script 오류 페이지 가능성): ${text.slice(0, 300)}`);
  }
  if (parsed && parsed.ok === false) {
    throw new Error(`GAS 오류 응답: ${parsed.error || JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.GAS_WEBAPP_URL;
  const token = process.env.GAS_TOKEN;

  const payload = JSON.parse(readFileSync(args.file, "utf8"));
  const games = Array.isArray(payload) ? payload : payload.games || [];
  const meta = Array.isArray(payload)
    ? {}
    : { scrapedAt: payload.scrapedAt, sourceUrl: payload.sourceUrl, stats: {
        initialCards: payload.initialCards,
        finalCards: payload.finalCards,
        uniquePackages: payload.uniquePackages,
        elapsedSec: payload.elapsedSec,
      } };

  console.log(`[send] 입력 ${args.file}: ${games.length}개 게임`);

  if (args.dryRun) {
    console.log("[send] --dry-run 이므로 전송하지 않습니다.");
    console.log(`[send] URL 설정됨: ${Boolean(url)} | 토큰 설정됨: ${Boolean(token)}`);
    return;
  }
  if (!url) throw new Error("GAS_WEBAPP_URL 환경변수가 없습니다.");
  if (!token) throw new Error("GAS_TOKEN 환경변수가 없습니다.");
  if (games.length === 0) {
    console.error("[send] 게임 0건 → 전송 생략 (실패로 처리)");
    process.exit(2);
  }

  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_COUNT; attempt += 1) {
    try {
      const res = await postOnce(url, token, { ...meta, games });
      console.log(`[send] 성공 (시도 ${attempt}): ${JSON.stringify(res)}`);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[send] 실패 (시도 ${attempt}/${RETRY_COUNT}): ${err.message}`);
      if (attempt < RETRY_COUNT) await sleep(RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

main().catch((err) => {
  console.error(`[send] 최종 실패: ${err.message}`);
  process.exit(1);
});
