const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mm = require("music-metadata");
const pLimit = require("p-limit");
const { spawn } = require("child_process");
const { buildCanonicalMap, applyCanonicalNames, findReviewPairs, loadAliases } = require("./lib/canonical");
const { createStore } = require("./lib/userstate");

const MUSIC_PATH = process.env.MUSIC_PATH || "/Volumes/Shulmeister HD/iTunes/Music";
const PORT = process.env.PORT || 3005;
const CACHE_PATH = process.env.CACHE_PATH || path.join(__dirname, "library-cache.json");
const ALIASES_PATH = process.env.ALIASES_PATH || path.join(__dirname, "data", "artist_aliases.json");
const REVIEW_PATH = path.join(__dirname, "data", "artist_review.json");
const USER_STATE_PATH = process.env.USER_STATE_PATH || path.join(__dirname, "data", "user_state.json");
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
// Cap concurrent ffmpeg transcodes — this is a PUBLIC URL on a host that also runs CCA production
// services, so unbounded spawns could exhaust CPU/memory. Over the cap we fall back to original
// passthrough (no ffmpeg) rather than failing playback. Env-tunable.
const MAX_TRANSCODES = parseInt(process.env.MAX_TRANSCODES || "3", 10) || 3;
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".flac", ".aac", ".wav", ".ogg"]);
const LOSSLESS_EXTS = new Set([".flac", ".wav", ".aiff", ".alac"]);
const MIME_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
};
const QUALITY_BITRATES = {
  high: "256k",
  normal: "128k",
  low: "96k",
};

// Grateful Dead show dedup. The master drive holds the same shows in up to three places —
// Music/Grateful Dead plus separate taper "vault" folders (e.g. "Paolo's Grateful Dead",
// "Tom's Grateful Dead"). We merge them all under one "Grateful Dead" artist and keep ONE copy per
// show DATE — the show folder with the newest mtime (the freshest transfer) — so the app shows each
// show once instead of 3-4 times. Non-destructive: nothing is deleted, this is index-only.
const GD_ARTIST = "Grateful Dead";
function gdVaultRoots() {
  if (process.env.GD_VAULT_ROOTS) {
    return process.env.GD_VAULT_ROOTS.split(":").filter(Boolean);
  }
  const parent = path.dirname(MUSIC_PATH);
  return ["Paolo's Grateful Dead", "Tom's Grateful Dead"]
    .map((n) => path.join(parent, n))
    .filter((p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

let library = [];
let idMap = new Map();
let scanState = { scanning: false, scanned: 0, total: null };
let artCache = new Map();
const ART_CACHE_MAX = 300;
const userStore = createStore(USER_STATE_PATH);

// Count of in-flight audio streams. Phase-2 enrichment yields the disk to active playback (both
// read from the same external USB drive — concurrent metadata reads starve the audio read and
// cause stutter on mobile). Metadata is non-urgent, so smooth streaming wins.
let activeStreams = 0;
// Count of in-flight ffmpeg transcodes (subset of streams) — bounded by MAX_TRANSCODES.
let activeTranscodes = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeId(relPath) {
  return crypto.createHash("sha1").update(relPath).digest("hex").slice(0, 16);
}

function isMounted() {
  return fs.existsSync(MUSIC_PATH);
}

async function walkDir(dir) {
  const files = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walkDir(abs)));
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (AUDIO_EXTS.has(ext) && ext !== ".m4p") {
          files.push(abs);
        }
      }
    }
  } catch (err) {
    // skip unreadable directories
  }
  return files;
}

function formatDuration(sec) {
  if (!sec || !isFinite(sec)) return 0;
  return Math.round(sec * 10) / 10;
}

function trackById(id) {
  return library.find((t) => t.id === id) || null;
}

function tracksByIds(ids) {
  const out = [];
  for (const id of ids) {
    const t = trackById(id);
    if (t) out.push(t);
  }
  return out;
}

function parseTitleFromFilename(filename) {
  // Pattern 1: disc-track prefix, e.g. "1-03 Song Name"
  const discTrack = /^\d{1,2}-(\d{1,2})[ .]+(\S.*)$/.exec(filename);
  if (discTrack) {
    return { title: discTrack[2], trackNo: parseInt(discTrack[1], 10) };
  }
  // Pattern 2: plain track number prefix, e.g. "01 Song", "03. Song", "07 - Song"
  const plain = /^(\d{1,2})[ .\-]+(\S.*)$/.exec(filename);
  if (plain) {
    return { title: plain[2], trackNo: parseInt(plain[1], 10) };
  }
  return { title: filename, trackNo: null };
}

