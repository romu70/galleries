---
name: gallery-walls
description: Group street-art photos of the Galleries site by physical wall, so the detail view can show "This wall over time". Two modes. "process" (default) takes the oldest photos without a wall, proposes 5 groups from GPS proximity and visual comparison, asks the user to review contact sheets, then writes the walls and opens a PR. "review <photo-id | wall-id>" corrects an existing wall (move, split, merge). Trigger when the user says things like "process walls", "run gallery-walls", "group the walls", "next walls batch", "review wall nantes-w004", "this photo is on the wrong wall".
---

# Gallery Walls

Assigns each street-art photo of `romu70/galleries` to the physical wall it shows. Runs by hand, in a Claude Code cloud session or locally, independently of `gallery-ingest`. GPS only produces candidates; the user decides what is the same wall. The result is a PR the user merges from the GitHub app.

## Project facts (load before doing anything)

- **Wall** = one physical painted surface. A pillar with 4 painted faces is 4 walls. Several photos of the same artwork are each a step on that wall.
- **Data** (see `docs/wall-implementation-plan.md` for the full design):
  - Street-art entries: `src/content/streetarts/<id>.json`. The `wall` field holds a wall id. **Missing or `null` = to process; set = processed.** There is no other flag.
  - Walls: `src/content/walls/<wall-id>.json` with `place`, optional `lat`/`lon`, optional `label`. Wall id = `<town>-wNNN` (lowercase ASCII town slug, at least 3 digits), opaque, e.g. `nantes-w001`.
  - **Every reviewed photo gets a wall**, even when it is the only photo of that wall. A single-photo wall is the normal case: no warning, and the site shows no section for it.
  - GPS lives only in the entry's `geo` string (`mlat=<lat>&mlon=<lon>#map=…`). A few entries have `geo: "#"` (no GPS).
