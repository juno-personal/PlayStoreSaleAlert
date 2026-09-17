"""
Play Store 'Games on sale' 컬션 계측 스크립트 (1회성 분석용)

전제: 브라우저 다운로드 없음. 설치된 시스템 Chrome 사용 (channel="chrome")
실행: ...001_Design_Gallery\\.venv\\Scripts\\python.exe probe.py
"""

import json
import re
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

URL_BASE = "https://play.google.com/store/apps/collection/promotion_3002a18_gamesonsale"
CARD_SELECTOR = 'div[jscontroller="tKHFxf"]'
OUT_PATH = Path(__file__).with_name("probe_result.json")


def count(text: str, token: str) -> int:
    return len(re.findall(re.escape(token), text))


def scroll_and_measure(page, max_scrolls=80, stable_needed=3,
                       settle_ms=1200, max_seconds=240):
    timeline = []
    stable = 0
    last_h, last_n = -1, -1
    started = time.time()

    for i in range(max_scrolls + 1):
        h = page.evaluate("() => document.body.scrollHeight")
        n = page.locator(CARD_SELECTOR).count()
        timeline.append({
            "step": i, "cards": n, "scroll_height": h,
            "elapsed_sec": round(time.time() - started, 2),
        })
        if h == last_h and n == last_n:
            stable += 1
        else:
            stable = 0
        last_h, last_n = h, n

        if stable >= stable_needed or time.time() - started > max_seconds:
            break
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(settle_ms)

    return {
        "scrolls_performed": len(timeline) - 1,
        "elapsed_sec": round(time.time() - started, 2),
        "timeline": timeline,
        "stop_reason": "stable" if stable >= stable_needed else "limit",
    }


JS_EXTRACT = """(sel) => Array.from(document.querySelectorAll(sel)).map(card => {
    const clean = (s) => s ? s.replace(/\\u00a0/g, ' ').replace(/\\s+/g, ' ').trim() : null;
    const txt = (el) => el ? clean(el.textContent) : null;
    const q = (s) => card.querySelector(s);
    const link = card.querySelector('a[href*="/store/apps/details?id="]');
    const thumb = q('img.T75of.stzEZd') || q('img.T75of') || q('img');
    const ratingEl = card.querySelector('[aria-label^="Rated "]');
    const spans = Array.from(card.querySelectorAll('span')).map(e => clean(e.textContent));
    return {
        name: txt(q('span.sT93pb.DdYX5.OnEJge')) || txt(q('span.DdYX5')),
        genre: txt(q('span.sT93pb.w2kbF')),
        aria_rating: ratingEl ? ratingEl.getAttribute('aria-label') : null,
        discount_text: txt(q('span.W0agu')),
        price_spans: spans.filter(s => s && /[A-Z]{2,3}\\s*\\d|\\$|\\u20ac|\\u00a3/.test(s)).slice(0, 4),
        thumb: thumb ? thumb.getAttribute('src') : null,
        href: link ? link.getAttribute('href') : null,
        raw_text: clean(card.textContent).slice(0, 220)
    };
})"""