function buildTrackFromPath(absPath, gdVaultRoot) {
  const relPath = path.relative(MUSIC_PATH, absPath);
  const filename = path.basename(absPath, path.extname(absPath));
  const parsed = parseTitleFromFilename(filename);

  let artist, album;
  if (gdVaultRoot) {
    // File came from a separate Grateful Dead taper-vault root: force the artist to "Grateful Dead"
    // and use the show folder (first segment under the vault root) as the album, so it merges and
    // dedupes with Music/Grateful Dead instead of becoming its own per-show "artist".
    artist = GD_ARTIST;
    const vparts = path.relative(gdVaultRoot, absPath).split(path.sep);
    album = vparts.length >= 2 ? vparts[0] : "Unknown Show";
  } else {
    // Artist/album come from the FOLDER structure — the user curates folder names, while ID3 tags
    // are inconsistent and create duplicate/garbage entries (one "2Pac" folder, tracks tagged
    // "2 Pac"/"2Pac"/"2pac"; junk artist tags like "02"). Phase 2 only fills these from ID3 in the
    // edge cases where the folder genuinely lacks the info (loose root files, "Compilations"
    // folders, and 2-segment Artist/file paths with no album folder).
    let parts = relPath.split(path.sep);
    // The master drive has a stray nested "Music/Music/…" dump folder; a leading "Music" segment is
    // not an artist, so drop it and use the real next segment (this also folds nested GD into dedup).
    if (parts.length > 1 && parts[0].toLowerCase() === "music") parts = parts.slice(1);
    const hasArtistFolder = parts.length >= 2 && parts[0].toLowerCase() !== "compilations";
    artist = hasArtistFolder ? parts[0] : "Unknown Artist";
    album = parts.length >= 3 ? parts[parts.length - 2] : "Unknown Album";
  }

  return {
    id: makeId(relPath),
    relPath,
    title: parsed.title,
    artist,
    album,
    duration: 0,
    genre: null,
    year: null,
    trackNo: parsed.trackNo,
    enriched: false, // set true once ID3 has been attempted — drives resumable enrichment
  };
}

function sortLibrary(arr) {
  arr.sort((a, b) => {
    const c = (a.artist || "").localeCompare(b.artist || "", undefined, { sensitivity: "base" });
    if (c !== 0) return c;
    const d = (a.album || "").localeCompare(b.album || "", undefined, { sensitivity: "base" });
    if (d !== 0) return d;
    const t = (a.trackNo || 0) - (b.trackNo || 0);
    if (t !== 0) return t;
    return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
  });
}

function deriveQualityFallback(ext) {
  return {
    lossless: LOSSLESS_EXTS.has(ext),
    bitrate: null,
    codec: null,
    sampleRate: null,
    bits: null,
  };
}

function buildQualityFromFormat(format, ext) {
  const fallback = deriveQualityFallback(ext);
  return {
    lossless: typeof format.lossless === "boolean" ? format.lossless : fallback.lossless,
    bitrate: format.bitrate || null,
    codec: format.codec || null,
    sampleRate: format.sampleRate || null,
    bits: format.bitsPerSample || null,
  };
}

