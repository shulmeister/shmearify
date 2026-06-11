const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mm = require("music-metadata");
const pLimit = require("p-limit");

const MUSIC_PATH = process.env.MUSIC_PATH || "/Volumes/Shulmeister HD/iTunes/Music";
const PORT = process.env.PORT || 3005;
const CACHE_PATH = path.join(__dirname, "library-cache.json");
const AUDIO_EXTS = new Set([".mp3", ".m4a", ".flac", ".aac", ".wav", ".ogg"]);
const MIME_TYPES = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".aac": "audio/aac",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
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

  const limit = pLimit(8);
  const tracks = [];
  let lastLogged = 0;

  const tasks = fileList.map((absPath) =>
    limit(async () => {
      const relPath = path.relative(MUSIC_PATH, absPath);
      let meta;
      try {
        meta = await mm.parseFile(absPath, { duration: true, skipCovers: true });
      } catch (err) {
        meta = null;
      }

      const common = meta && meta.common ? meta.common : {};
      const format = meta && meta.format ? meta.format : {};
      const filename = path.basename(absPath, path.extname(absPath));

      const parts = relPath.split(path.sep);
      const artistFallback = parts[0] || "Unknown Artist";

      const track = {
        id: makeId(relPath),
        relPath,
        title: common.title || filename,
        artist: common.artist || artistFallback,
        album: common.album || "Unknown Album",
        duration: formatDuration(format.duration),
        genre: common.genre ? common.genre[0] : null,
        year: common.year || null,
        trackNo: common.track && common.track.no ? common.track.no : null,
      };

      tracks.push(track);
      scanState.scanned += 1;

      if (scanState.scanned - lastLogged >= 500) {
        lastLogged = scanState.scanned;
        console.log(`[scan] parsed ${scanState.scanned} / ${scanState.total}`);
      }
    })
  );

  await Promise.all(tasks);

  // Sort by artist, album, trackNo, title for stable ordering
  tracks.sort((a, b) => {
    const c = (a.artist || "").localeCompare(b.artist || "", undefined, { sensitivity: "base" });
    if (c !== 0) return c;
    const d = (a.album || "").localeCompare(b.album || "", undefined, { sensitivity: "base" });
    if (d !== 0) return d;
    const t = (a.trackNo || 0) - (b.trackNo || 0);
    if (t !== 0) return t;
    return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
  });

  library = tracks;
  const newMap = new Map();
  for (const t of tracks) {
    newMap.set(t.id, path.join(MUSIC_PATH, t.relPath));
  }
  idMap = newMap;

  try {
    const tmp = CACHE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(tracks));
    fs.renameSync(tmp, CACHE_PATH);
  } catch (err) {
    console.error("[scan] cache write failed:", err.message);
  }

  scanState = { scanning: false, scanned: scanState.scanned, total: scanState.total };
  console.log(`[scan] complete — ${tracks.length} tracks in ${(Date.now() - startTime) / 1000}s`);
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
