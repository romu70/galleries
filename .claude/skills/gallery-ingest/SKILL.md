---
name: gallery-ingest
description: Ingest fresh iPhone HEIC photos from ~/Downloads into the Astro Galleries project. Classifies each photo as fonts vs streetarts, generates frontmatter (tag, alt) with a vision sub-agent, asks the user to approve a batch, then runs the existing add-items script and patches the generated entries. Trigger when the user says things like "ingest photos", "process the new gallery photos", "import the downloads", or mentions HEIC files waiting to be added.
---

# Gallery Ingest

End-to-end pipeline for taking fresh HEIC photos from `~/Downloads` and turning them into approved gallery entries in this Astro project. Sub-agents classify in parallel; the user approves before any write.

## Project facts (load before doing anything)

- **Collections**: `fonts` (Markdown `.md` entries) and `streetarts` (JSON `.json` entries). Schemas are identical (`src/content.config.ts`): `{ place, pubDate, geo, image: { file, alt }, tag }`. There is no `artist` field — for streetarts, the artist goes in `tag`.
- **Existing script**: `scripts/add-items.mjs`, invoked as `npm run add-items -- fonts` or `npm run add-items -- streetarts`. Reads from `inbox/`, NOT from `~/Downloads`. Handles HEIC→JPG conversion, resize, date+GPS extraction, reverse geocoding, filename indexing, and moves originals to `inbox/processed/`.
- **What the script leaves blank**: `tag` (set to `"Serif"` or `"unknown"` as placeholder) and `alt` (set to the basename). This skill's job is to fill those two fields with vision-derived values.
- **Tag conventions** (match existing data, do not invent new casings):
  - Fonts: `"Serif"`, `"Sans-Serif"`, `"Cursive"` (capitalized, hyphenated).
  - Streetarts: the artist's signature/tag exactly as written if legible, otherwise the string `"unknown"`. Never use `null` — the schema requires a string.
- **Alt conventions**:
  - Fonts: the word or short phrase visible in the photo (e.g. `"Canonica"`, `"Bakery"`).
  - Streetarts: a short descriptive title of the work (e.g. `"Vampire"`, `"Bald Eagle"`, `"30 Moult 1/2"`).

## Pipeline

### Step 0 — Verify preconditions
- Working directory must be the project root (contains `package.json` with the `add-items` script).
- `inbox/` and `inbox/processed/` exist.
- `sips` and `mdls` are available (macOS-only — abort with a clear message otherwise).

### Step 1 — Detect candidate files
Find HEIC files in `~/Downloads` that **arrived on this Mac in the last 5 minutes**. We filter by **ctime (inode status change time)**, not mtime or birth time. Why:

- **mtime** is preserved from the source — AirDrop keeps the iPhone's original photo timestamp.
- **birth time** is *also* preserved — AirDrop copies the original creation date too.
- **ctime** is set fresh when the file's inode is created on this volume — i.e. when AirDrop hands it to the disk. This is the only one of the three that reflects the arrival event.

This is equivalent to Spotlight's `kMDItemDateAdded`, but `find -cmin` is one command and doesn't depend on Spotlight indexing.

```bash
/usr/bin/find ~/Downloads -maxdepth 1 -type f -iname '*.heic' -cmin -5
```

**Always use `/usr/bin/find` directly** — the `rtk` proxy installed in this project intercepts `find` and rejects compound predicates (flags like `-iname` combined with `-cmin`), causing a hard error. Bypass it by calling the absolute path.

Notes:
- Case-insensitive: matches `.HEIC`, `.heic`, and double extensions like `.HEIC.heic`.
- If zero files: report "no fresh HEIC files in ~/Downloads (last 5 minutes)" and stop.
- Filenames can contain spaces — quote properly everywhere.
- To inspect all timestamps for one file: `stat -f 'm:%Sm c:%Sc b:%SB' <path>` (mtime / ctime / birth).
- Edge case: `chmod` or `chown` on a HEIC bumps its ctime. In a normal AirDrop workflow this doesn't happen, but if a previously-processed file shows up here, the review step in Step 4 lets the user skip it.

