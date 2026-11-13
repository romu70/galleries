# Implementation plan — Faster gallery loading

Single, self-contained reference for Claude Code. Measured on `main` at `eb17842` (merge of PR #28), built locally and loaded in headless Chromium on 2026-11-13.

## 1. Problem (measured)

On first load, the street-art page downloads **every photo of the gallery: 340 images, 81.4 MB**, on desktop and on phone alike. Lazy loading (`loading="lazy"` on all 682 `<img>`) has no effect.

| Scenario (headless Chromium, cold cache) | Images fetched on load | MB |
|---|---|---|
| Desktop 1440×900, as is | 340 | 81.4 |
| iPhone 13, as is | 340 | 81.4 |
| Desktop, `.detail { display: none }` injected | 81 | 23.2 |
| iPhone 13, `.detail { display: none }` injected | 14 | 4.3 |

The result is the same with JavaScript disabled, so the cause is in the HTML and CSS, not in the scripts.

### Root cause 1 — hidden detail panels sit over the viewport
- Every photo has its own `.detail` panel, rendered in the page (340 panels).
- `Detail.astro` styles `.detail` as `position: fixed; inset: 0`. Hidden panels are only `visibility: collapse` (set by `hideAllDetails()` in `Gallery.astro` on `DOMContentLoaded`).
- So all 340 hidden panels are laid out over the viewport. Each detail `<img>` intersects the viewport, so the browser's lazy loading considers it visible and fetches it.
- The script also hides the panels too late: the image requests have already started by `DOMContentLoaded`.

### Root cause 2 — thumbnails are full-size files
- `Thumbnail.astro` and `Detail.astro` both use `<Image src={item.data.image.file} />` with no `width`. Astro outputs the source size: 1600 px WebP, about 250 KB each.
- A thumbnail is displayed at about 240–480 CSS px wide.
- On a sample of 40 photos: 249 KB per image at 1600 px, 43 KB at 480 px.

Both causes are in the shared components, so the fonts page (`fonts.astro`, 98 photos) has the same problem.

## 2. Goal and scope

- First load fetches only the thumbnails near the viewport, at a size that matches their display size.
- Detail images load only when a photo is opened, with the previous and next photos loaded ahead of time so the arrows stay fast.
- In scope: `Detail.astro`, `Thumbnail.astro`, `Gallery.astro` (show/hide and preload logic), a measurement script.
- Out of scope: content, schema, ingest and walls skills, the `add-items.mjs` script, visual design changes.

## 3. Decisions

| # | Decision |
|---|---|
| L1 | Hidden detail panels are removed from layout (`display: none`), by **CSS by default**, not by script after load. |
| L2 | Thumbnails get a responsive `srcset` (`widths` + `sizes`), with a maximum of 1200 px. |
| L3 | Detail images keep a 1600 px maximum; the link to the full image (`<a href={theImage.src}>`) is unchanged. |
| L4 | When a photo is opened, the previous and next visible photos (per the current filter) are preloaded. |
| L5 | Load performance is checked by a script committed to the repo, not by eye. |

## 4. Work packages (one PR each, in this order)

### PR 0 — Measurement script
Add `scripts/measure-load.mjs` (Playwright, as a devDependency) that:
1. Serves `dist/` under `/galleries/`, or takes a base URL as argument (live site or local preview).
2. For `/streetart/` and `/fonts/`, on desktop 1440×900 and on `devices['iPhone 13']`, in a fresh context (cold cache):
   - counts the image requests and the bytes transferred until `networkidle` + 1.5 s;
   - calls `performance.setResourceTimingBufferSize(5000)` in an init script first, because the default buffer stops at 250 entries and truncates the count.
3. Opens the first photo (click on the first `.thumbnail`), then counts the extra image requests.
4. Prints one table.

Reference logic, already used for the numbers in §1:
```js
await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const [n, bytes] = await page.evaluate(() => {
  const e = performance.getEntriesByType('resource').filter(x => /\.(webp|jpg|png|avif)/.test(x.name));
  return [e.length, e.reduce((s, x) => s + x.encodedBodySize, 0)];
});
```
Note: `astro preview` did not keep running in the cloud workspace; a static server on a copy of `dist/` placed under a `galleries/` folder worked.

Done when the script reproduces the "as is" rows of §1.

### PR 1 — Detail panels out of layout (fixes root cause 1)
1. `Detail.astro` CSS: `.detail { display: none; }` and `.detail.open { display: flex; }`. Keep the existing `flex-direction` rules in the media queries.
2. `Gallery.astro`:
   - `showDetail()` adds `.open` **before** `layoutDetail()`, because the layout code may measure the panel.
   - `hideDetail()` and `hideAllDetails()` remove `.open` and stop setting `style.visibility`.
   - Check every other place that reads or writes `style.visibility` on `.detail`.
3. Check the fade between photos of the same wall (`.detail.wall-fade`): a `display` change cuts CSS transitions. If the fade breaks, start the fade one frame after adding `.open` (`requestAnimationFrame`).

Done when: measured first load on iPhone is at most 15 images, and no image from a detail panel is fetched before a photo is opened; opening, closing, the arrows, the keyboard, the artist filter, the wall timeline and the phone full-screen view behave as before.

### PR 2 — Responsive thumbnails (fixes root cause 2)
1. `Thumbnail.astro`: `<Image src=… alt="" widths={[400, 800, 1200]} sizes={…} />`.
2. Derive `sizes` from the grid columns in `Gallery.astro`:
   - 1 column below 440 px;
   - 2 columns from 440 px;
   - 3 columns from 768 px, and from 1024 px in portrait;
   - 4 columns from 1024 px in landscape;
   - 5 columns from 1282 px;
   - 6 columns from 1441 px.
   
   Starting proposal: `(min-width: 1441px) 17vw, (min-width: 1282px) 20vw, (min-width: 1024px) 33vw, (min-width: 768px) 33vw, (min-width: 440px) 50vw, 100vw`. Using 33vw from 1024 px covers the 3-column portrait case and slightly overestimates the 4-column landscape case.
3. The cover crop in `cropAndPositionImage()` reads `img.width / img.height`. Check that the ratio stays correct with `srcset`. Astro keeps `width`/`height` attributes proportional to the source.
4. Check the build time: the build makes about 3 extra files per photo (currently 51 s locally). Report the GitHub Actions build duration before and after.

Done when: on desktop, first-load bytes drop by about 5× compared with PR 1; thumbnails look sharp on a 2× and a 3× screen (no visible blur at 100 % zoom).

### PR 3 — Detail image on demand + preload of neighbours
1. `Detail.astro`: `<Image … widths={[800, 1600]} sizes="(min-width: 768px) calc(100vw - 22rem), 100vw" />`. Check the `22rem` against the actual right column (`.detail-right { flex: 0 0 20rem }` + gaps and padding).
2. Opened photo: once `.open` is set the image enters layout and loads. Add `fetchpriority="high"` on the opened photo's image when it is shown.
3. `Gallery.astro`: after `showDetail(index)`, preload the previous and next entries of `visibleThumbnails` (the filtered list). Do this by creating `new Image()` with the same `srcset`/`sizes` as their detail `<img>`, read from the DOM, so the browser picks the same file. Do not preload more than 2.

Done when: opening a photo fetches 1 detail image + at most 2 neighbours; next/previous show the photo without a visible blank on a throttled "Fast 4G" profile.

## 5. Targets (cold cache, from the PR 0 script)

| Page / device | Today | Target after PR 3 |
|---|---|---|
| Street art, iPhone 13 | 340 images, 81.4 MB | ≤ 15 images, ≤ 1.5 MB |
| Street art, desktop 1440×900 | 340 images, 81.4 MB | ≤ 90 images, ≤ 5 MB |
| Fonts, both | not measured | measured in PR 0, same ratio expected |

[Reasoning] The targets are estimates: per-image size after PR 2 (about 43 KB at 480 px, more on 2× screens) multiplied by the PR 1 image counts. Adjust them once PR 1 and PR 2 are measured.

## 6. Facts to verify before coding

- `layoutDetail()` and `readCssVariables()`: do they measure the detail panel itself? This decides the order of `.open` and layout in PR 1.
- Every use of `style.visibility` and of `.wall-fade` in `Gallery.astro` and `Detail.astro`.
- Cache headers sent by GitHub Pages for `/_astro/*` files on the live site. This could not be checked from the cloud workspace. It affects repeat visits only, not this plan.
- Side finding, separate fix: `src/pages/streetart/rss.xml.js` and `src/pages/fonts/rss.xml.js` read `image.alt`, which is absent from the schema, so RSS titles start with "undefined".