- **Helper script**: `scripts/walls.mjs`, run from the site repo root. It does all reading, distances, contact sheets and writing; do not hand-edit entry or wall files.
  - `node scripts/walls.mjs status` — counts: processed, to process, without GPS, walls.
  - `node scripts/walls.mjs batch [--seeds N] [--radius M]` — oldest photos to process (with GPS), each with every street-art photo within `M` metres (default 20), processed or not.
  - `node scripts/walls.mjs review <photo-id | wall-id> [--radius M]` — a wall's members, the walls near it, and unprocessed photos near it.
  - `node scripts/walls.mjs sheet --out <file.jpg> [--from <photo-id>] <photo-id>...` — numbered contact sheet in the order given; each label shows the number, entry id (which starts with the date), distance from `--from` (default: the first photo), and current wall or "to process".
  - `node scripts/walls.mjs check` — diff guard before committing (see Step 5).
  - `node scripts/walls.mjs apply <plan.json> [--dry-run]` — writes a plan (format below). Creates new walls with the next free `<town>-wNNN` (town from the oldest photo's `place`, `lat`/`lon` from the oldest photo with GPS), sets or changes `wall` on the listed photos, deletes wall files left with no photo. Prints a JSON summary.
- **Plan format**:
  ```json
  { "assign": [
      { "wall": "new", "photos": ["2023-01-12-03", "2023-02-24-01"] },
      { "wall": "nantes-w001", "photos": ["2025-10-02-01"] },
      { "wall": "new", "photos": ["2023-01-15-01"], "label": "optional" }
  ] }
  ```
  Each photo appears at most once. A photo not in the plan is left as it is.
- **Build checks**: `astro build` fails on a `wall` pointing to a missing file or a malformed id, and warns on a wall file no photo uses (`src/lib/walls.ts`, `checkWalls`).

## Mode `process` (default)

Works on street-art photos whose `wall` is missing or `null`: the backfill and new photos alike. A new photo of an already processed wall needs nothing special: it has no wall, so it is picked up and proposed as "join `<id>`".

### Step 0 — Preconditions
- Locate the site repo (`git remote get-url origin` ends in `/galleries`). Call it `$SITE`; run everything from there.
- `git -C "$SITE" pull --ff-only`; working tree clean (`git status --short`), else stop and show what is there.
- `convert` and `montage` (ImageMagick) on PATH; if missing, `apt-get install -y imagemagick` and say so in the report.
- If `node_modules` is missing, `npm ci` (needed for `astro build`).
- `mkdir -p /tmp/gallery-walls` for the batch, sheets and plan.
- `node scripts/walls.mjs status` — tell the user in one line where the backfill stands (e.g. "5 / 338 processed").

### Step 1 — Select
`node scripts/walls.mjs batch --seeds 15 > /tmp/gallery-walls/batch.json`

Walk the seeds oldest first and build proposals until there are **5 groups**. Skip a seed already placed in an earlier proposal of this run. If the seeds run out before 5 groups, run `batch` again with a larger `--seeds`.

Photos without GPS are listed apart (`without_gps`) and handled **only if the user asks**; mention their count in the report.

### Step 2 — Compare (visual grouping)
For each seed:
1. Make a comparison sheet of the seed and all its candidates, in date order: `node scripts/walls.mjs sheet --out /tmp/gallery-walls/cmp-<seed>.jpg --from <seed> <ids in date order>`. With more than 9 candidates, make several sheets (the seed on each).
2. Read the sheet and compare **what does not change when a wall is repainted**: roofline and gable shape, windows, doors, vents, pipes, gutters, downpipes, wall ends and corners, ground, kerb, neighbouring buildings. The painting itself is weak evidence: many of these walls are legal walls repainted every few months, so the same wall can show completely different works, and the same artist can paint different walls.
3. If a candidate already has a wall, look at that wall's other photos too (`review <wall-id>`) before proposing to join it.
4. Propose exactly one of:
   - **join existing wall `<id>`** — a candidate already on a wall matches;
   - **new wall with these photos** — several unprocessed photos match each other;
   - **new wall with this photo alone** — no match.

   An unprocessed candidate that matches is processed at the same time, in the same group. A candidate that does not match is left out (it will be a seed later, possibly in this run).
5. When unsure, say so in the proposal (`⚠ same roofline, but the window is missing on 3`) rather than guessing. Do not join a photo to a wall on GPS alone.

### Step 3 — Review on iPhone
The user is usually on the iPhone. For each proposed group, make **one contact sheet** (`sheet --out /tmp/gallery-walls/group-<n>.jpg <ids in date order>`, including the existing members when joining a wall) and send it to the user (e.g. with the file-sending tool, rendered inline). Then one compact line per group:

```
[1] join nantes-w001 ← 2023-04-26-01 (6 m)            same gable, vents and door
[2] new wall: 2023-01-12-03, 2023-02-24-01, 2023-05-26-01   red skyline band, same pipe at right
[3] new wall alone: 2022-12-10-01                       2 candidates, different building
[4] new wall: 2023-01-14-01, 2023-08-23-02   ⚠ only the ground matches
[5] new wall alone: 2023-01-15-01
```

Numbers inside a group are the numbers printed on its contact sheet. Ask:
> "Answer per group: `ok`, `split 3`, `drop 2`, `merge with nantes-w004`, `alone` (e.g. `1 ok, 2 split 3, 4 alone`)."

Meaning of each answer (numbers are positions on that group's sheet):
- `ok` — write the group as proposed.
- `split k` — photos `k` and after go to a new wall of their own; the photos before `k` keep the proposal.
- `drop k` — photo `k` leaves the group and stays **to process** (no wall): it will come back in a later run.
- `merge with <wall-id>` — the group's unprocessed photos join that existing wall instead.
- `alone` — each unprocessed photo of the group gets its own single-photo wall. `alone k` does it for photo `k` only.

In process mode, photos already on a wall are shown for context only: `split`/`drop`/`alone` on one of them is not applied; tell the user to use `review <wall-id>`. If the answer is something else, apply what the user actually said; if a detail stays open, pick the option most consistent with the data and state the assumption in the report rather than asking again.

**Do not write anything before the answer.** No branch, no plan applied.

### Step 4 — Write
1. Build `/tmp/gallery-walls/plan.json` from the answers. Every photo the user reviewed (all photos of all groups except dropped ones) must be in the plan, so it gets a wall.
2. `node scripts/walls.mjs apply /tmp/gallery-walls/plan.json --dry-run` and check the summary matches the answers (walls created, photos joined, single-photo walls). If not, fix the plan.
3. Create the branch: `git checkout -b walls/<YYYY-MM-DD>-<HHMM>`.
4. `node scripts/walls.mjs apply /tmp/gallery-walls/plan.json` and keep its JSON summary for the report.

### Step 5 — Check and deliver
1. `npx astro build` must pass with no `[walls]` warning. If it fails, fix the plan or stop and report; never open a PR on a broken build.
2. **Diff guard**: `node scripts/walls.mjs check` must print `"ok": true`. It compares every changed file with `HEAD`: only `src/content/walls/*.json` (valid ids) and the `wall` field of existing `src/content/streetarts/*.json` entries may change. Any other file or field is a stop.
3. Commit only those files (never `git add -A`):
   ```bash
   git add src/content/walls src/content/streetarts/<changed entries>
   git commit -m "Walls: <N> photos on <W> walls (<K> new)"
   ```
   with a body listing walls created, photos joined to existing walls, and single-photo walls, and the co-author line for the model actually running.
4. Push and open the PR through the REST API (`gh pr create` uses GraphQL, blocked in cloud sessions):
   ```bash
   git push -u origin <branch>
   gh api repos/romu70/galleries/pulls -f base=main -f head=<branch> \
     -f title="<commit subject>" -F body=@/tmp/gallery-walls/pr-body.md --jq .html_url
   ```
   PR body: the approved table, the answers given, the `apply` summary, and the remaining count from `status`.

### Step 6 — Report
Short:
- PR link; merging publishes the walls.
- Walls created (ids, with their photos), photos joined to an existing wall, single-photo walls.
- Dropped photos (still to process), photos without GPS left aside, and `status` after the run (e.g. "27 / 338 processed").
- Any assumption made, any build or push error.

## Mode `review <photo-id | wall-id>` — corrections

1. `node scripts/walls.mjs review <id>`: members of the wall, walls within ~20 m, unprocessed photos nearby. If the photo has no wall, say so and offer `process` instead.
2. Make one contact sheet of the wall's members (date order) and one per nearby wall (or a single sheet if they are few), send them, and list them:
   ```
   nantes-w004 (3 photos): 1 2023-…, 2 2024-…, 3 2025-…
   nearby: nantes-w002 (12 m, 2 photos), nantes-w009 (18 m, 1 photo)
   ```
3. Ask: "`ok`, `move 2 to nantes-w002`, `move 2 to new`, `split 3`, `merge with nantes-w002`?"
   - `ok` — nothing to change: stop, no branch, no PR.
   - `move k to <wall-id>` / `move k to new` — photo `k` changes wall.
   - `split k` — photos `k` and after go to a new wall.
   - `merge with <wall-id>` — all photos of this wall join `<wall-id>`; this wall's file is deleted.
4. Build the plan (only the photos that change), dry-run, branch `walls/review-<wall-id>-<YYYY-MM-DD>`, apply. `apply` deletes wall files left with no photo.
5. Step 5 and Step 6 of process mode (build, diff guard, commit, PR, report). Commit subject: `Walls: fix <wall-id> (<what changed>)`.

## Constraints and guardrails

- **The user decides membership.** GPS and visual similarity only produce proposals. Never write before the answer.
- **Change nothing but walls.** Only `wall` fields and `src/content/walls/*.json`. Never touch `tag`, `place`, `geo`, dates, images or `add-items.mjs`. A wrong place or artist seen during review goes in the report, not in this PR.
- **Never invent coordinates.** A wall's `lat`/`lon` come from a photo's GPS through `apply`; a wall made only of no-GPS photos has none.
- **Do not renumber or rename existing walls.** Ids are opaque and stable; a deleted id may be reused later by `apply`, which is fine.
- **One run, one PR.** Do not stack a second batch on an unmerged walls branch; if one is open, tell the user and ask whether to continue from it.
- **Look before you propose.** Read every comparison sheet yourself; with many candidates, split the sheets rather than skimming one huge image.

## Edge cases

- **Dense spots** (legal walls, a street with many murals): a seed can have 10+ candidates within 20 m that are different walls. Compare structure, not paint; propose small, confident groups and leave the doubtful candidates for later seeds.
- **Same wall, shot from far away** or from across the street: the GPS points can be more than 20 m apart. If the user says a photo belongs to a wall the batch did not offer, use `merge with` / `move … to` as asked; if you suspect it, run `batch --radius 40` for that seed.
- **Identical coordinates** for different works (photos taken in a row without a GPS update): distance 0 m is not evidence of the same wall.
- **A wall with 2 faces in one photo** (corner): the photo goes on the wall that is its main subject; mention it in the report.
- **A wall across two towns** (`place` differs, e.g. Nantes vs Rezé on a boundary street): the new wall takes the town of its oldest photo; joining an existing wall keeps that wall's id whatever the photo's town.
- **An entry with `place: "City, Country"`** (EXIF fallback from ingest): `apply` refuses to create a wall from it. Leave it to process and flag it.
- **Inbox, ingest**: this skill never reads `galleries-inbox` and never runs `add-items`.
