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
