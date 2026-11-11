# Implementation plan — "This wall over time"

Single, self-contained reference for implementing the feature. Everything needed is in this file and in the mockups under `docs/wall-design/`:

- `docs/wall-design/desktop.jpg` — detail view on desktop, photo 3 of 5 on the test wall.
- `docs/wall-design/phone.png` — same, on phone.
- `docs/wall-design/states.png` — states of the section: first photo, last photo, wall with 2 photos, wall with 12 photos, status line after a cleared filter. The dates in the 2- and 12-photo examples are illustrative.

Background only, not in the repo and not needed: two earlier planning notes and the design canvas they came from (kept in Romu's claude.ai project). Where they differ, this document wins.

Revision 4 (2026-11-11): made self-contained; mockups added. Revision 3: every reviewed photo gets a wall (S2); a photo without a wall is "to process"; 5 groups per run; review mode added to the skill.

## 1. Goal and scope

When a street-art photo is open in the detail view, the visitor sees the other photos of **the same physical wall**, in date order, and can move between them.

In scope: data model, detail-view UI, a dedicated `gallery-walls` skill (backfill, ongoing processing, corrections), a facts-only update of `gallery-ingest`.
Out of scope: before/after slider, `/walls` page, map of walls, per-photo URLs, links between the faces of one structure.

## 2. Decisions

| # | Decision |
|---|---|
| Wall | One physical painted surface. A pillar with 4 painted faces = 4 walls. |
| Membership | Declared and confirmed by Romu. GPS only produces candidates. |
| M1 | `walls` collection + `wall: reference("walls")` on street-art entries. |
| S2 | **Every reviewed street-art photo gets a wall**, even when it is the only photo of that wall. The `wall` field is the processing state: missing or `null` = to process; set = processed. No other flag. |
| D1 | Wall id `<town>-wNNN` (3 digits or more), opaque, e.g. `nantes-w001`. |
| M2 | `lat`/`lon` optional on a wall. |
| M3 | Several photos of the same artwork: each photo is one step. |
| M4 | A wall with 1 photo is the normal case: no warning; the UI section is not shown. |
| Order | `pubDate` ascending, then entry id. |
| Design | V2: date buttons + dot timeline, in the metadata block (D3). |
| D2 | Target hidden by an artist filter: clear the filter + show a status line. |
| U1 | Dots clickable when the wall has ≤ 7 photos; above, display only. |
| U2 | Section title "This wall over time". |
| D5 | The 5 test photos are one wall (confirmed). |
| S1 | Wall processing lives in its own skill, `gallery-walls`, run independently of photo ingest. |
| W2 | 5 proposed groups per run. |

## 3. Work packages (one PR each, in this order)

### PR 0 — Spike (no merge needed)
- Point one entry at a non-existent wall with `reference()`, run `astro build`.
- Record: does the build fail? This decides whether PR 1 needs its own existence check.

### PR 1 — Data model (no visible change)
1. Split the shared schema in `src/content.config.ts`: base schema (fonts unchanged) + street-art extension with `wall: reference("walls").nullish()` (missing and `null` both accepted, both mean "to process").
2. New collection `src/content/walls/<id>.json`: `place` (string), `lat`/`lon` (numbers, optional), `label` (optional string).
3. `src/lib/walls.ts` — `getWallMembers(entries)`: for each street-art entry with a wall, returns `{ wallId, members: [{ id, index, pubDate }], position, total }`, members sorted per §2. The full member list (not only prev/next) is needed by the dots.
4. Build-time checks: dangling reference (if PR 0 shows Astro doesn't catch it) → error; malformed wall id → error; wall file referenced by no photo → warning. No check on walls with 1 photo (M4).
5. Seed: `nantes-w001.json` + `"wall": "nantes-w001"` on `2023-04-20-01`, `2023-11-26-02`, `2024-11-10-01`, `2025-09-07-01`, `2026-05-08-03`. All other photos stay without a wall (to process).

Done when: `astro build` passes; a dangling reference fails the build; the site looks unchanged.

### PR 2 — Detail view UI
1. `Gallery.astro` passes the wall data from `getWallMembers` to each `Detail`.
2. `Detail.astro`: new section inside `.meta`, after the `<dl class="fields">`, before `.map-link`. Rendered only when `total ≥ 2`. Contents per §4.
3. Client script: buttons and dots call the existing `processImage(index)`. If the target is hidden by the artist filter, clear the filter first, then show the status line in the newly opened photo.
4. Crossfade between photos of the same wall (~200 ms), none under `prefers-reduced-motion: reduce`.

Done when all states of §4 render as in the mockups, on desktop and phone, keyboard-only use works, and the gallery arrows behave as before.

### PR 3 — New skill `gallery-walls`
Runs by hand, any time, independently of `gallery-ingest`. Two modes.

**Mode `process`** (default) — backfill and new photos alike: works on street-art photos whose `wall` is missing or `null`.
1. **Select** photos to process, oldest first, until 5 groups are proposed. Photos without GPS are listed apart and handled only on request.
2. **Candidates**: for each selected photo, every other street-art photo within ~20 m, plus photos with identical coordinates, processed or not.
3. **Visual grouping**: Claude compares the images (roofline, windows, vents, pipes) and proposes one of:
   - join existing wall `<id>` (a candidate already has a wall);
   - new wall with these photos (several unprocessed photos match each other);
   - new wall with this photo alone (no match).
4. **Review on iPhone**: one contact sheet per proposed group (thumbnails in date order, entry ids, dates, distance). Answers: `ok`, `split 3`, `drop 2`, `merge with nantes-w004`, `alone`.
5. **Write**: new wall files (next free `<town>-wNNN`, town from `place`, `lat`/`lon` from the photo's GPS) and the `wall` field on every reviewed photo. A matched unprocessed candidate is processed at the same time.
6. **Check and deliver**: `astro build` + checks, branch, PR, short report (walls created, photos joined to an existing wall, single-photo walls).

A new photo of an already processed wall needs nothing special: it has no wall, so the next run picks it up and proposes "join `<id>`".

**Mode `review <photo-id | wall-id>`** — corrections.
1. Show the wall's photos and the walls within ~20 m.
2. Answers: `ok`, `move 2 to nantes-w004`, `split 3` (photos from position 3 to a new wall), `merge with nantes-w004`.
3. Write the changes, delete wall files left with no photo, build, PR.

Done when: one `process` run on a small batch produces a reviewable PR; a second run does not re-propose the processed photos; a `review` run can move a photo between walls.

### PR 4 — `gallery-ingest` facts only
Update the skill's schema facts: `wall` exists; ingest never writes it, so new photos start "to process"; walls are handled by `gallery-walls`. No change to its steps or to `add-items.mjs`.

### Then — Backfill
Repeated `gallery-walls` runs, one PR per run, at your own pace. Expect ~300 wall files over time, most with a single photo.

## 4. UI spec (see the mockups in `docs/wall-design/`)

Uses the existing tokens: `--main-color` (white), `--active-background-color` (#464646), Inter.

Section `This wall over time`, inside `.meta`:
- Top: 1px separator (`--main-color` at 20 % opacity), 16 px padding above.
- Header row: label "THIS WALL OVER TIME" (same style as `.fields dt`) left; "3 of 5" right (13 px, ~80 % opacity).
- Timeline (≤ 7 photos): a 2 px line (30 % opacity) through one dot per photo, evenly spaced (not by date). Other photos: 10 px ring, 2 px border, each in a 44 × 44 px `<button>` with `aria-label` = full date. Current: 16 px filled dot with a 4 px halo, `aria-current="true"`, not a button. Under the line: first year at the left end, last year at the right end (12 px).
- Timeline (> 7 photos): same, dots 8 px, display only (`<span>`), current 14 px.
- Buttons row: two equal buttons, 44 px high, 1 px `--main-color` border, 8 px radius (distinct from the round gallery arrows). Left `← 26 Nov 2023`, right `7 Sep 2025 →`. Date format en-GB, `day: numeric, month: short, year: numeric`, UTC. `aria-label`: "Earlier on this wall, 26 November 2023".
- First / last photo: the matching button stays in place, `disabled`, 40 % opacity, text "Earlier" / "Later".
- Status line after a filter was cleared: `role="status"`, info icon + "Artist filter "<name>" cleared to show this photo." Disappears on the next navigation.
- Container: `role="group"`, `aria-label="Same wall, photo 3 of 5"`.
- Phone: identical section, same place in `.meta` (before the divider and the gallery controls).

## 5. Facts to verify before coding (from earlier reading, may have changed)

- Each photo has its own `Detail` with `data-index`; `processImage(index)` opens a photo.
- Artist filter mechanics (`.tag` buttons with `data-tag`).
- Where the existing skills live in the repo, so `gallery-walls` sits next to `gallery-ingest`.
- Side finding: `src/pages/streetart/rss.xml.js` reads `image.alt`, absent from the schema. Separate fix, not part of this feature.
