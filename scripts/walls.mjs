#!/usr/bin/env node
// Helper for the gallery-walls skill: the deterministic parts of wall
// processing. Visual grouping and the review with the user stay in the skill.
//
// Usage (from the site repo root):
//   node scripts/walls.mjs status
//   node scripts/walls.mjs batch [--seeds N] [--radius M]
//   node scripts/walls.mjs review <photo-id | wall-id> [--radius M]
//   node scripts/walls.mjs near <photo-id>... [--radius M] [--tolerance T] [--close C]
//   node scripts/walls.mjs sheet --out <file.jpg> [--from <photo-id>] <photo-id>...
//   node scripts/walls.mjs apply <plan.json> [--dry-run]
//   node scripts/walls.mjs check
//
// All output except `sheet` is JSON on stdout.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const SA_DIR = path.join(ROOT, "src/content/streetarts");
const WALL_DIR = path.join(ROOT, "src/content/walls");
const WALL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*-w\d{3,}$/;
const DEFAULT_RADIUS = 20; // metres

// ---------- data ----------

function parseGeo(geo) {
  const lat = /mlat=(-?\d+(?:\.\d+)?)/.exec(geo ?? "");
  const lon = /mlon=(-?\d+(?:\.\d+)?)/.exec(geo ?? "");
  if (!lat || !lon) return null;
  const p = { lat: Number(lat[1]), lon: Number(lon[1]) };
  if (p.lat === 0 && p.lon === 0) return null;
  return p;
}

function townOf(place) {
  return (place ?? "").split(",")[0].trim();
}

function slugify(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function loadPhotos() {
  return fs
    .readdirSync(SA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const file = path.join(SA_DIR, f);
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      const id = f.replace(/\.json$/, "");
      return {
        id,
        file,
        data,
        pubDate: String(data.pubDate).slice(0, 10),
        place: data.place,
        town: townOf(data.place),
        tag: data.tag,
        wall: data.wall ?? null,
        gps: parseGeo(data.geo),
        image: path.join(SA_DIR, data.image?.file ?? ""),
      };
    })
    .sort((a, b) => (a.pubDate === b.pubDate ? (a.id < b.id ? -1 : 1) : a.pubDate < b.pubDate ? -1 : 1));
}

function loadWalls() {
  if (!fs.existsSync(WALL_DIR)) return new Map();
  return new Map(
    fs
      .readdirSync(WALL_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => [f.replace(/\.json$/, ""), JSON.parse(fs.readFileSync(path.join(WALL_DIR, f), "utf8"))]),
  );
}

// Haversine distance in metres
function distance(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function brief(p, from) {
  const out = { id: p.id, date: p.pubDate, place: p.place, tag: p.tag, wall: p.wall };
  if (from?.gps && p.gps) out.distance_m = Math.round(distance(from.gps, p.gps));
  return out;
}

function nearby(photo, photos, radius) {
  if (!photo.gps) return [];
  return photos
    .filter((p) => p.id !== photo.id && p.gps && distance(photo.gps, p.gps) <= radius)
    .sort((a, b) => distance(photo.gps, a.gps) - distance(photo.gps, b.gps));
}

// ---------- args ----------

function parseArgs(argv) {
  const opts = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) opts[key] = true;
      else {
        opts[key] = next;
        i++;
      }
    } else rest.push(a);
  }
  return { opts, rest };
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fail(message) {
  process.stderr.write(`walls: ${message}\n`);
  process.exit(1);
}

// ---------- commands ----------

function cmdStatus() {
  const photos = loadPhotos();
  const walls = loadWalls();
  const todo = photos.filter((p) => !p.wall);
  const sizes = new Map();
  for (const p of photos) if (p.wall) sizes.set(p.wall, (sizes.get(p.wall) ?? 0) + 1);
  print({
    photos: photos.length,
    processed: photos.length - todo.length,
    to_process: todo.length,
    to_process_without_gps: todo.filter((p) => !p.gps).map((p) => p.id),
    walls: walls.size,
    single_photo_walls: [...sizes.values()].filter((n) => n === 1).length,
  });
}

// Oldest unprocessed photos with GPS, each with its candidates within the radius.
function cmdBatch(opts) {
  const seeds = Number(opts.seeds ?? 15);
  const radius = Number(opts.radius ?? DEFAULT_RADIUS);
  const photos = loadPhotos();
  const todo = photos.filter((p) => !p.wall);
  const withGps = todo.filter((p) => p.gps);
  print({
    radius_m: radius,
    remaining_with_gps: withGps.length,
    without_gps: todo.filter((p) => !p.gps).map((p) => brief(p)),
    seeds: withGps.slice(0, seeds).map((p) => ({
      ...brief(p),
      candidates: nearby(p, photos, radius).map((c) => brief(c, p)),
    })),
  });
}