// Collapse duplicate Grateful Dead shows. The same performance (keyed by its YYYY-MM-DD date) can
// live in Music/Grateful Dead AND the taper-vault roots. For each date we keep ONE show folder —
// the one with the newest mtime (freshest transfer) — and drop the others' tracks. GD entries whose
// album has no date (studio albums) and all non-GD tracks pass through untouched.
function dedupeGdShows(tracks) {
  const dateRe = /(\d{4}-\d{2}-\d{2})/;
  const kept = [];
  const byDate = new Map(); // date -> Map(showDir -> { mtime, tracks: [] })
  const mtimeCache = new Map();
  const showDirMtime = (dir) => {
    if (mtimeCache.has(dir)) return mtimeCache.get(dir);
    let m = 0;
    try {
      m = fs.statSync(dir).mtimeMs;
    } catch {
      m = 0;
    }
    mtimeCache.set(dir, m);
    return m;
  };

  for (const t of tracks) {
    const match = t.artist === GD_ARTIST ? (t.album || "").match(dateRe) : null;
    if (!match) {
      kept.push(t); // non-GD, or a GD studio album with no date
      continue;
    }
    const date = match[1];
    const showDir = path.dirname(path.join(MUSIC_PATH, t.relPath));
    if (!byDate.has(date)) byDate.set(date, new Map());
    const showMap = byDate.get(date);
    if (!showMap.has(showDir)) showMap.set(showDir, { mtime: showDirMtime(showDir), tracks: [] });
    showMap.get(showDir).tracks.push(t);
  }

  let shows = 0;
  let dropped = 0;
  for (const showMap of byDate.values()) {
    let winner = null;
    for (const [dir, info] of showMap) {
      const better =
        !winner ||
        info.mtime > winner.mtime ||
        (info.mtime === winner.mtime && info.tracks.length > winner.tracks.length);
      if (better) winner = { dir, mtime: info.mtime, tracks: info.tracks };
    }
    kept.push(...winner.tracks);
    shows += 1;
    for (const [dir, info] of showMap) if (dir !== winner.dir) dropped += info.tracks.length;
  }
  if (byDate.size) {
    console.log(`[gd-dedup] ${shows} unique GD shows kept, dropped ${dropped} duplicate tracks`);
  }
  return kept;
}

// Persist the library to disk (internal SSD, not the music drive — no contention with streaming).
// Written periodically during enrichment so a restart resumes instead of re-scanning from zero.
const CHECKPOINT_EVERY = parseInt(process.env.CHECKPOINT_EVERY || "20000", 10) || 20000;
let checkpointing = false;
async function saveCache() {
  if (checkpointing) return;
  checkpointing = true;
  try {
    const tmp = CACHE_PATH + ".tmp";
    await fs.promises.writeFile(tmp, JSON.stringify(library));
    await fs.promises.rename(tmp, CACHE_PATH);
  } catch (err) {
    console.error("[cache] write failed:", err.message);
  } finally {
    checkpointing = false;
  }
}

// Enrich only the given tracks (those with enriched === false), in place. Concurrency 4; each
// worker pauses entirely while audio is streaming (disk is shared with the music drive). Marks each
// track enriched after the attempt (success OR failure) so a corrupt file isn't retried forever,
// and checkpoints the cache every CHECKPOINT_EVERY tracks so progress survives restarts.
async function enrichTracks(targets) {
  if (!targets.length) {
    scanState = { scanning: false, scanned: 0, total: 0 };
    return;
  }
  scanState = { scanning: true, scanned: 0, total: targets.length };
  const limit = pLimit(4);
  let lastLogged = 0;
  let sinceCheckpoint = 0;

  const tasks = targets.map((track) =>
    limit(async () => {
      // Yield the disk to active playback — pause enrichment while anything is streaming.
      while (activeStreams > 0) {
        await sleep(400);
      }

      const absPath = idMap.get(track.id);
      if (absPath) {
        let meta;
        try {
          meta = await mm.parseFile(absPath, { duration: true, skipCovers: true });
        } catch (err) {
          meta = null;
        }
        const common = meta && meta.common ? meta.common : {};
        const format = meta && meta.format ? meta.format : {};

        // Folder-derived artist/album are authoritative (they de-dupe inconsistent tags). Fall back
        // to ID3 ONLY where the folder lacked the info: loose root / "Compilations" → ID3 artist;
        // 2-segment Artist/file (no album folder) → ID3 album. Never override a real folder value.
        const parts = track.relPath.split(path.sep);
        const artistFromFolder = parts.length >= 2 && parts[0].toLowerCase() !== "compilations";
        if (!artistFromFolder && common.artist) track.artist = common.artist;
        if (parts.length < 3 && common.album) track.album = common.album;

        if (common.title) track.title = common.title;
        track.duration = formatDuration(format.duration);
        if (common.genre && common.genre.length) track.genre = common.genre[0];
        if (common.year) track.year = common.year;
        if (common.track && common.track.no != null) track.trackNo = common.track.no;

        const ext = path.extname(absPath).toLowerCase();
        track.quality = buildQualityFromFormat(format, ext);
      }
      if (!track.quality) {
        const ext = path.extname(absPath).toLowerCase();
        track.quality = deriveQualityFallback(ext);
      }
      track.enriched = true;

      scanState.scanned += 1;
      sinceCheckpoint += 1;
      if (scanState.scanned - lastLogged >= 500) {
        lastLogged = scanState.scanned;
        console.log(`[scan] enriched ${scanState.scanned} / ${scanState.total}`);
      }
      if (sinceCheckpoint >= CHECKPOINT_EVERY) {
        sinceCheckpoint = 0;
        await saveCache();
        console.log(`[scan] checkpoint saved at ${scanState.scanned}`);
      }
    })
  );

  await Promise.all(tasks);
  sortLibrary(library); // enrichment can shift the rare edge-case artist/album; keep order stable
  await saveCache();
  scanState = { scanning: false, scanned: scanState.scanned, total: scanState.total };
  console.log(`[scan] enrichment complete — ${scanState.scanned} tracks`);
}

