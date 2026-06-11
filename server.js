const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mm = require("music-metadata");
const pLimit = require("p-limit");
const { spawn } = require("child_process");

const MUSIC_PATH = process.env.MUSIC_PATH || "/Volumes/Shulmeister HD/iTunes/Music";
const PORT = process.env.PORT || 3005;
const CACHE_PATH = path.join(__dirname, "library-cache.json");
const FFMPEG_PATH = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".flac", ".aac", ".wav", ".ogg"]);
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

let library = [];
let idMap = new Map();
let scanState = { scanning: false, scanned: 0, total: null };
let artCache = new Map();
const ART_CACHE_MAX = 300;

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

function buildTrackFromPath(absPath) {
  const relPath = path.relative(MUSIC_PATH, absPath);
  const parts = relPath.split(path.sep);
  const filename = path.basename(absPath, path.extname(absPath));
  const parsed = parseTitleFromFilename(filename);

  const artist = parts[0] || "Unknown Artist";
  const album = parts.length >= 3 ? parts[parts.length - 2] : "Unknown Album";

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

async function buildIndex() {
  if (scanState.scanning) return;
  scanState = { scanning: true, scanned: 0, total: null };

  const startTime = Date.now();
  console.log("[scan] starting library scan…");

  let fileList;
  try {
    fileList = await walkDir(MUSIC_PATH);
  } catch (err) {
    console.error("[scan] walk failed:", err.message);
    scanState = { scanning: false, scanned: 0, total: null };
    return;
  }

  scanState.total = fileList.length;
  console.log(`[scan] found ${fileList.length} audio files`);

  // Phase 1 — path-only index (no ID3 parsing)
  const cold = library.length === 0;
  const buffer = fileList.map((absPath) => buildTrackFromPath(absPath));
  const liveMap = new Map();
  for (const t of buffer) {
    liveMap.set(t.id, path.join(MUSIC_PATH, t.relPath));
  }

  sortLibrary(buffer);

  if (cold) {
    library = buffer;
    idMap = liveMap;
    console.log(`[scan] phase-1 live — ${library.length} tracks ready`);
  }

  // Phase 2 — background ID3 enrichment
  const limit = pLimit(8);
  let lastLogged = 0;

  // Build id → track map for in-place updates
  const trackById = new Map();
  for (const t of buffer) {
    trackById.set(t.id, t);
  }

  const tasks = fileList.map((absPath) =>
    limit(async () => {
      const relPath = path.relative(MUSIC_PATH, absPath);
      const id = makeId(relPath);
      const track = trackById.get(id);
      if (!track) return;

      let meta;
      try {
        meta = await mm.parseFile(absPath, { duration: true, skipCovers: true });
      } catch (err) {
        meta = null;
      }

      const common = meta && meta.common ? meta.common : {};
      const format = meta && meta.format ? meta.format : {};

      if (common.title) track.title = common.title;
      track.duration = formatDuration(format.duration);
      if (common.genre && common.genre.length) track.genre = common.genre[0];
      if (common.year) track.year = common.year;
      if (common.track && common.track.no != null) track.trackNo = common.track.no;

      scanState.scanned += 1;

      if (scanState.scanned - lastLogged >= 500) {
        lastLogged = scanState.scanned;
        console.log(`[scan] parsed ${scanState.scanned} / ${scanState.total}`);
      }
    })
  );

  await Promise.all(tasks);

  sortLibrary(buffer);

  library = buffer;
  idMap = liveMap;

  try {
    const tmp = CACHE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(library));
    fs.renameSync(tmp, CACHE_PATH);
  } catch (err) {
    console.error("[scan] cache write failed:", err.message);
  }

  scanState = { scanning: false, scanned: scanState.scanned, total: scanState.total };
  console.log(`[scan] complete — ${library.length} tracks in ${(Date.now() - startTime) / 1000}s`);
}

function loadCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return false;
    const data = fs.readFileSync(CACHE_PATH, "utf8");
    const tracks = JSON.parse(data);
    if (!Array.isArray(tracks)) return false;

    library = tracks;
    const newMap = new Map();
    for (const t of tracks) {
      newMap.set(t.id, path.join(MUSIC_PATH, t.relPath));
    }
    idMap = newMap;

    console.log(`[cache] loaded ${tracks.length} tracks from ${CACHE_PATH}`);
    return true;
  } catch (err) {
    console.error("[cache] load failed:", err.message);
    return false;
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

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

  const q = req.query.q;
  const quality = typeof q === "string" ? q.toLowerCase() : "";

  if (!quality || quality === "original" || !QUALITY_BITRATES[quality]) {
    // Original quality — raw-file passthrough with Range support
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
      stream.on("error", (err) => {
        if (!res.headersSent) {
          return res.status(500).end();
        }
        res.destroy();
      });
      stream.pipe(res);
    } else {
      res.set("Content-Length", String(size));
      res.set("Accept-Ranges", "bytes");
      res.set("Content-Type", contentType);
      res.status(200);
      const stream = fs.createReadStream(absPath);
      stream.on("error", (err) => {
        if (!res.headersSent) {
          return res.status(500).end();
        }
        res.destroy();
      });
      stream.pipe(res);
    }
    return;
  }

  // Transcoded quality
  const bitrate = QUALITY_BITRATES[quality];
  const tRaw = parseFloat(req.query.t);
  const t = isFinite(tRaw) && tRaw >= 0 ? tRaw : 0;

  const args = ["-hide_banner", "-loglevel", "error"];
  if (t > 0) {
    args.push("-ss", String(t));
  }
  args.push("-i", absPath, "-vn", "-c:a", "libmp3lame", "-b:a", bitrate, "-f", "mp3", "pipe:1");

  const child = spawn(FFMPEG_PATH, args);

  req.on("close", () => {
    child.kill("SIGKILL");
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  child.on("error", (err) => {
    console.error("[ffmpeg] spawn error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: "Transcode failed" });
    } else {
      res.destroy();
    }
  });

  child.on("exit", (code) => {
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
  if (!hadCache && isMounted()) {
    buildIndex().catch((err) => console.error("[startup scan] error:", err.message));
  }
});