### Step 2 — Convert each HEIC to a temp JPG for inspection
The Read tool cannot open HEIC. For each candidate, produce a **low-res JPG (1024px max)** in a temp directory. This is **only** for the vision sub-agent — it is not the final asset. The canonical 1600px conversion happens later in Step 6 when `scripts/add-items.mjs` runs (which does its own `sips -Z 1600` from the original HEIC).

```bash
mkdir -p /tmp/gallery-ingest
sips -Z 1024 -s format jpeg "<heic-path>" --out "/tmp/gallery-ingest/<basename>.jpg"
```

Keep a mapping `{ heic_path → temp_jpg_path }` for use in later steps.

**Do not change the 1024 here, and do not bypass the script's 1600px resize in Step 6.** The two resolutions serve different purposes.

### Step 3 — Classify in parallel via sub-agents
For each temp JPG, spawn a sub-agent (single message, multiple `Agent` tool calls in parallel) using `subagent_type: "general-purpose"`. Each sub-agent gets the prompt below.

**Sub-agent prompt template** (substitute `<jpg-path>` and `<original-heic-name>`):

> You are classifying a single photo for an Astro gallery site. Read the image at `<jpg-path>` using the Read tool, then output a YAML block describing it.
>
> Two possible collections:
> - `fonts` — photos of typefaces / lettering found in the street.
> - `streetarts` — murals, paintings, sculptures, graffiti, stickers, public art.
> - `skip` — anything else (screenshots, receipts, food, people, blurry, etc.).
>
> Rules:
> 1. If the photo is fonts: pick `font_category` from exactly one of `Serif`, `Sans-Serif`, `Cursive`. Set `alt` to the word/phrase visible in the photo (e.g. "Canonica"). Set `artist` to `null`.
> 2. If the photo is streetarts: set `font_category` to `null`. Set `alt` to a short descriptive title of the work (2–5 words). For `artist`, **only** transcribe a signature or tag that is clearly legible in the image. If you cannot read it with high confidence, output the string `unknown` — do NOT guess or hallucinate names.
> 3. If the photo is neither: set `collection` to `skip` and leave other fields `null`.
> 4. Output **only** the YAML block below — no prose, no markdown fences, no preamble, no trailing commentary.
>
> ```
> source: <original-heic-name>
> collection: fonts | streetarts | skip
> font_category: Serif | Sans-Serif | Cursive | null
> artist: <string or unknown or null>
> alt: <string or null>
> description: <one-sentence factual description of the image>
> tags: [<3 to 6 short keywords>]
> confidence: low | medium | high
> ```

Parse each sub-agent's reply into a structured record. If a reply contains anything other than the YAML block, treat it as a failure and re-run that one sub-agent once before flagging.

### Step 4 — Present batch for human review
Print a compact table to the user — one row per file. Suggested format:

```
[1] IMG_6338.HEIC  → fonts/Sans-Serif       alt="Bakery"         conf=high
[2] IMG_6421.HEIC  → streetarts/Ben Alpha   alt="Vampire"        conf=medium
[3] IMG_8486.HEIC  → streetarts/unknown     alt="Bald Eagle"     conf=high  ⚠ artist unknown
[4] IMG_9002.HEIC  → skip (screenshot)
```

Then ask the user:
> "Approve all, reject all, or list per-item decisions (e.g. `1 ok, 2 edit tag=Shino, 3 skip`)?"

Accept: `ok` / `approve`, `skip` / `reject`, or `edit <field>=<value>[, <field>=<value>]` (fields: `collection`, `tag`, `alt`).

**Do not write anything to disk yet.** No file moves, no script invocation.

### Step 5 — Apply approvals
After the user responds, partition the items:
- `approved` — go to Step 6.
- `skipped` / `rejected` — leave the HEIC in `~/Downloads` (do NOT delete user files), report at end.
- `edits` — apply user-supplied overrides to the record before Step 6.

