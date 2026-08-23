---
name: pixel-perfect
description: Measures design fidelity as a number instead of an opinion. Exports the reference frame, captures the running UI at the same pixel dimensions over CDP, diffs the two with ImageMagick, and reads the diff image. Use whenever a screen has to match a design as-is, when the user says "pixel perfect", "match the design", "as-is", "fiel ao design", "igual ao design", "idêntico ao layout", or asks to implement a screen from a Pencil `.pen` frame, an image, a screenshot or a mockup. Invoke before writing the markup, since the exported spec drives the implementation, and again before handing the screen over, so the fidelity claim is checked instead of guessed.
---

# Pixel-perfect fidelity

Replace "looks right" with a number: the percentage of pixels that differ between the design frame and the running UI, captured at identical dimensions. It gives the user a claim they can check, and gives you a signal to iterate against instead of a vibe.

## 1. Get the reference at a known size

Pencil frame, through the `pencil` MCP:

```
Export([frameId], "png", outPath, {scale: 2})
Export([frameId], "html-tailwind", specPath)
```

A 1440x900 frame at scale 2 gives a 2880x1800 PNG. The `html-tailwind` export is the spec: exact hex, exact px, exact font sizes. Read it instead of reading the design by eye.

Plain image: the image is already the reference. Read its dimensions and work out the CSS size it represents.

```bash
magick identify -format "%wx%h" reference.png
```

## 2. Implement

Build from the exported spec, not from the picture.

## 3. Capture the running UI

Same CSS size as the reference, device scale factor 2, so both PNGs come out at the same pixel dimensions.

```bash
node <skill-dir>/scripts/capture.mjs \
  --url http://localhost:4000/login --width 1440 --height 900 --out capture.png
```

`--scale` defaults to 2, `--wait-ms` to 1500. `--wait-for '<js expression>'` polls until it returns true, `--before '<js>'` runs just before the shutter.

Strip whatever the design does not contain, or dev widgets land in the picture. On Phoenix, that is every direct child of `body` whose id does not start with `phx-`:

```bash
--before '[...document.body.children].filter(el => !el.id.startsWith("phx-")).forEach(el => el.remove())'
```

## 4. Diff

```bash
magick compare -metric AE reference.png capture.png diff.png 2>&1
```

`AE` prints the count of differing pixels on stderr. Divide by `width * height` for the percentage.

## 5. Read `diff.png`, not just the number

It paints the differing pixels red over a faded original, and that image is the actual diagnostic.

- Red tracing the **outlines of glyphs** only: this is the floor. The browser and the design tool use different text rasterizers and will never agree per pixel. Done.
- **Solid red blocks, doubled edges, a whole element shifted**: real defect. Fix it.

## 6. When something shifted, measure it

```js
document.querySelector(sel).getBoundingClientRect()
```

Compare against the numbers in the `html-tailwind` spec. This is what turns "something is off around the button" into "the button is 347.73px wide and should be 342".

## Threshold

1% to 3% on a text-heavy screen is a pass when the diff is glyph outlines only. A screen with little text lands lower. Do not chase 0%, it does not exist. Report the number and what the diff image showed, both.

Measured on a real login screen: 1.38% desktop (1440x900), 2.40% mobile (390x844).

## Traps

Each of these cost hours once.

- **`--screenshot` never fires** on a page with a live websocket (LiveView, any socket app): the socket keeps `--virtual-time-budget` alive forever. `--timeout=N` makes it fire, but then it fires too early and photographs the loading state. That is why the capture runs over CDP.
- **A headless tab counts as backgrounded.** Without the three `--disable-*` throttling flags the script passes, timers get throttled, the socket drops and reconnects, and a flash message vanishes before the shutter: an error-state capture came out byte-identical to the clean state and looked like a bug in the implementation.
- **One fresh browser process per capture.** A reused session has already consumed the flash, or whatever one-shot state you are photographing. The script exits after one shot for that reason.
- **zsh does not word-split unquoted variables.** `node capture.mjs $args` passes the whole string as one argument and CDP answers `Invalid parameters ... width int32 expected`. Pass every flag explicitly.
- **Mobile width only exists inside the emulation override.** Do not resize a window and hope.
- **Brave in headless mode writes no file at all.** The binary is `chrome-headless-shell` from the Playwright cache, which the script resolves on its own. Override it with `CHROME_HEADLESS_SHELL`.
