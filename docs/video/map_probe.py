"""Check whether the results map renders in a browser: console errors, tile requests, pixels."""

import asyncio
import sys

from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://transplant-taste.fly.dev"
HEADED = "--headed" in sys.argv
ARGS = [a for a in sys.argv[2:] if a.startswith("--") and a != "--headed"]


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not HEADED, args=ARGS)
        page = await browser.new_page(viewport={"width": 1920, "height": 1080})
        logs, tiles = [], {"ok": 0, "fail": 0}
        page.on("console", lambda m: logs.append(f"{m.type}: {m.text[:160]}"))
        page.on("pageerror", lambda e: logs.append(f"pageerror: {str(e)[:160]}"))
        page.on("requestfinished", lambda r: tiles.__setitem__("ok", tiles["ok"] + 1) if "openfreemap" in r.url else None)
        page.on("requestfailed", lambda r: tiles.__setitem__("fail", tiles["fail"] + 1) if "openfreemap" in r.url else None)
        await page.goto(f"{BASE}/?demo=nyc-indie", wait_until="load")
        await page.get_by_label("Your taste visa").wait_for(timeout=60000)
        await asyncio.sleep(8)
        webgl = await page.evaluate(
            "() => { const c = document.createElement('canvas'); const gl = c.getContext('webgl2') || c.getContext('webgl'); if (!gl) return 'none'; const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'webgl (no debug info)'; }"
        )
        shot = await page.screenshot(clip={"x": 1100, "y": 300, "width": 600, "height": 500})
        from io import BytesIO

        from PIL import Image

        img = Image.open(BytesIO(shot)).convert("RGB")
        colors = img.getcolors(maxcolors=1 << 20) or []
        bright = sum(n for n, (r, g, b) in colors if r + g + b > 120)
        print("WebGL renderer:", webgl)
        print("openfreemap requests ok/fail:", tiles)
        print("distinct colors in map region:", len(colors), "| bright pixel share:", round(bright / (600 * 500), 4))
        print("console:")
        for line in logs[-15:]:
            print("  ", line)
        await browser.close()


asyncio.run(main())
