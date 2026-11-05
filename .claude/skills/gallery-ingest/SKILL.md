---
name: gallery-ingest
description: Ingest new iPhone photos from the galleries-inbox repo into the Astro Galleries site. Classifies each photo as fonts vs streetarts, generates the tag with a vision sub-agent, asks the user to approve the batch, runs the add-items script, patches the entries, opens a PR, then empties the inbox and resets its history. Trigger when the user says things like "process the inbox", "ingest photos", "process the new gallery photos", or mentions photos waiting in the inbox.
---

# Gallery Ingest

End-to-end pipeline for turning photos uploaded from the iPhone into approved gallery entries. It runs in a Claude Code cloud session (Linux) with two repos: the site repo `romu70/galleries` and the private intake repo `romu70/galleries-inbox`. Sub-agents classify in parallel; the user approves before any write; the result is a PR the user merges from the GitHub app.

## Project facts (load before doing anything)

- **Two repos**:
  - **Site repo** (`romu70/galleries`, **public**): the Astro project. Contains `package.json` with the `add-items` script. Its `inbox/` folder is git-ignored scratch space.
  - **Inbox repo** (`romu70/galleries-inbox`, **private**): `README.md` plus `inbox/`, where an iOS Shortcut uploads the original photos, one commit per photo, through the GitHub contents API.
- **Originals never go into the site repo.** They carry full-resolution pixels and exact GPS, and the site repo is public. Only the 1600px JPGs the script produces are committed there.
- **File names and types from the Shortcut are not reliable.** The iPhone share sheet usually sends a **JPEG even when the name ends in `.heic`**. Always read the real type with `exiftool -FileType`; never trust the extension.
- **Collections**: `fonts` (Markdown `.md` entries) and `streetarts` (JSON `.json` entries). Schemas are identical (`src/content.config.ts`): `{ place, pubDate, geo, image: { file }, tag }`. There is no `artist` field — for streetarts, the artist goes in `tag`.
- **Script**: `scripts/add-items.mjs`, invoked from the site repo root as `npm run add-items -- fonts` or `npm run add-items -- streetarts`. Reads from the site repo's `inbox/`. Uses `exiftool` for date and GPS, ImageMagick `convert` (ImageMagick 6: there is no `magick` command) for the 1600px JPG, `heif-convert` for real HEIC files, and Nominatim for `place` (town first, then city, then village). Processes files in shooting order and moves originals to `inbox/processed/`.
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
- **Locate both clones.** Check the working directory and its parent/children for two git repos; identify them by `git remote get-url origin` (`…/galleries` and `…/galleries-inbox`). Call them `$SITE` and `$INBOX` below. If the inbox repo is not present, stop and tell the user to start the session with both repos selected.
- **Update both clones**: `git -C "$SITE" pull --ff-only` and `git -C "$INBOX" pull --ff-only`. The Shortcut may have uploaded after the session cloned.
- **Tools**: `exiftool`, `convert`, `heif-convert`, `curl` on PATH. If one is missing, the cloud environment's setup script didn't run: install with `apt-get install -y libimage-exiftool-perl imagemagick libheif-examples libheif-plugin-libde265` and tell the user in the report.
- **Dependencies**: if `$SITE/node_modules` is missing, run `npm ci` in `$SITE` (needed for `astro build` in Step 6).
- **Working tree**: `git -C "$SITE" status --short` must be clean. If it isn't, stop and show the user what is there.

### Step 1 — Detect candidate files
Every image file in `$INBOX/inbox/` is a candidate:

```bash
find "$INBOX/inbox" -maxdepth 1 -type f ! -name '.*' ! -name 'README*'
exiftool -FileType -DateTimeOriginal -GPSPosition "$INBOX"/inbox/*
```

- Keep files whose real `FileType` is JPEG, HEIC/HEIF, PNG or WEBP. List any other file under "skipped" in the report and leave it in the inbox.
- If zero candidates: report "inbox is empty" and stop.
- Filenames can contain spaces — quote properly everywhere.

