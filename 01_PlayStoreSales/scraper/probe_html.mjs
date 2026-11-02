import { chromium } from "playwright";

const URL_ = "https://play.google.com/store/apps/collection/promotion_3002a18_gamesonsale?hl=ko&gl=AE";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext({
  locale: "ko-KR",
  viewport: { width: 1440, height: 900 },
  userAgent:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
});
const page = await ctx.newPage();
const resp = await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 60000 });
const html = await resp.text();
console.log("html len:", html.length, "status:", resp.status());
console.log("AF_initDataCallback count:", (html.match(/AF_initDataCallback/g) || []).length);
console.log("DREDGE in html:", html.includes("com.BlackSaltGames.DREDGE"));
const idx = html.indexOf("com.BlackSaltGames.DREDGE");
if (idx >= 0) {
  console.log("\ncontext around DREDGE:\n", html.slice(Math.max(0, idx - 300), idx + 900));
}
console.log("\nAED count in html:", (html.match(/AED/g) || []).length);
await browser.close();