// Full scan: walk the disk, reconcile against whatever is already in memory (reuse enrichment for
// ids we already have; add new files; drop missing), then enrich only the un-enriched. Used on cold
// start (no cache) and on /api/rescan (to pick up added/removed files).
async function buildIndex() {
  if (scanState.scanning) return;
  scanState = { scanning: true, scanned: 0, total: null };

  const startTime = Date.now();
  console.log("[scan] starting full library scan…");

  let fileList;
  try {
    fileList = await walkDir(MUSIC_PATH);
  } catch (err) {
    console.error("[scan] walk failed:", err.message);
    scanState = { scanning: false, scanned: 0, total: null };
    return;
  }
  // Also walk the separate Grateful Dead taper-vault roots; their files are merged under the
  // "Grateful Dead" artist and deduped by show date below.
  const vaultRoots = gdVaultRoots();
  const vaultFiles = [];
  for (const root of vaultRoots) {
    try {
      const vf = await walkDir(root);
      for (const f of vf) vaultFiles.push({ abs: f, root });
    } catch (err) {
      console.error(`[scan] GD vault walk failed (${root}):`, err.message);
    }
  }
  console.log(`[scan] found ${fileList.length} audio files (+${vaultFiles.length} GD vault files from ${vaultRoots.length} roots)`);

  // Reconcile with existing tracks so prior enrichment is preserved across restarts/rescans.
  const prevById = new Map();
  for (const t of library) prevById.set(t.id, t);

  let buffer = [];
  for (const absPath of fileList) {
    const id = makeId(path.relative(MUSIC_PATH, absPath));
    buffer.push(prevById.get(id) || buildTrackFromPath(absPath));
  }
  for (const { abs, root } of vaultFiles) {
    const id = makeId(path.relative(MUSIC_PATH, abs));
    buffer.push(prevById.get(id) || buildTrackFromPath(abs, root));
  }

  // Repair any tracks reused from the cache that were mis-filed under a phantom "Music" artist
  // (the nested Music/Music dump folder) — re-derive artist/album so they attribute correctly and
  // any nested Grateful Dead folds into the dedup below. Enrichment (duration etc.) is preserved.
  for (const t of buffer) {
    if (t.artist === "Music") {
      const fixed = buildTrackFromPath(path.join(MUSIC_PATH, t.relPath));
      t.artist = fixed.artist;
      t.album = fixed.album;
    }
  }

  // Merge + dedupe Grateful Dead shows (keep newest copy per date), then build idMap from survivors.
  buffer = dedupeGdShows(buffer);
  sortLibrary(buffer);

  // Canonicalize artist names (case/whitespace/punctuation variants) before serving or caching.
  library = buffer;
  canonicalizeLibrary();
  sortLibrary(library);
  buffer = library;

  const liveMap = new Map();
  for (const t of buffer) liveMap.set(t.id, path.join(MUSIC_PATH, t.relPath));

  library = buffer;
  idMap = liveMap;
  console.log(`[scan] phase-1 live — ${library.length} tracks ready`);

  const targets = buffer.filter((t) => !t.enriched);
  console.log(`[scan] ${targets.length} of ${buffer.length} tracks need enrichment`);
  await enrichTracks(targets);
  console.log(`[scan] full scan done in ${(Date.now() - startTime) / 1000}s`);
}

