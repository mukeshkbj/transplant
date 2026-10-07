# Demo film — gap audit (v1)

Film: `dist/video/transplant-demo.mp4` (not committed) · 102.4 s · 1920×1080 · 30 fps · H.264 + AAC 48 kHz · −16.4 LUFS integrated, −1.4 dBFS peak · 15.2 MB.
Graded from frames extracted from the final MP4, not from the build plan.

| # | Scene | Grade | Evidence |
| --- | --- | --- | --- |
| 0 | Title card | MET | Gloock "Transplant", eyebrow, dek match the script word for word. |
| 1 | Problem card | MET | Copy matches. |
| 2 | Intake | MET | NYC picked, text typed, Read my taste clicked with ring, 4 stamps land incl. "BRAND · Aesop"; caption matches. |
| 3 | Run → map | PARTIAL | Click on "Transplant my taste" and the glowing night map with "Greenpoint · ADMITTED" are shown. The boarding pass is on screen for only ~0.5 s because the wait for tiles was cut. |
| 4 | Results | MET | Features with taste lift + evidence ("People who love Khruangbin and Fleabag…"), spots, first-week plan. |
| 5 | Guide agent | MET | Click on Quieter → reply naming Desert Island, Patisserie Tomoko, Land to Sea; trace lines; "Filtered by Qloo tags: Quiet". |
| 6 | Blend | MET | Demo click → Sunnyside, "What you both love: Blues, Drums, Jazz…", You/Them meters, copy names a love from each person. |
| 7 | Why Qloo card | MET | Copy matches. |
| 8 | End card | MET | URL, repo, "Built with Qloo" stamp. |

## Deviations

- **Camera:** the script promised punch-ins at clicks; the cut uses a static full-bleed frame. Text stays readable at 1080p, but there is no zoom grammar.
- **Captions** sit bottom-right over the map. In scene 2 the caption covers the "Transplant my taste" button during the stamp hold; it fades out before the click.
- **Voice:** Windows "Microsoft Hazel Desktop" TTS (user's choice) — clear but synthetic. Loudness and placement were verified numerically; the mix has not been reviewed by ear.
- **Music:** a simple synthesized ambient pad (license-free), ducked under the voice — not the product-film Tier A engine, which is macOS-only.

## Product defects found while filming (all fixed and deployed before the final capture)

1. Night map black for every production visitor (MapLibre worker 404 after bundling).
2. Neighborhood copy echoed raw category codes ("brand, tv_show, and artist").
3. Plan entries vanished after a guide filter.
4. Broken-image icons for Qloo place photos blocked by the CDN.
5. Blend copy named only one person's love.

## Rebuild

```bash
python docs/video/capture.py .scratch/video/takes          # scripted capture of the live site
powershell -File docs/video/tts.ps1 -OutDir .scratch/video/vo
python docs/video/cards.py .scratch/video/cards
python docs/video/assemble.py .scratch/video dist/video/transplant-demo.mp4
```
