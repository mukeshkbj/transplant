"""Scripted capture of the live Transplant site for the demo film.

Records each take with Chrome's screencast (JPEG frames + timestamps) and logs
every scripted action, so the edit cuts on measured moments, not guesses.

Usage: python docs/video/capture.py <out_dir> [base_url]
"""

import asyncio
import json
import sys
import time
from pathlib import Path

from playwright.async_api import Page, async_playwright

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "out")
BASE = sys.argv[2] if len(sys.argv) > 2 else "https://transplant-taste.fly.dev"
W, H = 1920, 1080

CURSOR_JS = """
window.addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.innerHTML = '<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 15 L11.5 21.5 L14 20.3 L11 14 L17 14 Z" fill="#1b1a17" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(-200px,-200px)' });
  document.body.appendChild(c);
  document.addEventListener('mousemove', (e) => { c.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 2}px)`; }, true);
  document.addEventListener('mousedown', (e) => {
    const r = document.createElement('div');
    Object.assign(r.style, { position: 'fixed', left: `${e.clientX - 20}px`, top: `${e.clientY - 20}px`, width: '40px', height: '40px', borderRadius: '50%',
      border: '3px solid #c2410c', background: 'rgba(194,65,12,0.12)', zIndex: 2147483646, pointerEvents: 'none', transition: 'transform 500ms ease-out, opacity 500ms ease-out' });
    document.body.appendChild(r);
    requestAnimationFrame(() => requestAnimationFrame(() => { r.style.transform = 'scale(1.9)'; r.style.opacity = '0'; }));
    setTimeout(() => r.remove(), 700);
  }, true);
});
"""


class Take:
    def __init__(self, page: Page, name: str):
        self.page, self.name = page, name
        self.dir = OUT / name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.frames: list[tuple[str, float]] = []
        self.marks: list[tuple[str, float]] = []
        self.t0 = time.time()
        self.cdp = None

    async def start(self):
        self.cdp = await self.page.context.new_cdp_session(self.page)
        self.cdp.on("Page.screencastFrame", self._on_frame)
        await self.cdp.send("Page.startScreencast", {"format": "jpeg", "quality": 92, "maxWidth": W, "maxHeight": H, "everyNthFrame": 1})
        self.t0 = time.time()

    def _on_frame(self, event):
        import base64

        name = f"{len(self.frames):06d}.jpg"
        (self.dir / name).write_bytes(base64.b64decode(event["data"]))
        self.frames.append((name, event["metadata"]["timestamp"]))
        asyncio.ensure_future(self.cdp.send("Page.screencastFrameAck", {"sessionId": event["sessionId"]}))

    def mark(self, label: str):
        stamp = time.time()
        self.marks.append((label, stamp))
        print(f"  [{self.name}] {stamp - self.t0:6.2f}s {label}", flush=True)

    async def stop(self):
        await self.cdp.send("Page.stopScreencast")
        await asyncio.sleep(0.3)
        (self.dir / "frames.json").write_text(json.dumps({"frames": self.frames, "marks": self.marks}, indent=1))
        print(f"  [{self.name}] {len(self.frames)} frames", flush=True)


async def glide(page: Page, x: float, y: float, steps: int = 28):
    await page.mouse.move(x, y, steps=steps)


async def click(take: Take, locator, label: str, settle: float = 0.35):
    box = await locator.bounding_box()
    assert box, f"no box for {label}"
    await glide(take.page, box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
    await asyncio.sleep(settle)
    take.mark(f"click:{label}")
    await take.page.mouse.down()
    await asyncio.sleep(0.08)
    await take.page.mouse.up()


async def scroll_to(take: Take, locator, label: str, offset: int = 140):
    page = take.page
    target = await locator.evaluate(f"(el) => el.getBoundingClientRect().top + window.scrollY - {offset}")
    current = await page.evaluate("window.scrollY")
    distance = target - current
    steps = max(1, int(abs(distance) / 18))
    take.mark(f"scroll-start:{label}")
    for _ in range(steps):
        await page.mouse.wheel(0, distance / steps)
        await asyncio.sleep(0.016)
    await asyncio.sleep(0.4)
    take.mark(f"scroll-end:{label}")


async def map_painted(page: Page, timeout: float = 60.0):
    """Wait until the map region shows real tiles, not the black placeholder."""
    from io import BytesIO

    from PIL import Image

    deadline = time.time() + timeout
    while time.time() < deadline:
        shot = await page.screenshot(clip={"x": 1100, "y": 250, "width": 600, "height": 500})
        colors = Image.open(BytesIO(shot)).convert("RGB").getcolors(maxcolors=1 << 20) or []
        if len(colors) > 1500:
            await asyncio.sleep(1.5)
            return
        await asyncio.sleep(0.5)
    raise TimeoutError("map never painted")


async def new_page(browser):
    context = await browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=1, reduced_motion="no-preference")
    await context.add_init_script(CURSOR_JS)
    page = await context.new_page()
    return context, page