function cmdReview(target, opts) {
  if (!target) fail("review needs a photo id or a wall id");
  const radius = Number(opts.radius ?? DEFAULT_RADIUS);
  const photos = loadPhotos();
  const walls = loadWalls();
  let wallId = target;
  if (!walls.has(target)) {
    const photo = photos.find((p) => p.id === target);
    if (!photo) fail(`no photo or wall named ${target}`);
    if (!photo.wall) fail(`${target} has no wall yet: use "near" to look for its wall`);
    wallId = photo.wall;
  }
  const members = photos.filter((p) => p.wall === wallId);
  const anchor = members.find((p) => p.gps);
  // Walls within the radius of any member, other than this one
  const near = new Map();
  for (const m of members) {
    for (const p of nearby(m, photos, radius)) {
      if (p.wall && p.wall !== wallId) {
        const d = Math.round(distance(m.gps, p.gps));
        if (!near.has(p.wall) || near.get(p.wall) > d) near.set(p.wall, d);
      }
    }
  }
  print({
    wall: wallId,
    data: walls.get(wallId) ?? null,
    members: members.map((p) => brief(p, anchor)),
    nearby_walls: [...near.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([id, d]) => ({
        wall: id,
        distance_m: d,
        members: photos.filter((p) => p.wall === id).map((p) => p.id),
      })),
    nearby_unprocessed: anchor
      ? members
          .flatMap((m) => nearby(m, photos, radius))
          .filter((p, i, all) => !p.wall && all.findIndex((q) => q.id === p.id) === i)
          .map((p) => brief(p, anchor))
      : [],
  });
}

// Width / height of a photo as displayed (EXIF orientation applied).
function aspectOf(p) {
  try {
    const out = execFileSync("identify", ["-format", "%w %h %[orientation]\n", p.image], { encoding: "utf8" });
    const [w, h, o] = out.split("\n")[0].trim().split(/\s+/);
    const turned = ["LeftTop", "RightTop", "RightBottom", "LeftBottom"].includes(o);
    return turned ? Number(h) / Number(w) : Number(w) / Number(h);
  } catch {
    return null;
  }
}

// Candidates for one wall from the user's example photos. The main signal is
// the photo's proportions: the user frames each wall edge to edge, so photos
// of one wall keep almost the same width/height ratio over the years, while
// A candidate must be within --radius metres (default 50) of an example AND
// have a ratio within --tolerance (default 0.05 = 5 %) of an example's ratio.
// Photos within --close metres (default 25) whose ratio does not match are
// listed apart (`close_other_ratio`): an example may be a partial framing.
// Photos farther than the radius are ignored; the user names them if needed.
const NEAR_RADIUS = 50;
const NEAR_CLOSE = 25;
const NEAR_TOLERANCE = 0.05;

function cmdNear(ids, opts) {
  if (!ids.length) fail("near needs at least one photo id");
  const radius = Number(opts.radius ?? NEAR_RADIUS);
  const tolerance = Number(opts.tolerance ?? NEAR_TOLERANCE);
  const close = Number(opts.close ?? NEAR_CLOSE);
  const photos = loadPhotos();
  const examples = [...new Set(ids)].map((id) => photos.find((p) => p.id === id) ?? fail(`no street-art photo named ${id}`));
  const exIds = new Set(examples.map((p) => p.id));
  const exRatio = new Map(examples.map((p) => [p.id, aspectOf(p)]));
  const located = examples.filter((p) => p.gps);
  const ratios = [...exRatio.values()].filter((r) => r != null);
  const ratioGap = (r) => (r == null || !ratios.length ? Infinity : Math.min(...ratios.map((e) => Math.abs(Math.log(r / e)))));
  const candidates = [];
  const closeOther = [];
  for (const p of photos) {
    if (exIds.has(p.id) || !p.gps || !located.length) continue;
    const d = Math.min(...located.map((e) => distance(e.gps, p.gps)));
    if (d > radius) continue;
    const ratio = aspectOf(p);
    const item = { ...brief(p), distance_m: Math.round(d), ratio: ratio && +ratio.toFixed(2) };
    if (ratioGap(ratio) <= Math.log(1 + tolerance)) candidates.push(item);
    else if (d <= close) closeOther.push(item);
  }
  candidates.sort((a, b) => a.distance_m - b.distance_m);
  closeOther.sort((a, b) => a.distance_m - b.distance_m);
  const walls = new Map();
  for (const p of [...examples, ...candidates]) if (p.wall) walls.set(p.wall, [...(walls.get(p.wall) ?? []), p.id]);
  print({
    radius_m: radius,
    tolerance,
    close_m: close,
    examples: examples.map((p) => ({ ...brief(p), ratio: exRatio.get(p.id) && +exRatio.get(p.id).toFixed(2) })),
    examples_without_gps: examples.filter((p) => !p.gps).map((p) => p.id),
    walls_involved: [...walls.entries()].map(([wall, members]) => ({
      wall,
      members_here: members,
      members_all: photos.filter((p) => p.wall === wall).map((p) => p.id),
    })),
    candidates,
    close_other_ratio: closeOther,
  });
}

