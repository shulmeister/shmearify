# Shmearify

_Last reviewed: 2026-07-02_

Personal music streamer (Tommy Engelshmear's library) — Node/Express server + vanilla-JS PWA. Single-user, PHI-free, low stakes — but **this checkout IS the live site**.

## The one rule that matters

**`~/Sites/shmearify` on `main` serves production directly** (no deploy-listener, no build step). A LaunchAgent runs `server.js` straight from this directory.

- **Never leave this checkout on a feature branch** — on 7/2/26 an agent switched it to a stale rebuild branch and the live site silently regressed (lost playlists/PWA/resume).
- Work in a worktree: `git worktree add ../shmearify-work -b feat/x main`, test there on a non-live port (`PORT=3999 node server.js`), PR, merge, then here: `git pull && launchctl kickstart -k gui/$(id -u)/com.coloradocareassist.shmearify`.

## Run / deploy

| Thing | Value |
|---|---|
| Live port | `3005` (localhost, Cloudflare tunnel → `shmearify.coloradocareassist.com`) |
| LaunchAgent | `com.coloradocareassist.shmearify` |
| Music source | `/Volumes/Shulmeister HD/iTunes/Music` (external USB — may be unmounted; server answers 503s gracefully) |
| Library cache | `library-cache.json` (gitignored, rebuildable via `/api/rescan`) |
| User state | `data/user_state.json` — playlists/likes/resume. **Real user data, gitignored, never commit/delete** |

Health: `curl localhost:3005/api/status`. Deploy verification: check the page renders AND `curl localhost:3005/sw.js | grep CACHE_NAME` shows the new version.

## Gotchas

- **Bump `CACHE_NAME` in `public/sw.js` on EVERY front-end change** (`shmearify-vN` → `vN+1`) or users get stale cached assets and the deploy looks like it didn't happen.
- **Never add `/api/*` (or `/stream/`, `/art/`) to the SW cache path** — API responses are live user state; cache-first served week-old JSON until fixed 7/2 (network-only now, pinned in `sw.js isNoStore`).
- **The Spotify-dark "Desktop" design is ALREADY SHIPPED** (commit `b93b2f7` + successors). Branch `feat/shmearify-player` is a stale from-scratch rebuild kept only as a visual reference — never merge or branch from it.
- Artist sidebar renders max 500 (`ARTIST_RENDER_CAP` in `app.js`); anything operating on "all artists" must handle the cap (the A-Z scrubber broke on it).
- `renderArtists()` reads `searchBox.value` directly — programmatic filtering = set the value + call it.
- Grateful Dead dedup: taper vaults (`Paolo's/Tom's Grateful Dead`) merge under one artist, one copy per show DATE, index-only (nothing deleted). Don't "fix" duplicate-looking folders on disk.
- ffmpeg transcodes capped at `MAX_TRANSCODES=3` (this Mac also runs CCA production) — over cap falls back to original passthrough. Keep the cap.
- Two-phase scan: instant browse from paths, background ID3 enrichment that **yields to active streams** (same USB disk; concurrent reads = mobile stutter). Don't remove the yield.