// Index-level artist canonicalization: merge case/whitespace/punctuation variants.
// Non-destructive (folders are untouched); applied after every scan and cache load.
function canonicalizeLibrary() {
  if (!library.length) return;
  const counts = new Map();
  for (const t of library) {
    const a = t.artist || "Unknown Artist";
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  const artists = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
  const aliases = loadAliases(ALIASES_PATH);
  const { map, groups } = buildCanonicalMap(artists, aliases);
  applyCanonicalNames(library, map);

  // Emit near-pairs for manual review (potential true misspellings we should NOT auto-merge).
  try {
    const pairs = findReviewPairs(map.keys());
    if (pairs.length) {
      const totalForKey = (key) => (groups.get(key) || []).reduce((s, v) => s + v.count, 0);
      const review = pairs.map(([k1, k2]) => ({
        a: { key: k1, total: totalForKey(k1), variants: (groups.get(k1) || []).map((v) => v.name) },
        b: { key: k2, total: totalForKey(k2), variants: (groups.get(k2) || []).map((v) => v.name) },
      }));
      fs.writeFileSync(REVIEW_PATH, JSON.stringify({ generated: new Date().toISOString(), count: review.length, pairs: review }, null, 2));
      console.log(`[canonical] ${review.length} near-pair(s) written to ${path.basename(REVIEW_PATH)} for review`);
    } else {
      if (fs.existsSync(REVIEW_PATH)) fs.unlinkSync(REVIEW_PATH);
    }
  } catch (err) {
    console.error("[canonical] review write failed:", err.message);
  }
}

// Warm start: cache is already loaded and serving. Finish any enrichment the cache still lacks,
// WITHOUT walking the disk. Once the cache is fully enriched this does nothing — zero contention.
async function resumeEnrichment() {
  if (scanState.scanning) return;
  const targets = library.filter((t) => !t.enriched);
  if (!targets.length) {
    console.log(`[scan] cache fully enriched (${library.length} tracks) — no scan needed`);
    return;
  }
  console.log(`[scan] resuming enrichment — ${targets.length} of ${library.length} tracks remain`);
  await enrichTracks(targets);
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return false;
    const data = fs.readFileSync(CACHE_PATH, "utf8");
    const tracks = JSON.parse(data);
    if (!Array.isArray(tracks)) return false;

    // Migrate caches written before the `enriched` flag existed: a real duration means it was
    // parsed. Tracks still at duration 0 are treated as un-enriched and get finished on resume.
    for (const t of tracks) {
      if (typeof t.enriched !== "boolean") {
        t.enriched = typeof t.duration === "number" && t.duration > 0;
      }
      // Migrate caches without quality metadata (derive lossless from extension; full values fill
      // on the next enrichment pass).
      if (!t.quality) {
        const ext = path.extname(t.relPath || "").toLowerCase();
        t.quality = deriveQualityFallback(ext);
      }

      // Repair any tracks that were mis-filed under the phantom "Music" artist (the nested
      // Music/Music dump folder). Re-derive artist/album from the folder path so they attribute
      // correctly. This mirrors the cold-scan migration in buildIndex().
      if (t.artist === "Music") {
        const fixed = buildTrackFromPath(path.join(MUSIC_PATH, t.relPath));
        t.artist = fixed.artist;
        t.album = fixed.album;
      }
    }

    library = tracks;
    canonicalizeLibrary();
    sortLibrary(library);
    const newMap = new Map();
    for (const t of tracks) {
      newMap.set(t.id, path.join(MUSIC_PATH, t.relPath));
    }
    idMap = newMap;

    const pending = tracks.filter((t) => !t.enriched).length;
    console.log(`[cache] loaded ${tracks.length} tracks (${pending} still need enrichment)`);
    return true;
  } catch (err) {
    console.error("[cache] load failed:", err.message);
    return false;
  }
}

const app = express();
app.use(cors());
app.use(express.json());
// Never cache the HTML shell — it carries the client code, and a stale copy means deploys silently
// don't reach the browser (Cloudflare otherwise stamps max-age, and mobile browsers cache hard).
// Static assets (images) still cache normally.
app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-store, must-revalidate");
      }
    },
  })
);

app.get("/api/status", (req, res) => {
  res.json({
    scanning: scanState.scanning,
    scanned: scanState.scanned,
    total: scanState.total,
    mounted: isMounted(),
    ready: library.length > 0,
    trackCount: library.length,
  });
});

app.get("/api/library", (req, res) => {
  res.json(library);
});

