/**
 * @file scripts/add-items.mjs
 * @description Automates the process of adding new image items to the Astro galleries project.
 *              It handles image processing (conversion, resizing), metadata extraction (shooting date, GPS),
 *              reverse geocoding for location, and content file generation.
 *
 * @requirements
 *   Linux or macOS with `exiftool`, ImageMagick (`convert`) and `curl` on PATH.
 *   `heif-convert` (libheif) is only needed if a real HEIC file is supplied.
 *   Cloud environment setup: apt-get install libimage-exiftool-perl imagemagick libheif-examples
 *
 * @usage
 *   1. Place your new image files (HEIC, JPG, PNG, etc.) into the 'inbox/' directory at the project root.
 *   2. Run the script from your terminal using npm:
 *      `npm run add-items -- <gallery-type>`
 *      Replace `<gallery-type>` with either 'fonts' or 'streetarts'.
 *      Example: `npm run add-items -- streetarts`
 *
 * @input
 *   - Image files in the 'inbox/' directory (git-ignored).
 *
 * @output
 *   - Processed JPG images (resized to MAX_DIMENSION) are saved to 'src/content/<gallery-type>/images/'.
 *   - Corresponding content files (.md for 'fonts', .json for 'streetarts') are created in 'src/content/<gallery-type>/'.
 *   - Original image files from 'inbox/' are moved to 'inbox/processed/' for archiving.
 *
 * @features
 *   - Detects the real file type from content (an iPhone share may send a JPEG named .heic).
 *   - Converts HEIC/PNG/etc. to JPG and resizes to a maximum dimension of 1600px (never upscales).
 *   - Keeps the source EXIF (date, GPS) in the output JPG, as the previous macOS pipeline did.
 *   - Extracts the shooting date (local time of capture) for filenames (YYYY-MM-DD-II) and 'pubDate'.
 *   - Extracts GPS coordinates for the 'geo' field (mlat=<lat>&mlon=<lon>#map=19/<lat>/<lon>).
 *   - Reverse geocodes with OpenStreetMap Nominatim to set 'place' (Town, Country), max 1 request/second.
 *   - Processes files in shooting order, so indices run chronologically.
 *   - Handles incremental indexing for files shot on the same day.
 *
 * @stdout_contract
 *   One line per file, parsed by the gallery-ingest skill:
 *   `[<n>/<total>] Processing <source-file> -> images/<YYYY-MM-DD-II>.jpg`
 *   Fallbacks are announced with lines starting with `Warning:`.
 *
 * @manual_steps_remaining
 *   - After running the script, you must manually edit the generated content files to:
 *     - Update the 'tag' field.
 */

import fs from "fs";
import os from "os";
import path from "path";
import { execFileSync } from "child_process";

// --- CONFIGURATION ---
const MAX_DIMENSION = 1600;
const JPEG_QUALITY = 92;
const CONTENT_DIR = "src/content";
const IMG_SOURCE_DIR = "inbox";
const PROCESSED_DIR = path.join(IMG_SOURCE_DIR, "processed");
const GALLERY_TYPE = process.argv[2];
// Nominatim's usage policy asks for a User-Agent that identifies the application.
const USER_AGENT = "Galleries/1.0 (https://github.com/romu70/galleries)";
const NOMINATIM_MIN_INTERVAL_MS = 1100;

// --- VALIDATION ---
if (!GALLERY_TYPE) {
  console.error("Usage: node scripts/add-items.mjs <gallery-type>");
  console.error("Example: node scripts/add-items.mjs fonts");
  process.exit(1);
}

if (GALLERY_TYPE !== "fonts" && GALLERY_TYPE !== "streetarts") {
  console.error(
    'Error: <gallery-type> must be either "fonts" or "streetarts".',
  );
  process.exit(1);
}

const targetDir = path.join(CONTENT_DIR, GALLERY_TYPE);
if (!fs.existsSync(targetDir)) {
  console.error(`Error: Target directory not found at ${targetDir}`);
  process.exit(1);
}
if (!fs.existsSync(IMG_SOURCE_DIR)) {
  console.error(`Error: Source directory not found at ${IMG_SOURCE_DIR}`);
  process.exit(1);
}

