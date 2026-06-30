# Shmearify

Personal, Spotify-style web player that streams the local iTunes library off the
"Shulmeister HD" external drive, served from the Mac Mini via the Cloudflare tunnel
at `https://shmearify.coloradocareassist.com`.

- **Backend:** Node + Express (`server.js`), port **3005**. Recursive scan of
  `/Volumes/Shulmeister HD/iTunes/Music`, ID3 via `music-metadata`, a **cached/async
  index** (the library is ~40k+ tracks — never block startup), `GET /api/library`,
  and `GET /stream/:id` with HTTP Range support.
- **Frontend:** `public/index.html` — dark Spotify-style UI, artist sidebar, bottom player.
- **Serving:** Cloudflare tunnel → `localhost:3005` (no nginx). Runs as LaunchAgent
  `com.coloradocareassist.shmearify` (no PM2).

Built via the Fable-spec → Kimi-build → Fable-review pipeline; deploy (tunnel + LaunchAgent) done by hand.

## Getting started (build your own)

Everything is configured by environment variables — nothing is hard-coded to one machine, so point it at *your* library and run.

**Prerequisites:** [Node.js](https://nodejs.org) 18+ and [`ffmpeg`](https://ffmpeg.org) (used to transcode on the fly).

```bash
git clone <your-fork-url> && cd shmearify
npm install
MUSIC_PATH="/path/to/your/Music" npm start    # then open http://localhost:3005
```

On first launch it recursively scans `MUSIC_PATH`, reads ID3 tags, and writes a `library-cache.json` index (gitignored — regenerated per machine; large libraries take a minute the first time, then start instantly).

**Configuration (all optional except `MUSIC_PATH`):**

| Env var | Default | What it does |
|---|---|---|
| `MUSIC_PATH` | `/Volumes/Shulmeister HD/iTunes/Music` | Root folder of your music library — **set this** |
| `PORT` | `3005` | HTTP port |
| `FFMPEG_PATH` | `/opt/homebrew/bin/ffmpeg` | Path to the `ffmpeg` binary (`which ffmpeg`) |
| `MAX_TRANSCODES` | `3` | Max concurrent on-the-fly transcodes |
| `CACHE_PATH` | `./library-cache.json` | Where the scanned index is cached |
| `ALIASES_PATH` | `./data/artist_aliases.json` | Optional artist-name alias map |
| `GD_VAULT_ROOTS` | (off) | Colon-separated extra roots for live-show "vault" browsing |

**Serving it publicly** is independent of the app: any reverse proxy or tunnel (Cloudflare Tunnel, ngrok, nginx) pointed at `localhost:$PORT` works. To run it as a background service, wrap `node server.js` in your platform's service manager (a macOS LaunchAgent, a systemd unit, pm2, etc.).
