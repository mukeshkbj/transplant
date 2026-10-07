"""Render title cards and caption overlays in Transplant's own fonts and palette.

Usage: python docs/video/cards.py <out_dir>
"""

import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright

OUT = Path(sys.argv[1] if len(sys.argv) > 1 else "cards")
FONTS = Path("node_modules").resolve()


def font(rel: str) -> str:
    import base64

    return "data:font/woff2;base64," + base64.b64encode((FONTS / rel).read_bytes()).decode()


CSS = f"""
@font-face {{ font-family: Gloock; src: url('{font("@fontsource/gloock/files/gloock-latin-400-normal.woff2")}'); }}
@font-face {{ font-family: Newsreader; font-weight: 200 800; src: url('{font("@fontsource-variable/newsreader/files/newsreader-latin-wght-normal.woff2")}'); }}
@font-face {{ font-family: Plex; font-weight: 400; src: url('{font("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2")}'); }}
@font-face {{ font-family: Plex; font-weight: 500; src: url('{font("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2")}'); }}
:root {{ --paper: #f3ede2; --ink: #1b1a17; --stamp: #c2410c; --visa: #1f4d3a; --muted: #6b645a; }}
* {{ margin: 0; box-sizing: border-box; }}
html, body {{ width: 1920px; height: 1080px; }}
.card {{ width: 1920px; height: 1080px; background: var(--paper); color: var(--ink); display: grid; align-content: center; padding: 0 240px; gap: 36px; }}
.eyebrow {{ font: 500 26px/1 Plex; letter-spacing: 0.14em; text-transform: uppercase; color: var(--stamp); }}
.display {{ font: 400 168px/0.95 Gloock; letter-spacing: -0.02em; }}
.headline {{ font: 400 88px/1.05 Gloock; letter-spacing: -0.01em; max-width: 1400px; }}
.dek {{ font: 400 46px/1.35 Newsreader; color: var(--muted); max-width: 1300px; }}
.rule {{ height: 2px; background: var(--ink); width: 100%; }}
.links {{ font: 500 34px/1.7 Plex; }}
.links span {{ color: var(--stamp); }}
.stamp {{ justify-self: start; font: 500 30px/1 Plex; letter-spacing: 0.16em; text-transform: uppercase; color: var(--stamp); border: 3px solid var(--stamp); padding: 14px 22px; transform: rotate(-4deg); }}
.cap {{ position: absolute; right: 56px; bottom: 60px; max-width: 820px; background: rgba(27, 26, 23, 0.92); color: var(--paper);
  font: 400 38px/1.3 Newsreader; padding: 20px 30px; border-left: 6px solid var(--stamp); box-shadow: 0 8px 30px rgba(0, 0, 0, 0.35); }}
"""

CARDS = {
    "s0": """<div class="card"><p class="eyebrow">Qloo Agentic Hackathon</p><h1 class="display">Transplant</h1><div class="rule"></div>
             <p class="dek">Find the neighborhood that already loves what you love.</p></div>""",
    "s1": """<div class="card"><p class="eyebrow">The problem</p><h2 class="headline">Moving to a new city? A chatbot sends everyone to the same famous neighborhoods.</h2></div>""",
    "s7": """<div class="card"><p class="eyebrow">Why Qloo</p><h2 class="headline">It only works because Qloo knows taste across music, TV, brands and places — and where it lives.</h2></div>""",
    "s8": """<div class="card"><h1 class="display">Transplant</h1><div class="rule"></div>
             <p class="links"><span>Try it</span> &nbsp;transplant-taste.fly.dev<br><span>Code</span> &nbsp;github.com/mukeshkbj/transplant</p>
             <p class="stamp">Built with Qloo</p></div>""",
}

CAPTIONS = {
    "s2": "Qloo resolves each love — Aesop the brand, not the author.",
    "s3": "Qloo heatmaps show where this exact taste over-indexes — adjusted for popularity.",
    "s4": "Taste-matched spots and a first week, written only from Qloo evidence.",
    "s5": "A tool-using agent refines with live Qloo calls — and shows its work.",
    "s6": "Moving together? Blend two tastes into one neighborhood.",
}


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={"width": 1920, "height": 1080})
        for name, body in CARDS.items():
            await page.set_content(f"<style>{CSS}</style>{body}")
            await page.evaluate("document.fonts.ready")
            await page.screenshot(path=str(OUT / f"{name}.png"))
            print("card", name)
        for name, text in CAPTIONS.items():
            await page.set_content(f"<style>{CSS} html, body {{ background: transparent; }}</style><div class='cap'>{text}</div>")
            await page.evaluate("document.fonts.ready")
            await page.screenshot(path=str(OUT / f"cap_{name}.png"), omit_background=True)
            print("caption", name)
        await browser.close()


asyncio.run(main())
