#!/usr/bin/env node
// Measures how many images the gallery pages fetch on first load, and how many
// more when the first photo is opened. See docs/image-loading-plan.md (PR 0).
//
// Usage (from the site repo root):
//   npm run build && node scripts/measure-load.mjs
//   node scripts/measure-load.mjs https://romu70.github.io/galleries/
//
// Without an argument, dist/ is served locally under /galleries/.
// Each scenario runs in a fresh browser context (cold cache).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium, devices } from "playwright";

const ROOT = process.cwd();
const DIST = path.join(ROOT, "dist");
const BASE_PATH = "/galleries/";
const PAGES = ["streetart/", "fonts/"];
const DEVICES = {
  "Desktop 1440×900": { viewport: { width: 1440, height: 900 } },
  "iPhone 13": devices["iPhone 13"],
};
const SETTLE_MS = 1500;
const IMAGE_RE = /\.(webp|jpe?g|png|avif|gif)(\?|$)/i;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
};

// Static server for dist/, mounted under BASE_PATH like GitHub Pages.
function serveDist() {
  if (!fs.existsSync(path.join(DIST, "index.html"))) {
    console.error("dist/ not found: run `npm run build` first, or pass a base URL.");
    process.exit(1);
  }
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (!url.startsWith(BASE_PATH)) {
      res.writeHead(404).end();
      return;
    }
    let file = path.join(DIST, url.slice(BASE_PATH.length));
    if (!file.startsWith(DIST)) {
      res.writeHead(403).end();
      return;
    }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
    if (!fs.existsSync(file)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}${BASE_PATH}` });
    });
  });
}

// Image resource entries seen by the page so far: [count, bytes].
function imageStats(page) {
  return page.evaluate((src) => {
    const re = new RegExp(src, "i");
    const e = performance.getEntriesByType("resource").filter((x) => re.test(x.name));
    return [e.length, e.reduce((s, x) => s + x.encodedBodySize, 0)];
  }, IMAGE_RE.source);
}

async function settle(page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(SETTLE_MS);
}

async function measure(browser, baseUrl, pagePath, deviceName) {
  const context = await browser.newContext(DEVICES[deviceName]);
  const page = await context.newPage();
  // The default buffer stops at 250 entries and would truncate the count.
  await page.addInitScript(() => performance.setResourceTimingBufferSize(5000));

  await page.goto(new URL(pagePath, baseUrl).href, { waitUntil: "networkidle" });
  await page.waitForTimeout(SETTLE_MS);
  const [loadN, loadBytes] = await imageStats(page);

  let openN = null;
  let openBytes = null;
  const thumb = page.locator(".thumbnail").first();
  if (await thumb.count()) {
    await thumb.click();
    await settle(page);
    // Works with both the current `visibility` toggle and a `display` toggle.
    const opened = await page.evaluate(() =>
      [...document.querySelectorAll(".detail")].some((d) => {
        const s = getComputedStyle(d);
        return s.display !== "none" && s.visibility === "visible";
      }),
    );
    if (!opened) throw new Error(`${pagePath} on ${deviceName}: no detail panel visible after clicking the first thumbnail`);
    const [n, bytes] = await imageStats(page);
    openN = n - loadN;
    openBytes = bytes - loadBytes;
  }

  await context.close();
  return { page: pagePath, device: deviceName, loadN, loadBytes, openN, openBytes };
}

const mb = (b) => (b == null ? "–" : (b / 1e6).toFixed(1));

async function main() {
  const arg = process.argv[2];
  let local = null;
  let baseUrl;
  if (arg) {
    baseUrl = arg.endsWith("/") ? arg : `${arg}/`;
  } else {
    local = await serveDist();
    baseUrl = local.baseUrl;
  }

  const browser = await chromium.launch();
  const rows = [];
  try {
    for (const p of PAGES) {
      for (const d of Object.keys(DEVICES)) {
        rows.push(await measure(browser, baseUrl, p, d));
      }
    }
  } finally {
    await browser.close();
    local?.server.close();
  }

  console.log(`Base URL: ${arg ?? `dist/ served at ${baseUrl}`}\n`);
  console.log("| Page | Device | Images on load | MB on load | Extra images on open | Extra MB on open |");
  console.log("|---|---|---|---|---|---|");
  for (const r of rows) {
    console.log(
      `| ${r.page} | ${r.device} | ${r.loadN} | ${mb(r.loadBytes)} | ${r.openN ?? "–"} | ${mb(r.openBytes)} |`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