### Step 6 — Stage, run script, patch
Group approved items by collection (`fonts` vs `streetarts`). For **each group**, in series (the script's date-index map is per-invocation and serial avoids collisions):

1. **Snapshot the target dir** so we can identify newly-created entries:
   ```bash
   ls src/content/<collection>/ > /tmp/gallery-ingest/before-<collection>.txt
   ```
2. **Stage** each approved HEIC into `inbox/`. Use a deterministic order (sort by HEIC's mtime ascending) so the script's index matches the order presented to the user:
   ```bash
   cp "<heic-path>" "inbox/<basename>"
   ```
   Use `cp`, not `mv`. The script will move them to `inbox/processed/` after success; keeping the original in `~/Downloads` is preserved only if you used `cp` and you delete from `~/Downloads` at the end on success.
3. **Run the script**:
   ```bash
   npm run add-items -- <collection>
   ```
   Capture stdout. Abort the group on non-zero exit.
4. **Diff the target dir** to find the new entry files (`.md` for fonts, `.json` for streetarts):
   ```bash
   ls src/content/<collection>/ > /tmp/gallery-ingest/after-<collection>.txt
   diff /tmp/gallery-ingest/before-<collection>.txt /tmp/gallery-ingest/after-<collection>.txt
   ```
   Map new files back to source HEIC by **mtime-sorted order** — the script processes `readdirSync` order, which on macOS is generally alphabetical. To be safe, sort the staged inbox files alphabetically and pair them with the new entries sorted alphabetically.
5. **Patch each new entry** with the vision-derived `tag` and `alt`:
   - First, **Read all new entry files in parallel** (one Read tool call per file in a single message). The Edit tool requires a prior Read in the same session — skipping this causes every edit to fail.
   - Then apply edits in parallel: Fonts (Markdown): replace `alt: "<basename>"` → `alt: "<vision-alt>"` and `tag: "Serif"` → `tag: "<font_category>"`. Streetarts (JSON): replace `"alt": "<basename>"` and `"tag": "unknown"` with the vision values.
6. **Clean up Downloads on success only**: delete the approved HEIC files from `~/Downloads`. Skipped files stay put. Never delete a file you couldn't confirm was successfully patched.

### Step 7 — Report
End with a short summary:
- `N` entries created in `fonts`, `M` in `streetarts`.
- Items flagged for manual follow-up (e.g. streetarts with `artist=unknown` and medium/low confidence — list their entry filenames so the user can revisit).
- Skipped files (with reason).
- Any errors (script failure, patching failure, parse failure).

Do NOT commit, push, or open a PR. Stop at the report.

## Constraints and guardrails

- **Never hallucinate artist names.** If a signature is partially visible or you "kind of recognize" the style, that is not high confidence — output `unknown`. The user would rather edit one file later than have a wrong attribution shipped.
- **Vision sub-agents output YAML only.** No prose, no fences, no "here is the result". If a sub-agent breaks this, retry once, then surface the raw output to the user.
- **Human checkpoint is mandatory before any write.** No `cp` into `inbox/`, no `npm run`, no file edits before the user has responded to the review prompt.
- **Failed group is isolated.** If the streetarts group fails mid-script, the fonts group (if processed first) stays committed; surface what succeeded vs failed and what's left in `inbox/`.
- **Never touch files in `~/Downloads` that this run did not classify** — the 5-minute filter is the contract.
- **Do not modify `scripts/add-items.mjs`** as part of this skill. If you find a case the script can't handle, surface it; don't patch it silently.

## Edge cases to handle explicitly

- Zero fresh HEIC files → exit cleanly with a one-line message.
- HEIC with no GPS or no creation date → script handles via fallbacks; pass through and note it in the report.
- Sub-agent classifies as `skip` → leave HEIC in `~/Downloads`, list under "skipped" in the report.
- Same artist signature appearing across multiple photos in a batch → fine; each entry gets its own `tag` independently. If the user edits one, they can specify the same edit for the others in their response.
- Filenames with spaces or double extensions (e.g. `IMG_6421 2.HEIC.heic`) → quote shell args; when staging into `inbox/`, sanitize to a simpler ASCII-only name to avoid surprises in `readdirSync` ordering (e.g. strip spaces, lowercase the extension).
- An image with multiple distinct works/fonts → the schema is one entry per file; mark it for manual handling in the review table (set `collection: skip` with a note, or let the user decide via `edit`).
- Sub-agent timeout or empty reply → retry once, then surface and skip that file.