// Lightweight artist list for the sidebar — names + track counts only, never the full library.
// A 289k-track library yields ~4k artists (~150 KB) vs. ~74 MB for /api/library, so this loads
// instantly on mobile and desktop alike. Computed on demand; the in-memory loop is sub-ms.
app.get("/api/artists", (req, res) => {
  const counts = new Map();
  for (const t of library) {
    const a = t.artist || "Unknown Artist";
    counts.set(a, (counts.get(a) || 0) + 1);
  }
  const arr = Array.from(counts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  res.json(arr);
});

// Tracks for a single artist — lazy-loaded when the user picks an artist. Capped so a mega-artist
// (e.g. Grateful Dead, ~45k tracks) doesn't ship a 12 MB payload to a phone; total is reported.
app.get("/api/tracks", (req, res) => {
  const artist = typeof req.query.artist === "string" ? req.query.artist : "";
  if (!artist) return res.json({ tracks: [], total: 0 });
  const all = library.filter((t) => t.artist === artist);
  res.json({ tracks: all.slice(0, 1000), total: all.length });
});

// Albums for an artist — for live tapers (Grateful Dead) the "album" folder is a show
// (`YYYY-MM-DD - Venue - City`), so this is the show list. Date-prefixed names sort chronologically
// as plain strings. Lightweight: name + track count only.
app.get("/api/albums", (req, res) => {
  const artist = typeof req.query.artist === "string" ? req.query.artist : "";
  if (!artist) return res.json([]);
  const counts = new Map();
  for (const t of library) {
    if (t.artist !== artist) continue;
    const al = t.album || "Unknown Album";
    counts.set(al, (counts.get(al) || 0) + 1);
  }
  const arr = Array.from(counts.entries())
    .map(([album, count]) => ({ album, count }))
    .sort((a, b) => a.album.localeCompare(b.album, undefined, { numeric: true, sensitivity: "base" }));
  res.json(arr);
});

// Tracks for one artist + album (one show), already in track order (library is pre-sorted by
// artist → album → trackNo → title, so a filter preserves order). A show is small; no cap needed.
app.get("/api/album-tracks", (req, res) => {
  const artist = typeof req.query.artist === "string" ? req.query.artist : "";
  const album = typeof req.query.album === "string" ? req.query.album : "";
  if (!artist || !album) return res.json([]);
  res.json(library.filter((t) => t.artist === artist && t.album === album));
});

// Server-side search across title/artist/album. Returns up to `max` hits plus a total count so
// the client never has to hold the whole library to search it. Works mid-scan against the live array.
app.get("/api/search", (req, res) => {
  const q = (typeof req.query.q === "string" ? req.query.q : "").trim().toLowerCase();
  if (!q) return res.json({ tracks: [], total: 0 });
  const max = 500;
  const out = [];
  let total = 0;
  for (const t of library) {
    if (
      (t.title && t.title.toLowerCase().includes(q)) ||
      (t.artist && t.artist.toLowerCase().includes(q)) ||
      (t.album && t.album.toLowerCase().includes(q))
    ) {
      total += 1;
      if (out.length < max) out.push(t);
    }
  }
  res.json({ tracks: out, total });
});

// --- User state endpoints (single user, no auth) ---

app.get("/api/liked", (req, res) => {
  res.json({ tracks: tracksByIds(userStore.getLiked()) });
});

app.post("/api/liked/:id", (req, res) => {
  userStore.addLiked(req.params.id);
  res.json({ liked: true });
});

app.delete("/api/liked/:id", (req, res) => {
  userStore.removeLiked(req.params.id);
  res.json({ liked: false });
});

app.get("/api/playlists", (req, res) => {
  res.json(userStore.getPlaylists());
});

app.post("/api/playlists", (req, res) => {
  const name = req.body && typeof req.body.name === "string" ? req.body.name : "My Playlist";
  const created = userStore.createPlaylist(name);
  res.status(201).json(created);
});

app.put("/api/playlists/:id", (req, res) => {
  const name = req.body && typeof req.body.name === "string" ? req.body.name : null;
  if (!name) return res.status(400).json({ error: "Missing name" });
  if (!userStore.renamePlaylist(req.params.id, name)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  res.json({ id: req.params.id, name });
});

app.delete("/api/playlists/:id", (req, res) => {
  if (!userStore.deletePlaylist(req.params.id)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  res.status(204).end();
});

app.get("/api/playlists/:id/tracks", (req, res) => {
  const p = userStore.getPlaylist(req.params.id);
  if (!p) return res.status(404).json({ error: "Playlist not found" });
  res.json({ id: p.id, name: p.name, tracks: tracksByIds(p.tracks) });
});

app.post("/api/playlists/:id/tracks", (req, res) => {
  const trackId = req.body && typeof req.body.trackId === "string" ? req.body.trackId : null;
  if (!trackId) return res.status(400).json({ error: "Missing trackId" });
  if (!userStore.addPlaylistTrack(req.params.id, trackId)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  res.json({ added: true });
});

app.delete("/api/playlists/:id/tracks/:trackId", (req, res) => {
  if (!userStore.removePlaylistTrack(req.params.id, req.params.trackId)) {
    return res.status(404).json({ error: "Playlist or track not found" });
  }
  res.json({ removed: true });
});

app.put("/api/playlists/:id/tracks", (req, res) => {
  const ordered = req.body && Array.isArray(req.body.tracks) ? req.body.tracks : null;
  if (!ordered) return res.status(400).json({ error: "Missing tracks array" });
  if (!userStore.reorderPlaylistTracks(req.params.id, ordered)) {
    return res.status(404).json({ error: "Playlist not found" });
  }
  res.json({ reordered: true });
});

app.post("/api/play-events", (req, res) => {
  const id = req.body && typeof req.body.id === "string" ? req.body.id : null;
  const position = req.body && typeof req.body.position === "number" ? req.body.position : 0;
  if (!id) return res.status(400).json({ error: "Missing id" });
  userStore.logPlay(id);
  if (position >= 0) userStore.setResume(id, position);
  res.json({ logged: true });
});

app.get("/api/recently-played", (req, res) => {
  const raw = userStore.getRecentlyPlayed(50);
  res.json({ tracks: tracksByIds(raw.map((x) => x.id)) });
});

app.get("/api/resume", (req, res) => {
  const r = userStore.getResume();
  if (!r) return res.json(null);
  const track = trackById(r.id);
  if (!track) return res.json(null);
  res.json({ track, position: r.position, ts: r.ts });
});

// Raw-file passthrough with HTTP Range support (206). No ffmpeg. Used for "original" quality and as
// the graceful fallback when the transcode cap is hit.
function serveOriginal(req, res, absPath, stats) {
  const ext = path.extname(absPath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  const size = stats.size;

  const range = req.headers.range;
  if (range) {
    const match = range.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      res.set("Content-Length", String(size));
      res.set("Accept-Ranges", "bytes");
      res.set("Content-Type", contentType);
      return res.status(200).end();
    }
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : size - 1;
    if (start >= size || end >= size || start > end) {
      res.set("Content-Range", `bytes */${size}`);
      return res.status(416).end();
    }
    const chunkSize = end - start + 1;
    res.set("Content-Range", `bytes ${start}-${end}/${size}`);
    res.set("Accept-Ranges", "bytes");
    res.set("Content-Length", String(chunkSize));
    res.set("Content-Type", contentType);
    res.status(206);
    const stream = fs.createReadStream(absPath, { start, end });
    stream.on("error", () => {
      if (!res.headersSent) return res.status(500).end();
      res.destroy();
    });
    stream.pipe(res);
  } else {
    res.set("Content-Length", String(size));
    res.set("Accept-Ranges", "bytes");
    res.set("Content-Type", contentType);
    res.status(200);
    const stream = fs.createReadStream(absPath);
    stream.on("error", () => {
      if (!res.headersSent) return res.status(500).end();
      res.destroy();
    });
    stream.pipe(res);
  }
}

app.get("/stream/:id", (req, res) => {
  if (!isMounted()) {
    return res.status(503).json({ error: "Music drive not mounted" });
  }
  const absPath = idMap.get(req.params.id);
  if (!absPath) {
    return res.status(404).json({ error: "Track not found" });
  }

  let stats;
  try {
    stats = fs.statSync(absPath);
  } catch (err) {
    return res.status(404).json({ error: "Track file missing" });
  }

  // Mark this as an active stream so background enrichment yields the disk. Decrement exactly once
  // when the connection closes (covers normal end, client abort, and errors; both quality paths).
  activeStreams += 1;
  let streamCounted = true;
  const releaseStream = () => {
    if (streamCounted) {
      streamCounted = false;
      activeStreams = Math.max(0, activeStreams - 1);
    }
  };
  res.on("close", releaseStream);

  const q = req.query.q;
  const quality = typeof q === "string" ? q.toLowerCase() : "";
  const wantsTranscode = quality && quality !== "original" && QUALITY_BITRATES[quality];

  if (!wantsTranscode) {
    return serveOriginal(req, res, absPath, stats);
  }

  // Transcode requested — enforce the concurrency cap. Over the cap, degrade to original passthrough
  // (still plays, just heavier) rather than failing the stream or piling up ffmpeg processes.
  if (activeTranscodes >= MAX_TRANSCODES) {
    console.warn(`[ffmpeg] transcode cap (${MAX_TRANSCODES}) reached — serving original for ${req.params.id}`);
    res.set("X-Shmearify-Transcode", "fallback-original");
    return serveOriginal(req, res, absPath, stats);
  }

  const bitrate = QUALITY_BITRATES[quality];
  const tRaw = parseFloat(req.query.t);
  const t = isFinite(tRaw) && tRaw >= 0 ? tRaw : 0;

  const args = ["-hide_banner", "-loglevel", "error"];
  if (t > 0) {
    args.push("-ss", String(t));
  }
  args.push("-i", absPath, "-vn", "-c:a", "libmp3lame", "-b:a", bitrate, "-f", "mp3", "pipe:1");

  activeTranscodes += 1;
  let transcodeCounted = true;
  const releaseTranscode = () => {
    if (transcodeCounted) {
      transcodeCounted = false;
      activeTranscodes = Math.max(0, activeTranscodes - 1);
    }
  };

  const child = spawn(FFMPEG_PATH, args);

  req.on("close", () => {
    child.kill("SIGKILL");
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  child.on("error", (err) => {
    releaseTranscode();
    console.error("[ffmpeg] spawn error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Transcode failed" });
    } else {
      res.destroy();
    }
  });

  child.on("exit", (code) => {
    releaseTranscode();
    if (code !== 0 && code !== null) {
      console.error("[ffmpeg] exited", code, stderr.trim());
    }
  });

  res.set("Content-Type", "audio/mpeg");
  res.set("Accept-Ranges", "none");
  res.status(200);
  child.stdout.pipe(res);
});

app.get("/art/:id", async (req, res) => {
  if (!isMounted()) {
    return res.status(503).json({ error: "Music drive not mounted" });
  }
  const id = req.params.id;
  const absPath = idMap.get(id);
  if (!absPath) {
    return res.status(404).json({ error: "Track not found" });
  }

  if (artCache.has(id)) {
    const cached = artCache.get(id);
    if (!cached) {
      return res.status(404).end();
    }
    res.set("Content-Type", cached.format);
    return res.send(cached.data);
  }

  try {
    const meta = await mm.parseFile(absPath);
    const pic = meta && meta.common && meta.common.picture && meta.common.picture[0];
    if (!pic) {
      artCache.set(id, null);
      if (artCache.size > ART_CACHE_MAX) {
        const firstKey = artCache.keys().next().value;
        artCache.delete(firstKey);
      }
      return res.status(404).end();
    }
    const entry = { format: pic.format, data: pic.data };
    artCache.set(id, entry);
    if (artCache.size > ART_CACHE_MAX) {
      const firstKey = artCache.keys().next().value;
      artCache.delete(firstKey);
    }
    res.set("Content-Type", entry.format);
    return res.send(entry.data);
  } catch (err) {
    artCache.set(id, null);
    if (artCache.size > ART_CACHE_MAX) {
      const firstKey = artCache.keys().next().value;
      artCache.delete(firstKey);
    }
    return res.status(404).end();
  }
});

function handleRescan(req, res) {
  if (!isMounted()) {
    return res.status(503).json({ error: "Music drive not mounted" });
  }
  if (scanState.scanning) {
    return res.status(409).json({ error: "Scan already running" });
  }
  buildIndex().catch((err) => console.error("[rescan] error:", err.message));
  res.json({ started: true });
}

app.post("/api/rescan", handleRescan);
app.get("/api/rescan", handleRescan);

process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(`Shmearify listening on http://127.0.0.1:${PORT}`);
  const hadCache = loadCache();
  if (isMounted()) {
    if (hadCache) {
      // Warm start — serve from cache instantly, finish any remaining enrichment (no disk walk).
      resumeEnrichment().catch((err) => console.error("[resume] error:", err.message));
    } else {
      // Cold start — no cache, do the full walk + enrich (checkpointed so it survives restarts).
      buildIndex().catch((err) => console.error("[startup scan] error:", err.message));
    }
  }
});
