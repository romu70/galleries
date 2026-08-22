---
name: gallery-ingest
description: Ingest fresh iPhone HEIC photos from ~/Downloads into the Astro Galleries project. Classifies each photo as fonts vs streetarts, generates the tag with a vision sub-agent, asks the user to approve a batch, then runs the existing add-items script and patches the generated entries. Trigger when the user says things like "ingest photos", "process the new gallery photos", "import the downloads", or mentions HEIC files waiting to be added.
---

# Gallery Ingest

End-to-end pipeline for taking fresh HEIC photos from `~/Downloads` and turning them into approved gallery entries in this Astro project. Sub-agents classify in parallel; the user approves before any write.

## Project facts (load before doing anything)

- **Collections**: `fonts` (Markdown `.md` entries) and `streetarts` (JSON `.json` entries). Schemas are identical (`src/content.config.ts`): `{ place, pubDate, geo, image: { file }, tag }`. There is no `artist` field — for streetarts, the artist goes in `tag`.
- **Existing script**: `scripts/add-items.mjs`, invoked as `npm run add-items -- fonts` or `npm run add-items -- streetarts`. Reads from `inbox/`, NOT from `~/Downloads`. Handles HEIC→JPG conversion, resize, date+GPS extraction, reverse geocoding, filename indexing, and moves originals to `inbox/processed/`.
- **What the script leaves blank**: `tag` (set to `"Serif"` or `"unknown"` as placeholder). This skill's job is to fill that field with a vision-derived value.
- **Tag conventions** (match existing data, do not invent new casings):
  - Fonts: `"Serif"`, `"Sans-Serif"`, `"Cursive"` (capitalized, hyphenated). Blackletter/gothic has no category of its own — file it as `"Serif"` and flag it in the report.
  - Streetarts: the artist's name if legible, otherwise the string `"unknown"`. Never use `null` — the schema requires a string.
    - Write it as a **normally-spaced human name**, not the verbatim wall signature: `@FrancoMartinez ARTE` → `"Franco Martinez"`.
    - Join collaborators with **` + `**: a credit reading `Vincenzo Dioniso X Olossolo` → `"Vincenzo Dioniso + Olossolo"`.
    - Older entries like `GARCIAYESSS` and `JP_gimenez_dibujos` predate this convention. Don't copy them.
    - Text naming the artwork's **subject or title is never the artist** — `DIEGO` on a Maradona mural, `L'ANGOLO DI SOPHIA LOREN` on a group portrait, a dedication plaque naming Bud Spencer. All of those are `"unknown"`.

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
> - `fonts` — photos of typefaces / lettering found in the street. This includes lettering rendered in unusual media (mosaic tiles, neon, carved stone, painted signs) as long as the subject is the letterforms themselves.
> - `streetarts` — murals, paintings, sculptures, welded/assembled metal artworks, graffiti, stickers, public art. A mosaic or tile piece that depicts a *scene* rather than letters belongs here, not in `fonts`.
> - `skip` — anything else (screenshots, receipts, food, people, blurry, etc.).
>
> Rules:
> 1. If the photo is fonts: pick `font_category` from exactly one of `Serif`, `Sans-Serif`, `Cursive`. Set `artist` to `null`.
> 2. If the photo is streetarts: set `font_category` to `null`. For `artist`, **only** transcribe a signature that is clearly legible AND is plausibly the artist's own. Text naming the artwork's *subject* or *title* is NOT an artist signature — a celebrity's name across a portrait of them, a dedication plaque, a painted caption. In those cases output `unknown`. If you cannot read a signature with high confidence, output `unknown` — do NOT guess or hallucinate names. Format a legible signature as a normally-spaced name (`@FrancoMartinez` → `Franco Martinez`); join collaborators with ` + `.
> 3. If the photo is neither: set `collection` to `skip` and leave other fields `null`.
> 4. Output **only** the YAML block below — no prose, no markdown fences, no preamble, no trailing commentary.
>
> ```
> source: <original-heic-name>
> collection: fonts | streetarts | skip
> font_category: Serif | Sans-Serif | Cursive | null
> artist: <string or unknown or null>
> description: <one-sentence factual description of the image>
> tags: [<3 to 6 short keywords>]
> confidence: low | medium | high
> ```

Parse each sub-agent's reply into a structured record. If a reply contains anything other than the YAML block, treat it as a failure and re-run that one sub-agent once before flagging.

### Step 4 — Present batch for human review
Print a compact table to the user — one row per file. Suggested format:

```
[1] IMG_6338.HEIC  → fonts/Sans-Serif       conf=high    "arbiter" rounded shopfront sign
[2] IMG_6421.HEIC  → streetarts/Ben Alpha   conf=medium  ⚠ name only at medium confidence
[3] IMG_8486.HEIC  → streetarts/unknown     conf=high    mural, no legible signature
[4] IMG_9002.HEIC  → skip (screenshot)
```

Include a few words of description per row — it's what lets the user catch a miscategorised item without opening anything. `unknown` is the normal case for streetarts and needs no warning marker; reserve `⚠` for things you actively want a decision on (a name at medium confidence, a category with no good fit, a `skip` you're unsure about).

Then ask the user:
> "Approve all, reject all, or list per-item decisions (e.g. `1 ok, 2 edit tag=Shino, 3 skip`)?"

Accept: `ok` / `approve`, `skip` / `reject`, or `edit <field>=<value>[, <field>=<value>]` (fields: `collection`, `tag`).

If you disagree with a sub-agent's call, say so with your reasoning **before** the question and offer the corrected version as an option — don't pass a doubtful attribution through silently just because it came back `high`.

The user may answer with something other than the options offered ("all are streetarts, even 10", "put 5 in fonts"). Apply what they actually said. If their answer leaves a sub-question unresolved, pick the option most consistent with existing data, proceed, and state the assumption in the report rather than asking again.

**Do not write anything to disk yet.** No file moves, no script invocation.

### Step 5 — Apply approvals
After the user responds, partition the items:
- `approved` — go to Step 6.
- `skipped` / `rejected` — leave the HEIC in `~/Downloads` (do NOT delete user files), report at end.
- `edits` — apply user-supplied overrides to the record before Step 6.

### Step 6 — Stage, run script, patch
**Before doing anything else in this step**, stop the Astro dev server if it is running. The dev server watches `src/content/` and reacts to every file write — multiple rapid writes from the script plus the patch edits overwhelm its content layer and crash it. Stopping it first is the only reliable fix.

```bash
pkill -f "astro dev" 2>/dev/null || true
```

This is safe: `|| true` prevents an error if no process is found. Note that the user will need to run `npm run dev` again after the skill completes.

Group approved items by collection (`fonts` vs `streetarts`). For **each group**, in series (the script's date-index map is per-invocation and serial avoids collisions):

1. **Snapshot the target dir** so we can identify newly-created entries:
   ```bash
   ls src/content/<collection>/ > /tmp/gallery-ingest/before-<collection>.txt
   ```
2. **Stage** each approved HEIC into `inbox/`. Sort by HEIC mtime ascending so the assigned indices run in chronological order — the mapping itself comes from stdout in step 4, but chronological indices keep the gallery readable:
   ```bash
   cp "<heic-path>" "inbox/<basename>"
   ```
   Use `cp`, not `mv`. The script will move them to `inbox/processed/` after success; keeping the original in `~/Downloads` is preserved only if you used `cp` and you delete from `~/Downloads` at the end on success.
3. **Run the script**:
   ```bash
   npm run add-items -- <collection>
   ```
   Capture stdout. Abort the group on non-zero exit.
4. **Map source HEICs to new entries by parsing the script's stdout.** It prints one line per file naming both sides of the mapping explicitly:
   ```
   [1/6] Processing IMG_7769.heic -> images/2025-07-12-01.jpg
   ```
   `IMG_7769.heic` → entry `2025-07-12-01` (`.md` for fonts, `.json` for streetarts) and image `2025-07-12-01.jpg`. **Use this, not filename ordering.** The `before`/`after` snapshot from step 1 is only a cross-check that the count of new files matches the count of lines parsed — if they disagree, stop and surface it.

   Do NOT infer the mapping from alphabetical or mtime order. Index numbers do not restart at `01` per run — they continue from whatever already exists for that date, so a run's entries can start at `-06` or `-20`, and a batch can span two dates with independent counters.

   Also scan stdout for `Warning:` lines here — see the EXIF-fallback edge case below.
5. **Patch each new entry** with the vision-derived `tag`:
   - First, **Read all new entry files in parallel** (one Read tool call per file in a single message). The Edit tool requires a prior Read in the same session — skipping this causes every edit to fail.
   - Then apply edits in parallel: Fonts (Markdown): replace `tag: "Serif"` → `tag: "<font_category>"`. Streetarts (JSON): replace `"tag": "unknown"` with the artist value, formatted per the tag conventions above.
   - The script's placeholder is *already correct* for a good share of entries (`"Serif"` for fonts, `"unknown"` for streetarts). Only edit the ones that actually change; a no-op Edit call fails on an unchanged string.
6. **Verify, then clean up Downloads — on success only**:
   ```bash
   npx astro build
   ```
   This rebuilds the content store *and* validates every new entry against the collection schema, catching a broken `image.file` reference that `astro sync` would let through. Run it once after all groups are patched.

   Only once the build is clean, delete the approved HEIC files from `~/Downloads`. Skipped files stay put. Never delete a file you couldn't confirm was successfully patched — check that each original landed in `inbox/processed/` first, since that is the only remaining copy.

7. **Commit the new entries**. Stage only the files this run created — the content entries and their images — then commit:
   ```bash
   git add src/content/fonts/<new-entries> src/content/fonts/images/<new-images>
   git add src/content/streetarts/<new-entries> src/content/streetarts/images/<new-images>
   git commit -m "$(cat <<'EOF'
   Add <N> entries (<collections>, <date-range>)

   Co-Authored-By: <your model name> <noreply@anthropic.com>
   EOF
   )"
   ```
   The commit message should summarise what was added, e.g. `Add 4 streetarts entries (2025-06-26 / 2025-06-28)` or `Add 3 fonts + 2 streetarts entries (2025-07-01)`. If you repaired an EXIF fallback, say so in the body.

   Only stage files this run produced — never use `git add .` or `git add -A`. The working tree often carries unrelated edits (dependency bumps, the user's own tag corrections); `git status --short` before staging and confirm nothing else rides along. If the user edits one of your entries between your write and your commit, re-`git add` that file so the committed blob matches what is on disk.

### Step 7 — Report
End with a short summary:
- `N` entries created in `fonts`, `M` in `streetarts`, with the entry filenames.
- Items flagged for manual follow-up (e.g. streetarts with `artist=unknown` and medium/low confidence — list their entry filenames so the user can revisit).
- **Any EXIF fallback you repaired**: which entries, what the script wrote, what you corrected it to, and where the corrected values came from.
- Skipped files (with reason).
- Any assumption you made because the user's approval didn't cover it.
- Any errors (script failure, patching failure, parse failure, commit failure).
- Remind the user to run `npm run dev` to restart the dev server.

## Constraints and guardrails

- **Never hallucinate artist names.** If a signature is partially visible or you "kind of recognize" the style, that is not high confidence — output `unknown`. The user would rather edit one file later than have a wrong attribution shipped. A sub-agent returning a name at `medium` confidence is a candidate for downgrading to `unknown` — say so in the review table rather than passing it through silently.
- **Look at the image yourself when a call is doubtful.** Sub-agents see one photo with no context and do misread things — an abstract "mosaic pattern" that is actually a word in tiles, a "light fixture" that is actually a welded sculpture. Before presenting the batch, open any item that is `medium` confidence, that you intend to flag, or that the user pushes back on. One `Read` of the temp JPG settles it.
- **Vision sub-agents output YAML only.** No prose, no fences, no "here is the result". If a sub-agent breaks this, retry once, then surface the raw output to the user.
- **Human checkpoint is mandatory before any write.** No `cp` into `inbox/`, no `npm run`, no file edits before the user has responded to the review prompt.
- **Failed group is isolated.** If the streetarts group fails mid-script, the fonts group (if processed first) stays committed; surface what succeeded vs failed and what's left in `inbox/`.
- **Never touch files in `~/Downloads` that this run did not classify** — the 5-minute filter is the contract.
- **Do not modify `scripts/add-items.mjs`** as part of this skill. If you find a case the script can't handle, surface it; don't patch it silently.

## Edge cases to handle explicitly

- Zero fresh HEIC files → exit cleanly with a one-line message.
- **Script fails to read EXIF → recover the real values, do not ship the fallback.** The script sometimes cannot extract the shooting date and/or GPS from a HEIC and silently substitutes **today's date** plus the placeholders `geo: "0, 0"` and `place: "City, Country"`. It announces this on stdout:
  ```
  Warning: Could not read shooting date for IMG_7811.heic. Falling back to current date.
  ```
  A fallback date is not a cosmetic problem — the entry is named `<today>-NN` and sorts to the wrong end of the gallery, and `"City, Country"` renders as visible junk. The metadata is usually still in the file; `mdls` reads it when the script cannot:
  ```bash
  mdls -name kMDItemContentCreationDate -name kMDItemLatitude -name kMDItemLongitude "<heic-path>"
  ```
  When it does, repair the entry:
  1. Rename the entry file and its image to the correct `YYYY-MM-DD-NN`, continuing that date's existing index (check `ls src/content/<collection>/ | grep '^YYYY-MM-DD'`).
  2. Rewrite `pubDate`, `image.file`, and — if the script wrote placeholders — `geo` and `place`. Geo format: `mlat=<lat>&mlon=<lon>#map=19/<lat>/<lon>`.
  3. Verify the referenced image exists on disk before committing.

  **Only use values actually read from the file.** If `mdls` also comes up empty, leave the fallback in place and flag the entry loudly in the report — never infer coordinates from neighbouring photos or invent a plausible date.
- Sub-agent classifies as `skip` → leave HEIC in `~/Downloads`, list under "skipped" in the report.
- User overrides a classification (`edit collection=...`) → take it, but open the image first so the report can say what it actually shows. The user knows the location and the medium; the sub-agent saw one frame.
- Same artist signature appearing across multiple photos in a batch → fine; each entry gets its own `tag` independently. If the user edits one, they can specify the same edit for the others in their response.
- Filenames with spaces or double extensions (e.g. `IMG_6421 2.HEIC.heic`) → quote shell args; when staging into `inbox/`, sanitize to a simpler ASCII-only name to avoid surprises in `readdirSync` ordering (e.g. strip spaces, lowercase the extension).
- An image with multiple distinct works/fonts → the schema is one entry per file; mark it for manual handling in the review table (set `collection: skip` with a note, or let the user decide via `edit`).
- Sub-agent timeout or empty reply → retry once, then surface and skip that file.