for (const tool of ["exiftool", "convert", "curl"]) {
  try {
    execFileSync("which", [tool], { stdio: "ignore" });
  } catch (_) {
    console.error(`Error: required tool "${tool}" not found on PATH.`);
    process.exit(1);
  }
}

// --- HELPERS ---
const pad2 = (n) => n.toString().padStart(2, "0");

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read the metadata we need with exiftool. Returns {} if exiftool fails. */
function readMetadata(filePath) {
  try {
    const out = execFileSync("exiftool", [
      "-j",
      "-n",
      "-FileType",
      "-DateTimeOriginal",
      "-CreateDate",
      "-GPSLatitude",
      "-GPSLongitude",
      filePath,
    ]).toString();
    return JSON.parse(out)[0] || {};
  } catch (_) {
    return {};
  }
}

/**
 * Parse an EXIF date "YYYY:MM:DD HH:MM:SS" into its parts.
 * The value is the local wall-clock time at capture, which is what the
 * gallery shows; no time zone conversion is applied.
 */
function parseExifDate(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m || m[1] === "0000") return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, sortKey: `${m[1]}${m[2]}${m[3]}${m[4]}${m[5]}${m[6]}` };
}

let lastGeocodeAt = 0;
function reverseGeocode(lat, lon) {
  const wait = lastGeocodeAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) sleepMs(wait);
  lastGeocodeAt = Date.now();
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
  const response = execFileSync("curl", [
    "-sS",
    "--fail",
    "--max-time",
    "20",
    "-A",
    USER_AGENT,
    url,
  ]).toString();
  const geoJson = JSON.parse(response);
  if (!geoJson.address) return null;
  // Town first: a photo taken in Rezé is filed as Rezé even when Nominatim
  // also reports the larger municipality.
  const town =
    geoJson.address.town ||
    geoJson.address.city ||
    geoJson.address.village ||
    "";
  const country = geoJson.address.country || "";
  return town && country ? `${town}, ${country}` : null;
}