// Contact sheet: numbered thumbnails in the order given, labelled with id,
// date, distance from --from (or the first photo) and current wall.
function cmdSheet(ids, opts) {
  if (!opts.out || opts.out === true) fail("sheet needs --out <file.jpg>");
  if (ids.length === 0) fail("sheet needs at least one photo id");
  const photos = new Map(loadPhotos().map((p) => [p.id, p]));
  const list = ids.map((id) => photos.get(id) ?? fail(`unknown photo ${id}`));
  const from = opts.from ? photos.get(opts.from) ?? fail(`unknown photo ${opts.from}`) : list[0];
  const args = [];
  list.forEach((p, i) => {
    const d = from.gps && p.gps ? `${Math.round(distance(from.gps, p.gps))} m` : "no GPS";
    const wall = p.wall ? p.wall : "to process";
    args.push("-label", `${i + 1}  ${p.id}\n${d} · ${wall}`, p.image);
  });
  const columns = Math.min(list.length, 3);
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  execFileSync(
    "montage",
    [
      ...args,
      "-auto-orient",
      "-geometry", "480x360+8+8",
      "-tile", `${columns}x`,
      "-pointsize", "18",
      "-background", "#464646",
      "-fill", "white",
      "-quality", "85",
      opts.out,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  process.stdout.write(`${opts.out}\n`);
}

// plan.json: { "assign": [ { "wall": "<wall-id>" | "new", "photos": [ids], "label"?: string } ] }
// - "new" creates the next free <town>-wNNN; town from the oldest photo's place,
//   lat/lon from the oldest photo with GPS.
// - A photo listed under an existing wall moves to it.
// - Wall files left with no photo after the plan are deleted.
function cmdApply(planFile, opts) {
  if (!planFile) fail("apply needs a plan file");
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  if (!Array.isArray(plan.assign)) fail('plan must have an "assign" array');
  const dryRun = Boolean(opts["dry-run"]);
  const photos = loadPhotos();
  const byId = new Map(photos.map((p) => [p.id, p]));
  const walls = loadWalls();
  const seen = new Set();

  const nextNumber = new Map(); // town slug -> next free number
  const nextId = (slug) => {
    if (!nextNumber.has(slug)) {
      let max = 0;
      for (const id of walls.keys()) {
        const m = new RegExp(`^${slug}-w(\\d+)$`).exec(id);
        if (m) max = Math.max(max, Number(m[1]));
      }
      nextNumber.set(slug, max + 1);
    }
    const n = nextNumber.get(slug);
    nextNumber.set(slug, n + 1);
    return `${slug}-w${String(n).padStart(3, "0")}`;
  };

  const created = [];
  const moves = []; // { photo, from, to }
  for (const group of plan.assign) {
    if (!Array.isArray(group.photos) || group.photos.length === 0) fail("each group needs photos");
    const members = group.photos.map((id) => {
      if (seen.has(id)) fail(`photo ${id} appears twice in the plan`);
      seen.add(id);
      return byId.get(id) ?? fail(`unknown photo ${id}`);
    });
    let wallId = group.wall;
    if (wallId === "new") {
      const oldest = [...members].sort((a, b) => (a.pubDate < b.pubDate ? -1 : a.pubDate > b.pubDate ? 1 : a.id < b.id ? -1 : 1));
      const slug = slugify(oldest[0].town);
      if (!slug || slug === "city") fail(`no usable town for ${oldest[0].id} (place "${oldest[0].place}")`);
      wallId = nextId(slug);
      const gpsPhoto = oldest.find((p) => p.gps);
      const data = { place: oldest[0].place };
      if (gpsPhoto) {
        data.lat = Number(gpsPhoto.gps.lat.toFixed(6));
        data.lon = Number(gpsPhoto.gps.lon.toFixed(6));
      }
      if (group.label) data.label = group.label;
      walls.set(wallId, data);
      created.push(wallId);
    } else {
      if (!WALL_ID.test(wallId ?? "")) fail(`bad wall id ${wallId}`);
      if (!walls.has(wallId)) fail(`wall ${wallId} does not exist (use "new")`);
      if (group.label) walls.set(wallId, { ...walls.get(wallId), label: group.label });
    }
    for (const p of members) moves.push({ photo: p, from: p.wall, to: wallId });
  }

  // Walls referenced after the plan
  const after = new Map(photos.map((p) => [p.id, p.wall]));
  for (const m of moves) after.set(m.photo.id, m.to);
  const used = new Set([...after.values()].filter(Boolean));
  const deleted = [...walls.keys()].filter((id) => !used.has(id) && !created.includes(id) && moves.some((m) => m.from === id));

  if (!dryRun) {
    fs.mkdirSync(WALL_DIR, { recursive: true });
    for (const id of created) fs.writeFileSync(path.join(WALL_DIR, `${id}.json`), JSON.stringify(walls.get(id), null, 2) + "\n");
    for (const g of plan.assign) {
      if (g.wall !== "new" && g.label) fs.writeFileSync(path.join(WALL_DIR, `${g.wall}.json`), JSON.stringify(walls.get(g.wall), null, 2) + "\n");
    }
    for (const m of moves) {
      if (m.from === m.to) continue;
      const raw = fs.readFileSync(m.photo.file, "utf8");
      const data = JSON.parse(raw);
      data.wall = m.to;
      fs.writeFileSync(m.photo.file, JSON.stringify(data, null, 2) + (raw.endsWith("\n") ? "\n" : ""));
    }
    for (const id of deleted) fs.unlinkSync(path.join(WALL_DIR, `${id}.json`));
  }

  print({
    dry_run: dryRun,
    walls_created: created.map((id) => ({ wall: id, photos: moves.filter((m) => m.to === id).map((m) => m.photo.id) })),
    photos_joined_existing: moves.filter((m) => !created.includes(m.to) && m.from !== m.to).map((m) => ({ photo: m.photo.id, from: m.from, to: m.to })),
    unchanged: moves.filter((m) => m.from === m.to).map((m) => m.photo.id),
    walls_deleted: deleted,
    single_photo_walls_created: created.filter((id) => moves.filter((m) => m.to === id).length === 1),
  });
}

// Diff guard before committing: compared with HEAD, only wall files and the
// `wall` field of street-art entries may have changed.
function cmdCheck() {
  const git = (...a) => execFileSync("git", a, { encoding: "utf8" });
  const changed = git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), file: l.slice(3) }));
  const problems = [];
  const entries = [];
  for (const { status, file } of changed) {
    if (/^src\/content\/walls\/[^/]+\.json$/.test(file)) {
      const id = path.basename(file, ".json");
      if (!WALL_ID.test(id)) problems.push(`${file}: bad wall id`);
      continue;
    }
    if (!/^src\/content\/streetarts\/[^/]+\.json$/.test(file) || status !== "M") {
      problems.push(`${file}: not allowed in a walls change (${status})`);
      continue;
    }
    const before = JSON.parse(git("show", `HEAD:${file}`));
    const after = JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      if (k === "wall") continue;
      if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) problems.push(`${file}: field "${k}" changed`);
    }
    entries.push(file);
  }
  print({ ok: problems.length === 0, entries_changed: entries.length, files: changed.map((c) => c.file), problems });
  if (problems.length) process.exit(1);
}

// ---------- main ----------

const [command, ...argv] = process.argv.slice(2);
const { opts, rest } = parseArgs(argv);
switch (command) {
  case "status": cmdStatus(); break;
  case "batch": cmdBatch(opts); break;
  case "review": cmdReview(rest[0], opts); break;
  case "near": cmdNear(rest, opts); break;
  case "sheet": cmdSheet(rest, opts); break;
  case "apply": cmdApply(rest[0], opts); break;
  case "check": cmdCheck(); break;
  default:
    fail("usage: walls.mjs status | batch [--seeds N] [--radius M] | review <id> | near <id>... [--radius M] [--tolerance T] [--close C] | sheet --out f.jpg [--from id] ids... | apply plan.json [--dry-run] | check");
}