### Step 2 — Make a low-res preview JPG of each file for inspection
The Read tool cannot open HEIC, and full-size photos are wasteful to read. For each candidate, produce a **1024px max** JPG in a temp directory. This is **only** for the vision sub-agent — it is not the final asset. The canonical 1600px conversion happens in Step 6 when the script runs.

```bash
mkdir -p /tmp/gallery-ingest
# JPEG / PNG / WEBP (whatever the extension says):
convert "<file>" -auto-orient -resize '1024x1024>' "/tmp/gallery-ingest/<basename>.jpg"
# Real HEIC/HEIF only (FileType says so):
heif-convert -q 90 "<file>" /tmp/gallery-ingest/<basename>-full.jpg && \
  convert /tmp/gallery-ingest/<basename>-full.jpg -resize '1024x1024>' "/tmp/gallery-ingest/<basename>.jpg"
```

Keep a mapping `{ inbox_path → preview_jpg_path }` for use in later steps.

### Step 3 — Classify in parallel via sub-agents
For each preview JPG, spawn a sub-agent (single message, multiple `Agent` tool calls in parallel) using `subagent_type: "general-purpose"`. Each sub-agent gets the prompt below.

**Sub-agent prompt template** (substitute `<jpg-path>` and `<original-name>`):

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
> source: <original-name>
> collection: fonts | streetarts | skip
> font_category: Serif | Sans-Serif | Cursive | null
> artist: <string or unknown or null>
> description: <one-sentence factual description of the image>
> tags: [<3 to 6 short keywords>]
> confidence: low | medium | high
> ```

Parse each sub-agent's reply into a structured record. If a reply contains anything other than the YAML block, treat it as a failure and re-run that one sub-agent once before flagging.

### Step 4 — Present batch for human review
The user is usually on the iPhone: keep the table compact. One row per file. Suggested format:

```
[1] 20261105-1.jpg  → fonts/Sans-Serif       conf=high    "arbiter" rounded shopfront sign
[2] 20261105-2.jpg  → streetarts/Ben Alpha   conf=medium  ⚠ name only at medium confidence
[3] 20261105-3.jpg  → streetarts/unknown     conf=high    mural, no legible signature
[4] 20261105-4.jpg  → skip (screenshot)
```

Include a few words of description per row — it's what lets the user catch a miscategorised item without opening anything. Add the shooting date and town if they help tell photos apart. `unknown` is the normal case for streetarts and needs no warning marker; reserve `⚠` for things you actively want a decision on (a name at medium confidence, a category with no good fit, a `skip` you're unsure about, a photo with no GPS or no date).

Then ask the user:
> "Approve all, reject all, or list per-item decisions (e.g. `1 ok, 2 edit tag=Shino, 3 skip`)?"

Accept: `ok` / `approve`, `skip` / `reject`, or `edit <field>=<value>[, <field>=<value>]` (fields: `collection`, `tag`).

If you disagree with a sub-agent's call, say so with your reasoning **before** the question and offer the corrected version as an option — don't pass a doubtful attribution through silently just because it came back `high`.

The user may answer with something other than the options offered ("all are streetarts, even 10", "put 5 in fonts"). Apply what they actually said. If their answer leaves a sub-question unresolved, pick the option most consistent with existing data, proceed, and state the assumption in the report rather than asking again.

**Do not write anything to disk yet.** No copies into `$SITE/inbox/`, no script invocation, no branch.

### Step 5 — Apply approvals
After the user responds, partition the items:
- `approved` — go to Step 6.
- `skipped` / `rejected` — leave the file in `$INBOX/inbox/`. It survives the cleanup in Step 8, and is listed in the report.
- `edits` — apply user-supplied overrides to the record before Step 6.

### Step 6 — Branch, stage, run script, patch, verify, commit
1. **Create the branch** in the site repo: `git -C "$SITE" checkout -b ingest/<YYYY-MM-DD>-<HHMM>` (today's date and time).

Then group approved items by collection (`fonts` vs `streetarts`). For **each group**, in series (the script's date-index map is per-invocation and serial avoids collisions):

2. **Snapshot the target dir** so we can identify newly-created entries:
   ```bash
   ls "$SITE/src/content/<collection>/" > /tmp/gallery-ingest/before-<collection>.txt
   ```
3. **Stage** each approved file into `$SITE/inbox/` (create it if missing; it is git-ignored). Use `cp`, not `mv` — the inbox repo copy is only removed in Step 8, after the PR exists. Sanitize names to ASCII without spaces, and give the copy an extension that matches its real type (`.jpg` for JPEG, `.heic` for HEIC). Keep a mapping `{ staged_name → inbox_path }`.
4. **Run the script** from `$SITE`:
   ```bash
   npm run add-items -- <collection>
   ```
   Capture stdout. Abort the group on non-zero exit.
5. **Map source files to new entries by parsing the script's stdout.** It prints one line per file naming both sides of the mapping explicitly:
   ```
   [1/6] Processing 20261105-1.jpg -> images/2026-11-01-01.jpg
   ```
   `20261105-1.jpg` → entry `2026-11-01-01` (`.md` for fonts, `.json` for streetarts) and image `2026-11-01-01.jpg`. **Use this, not filename ordering.** The `before`/`after` snapshot from step 2 is only a cross-check that the count of new files matches the count of lines parsed — if they disagree, stop and surface it.

   Do NOT infer the mapping from alphabetical order. The script sorts by shooting time, and index numbers continue from whatever already exists for that date, so a run's entries can start at `-06` or `-20`, and a batch can span two dates with independent counters.

   Also scan stdout for `Warning:` lines here — see the edge cases below. An `Error processing image` line means that file was skipped by the script: it stays in `$SITE/inbox/`, gets no entry, and must not be deleted from the inbox repo.
6. **Patch each new entry** with the vision-derived `tag`:
   - First, **Read all new entry files in parallel** (one Read tool call per file in a single message). The Edit tool requires a prior Read in the same session — skipping this causes every edit to fail.
   - Then apply edits in parallel: Fonts (Markdown): replace `tag: "Serif"` → `tag: "<font_category>"`. Streetarts (JSON): replace `"tag": "unknown"` with the artist value, formatted per the tag conventions above.
   - The script's placeholder is *already correct* for a good share of entries (`"Serif"` for fonts, `"unknown"` for streetarts). Only edit the ones that actually change; a no-op Edit call fails on an unchanged string.

After all groups:

7. **Verify the build** from `$SITE`:
   ```bash
   npx astro build
   ```
   This validates every new entry against the collection schema, catching a broken `image.file` reference. If it fails, fix the entry or stop and report; do not open a PR on a broken build.
8. **Guard: no originals in the site repo.** Before committing, check every file you are about to stage:
   - It is under `src/content/fonts/` or `src/content/streetarts/` — never under `inbox/`.
   - Every staged image is a JPEG at most 1600px on its long side (`exiftool -ImageSize`).
   - No staged file has the same SHA-256 as any original in `$INBOX/inbox/` (`sha256sum`).

   If any check fails, stop, unstage, and report. Never use `git add -f` on anything under `inbox/`.
9. **Commit**. Stage only the files this run created — the content entries and their images — then commit:
   ```bash
   git add src/content/fonts/<new-entries> src/content/fonts/images/<new-images>
   git add src/content/streetarts/<new-entries> src/content/streetarts/images/<new-images>
   git commit -m "$(cat <<'EOF'
   Add <N> entries (<collections>, <date-range>)

   Co-Authored-By: <your model name> <noreply@anthropic.com>
   EOF
   )"
   ```
   The commit message should summarise what was added, e.g. `Add 4 streetarts entries (2025-06-26 / 2025-06-28)` or `Add 3 fonts + 2 streetarts entries (2025-07-01)`. If you repaired an EXIF fallback, say so in the body. Never use `git add .` or `git add -A`; run `git status --short` before staging and confirm nothing else rides along.
10. **Push and open the PR** against `main`: `git push -u origin <branch>`, then open the PR through the REST API — `gh pr create` uses GraphQL, which cloud sessions block:
    ```bash
    gh api repos/romu70/galleries/pulls -f base=main -f head=<branch> \
      -f title="<commit subject>" -F body=@/tmp/gallery-ingest/pr-body.md --jq .html_url
    ```
    Title as the commit subject. Body: the review table as approved, any flagged entries, and any EXIF repair. The user reviews and merges it from the GitHub app; merging deploys the site.

### Step 7 — Confirm before cleanup
Cleanup is only allowed once the PR exists and its branch is pushed. Check `git -C "$SITE" ls-remote origin ingest/...` returns the commit you pushed. If the push or PR failed, **skip Step 8**: the originals in the inbox repo are then the only copy outside the iPhone.

### Step 8 — Empty the inbox and reset its history
Git keeps deleted files in history, so deleting originals with a normal commit would leave every one of them in the private repo forever. Instead, replace `main` with a fresh single commit.

1. **Catch late uploads**: `git -C "$INBOX" pull --ff-only`. The Shortcut may have uploaded more photos during the run; the force-push below would otherwise wipe them from the remote.
2. **Decide what stays**: every file in `$INBOX/inbox/` that was *not* successfully processed — skipped, rejected, unsupported type, failed in the script, or arrived after Step 1. A file counts as processed only if it appears in `$SITE/inbox/processed/` (via the staged-name mapping) **and** its entry is in the pushed commit.
3. **Build the fresh commit** in `$INBOX`, then push it with a lease so the push fails if anything landed after step 1:
   ```bash
   cd "$INBOX"
   BASE=$(git rev-parse HEAD)
   git checkout -q --orphan reset-tmp
   git rm -r -q --cached .
   mkdir -p inbox && touch inbox/.gitkeep
   git add README.md inbox/.gitkeep <each file that stays>
   git commit -q -m "Reset inbox after <site-branch-name>"
   git push --force-with-lease=main:"$BASE" origin reset-tmp:main
   git checkout -q -B main reset-tmp && git branch -q -D reset-tmp
   git clean -fdq inbox/
   ```
   If the lease push is rejected, new photos arrived: go back to step 1 of this Step 8 (pull, recompute, retry) once.
   Show the user the list of files about to be dropped **in the report** (no extra question — approval in Step 4 covers it).
4. **Verify**: after `git -C "$INBOX" fetch -q origin`, `git -C "$INBOX" log --oneline origin/main` shows one commit, and `git -C "$INBOX" ls-tree -r --name-only origin/main` lists only `README.md`, `inbox/.gitkeep` and the files that stay.
5. If the force-push is refused (branch protection, permissions), stop and report. Do not try other ways to rewrite the history.

Scope: only the inbox repo copies are deleted. The originals stay in the iPhone Photos library. GitHub may keep unreachable objects for a while after a force-push; the repo is private.

### Step 9 — Report
End with a short summary:
- The PR link, and a reminder that merging it from the GitHub app publishes the entries.
- `N` entries created in `fonts`, `M` in `streetarts`, with the entry filenames.
- Items flagged for manual follow-up (e.g. streetarts with `artist=unknown` and medium/low confidence — list their entry filenames so the user can revisit).
- **Any EXIF fallback**: which entries, what the script wrote, and what you did about it.
- Skipped files (with reason), and confirmation they are still in the inbox.
- Inbox cleanup: files dropped, files kept, and the single-commit check result.
- Any assumption you made because the user's approval didn't cover it.
- Any errors (script failure, patching failure, parse failure, build, push, PR or cleanup failure).

## Constraints and guardrails

- **Never hallucinate artist names.** If a signature is partially visible or you "kind of recognize" the style, that is not high confidence — output `unknown`. The user would rather edit one file later than have a wrong attribution shipped. A sub-agent returning a name at `medium` confidence is a candidate for downgrading to `unknown` — say so in the review table rather than passing it through silently.
- **Look at the image yourself when a call is doubtful.** Sub-agents see one photo with no context and do misread things — an abstract "mosaic pattern" that is actually a word in tiles, a "light fixture" that is actually a welded sculpture. Before presenting the batch, open any item that is `medium` confidence, that you intend to flag, or that the user pushes back on. One `Read` of the preview JPG settles it.
- **Vision sub-agents output YAML only.** No prose, no fences, no "here is the result". If a sub-agent breaks this, retry once, then surface the raw output to the user.
- **Human checkpoint is mandatory before any write.** No branch, no copy into `$SITE/inbox/`, no `npm run`, no file edits before the user has responded to the review prompt.
- **Originals never reach the site repo**, and are never deleted from the inbox repo before the PR's branch is confirmed pushed.
- **Failed group is isolated.** If the streetarts group fails mid-script, the fonts group (if processed first) stays in the branch; surface what succeeded vs failed. Files that failed stay in the inbox repo.
- **Never touch inbox files this run did not classify.** If new files arrive in the inbox during the run, they are not part of this batch and must survive the reset.
- **Changing `scripts/add-items.mjs` is out of scope for an ingest run.** If you find a case the script can't handle, surface it in the report; fix it in a separate change, not silently mid-run.

## Edge cases to handle explicitly

- Inbox empty → exit cleanly with a one-line message.
- **Script fails to read EXIF → do not ship the fallback.** When the script can't extract the shooting date and/or GPS, it substitutes **today's date** plus the placeholders `geo: "0, 0"` and `place: "City, Country"`, and announces it on stdout:
  ```
  Warning: Could not read shooting date for 20261105-3.jpg. Falling back to current date.
    Warning: No GPS data found for 20261105-3.jpg.
  ```
  A fallback date is not cosmetic — the entry is named `<today>-NN` and sorts to the wrong end of the gallery, and `"City, Country"` renders as visible junk. Look for the values in other tags of the original before giving up:
  ```bash
  exiftool -a -G1 -time:all -gps:all "<original>"
  ```
  Usable: `SubSecDateTimeOriginal`, `GPSDateStamp`+`GPSTimeStamp` (UTC, convert with the offset tags), `GPSLatitude`/`GPSLongitude` with their `Ref` tags. **Not** usable: `FileModifyDate` and other file-system dates — in this flow they reflect the upload, not the shot.
  When you find real values, repair the entry:
  1. Rename the entry file and its image to the correct `YYYY-MM-DD-NN`, continuing that date's existing index (check `ls src/content/<collection>/ | grep '^YYYY-MM-DD'`).
  2. Rewrite `pubDate`, `image.file`, and — if the script wrote placeholders — `geo` and `place`. Geo format: `mlat=<lat>&mlon=<lon>#map=19/<lat>/<lon>`. For `place`, query Nominatim the way the script does (same User-Agent, town first).
  3. Verify the referenced image exists on disk before committing.

  **Only use values actually read from the file.** If nothing usable exists, leave the fallback in place and flag the entry loudly in the report and the PR body — never infer coordinates from neighbouring photos or invent a plausible date. A photo without GPS usually means Location was off in the share sheet's Options: say so.
- `Warning: Could not reverse geocode` with valid GPS → Nominatim was unreachable or rate-limited. Retry that one lookup after a few seconds; if it still fails, leave `"City, Country"` and flag it.
- Sub-agent classifies as `skip` → leave the file in the inbox, list under "skipped" in the report.
- User overrides a classification (`edit collection=...`) → take it, but open the image first so the report can say what it actually shows. The user knows the location and the medium; the sub-agent saw one frame.
- Same artist signature appearing across multiple photos in a batch → fine; each entry gets its own `tag` independently. If the user edits one, they can specify the same edit for the others in their response.
- An image with multiple distinct works/fonts → the schema is one entry per file; mark it for manual handling in the review table (set `collection: skip` with a note, or let the user decide via `edit`).
- Two inbox files with identical content (the Shortcut ran twice) → compare `sha256sum`; process one, list the other as a duplicate. It is dropped by the reset.
- Sub-agent timeout or empty reply → retry once, then surface and skip that file.