/** Convert + resize to a JPEG, keeping EXIF. Handles real HEIC via heif-convert. */
function writeWebImage(sourcePath, fileType, destPath) {
  let input = sourcePath;
  let tmpDir = null;
  if (fileType === "HEIC" || fileType === "HEIF") {
    // ImageMagick 6 on Ubuntu has no HEIC decoder; decode with libheif first.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "add-items-"));
    input = path.join(tmpDir, "decoded.jpg");
    execFileSync("heif-convert", ["-q", "100", sourcePath, input], {
      stdio: "ignore",
    });
  }
  try {
    execFileSync("convert", [
      input,
      "-auto-orient",
      "-resize",
      `${MAX_DIMENSION}x${MAX_DIMENSION}>`,
      "-quality",
      String(JPEG_QUALITY),
      destPath,
    ]);
    if (input !== sourcePath) {
      // heif-convert may drop metadata: copy it back from the original.
      execFileSync(
        "exiftool",
        ["-q", "-overwrite_original", "-TagsFromFile", sourcePath, "-all:all", "-Orientation=1", "-n", destPath],
        { stdio: "ignore" },
      );
    }
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- SCRIPT ---
console.log(
  `Processing images from "${IMG_SOURCE_DIR}" for "${GALLERY_TYPE}" gallery...`,
);

const imagesDir = path.join(targetDir, "images");
fs.mkdirSync(imagesDir, { recursive: true });
fs.mkdirSync(PROCESSED_DIR, { recursive: true });

const candidates = fs
  .readdirSync(IMG_SOURCE_DIR)
  .filter((file) =>
    [".heic", ".heif", ".jpg", ".jpeg", ".png", ".webp"].some((ext) =>
      file.toLowerCase().endsWith(ext),
    ),
  );

if (candidates.length === 0) {
  console.log("No image files found to process in the source directory.");
  process.exit(0);
}

// Read metadata first so files can be processed in shooting order.
const items = candidates.map((file) => {
  const sourceImagePath = path.join(IMG_SOURCE_DIR, file);
  const meta = readMetadata(sourceImagePath);
  const shot = parseExifDate(meta.DateTimeOriginal) || parseExifDate(meta.CreateDate);
  return { file, sourceImagePath, meta, shot };
});
items.sort((a, b) => {
  const ka = a.shot ? a.shot.sortKey : "99999999999999";
  const kb = b.shot ? b.shot.sortKey : "99999999999999";
  return ka === kb ? a.file.localeCompare(b.file) : ka.localeCompare(kb);
});

// Use a map to keep track of the last index used for each date
const dateIndexMap = new Map();
let processedCount = 0;

items.forEach(({ file, sourceImagePath, meta, shot }, i) => {
  let datePrefix;
  if (shot) {
    datePrefix = shot.date;
  } else {
    console.warn(
      `Warning: Could not read shooting date for ${file}. Falling back to current date.`,
    );
    const today = new Date();
    datePrefix = `${today.getFullYear()}-${pad2(today.getMonth() + 1)}-${pad2(today.getDate())}`;
  }
  const pubDate = datePrefix;

  // Determine the index for the file based on its date
  if (!dateIndexMap.has(datePrefix)) {
    // If we haven't seen this date before, find the last index from existing files
    let lastIndex = 0;
    fs.readdirSync(targetDir).forEach((f) => {
      if (f.startsWith(datePrefix)) {
        const parts = f.split("-");
        const index = parseInt(parts[parts.length - 1].split(".")[0], 10);
        if (index > lastIndex) lastIndex = index;
      }
    });
    dateIndexMap.set(datePrefix, lastIndex);
  }

  const newIndexValue = dateIndexMap.get(datePrefix) + 1;
  dateIndexMap.set(datePrefix, newIndexValue);
  const newBaseName = `${datePrefix}-${pad2(newIndexValue)}`;

  // Process and save the image
  const newImageName = `${newBaseName}.jpg`;
  const destImagePath = path.join(imagesDir, newImageName);
  console.log(
    `[${i + 1}/${items.length}] Processing ${file} -> images/${newImageName}`,
  );
  try {
    writeWebImage(sourceImagePath, meta.FileType, destImagePath);
  } catch (error) {
    console.error(`Error processing image ${file}: ${error.message}`);
    dateIndexMap.set(datePrefix, newIndexValue - 1);
    return; // Skip to next file
  }

  // --- Location ---
  let geo = "0, 0";
  let place = "City, Country";
  const lat = Number(meta.GPSLatitude);
  const lon = Number(meta.GPSLongitude);

  if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) {
    geo = `mlat=${lat}&mlon=${lon}#map=19/${lat}/${lon}`;
    console.log(`  Found GPS: ${geo}`);
    try {
      const found = reverseGeocode(lat, lon);
      if (found) {
        place = found;
        console.log(`  Found Place: ${place}`);
      } else {
        console.warn(`  Warning: Could not reverse geocode for ${file}.`);
      }
    } catch (_) {
      console.warn(`  Warning: Could not reverse geocode for ${file}.`);
    }
  } else {
    console.warn(`  Warning: No GPS data found for ${file}.`);
  }

  const tag = GALLERY_TYPE === "streetarts" ? "unknown" : "Serif";
  const imagePath = `./images/${newImageName}`;

  if (GALLERY_TYPE === "fonts") {
    const content = `---\npubDate: ${pubDate}\nimage:\n    file: "${imagePath}"\ngeo: "${geo}"\nplace: "${place}"\ntag: "${tag}"\n---\n`;
    fs.writeFileSync(path.join(targetDir, `${newBaseName}.md`), content);
  } else {
    // streetart
    const content = {
      pubDate,
      image: {
        file: imagePath,
      },
      geo,
      place,
      tag,
    };
    fs.writeFileSync(
      path.join(targetDir, `${newBaseName}.json`),
      JSON.stringify(content, null, 2),
    );
  }

  // Move the original file to the processed directory
  fs.renameSync(sourceImagePath, path.join(PROCESSED_DIR, file));
  processedCount += 1;
});

console.log("\nDone!");
console.log(
  `${processedCount} of ${items.length} images processed and added to the "${GALLERY_TYPE}" gallery.`,
);
console.log(
  "Next step: Open the new files and update the placeholder metadata.",
);