async def ready(page: Page, url: str):
    await page.goto(url, wait_until="networkidle")
    await page.evaluate("document.fonts.ready")
    await page.get_by_role("button", name="New York City").wait_for()
    await page.mouse.move(W * 0.62, H * 0.72)
    await asyncio.sleep(1.2)


async def main_take(browser):
    context, page = await new_page(browser)
    await ready(page, BASE)
    take = Take(page, "main")
    await take.start()
    await asyncio.sleep(1.5)
    take.mark("intake-visible")

    await click(take, page.get_by_role("button", name="New York City"), "nyc")
    await asyncio.sleep(0.6)
    await click(take, page.get_by_label("What do you love?"), "textarea")
    take.mark("type-start")
    await page.keyboard.type("Khruangbin, Fleabag, natural wine bars and Aesop", delay=55)
    take.mark("type-end")
    await asyncio.sleep(0.6)
    await click(take, page.get_by_role("button", name="Read my taste"), "read")
    await page.get_by_text("4/3 stamps").or_(page.get_by_text("3/3 stamps")).first.wait_for(timeout=60000)
    take.mark("stamps-landed")
    await glide(page, W * 0.66, H * 0.62)
    await asyncio.sleep(3.2)
    take.mark("stamps-hold-end")

    await click(take, page.get_by_role("button", name="Transplant my taste →"), "transplant")
    await page.get_by_label("Your taste visa").wait_for(timeout=90000)
    take.mark("results-visible")
    await map_painted(page)
    take.mark("map-settled")
    await glide(page, W * 0.3, H * 0.55)
    await asyncio.sleep(2.0)
    take.mark("visa-hold-end")

    await scroll_to(take, page.locator(".hoods"), "features", offset=110)
    await asyncio.sleep(3.0)
    await scroll_to(take, page.get_by_role("heading", name="Your spots in Greenpoint"), "spots", offset=110)
    await asyncio.sleep(3.0)
    await scroll_to(take, page.locator(".plan"), "plan", offset=200)
    await asyncio.sleep(3.0)
    take.mark("plan-hold-end")

    await scroll_to(take, page.get_by_role("heading", name="Ask your guide"), "guide", offset=120)
    await asyncio.sleep(1.0)
    await click(take, page.get_by_role("button", name="Quieter"), "quieter")
    await page.locator(".guide__trace").first.wait_for(timeout=90000)
    take.mark("guide-replied")
    await asyncio.sleep(3.5)
    take.mark("guide-hold-end")
    await scroll_to(take, page.get_by_role("heading", name="Your spots in Greenpoint"), "filtered-spots", offset=110)
    await asyncio.sleep(3.0)
    take.mark("filtered-hold-end")
    await take.stop()
    await context.close()


async def blend_take(browser):
    context, page = await new_page(browser)
    await ready(page, BASE)
    take = Take(page, "blend")
    await take.start()
    await asyncio.sleep(1.2)
    take.mark("intake-visible")
    await click(take, page.get_by_role("button", name="Two tastes, one NYC apartment"), "demo-blend")
    await page.get_by_label("Your taste visa").wait_for(timeout=90000)
    take.mark("results-visible")
    await map_painted(page)
    await asyncio.sleep(2.0)
    take.mark("map-settled")
    await scroll_to(take, page.get_by_text("What you both love"), "shared", offset=160)
    await asyncio.sleep(3.5)
    take.mark("shared-hold-end")
    await take.stop()
    await context.close()


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--hide-scrollbars"])
        print("take: main", flush=True)
        await main_take(browser)
        print("take: blend", flush=True)
        await blend_take(browser)
        await browser.close()


asyncio.run(main())