def measure(p, url, label, do_scroll=True):
    print(f"\n{'=' * 70}\n[{label}] {url}\n{'=' * 70}", flush=True)
    browser = p.chromium.launch(headless=True, channel="chrome")
    ctx = browser.new_context(
        locale="en-US",
        viewport={"width": 1440, "height": 900},
        user_agent=("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                    "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"),
    )
    page = ctx.new_page()
    t0 = time.time()

    resp = page.goto(url, wait_until="domcontentloaded", timeout=60000)
    raw_html = ""
    try:
        raw_html = resp.text() if resp else ""
    except Exception as e:
        print(f"  (response.text() 실패: {e})")

    try:
        page.wait_for_selector(CARD_SELECTOR, timeout=15000)
    except Exception:
        print("  ! 카드 셀렉터 대기 실패 - 대체 렉터 재시도")
        for alt in ['div[jscontroller]', 'a[href*="/store/apps/details"]']:
            try:
                page.wait_for_selector(alt, timeout=8000)
                print(f"  i 대체 셀렉터 매칭: {alt}")
                break
            except Exception:
                pass

    page.wait_for_timeout(2500)
    load_sec = round(time.time() - t0, 2)
    dom_html = page.content()
    initial_cards = page.locator(CARD_SELECTOR).count()

    init = {
        "load_sec": load_sec,
        "raw_html_len": len(raw_html),
        "dom_html_len": len(dom_html),
        "cards_initial": initial_cards,
        "raw_hX5Dhd": count(raw_html, "hX5Dhd"),
        "dom_hX5Dhd": count(dom_html, "hX5Dhd"),
        "raw_shoppingmode": count(raw_html, "shoppingmode"),
        "dom_shoppingmode": count(dom_html, "shoppingmode"),
        "raw_W0agu": count(raw_html, "W0agu"),
        "dom_W0agu": count(dom_html, "W0agu"),
        "raw_jslog38003": count(raw_html, 'jslog="38003'),
        "dom_jslog38003": count(dom_html, 'jslog="38003'),
        "dom_ytimg": count(dom_html, "i.ytimg.com"),
    }
    print(f"  초기 카드 수         : {initial_cards}")
    print(f"  raw_html 길이        : {len(raw_html):,}")
    print(f"  dom_html 길이        : {len(dom_html):,}")
    print(f"  shoppingmode raw/dom : {init['raw_shoppingmode']} / {init['dom_shoppingmode']}")
    print(f"  W0agu        raw/dom : {init['raw_W0agu']} / {init['dom_W0agu']}")
    print(f"  hX5Dhd       raw/dom : {init['raw_hX5Dhd']} / {init['dom_hX5Dhd']}")

    scroll_info = None
    if do_scroll:
        scroll_info = scroll_and_measure(page)
        print(f"  스크롤 횟수          : {scroll_info['scrolls_performed']}")
        print(f"  스크롤 소요          : {scroll_info['elapsed_sec']}s")
        print("  증가 곡선 (step: cards / scrollHeight)")
        tl = scroll_info["timeline"]
        for row in tl:
            if row["step"] % 5 == 0 or row["step"] == len(tl) - 1:
                print(f"    {row['step']:>3} : {row['cards']:>4} / {row['scroll_height']:>8}  ({row['elapsed_sec']}s)")
    return page, ctx, browser, init, scroll_info, t0, raw_html, dom_html


def finish(page, ctx, browser, init, scroll_info, t0, raw_html, dom_html, label, url):
    final_cards = page.locator(CARD_SELECTOR).count()
    all_cards = page.evaluate(JS_EXTRACT, CARD_SELECTOR)

    pkg_ids = set()
    for c in all_cards:
        if c.get("href"):
            m = re.search(r"id=([^&]+)", c["href"])
            if m:
                pkg_ids.add(m.group(1))

    print(f"  최종 카드 수         : {final_cards}")
    print(f"  고유 packageId 수    : {len(pkg_ids)}")
    print("  --- 앞 3장 파싱 결과 ---")
    for i, c in enumerate(all_cards[:3], 1):
        print(f"   [{i}] name={c['name']!r}")
        print(f"       genre={c['genre']!r} rating={c['aria_rating']!r}")
        print(f"       discount={c['discount_text']!r} prices={c['price_spans']}")
        print(f"       thumb={str(c['thumb'])[:80]!r}")

    ctx.close()
    browser.close()
    return {
        "label": label,
        "url": url,
        "initial": init,
        "scroll": scroll_info,
        "final_cards": final_cards,
        "unique_packages": len(pkg_ids),
        "total_sec": round(time.time() - t0, 2),
        "sample_cards": all_cards[:3],
        "package_ids": sorted(pkg_ids),
    }


def main():
    results = []
    with sync_playwright() as p:
        for label, url, do_scroll in [
            ("A: hl=en&gl=US (SCROLL)", f"{URL_BASE}?hl=en&gl=US", True),
            ("B: hl=en&gl=US (NO SCROLL)", f"{URL_BASE}?hl=en&gl=US", False),
        ]:
            try:
                parts = measure(p, url, label, do_scroll=do_scroll)
                results.append(finish(*parts, label=label, url=url))
            except Exception as e:
                print(f"  X 실행 실패: {type(e).__name__}: {e}")

    OUT_PATH.write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"\n{'=' * 70}\n요약\n{'=' * 70}")
    for r in results:
        sc = r.get("scroll") or {}
        print(f"[{r['label']}]")
        print(f"  초기 카드 {r['initial']['cards_initial']} -> 최종 {r['final_cards']} "
              f"(고유 패키지 {r['unique_packages']}), 스크롤 {sc.get('scrolls_performed')}회 "
              f"{sc.get('elapsed_sec')}s, 총 {r['total_sec']}s")
        print(f"  할인배지 dom_shoppingmode={r['initial']['dom_shoppingmode']} "
              f"dom_W0agu={r['initial']['dom_W0agu']}")
    print(f"\n저장: {OUT_PATH}")


if __name__ == "__main__":
    main()
