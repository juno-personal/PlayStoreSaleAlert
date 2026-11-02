import { chromium } from "playwright";
import { parseEmbeddedApps, isSaleGame } from "./scrape.js";

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
const apps = parseEmbeddedApps(html);
console.log("embedded apps:", apps.length);
console.log("sale games:", apps.filter(isSaleGame).length);
const dredge = apps.find((a) => a.packageId === "com.BlackSaltGames.DREDGE");
console.log("DREDGE:", JSON.stringify(dredge, null, 1));
console.log("no price:", apps.filter((a) => !a.originalPrice).length, apps.filter((a) => !a.originalPrice).map((a) => a.name));
console.log("sample:", JSON.stringify(apps.slice(0, 2), null, 1));
await browser.close();
