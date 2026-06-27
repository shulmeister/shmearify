/**
 * Shmearify client — Phase 2 + 3
 * Adds liked songs, playlists, recently played / resume, queue panel,
 * lazy album art, keyboard shortcuts, sleep timer, and sort options.
 */
(function () {
  "use strict";

  const state = {
    artists: [],          // [{ name, count }]
    albums: [],           // [{ album, count, date, venue, city, year }]
    filteredAlbums: [],   // after within-artist search
    tracks: [],           // currently displayed tracks
    viewTotal: 0,
    selectedArtist: null,
    selectedAlbum: null,
    search: "",
    albumFilter: "",
    status: { scanning: false, scanned: 0, total: null, mounted: true, ready: false, trackCount: 0 },

    // Player state
    queue: [],            // currently playing order
    contextQueue: [],     // original order for the current context
    queueIndex: -1,
    currentTrack: null,
    isPlaying: false,
    streamBaseOffset: 0,
    quality: "original",
    volume: 1,
    shuffle: false,
    repeat: "off",        // off | all | one
    activeAudioIdx: 0,

    // User state
    likedIds: new Set(),
    playlists: [],
    recentlyPlayed: [],
    resume: null,

    // UI state
    view: "home",         // home | artist | album | search | liked | playlist | recently
    selectedPlaylistId: null,
    queuePanelOpen: false,
    sleepTimer: null,     // { until: number, timerId: number }
    albumSort: "date",    // date | name
    trackSort: "trackNo", // trackNo | title
  };

  const audioPool = [new Audio(), new Audio()];
  audioPool.forEach((a) => (a.preload = "metadata"));

  const els = {
    artistList: document.getElementById("artistList"),
    libraryList: document.getElementById("libraryList"),
    azScrubber: document.getElementById("azScrubber"),
    main: document.getElementById("main"),
    trackPanel: document.getElementById("trackPanel"),
    resumePrompt: document.getElementById("resumePrompt"),
    searchBox: document.getElementById("searchBox"),
    btnPlay: document.getElementById("btnPlay"),
    btnPrev: document.getElementById("btnPrev"),
    btnNext: document.getElementById("btnNext"),
    btnShuffle: document.getElementById("btnShuffle"),
    btnRepeat: document.getElementById("btnRepeat"),
    btnHeart: document.getElementById("btnHeart"),
    btnQueue: document.getElementById("btnQueue"),
    btnCloseQueue: document.getElementById("btnCloseQueue"),
    btnSleep: document.getElementById("btnSleep"),
    sleepWrap: document.getElementById("sleepWrap"),
    sleepMenu: document.getElementById("sleepMenu"),
    iconPlay: document.getElementById("iconPlay"),
    iconPause: document.getElementById("iconPause"),
    playerTitle: document.getElementById("playerTitle"),
    playerArtist: document.getElementById("playerArtist"),
    playerQuality: document.getElementById("playerQuality"),
    artWrap: document.getElementById("artWrap"),
    progressWrap: document.getElementById("progressWrap"),
    progressFill: document.getElementById("progressFill"),
    timeCurrent: document.getElementById("timeCurrent"),
    timeTotal: document.getElementById("timeTotal"),
    playerNotice: document.getElementById("playerNotice"),
    mobileToggle: document.getElementById("mobileToggle"),
    sidebar: document.getElementById("sidebar"),
    qualitySelect: document.getElementById("qualitySelect"),
    volumeSlider: document.getElementById("volumeSlider"),
    queuePanel: document.getElementById("queuePanel"),
    queueList: document.getElementById("queueList"),
  };

  function formatTime(s) {
    if (!s || !isFinite(s)) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  function formatNumber(n) {
    return n.toLocaleString();
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  async function fetchJson(url, options) {
    const r = await fetch(url, options);
    if (!r.ok) {
      const text = await r.text().catch(() => "");
      throw new Error(r.status + " " + r.statusText + (text ? ": " + text : ""));
    }
    const type = r.headers.get("content-type") || "";
    if (type.includes("application/json")) return r.json();
    return null;
  }

  function postJson(url, body) {
    return fetchJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function putJson(url, body) {
    return fetchJson(url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  function apiDelete(url) {
    return fetchJson(url, { method: "DELETE" });
  }

  // --- Quality badges ---
  function codecShort(track) {
    const codec = (track.quality && track.quality.codec) || "";
    const ext = (track.relPath || "").split(".").pop().toLowerCase();
    const map = {
      "mpeg 1 layer 3": "MP3",
      "mpeg": "MP3",
      "mp3": "MP3",
      "aac": "AAC",
      "flac": "FLAC",
      "wav": "WAV",
      "aiff": "AIFF",
      "alac": "ALAC",
      "vorbis": "OGG",
      "ogg": "OGG",
      "pcm": "PCM",
    };
    const key = codec.toLowerCase();
    if (map[key]) return map[key];
    if (ext === "m4a") return "AAC";
    if (ext === "flac") return "FLAC";
    if (ext === "mp3") return "MP3";
    return codec.toUpperCase() || ext.toUpperCase() || "?";
  }

  function formatQuality(track) {
    if (!track.quality) return "";
    const codec = codecShort(track);
    const lossless = track.quality.lossless;
    if (lossless) {
      const bits = track.quality.bits || "";
      const sr = track.quality.sampleRate;
      const khz = sr ? Math.round(sr / 1000) : "";
      if (bits && khz) return `${codec} ${bits}/${khz}`;
      if (khz) return `${codec} ${khz}k`;
      return codec;
    }
    const br = track.quality.bitrate;
    if (br) {
      const kbps = Math.round(br / 1000);
      return `${codec} ${kbps}`;
    }
    return codec;
  }

  function qualityBadge(track) {
    const label = formatQuality(track);
    if (!label) return "";
    const cls = track.quality && track.quality.lossless ? "quality-badge lossless" : "quality-badge lossy";
    return `<span class="${cls}" title="Source: ${esc((track.quality.codec || "unknown"))} • ${track.quality.lossless ? "lossless" : "lossy"}">${esc(label)}</span>`;
  }

  // --- Lazy album art ---
  const artObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const img = entry.target;
          if (img.dataset.src) {
            img.src = img.dataset.src;
            img.removeAttribute("data-src");
            artObserver.unobserve(img);
          }
        }
      });
    },
    { root: els.main, rootMargin: "200px" }
  );

  function lazyArtImg(trackId, className, alt) {
    const img = document.createElement("img");
    img.className = className || "row-art";
    img.alt = alt || "";
    img.dataset.src = "art/" + trackId;
    img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    artObserver.observe(img);
    img.onerror = function () {
      this.style.opacity = "0";
    };
    return img;
  }

  // --- User state loaders ---
  async function loadLiked() {
    try {
      const data = await fetchJson("api/liked");
      state.likedIds = new Set((data.tracks || []).map((t) => t.id));
    } catch (e) {
      // ignore
    }
  }

  async function toggleLiked(id) {
    if (state.likedIds.has(id)) {
      await apiDelete("api/liked/" + encodeURIComponent(id));
      state.likedIds.delete(id);
    } else {
      await postJson("api/liked/" + encodeURIComponent(id));
      state.likedIds.add(id);
    }
    updateHeartUI();
    renderLibrary();
  }

  async function loadPlaylists() {
    try {
      state.playlists = await fetchJson("api/playlists");
      renderLibrary();
    } catch (e) {
      // ignore
    }
  }

  async function createPlaylist(name) {
    const created = await postJson("api/playlists", { name });
    await loadPlaylists();
    return created;
  }

  async function renamePlaylist(id, name) {
    await putJson("api/playlists/" + encodeURIComponent(id), { name });
    await loadPlaylists();
  }

  async function deletePlaylist(id) {
    await apiDelete("api/playlists/" + encodeURIComponent(id));
    await loadPlaylists();
    if (state.view === "playlist" && state.selectedPlaylistId === id) {
      state.view = "home";
      state.selectedPlaylistId = null;
      renderMain();
    }
  }

  async function addToPlaylist(playlistId, trackId) {
    await postJson("api/playlists/" + encodeURIComponent(playlistId) + "/tracks", { trackId });
    await loadPlaylists();
  }

  async function removeFromPlaylist(playlistId, trackId) {
    await apiDelete(
      "api/playlists/" + encodeURIComponent(playlistId) + "/tracks/" + encodeURIComponent(trackId)
    );
    if (state.view === "playlist" && state.selectedPlaylistId === playlistId) {
      await loadPlaylistTracks(playlistId);
    }
  }

  async function reorderPlaylist(playlistId, orderedIds) {
    await putJson("api/playlists/" + encodeURIComponent(playlistId) + "/tracks", {
      tracks: orderedIds,
    });
  }

  async function loadPlaylistTracks(id) {
    return await fetchJson("api/playlists/" + encodeURIComponent(id) + "/tracks");
  }

  async function loadRecentlyPlayed() {
    try {
      const data = await fetchJson("api/recently-played");
      state.recentlyPlayed = data.tracks || [];
    } catch (e) {
      state.recentlyPlayed = [];
    }
  }

  async function loadResume() {
    try {
      state.resume = await fetchJson("api/resume");
    } catch (e) {
      state.resume = null;
    }
  }

  let lastLoggedAt = 0;
  function logPlayEvent(id, position) {
    const now = Date.now();
    if (now - lastLoggedAt < 5000) return;
    lastLoggedAt = now;
    postJson("api/play-events", { id, position: position || 0 }).catch(() => {});
  }

  // --- Status polling ---
  let artistsLoaded = false;
  let pollCount = 0;
  async function pollStatus() {
    try {
      state.status = await fetchJson("api/status");
    } catch (e) {
      // ignore
    }
    if (state.status.ready && !artistsLoaded) {
      artistsLoaded = true;
      await Promise.all([loadArtists(), loadLiked(), loadPlaylists(), loadRecentlyPlayed(), loadResume()]);
      renderResumePrompt();
    }
    renderState();
    pollCount += 1;
    if (state.status.scanning && artistsLoaded && pollCount % 10 === 0) {
      refreshCurrentView();
    }
    if (!state.status.ready || state.status.scanning) {
      setTimeout(pollStatus, 3000);
    }
  }

  async function loadArtists() {
    try {
      state.artists = await fetchJson("api/artists");
      renderArtists();
      renderAzScrubber();
    } catch (e) {
      // ignore
    }
  }

  function refreshCurrentView() {
    if (state.view === "search" || state.search.trim()) {
      runSearch(state.search, true);
    } else if (state.view === "playlist" && state.selectedPlaylistId) {
      loadPlaylistView(state.selectedPlaylistId, true);
    } else if (state.selectedArtist && state.selectedAlbum) {
      loadAlbumTracks(state.selectedArtist, state.selectedAlbum, true);
    } else if (state.selectedArtist) {
      loadArtistAlbums(state.selectedArtist, true);
    }
  }

  // --- Catalog loading ---
  async function loadArtistAlbums(name, silent) {
    state.view = "artist";
    state.selectedArtist = name;
    state.selectedAlbum = null;
    state.albumFilter = "";
    if (!silent) {
      state.search = "";
      els.searchBox.value = "";
      renderArtists();
    }
    try {
      const raw = await fetchJson("api/albums?artist=" + encodeURIComponent(name));
      state.albums = raw.map(parseAlbum);
      applyAlbumSort();
      filterAlbums();
    } catch (e) {
      state.albums = [];
      state.filteredAlbums = [];
    }
    if (state.albums.length === 1 && !state.albumFilter) {
      loadAlbumTracks(name, state.albums[0].album, silent);
      return;
    }
    renderMain();
  }

  async function loadAlbumTracks(artist, album, silent) {
    state.view = "album";
    state.selectedArtist = artist;
    state.selectedAlbum = album;
    try {
      state.tracks = await fetchJson(
        "api/album-tracks?artist=" + encodeURIComponent(artist) + "&album=" + encodeURIComponent(album)
      );
      state.viewTotal = state.tracks.length;
      applyTrackSort(false);
    } catch (e) {
      state.tracks = [];
      state.viewTotal = 0;
    }
    renderMain();
  }

  async function loadArtistTracks(artist) {
    try {
      const data = await fetchJson("api/tracks?artist=" + encodeURIComponent(artist));
      return data.tracks;
    } catch (e) {
      return [];
    }
  }

  async function loadLikedView() {
    state.view = "liked";
    state.selectedArtist = null;
    state.selectedAlbum = null;
    state.selectedPlaylistId = null;
    try {
      const data = await fetchJson("api/liked");
      state.tracks = data.tracks || [];
      state.viewTotal = state.tracks.length;
      applyTrackSort(false);
    } catch (e) {
      state.tracks = [];
      state.viewTotal = 0;
    }
    renderMain();
  }

  async function loadPlaylistView(id, silent) {
    state.view = "playlist";
    state.selectedArtist = null;
    state.selectedAlbum = null;
    state.selectedPlaylistId = id;
    try {
      const data = await loadPlaylistTracks(id);
      state.playlistName = data.name;
      state.tracks = data.tracks || [];
      state.viewTotal = state.tracks.length;
      applyTrackSort(false);
    } catch (e) {
      state.playlistName = null;
      state.tracks = [];
      state.viewTotal = 0;
    }
    if (!silent) renderMain();
  }

  async function loadRecentlyView() {
    state.view = "recently";
    state.selectedArtist = null;
    state.selectedAlbum = null;
    state.selectedPlaylistId = null;
    try {
      const data = await fetchJson("api/recently-played");
      state.tracks = data.tracks || [];
      state.viewTotal = state.tracks.length;
    } catch (e) {
      state.tracks = [];
      state.viewTotal = 0;
    }
    renderMain();
  }

  let searchSeq = 0;
  async function runSearch(q, silent) {
    state.search = q;
    if (!silent) {
      state.view = "search";
      state.selectedArtist = null;
      state.selectedAlbum = null;
      state.selectedPlaylistId = null;
    }
    const trimmed = q.trim();
    if (!trimmed) {
      state.tracks = [];
      state.viewTotal = 0;
      renderMain();
      return;
    }
    const seq = ++searchSeq;
    try {
      const data = await fetchJson("api/search?q=" + encodeURIComponent(trimmed));
      if (seq !== searchSeq) return;
      state.tracks = data.tracks;
      state.viewTotal = data.total;
      applyTrackSort(false);
    } catch (e) {
      if (seq !== searchSeq) return;
      state.tracks = [];
      state.viewTotal = 0;
    }
    renderMain();
  }

  function parseAlbum(al) {
    const album = al.album || "Unknown Album";
    const m = album.match(/^(\d{4})-(\d{2})-(\d{2})/);
    let date = null, year = null, venue = null, city = null;
    if (m) {
      date = `${m[1]}-${m[2]}-${m[3]}`;
      year = m[1];
      const rest = album.slice(10).replace(/^\s*[-–]\s*/, "");
      const parts = rest.split(/\s*-\s*/);
      venue = parts[0] ? parts[0].trim() : null;
      city = parts[1] ? parts[1].trim() : null;
    }
    return { album, count: al.count, date, year, venue, city };
  }

  function isDatedArtist() {
    if (!state.albums.length) return false;
    const dated = state.albums.filter((a) => a.date).length;
    return dated / state.albums.length > 0.5;
  }

  function filterAlbums() {
    const q = state.albumFilter.trim().toLowerCase();
    if (!q) {
      state.filteredAlbums = state.albums;
      return;
    }
    state.filteredAlbums = state.albums.filter(
      (a) =>
        (a.album || "").toLowerCase().includes(q) ||
        (a.venue || "").toLowerCase().includes(q) ||
        (a.city || "").toLowerCase().includes(q) ||
        (a.year || "").includes(q)
    );
  }

  function applyAlbumSort() {
    if (state.albumSort === "date") {
      state.albums.sort((a, b) => a.album.localeCompare(b.album, undefined, { numeric: true, sensitivity: "base" }));
    } else {
      state.albums.sort((a, b) => a.album.localeCompare(b.album, undefined, { sensitivity: "base" }));
    }
  }

  function applyTrackSort(mutate = true) {
    const arr = mutate ? state.tracks : state.tracks.slice();
    if (state.trackSort === "title") {
      arr.sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
    } else if (state.trackSort === "trackNo") {
      arr.sort((a, b) => {
        const ta = a.trackNo || 0;
        const tb = b.trackNo || 0;
        if (ta !== tb) return ta - tb;
        return (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" });
      });
    }
    if (!mutate) state.tracks = arr;
  }

  // --- Rendering ---
  function renderState() {
    const s = state.status;
    if (!s.ready) {
      let html = '<div class="center-panel">';
      if (!s.mounted) {
        html += '<div style="font-size:14px;">Music drive not mounted — connect the drive and restart/rescan</div>';
      } else if (s.scanning) {
        html += '<div style="font-size:14px;">Building your library…';
        if (s.total) html += " " + s.scanned + " of " + s.total + " tracks";
        html += "</div>";
        html +=
          '<div class="progress-bar-outer' +
          (s.total ? "" : " indeterminate") +
          '"><div class="progress-bar-inner" style="width:' +
          (s.total ? Math.round((s.scanned / s.total) * 100) : 0) +
          '%"></div></div>';
      } else {
        html += '<div style="font-size:14px;">Loading…</div>';
      }
      html += "</div>";
      els.trackPanel.innerHTML = html;
      return;
    }
    if (!els.trackPanel.innerHTML.trim()) {
      renderMain();
    }
  }

  const ARTIST_RENDER_CAP = 500;
  function filterArtists(q) {
    if (!q) return state.artists;
    const starts = [];
    const contains = [];
    for (const a of state.artists) {
      const n = a.name.toLowerCase();
      if (n.startsWith(q)) starts.push(a);
      else if (n.includes(q)) contains.push(a);
    }
    return starts.concat(contains);
  }

  function renderArtists() {
    const q = els.searchBox.value.trim().toLowerCase();
    const list = filterArtists(q);
    const frag = document.createDocumentFragment();

    if (!q) {
      const home = document.createElement("li");
      home.textContent = "Home";
      if (state.view === "home") home.classList.add("active");
      home.addEventListener("click", () => {
        state.view = "home";
        state.selectedArtist = null;
        state.selectedAlbum = null;
        state.selectedPlaylistId = null;
        state.search = "";
        state.albumFilter = "";
        els.searchBox.value = "";
        state.tracks = [];
        renderArtists();
        renderMain();
        closeSidebarOnMobile();
      });
      frag.appendChild(home);
    }

    const shown = list.slice(0, ARTIST_RENDER_CAP);
    for (const a of shown) {
      const li = document.createElement("li");
      li.textContent = a.name;
      li.title = a.name + " · " + a.count + (a.count === 1 ? " track" : " tracks");
      li.dataset.artist = a.name;
      if (state.view === "artist" && state.selectedArtist === a.name) li.classList.add("active");
      li.addEventListener("click", () => {
        loadArtistAlbums(a.name);
        closeSidebarOnMobile();
      });
      frag.appendChild(li);
    }

    if (list.length > shown.length) {
      const more = document.createElement("li");
      more.style.color = "#6a6a6a";
      more.style.cursor = "default";
      more.textContent = "+" + formatNumber(list.length - shown.length) + " more — keep typing to narrow";
      frag.appendChild(more);
    } else if (!q && state.artists.length === 0) {
      const empty = document.createElement("li");
      empty.style.color = "#6a6a6a";
      empty.style.cursor = "default";
      empty.textContent = "Loading artists…";
      frag.appendChild(empty);
    }

    els.artistList.innerHTML = "";
    els.artistList.appendChild(frag);
  }

  function renderLibrary() {
    const frag = document.createDocumentFragment();

    const items = [
      { key: "liked", label: "Liked Songs", icon: "♥" },
      { key: "recently", label: "Recently Played", icon: "↺" },
    ];

    for (const item of items) {
      const li = document.createElement("li");
      const active = state.view === item.key;
      li.className = active ? "active" : "";
      li.innerHTML = `<span class="lib-icon">${item.icon}</span><span class="lib-label">${esc(item.label)}</span>`;
      li.addEventListener("click", () => {
        if (item.key === "liked") loadLikedView();
        else if (item.key === "recently") loadRecentlyView();
        renderArtists();
        closeSidebarOnMobile();
      });
      frag.appendChild(li);
    }

    const plHeader = document.createElement("li");
    plHeader.className = "library-sub";
    plHeader.textContent = "Playlists";
    frag.appendChild(plHeader);

    for (const p of state.playlists) {
      const li = document.createElement("li");
      const active = state.view === "playlist" && state.selectedPlaylistId === p.id;
      li.className = active ? "active" : "";
      li.innerHTML = `<span class="lib-icon">▭</span><span class="lib-label">${esc(p.name)}</span><span class="lib-count">${p.trackCount}</span>`;
      li.title = `${p.name} · ${p.trackCount} tracks`;
      li.addEventListener("click", () => {
        loadPlaylistView(p.id);
        renderArtists();
        closeSidebarOnMobile();
      });
      frag.appendChild(li);
    }

    const createLi = document.createElement("li");
    createLi.className = "library-action";
    createLi.innerHTML = '<span class="lib-icon">+</span><span class="lib-label">New playlist</span>';
    createLi.addEventListener("click", async () => {
      const name = prompt("Playlist name?");
      if (name && name.trim()) {
        await createPlaylist(name.trim());
        renderLibrary();
      }
    });
    frag.appendChild(createLi);

    els.libraryList.innerHTML = "";
    els.libraryList.appendChild(frag);
  }

  function renderAzScrubber() {
    const letters = new Set();
    for (const a of state.artists) {
      const first = (a.name || "").trim().charAt(0).toUpperCase();
      if (first) letters.add(first);
    }
    const sorted = Array.from(letters).sort();
    const frag = document.createDocumentFragment();
    for (const letter of sorted) {
      const btn = document.createElement("button");
      btn.textContent = letter;
      btn.title = "Jump to " + letter;
      btn.addEventListener("click", () => jumpToArtistLetter(letter));
      frag.appendChild(btn);
    }
    els.azScrubber.innerHTML = "";
    els.azScrubber.appendChild(frag);
  }

  function jumpToArtistLetter(letter) {
    const target = Array.from(els.artistList.children).find(
      (li) => (li.textContent || "").trim().toUpperCase().startsWith(letter)
    );
    if (target) {
      target.scrollIntoView({ block: "start" });
      els.sidebar.classList.add("open");
    }
  }

  function closeSidebarOnMobile() {
    if (window.innerWidth <= 720) {
      els.sidebar.classList.remove("open");
    }
  }

  function renderMain() {
    if (state.view === "liked") return renderLiked();
    if (state.view === "playlist") return renderPlaylistViewPanel();
    if (state.view === "recently") return renderRecentlyView();
    if (state.search.trim() || state.view === "search") return renderTracks();
    if (state.selectedArtist && state.selectedAlbum) return renderTracks();
    if (state.selectedArtist) return renderAlbums();
    return renderHome();
  }

  function appendScanBadge(frag) {
    if (!state.status.scanning) return;
    const headerEl = frag.querySelector(".main-header");
    if (!headerEl) return;
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.textContent = "Indexing…";
    headerEl.appendChild(badge);
  }

  function renderHome() {
    const frag = document.createDocumentFragment();
    const header = document.createElement("div");
    header.className = "main-header";
    header.textContent = "Home";
    frag.appendChild(header);
    const summary = document.createElement("div");
    summary.className = "summary-line";
    summary.textContent =
      formatNumber(state.artists.length) +
      " artists · " +
      formatNumber(state.status.trackCount) +
      " tracks — pick an artist on the left, or search.";
    frag.appendChild(summary);

    if (state.recentlyPlayed.length) {
      const row = document.createElement("div");
      row.className = "card-row";
      const h = document.createElement("div");
      h.className = "section-title";
      h.textContent = "Jump back in";
      row.appendChild(h);
      const cards = document.createElement("div");
      cards.className = "cards";
      for (const t of state.recentlyPlayed.slice(0, 10)) {
        cards.appendChild(trackCard(t, () => playTrack(t, [t])));
      }
      row.appendChild(cards);
      frag.appendChild(row);
    }

    appendScanBadge(frag);
    els.trackPanel.innerHTML = "";
    els.trackPanel.appendChild(frag);
  }

  function trackCard(t, onClick) {
    const card = document.createElement("button");
    card.className = "track-card";
    card.appendChild(lazyArtImg(t.id, "card-art", t.title));
    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = t.title;
    const sub = document.createElement("div");
    sub.className = "card-sub";
    sub.textContent = t.artist;
    card.appendChild(title);
    card.appendChild(sub);
    card.addEventListener("click", onClick);
    return card;
  }

  function renderResumePrompt() {
    els.resumePrompt.innerHTML = "";
    if (!state.resume || !state.resume.track) return;
    const t = state.resume.track;
    const wrap = document.createElement("div");
    wrap.className = "resume-prompt";
    wrap.innerHTML = `<span>Resume <strong>${esc(t.title)}</strong> · ${esc(t.artist)} at ${formatTime(state.resume.position)}?</span>`;
    const resumeBtn = document.createElement("button");
    resumeBtn.className = "action-btn";
    resumeBtn.textContent = "Resume";
    resumeBtn.addEventListener("click", () => {
      playTrackAtOffset(t, state.resume.position || 0);
      els.resumePrompt.innerHTML = "";
    });
    const dismiss = document.createElement("button");
    dismiss.className = "btn";
    dismiss.textContent = "×";
    dismiss.addEventListener("click", () => {
      els.resumePrompt.innerHTML = "";
    });
    wrap.appendChild(resumeBtn);
    wrap.appendChild(dismiss);
    els.resumePrompt.appendChild(wrap);
  }

  function actionButton(label, icon, onClick, secondary) {
    const btn = document.createElement("button");
    btn.className = "action-btn" + (secondary ? " secondary" : "");
    btn.innerHTML = (icon ? `<span>${icon}</span>` : "") + `<span>${esc(label)}</span>`;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function sortSelect(opts, current, onChange) {
    const wrap = document.createElement("label");
    wrap.className = "sort-wrap";
    wrap.innerHTML = '<span class="sort-label">Sort</span>';
    const select = document.createElement("select");
    select.className = "sort-select";
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === current) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => onChange(select.value));
    wrap.appendChild(select);
    return wrap;
  }

  function renderAlbums() {
    const frag = document.createDocumentFragment();

    const header = document.createElement("div");
    header.className = "main-header";
    header.textContent = state.selectedArtist;
    frag.appendChild(header);

    const bar = document.createElement("div");
    bar.className = "action-bar";
    bar.appendChild(
      actionButton("Play All", "▶", async () => {
        const tracks = await loadArtistTracks(state.selectedArtist);
        if (tracks.length) playContext(tracks, false);
      })
    );
    bar.appendChild(
      actionButton("Shuffle", "⇄", async () => {
        const tracks = await loadArtistTracks(state.selectedArtist);
        if (tracks.length) playContext(tracks, true);
      }, true)
    );
    bar.appendChild(
      sortSelect(
        [
          { value: "date", label: "Date" },
          { value: "name", label: "Name" },
        ],
        state.albumSort,
        (v) => {
          state.albumSort = v;
          applyAlbumSort();
          filterAlbums();
          renderMain();
        }
      )
    );
    frag.appendChild(bar);

    const sub = document.createElement("div");
    sub.className = "summary-line";
    sub.textContent =
      formatNumber(state.albums.length) +
      (state.albums.length === 1 ? " show / album" : " shows / albums") +
      (state.albumFilter ? " — filtered to " + formatNumber(state.filteredAlbums.length) : "");
    frag.appendChild(sub);

    const filter = document.createElement("input");
    filter.className = "album-filter";
    filter.placeholder = "Filter shows by date, venue, city…";
    filter.value = state.albumFilter;
    filter.addEventListener("input", () => {
      state.albumFilter = filter.value;
      filterAlbums();
      renderMain();
    });
    frag.appendChild(filter);

    if (state.filteredAlbums.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "#b3b3b3";
      empty.style.fontSize = "13px";
      empty.textContent = state.status.scanning ? "Still indexing…" : "No shows found.";
      frag.appendChild(empty);
    } else {
      const dated = isDatedArtist();
      if (dated) {
        renderYearView(frag);
      } else {
        const listEl = document.createElement("div");
        for (const al of state.filteredAlbums) {
          listEl.appendChild(albumRow(al));
        }
        frag.appendChild(listEl);
      }
    }

    appendScanBadge(frag);
    els.trackPanel.innerHTML = "";
    els.trackPanel.appendChild(frag);
    attachYearObserver();
  }

  function albumRow(al) {
    const row = document.createElement("div");
    row.className = "album-row";
    const meta = document.createElement("div");
    meta.className = "album-meta";
    const title = document.createElement("div");
    title.className = "album-title";
    title.textContent = al.album;
    meta.appendChild(title);
    if (al.venue || al.city) {
      const sub = document.createElement("div");
      sub.className = "album-sub";
      sub.textContent = [al.date, al.venue, al.city].filter(Boolean).join(" · ");
      meta.appendChild(sub);
    }
    row.appendChild(meta);
    const count = document.createElement("span");
    count.className = "album-count";
    count.textContent = al.count;
    row.appendChild(count);
    row.addEventListener("click", () => loadAlbumTracks(state.selectedArtist, al.album));
    return row;
  }

  function renderYearView(frag) {
    const groups = new Map();
    for (const al of state.filteredAlbums) {
      const year = al.year || "Unknown";
      if (!groups.has(year)) groups.set(year, []);
      groups.get(year).push(al);
    }
    const years = Array.from(groups.keys()).sort();

    const rail = document.createElement("div");
    rail.className = "year-rail";
    const chips = document.createElement("div");
    chips.className = "year-chips";
    chips.id = "yearChips";
    for (const year of years) {
      const chip = document.createElement("button");
      chip.className = "year-chip";
      chip.textContent = year;
      chip.dataset.year = year;
      chip.addEventListener("click", () => {
        const header = document.getElementById("year-" + year);
        if (header) header.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      chips.appendChild(chip);
    }
    rail.appendChild(chips);
    frag.appendChild(rail);

    const container = document.createElement("div");
    container.id = "yearSections";
    for (const year of years) {
      const section = document.createElement("div");
      section.className = "year-section";
      section.dataset.year = year;
      const header = document.createElement("div");
      header.className = "year-header";
      header.id = "year-" + year;
      const count = groups.get(year).length;
      header.innerHTML = `<span>${year} — ${count} show${count === 1 ? "" : "s"}</span><span class="chevron">▼</span>`;
      header.addEventListener("click", () => {
        section.classList.toggle("collapsed");
        header.classList.toggle("collapsed");
      });
      section.appendChild(header);
      for (const al of groups.get(year)) {
        section.appendChild(albumRow(al));
      }
      container.appendChild(section);
    }
    frag.appendChild(container);
  }

  let yearObserver = null;
  function attachYearObserver() {
    if (yearObserver) yearObserver.disconnect();
    const headers = document.querySelectorAll(".year-header");
    if (!headers.length) return;
    yearObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const year = entry.target.id.replace("year-", "");
            document.querySelectorAll(".year-chip").forEach((c) => {
              c.classList.toggle("active", c.dataset.year === year);
            });
          }
        });
      },
      { root: els.main, rootMargin: "-40px 0px -80% 0px", threshold: 0 }
    );
    headers.forEach((h) => yearObserver.observe(h));
  }

  function renderLiked() {
    const frag = document.createDocumentFragment();
    const header = document.createElement("div");
    header.className = "main-header";
    header.textContent = "Liked Songs";
    frag.appendChild(header);
    frag.appendChild(buildTrackSortBar());
    frag.appendChild(buildTrackTable(state.tracks, true, false));
    appendScanBadge(frag);
    els.trackPanel.innerHTML = "";
    els.trackPanel.appendChild(frag);
  }

  function renderPlaylistViewPanel() {
    const frag = document.createDocumentFragment();
    const back = document.createElement("div");
    back.className = "back-link";
    back.textContent = "← Your Library";
    back.addEventListener("click", () => {
      state.view = "home";
      state.selectedPlaylistId = null;
      renderMain();
    });
    frag.appendChild(back);

    const header = document.createElement("div");
    header.className = "main-header";
    header.textContent = state.playlistName || "Playlist";
    frag.appendChild(header);

    const bar = document.createElement("div");
    bar.className = "action-bar";
    if (state.tracks.length) {
      bar.appendChild(actionButton("Play", "▶", () => playContext(state.tracks, false)));
      bar.appendChild(actionButton("Shuffle", "⇄", () => playContext(state.tracks, true), true));
    }
    bar.appendChild(
      actionButton("Rename", "✎", async () => {
        const name = prompt("Rename playlist?", state.playlistName || "");
        if (name && name.trim()) {
          await renamePlaylist(state.selectedPlaylistId, name.trim());
          state.playlistName = name.trim();
          renderMain();
        }
      }, true)
    );
    bar.appendChild(
      actionButton("Delete", "🗑", async () => {
        if (confirm("Delete this playlist?")) await deletePlaylist(state.selectedPlaylistId);
      }, true)
    );
    frag.appendChild(bar);

    frag.appendChild(buildTrackSortBar());
    frag.appendChild(buildTrackTable(state.tracks, true, true));
    appendScanBadge(frag);
    els.trackPanel.innerHTML = "";
    els.trackPanel.appendChild(frag);
  }

  function renderRecentlyView() {
    const frag = document.createDocumentFragment();
    const header = document.createElement("div");
    header.className = "main-header";
    header.textContent = "Recently Played";
    frag.appendChild(header);
    frag.appendChild(buildTrackTable(state.tracks, false, false));
    appendScanBadge(frag);
    els.trackPanel.innerHTML = "";
    els.trackPanel.appendChild(frag);
  }

  function buildTrackSortBar() {
    const bar = document.createElement("div");
    bar.className = "sort-bar";
    bar.appendChild(
      sortSelect(
        [
          { value: "trackNo", label: "Track #" },
          { value: "title", label: "Title" },
        ],
        state.trackSort,
        (v) => {
          state.trackSort = v;
          applyTrackSort();
          renderMain();
        }
      )
    );
    return bar;
  }

  function renderTracks() {
    const tracks = state.tracks;
    const isSearch = state.view === "search";
    const inAlbum = state.view === "album";
    const inLiked = state.view === "liked";
    const inPlaylist = state.view === "playlist";
    const frag = document.createDocumentFragment();

    if (inAlbum) {
      const back = document.createElement("div");
      back.className = "back-link";
      back.textContent = "← " + state.selectedArtist;
      back.addEventListener("click", () => loadArtistAlbums(state.selectedArtist));
      frag.appendChild(back);
    }

    const header = document.createElement("div");
    header.className = "main-header";
    if (isSearch) header.textContent = 'Search: "' + state.search.trim() + '"';
    else if (state.selectedAlbum) header.textContent = state.selectedAlbum;
    else header.textContent = state.selectedArtist || "Library";
    frag.appendChild(header);

    if (inAlbum) {
      const bar = document.createElement("div");
      bar.className = "action-bar";
      bar.appendChild(actionButton("Play Show", "▶", () => playContext(state.tracks, false)));
      bar.appendChild(actionButton("Shuffle Show", "⇄", () => playContext(state.tracks, true), true));
      frag.appendChild(bar);
    }

    frag.appendChild(buildTrackSortBar());
    frag.appendChild(buildTrackTable(tracks, true, inPlaylist));
    appendScanBadge(frag);
    els.trackPanel.innerHTML = "";
    els.trackPanel.appendChild(frag);
  }

  function buildTrackTable(tracks, showLike, allowPlaylistRemove) {
    const inAlbum = state.view === "album";
    const isSearch = state.view === "search";
    const frag = document.createDocumentFragment();

    if (tracks.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "#b3b3b3";
      empty.style.fontSize = "13px";
      empty.textContent = state.status.scanning ? "No matches yet — still indexing…" : "No tracks found.";
      frag.appendChild(empty);
      return frag;
    }

    const limit = 500;
    const toShow = tracks.slice(0, limit);

    const table = document.createElement("table");
    table.className = "track-table";
    const thead = document.createElement("thead");
    thead.innerHTML = '<tr><th class="col-art"></th><th>#</th><th>Title</th><th>Artist</th><th>Album</th><th></th><th></th><th></th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement("tbody");

    toShow.forEach((t, i) => {
      const tr = document.createElement("tr");
      if (state.currentTrack && state.currentTrack.id === t.id) tr.classList.add("playing");
      const dur = t.duration ? formatTime(t.duration) : "--:--";
      const num = inAlbum && t.trackNo ? t.trackNo : i + 1;
      const badge = qualityBadge(t);
      const liked = state.likedIds.has(t.id);

      const artTd = document.createElement("td");
      artTd.className = "col-art";
      artTd.appendChild(lazyArtImg(t.id, "row-art", t.title));

      const heartTd = document.createElement("td");
      heartTd.className = "col-heart";
      const heart = document.createElement("button");
      heart.className = "heart-btn" + (liked ? " liked" : "");
      heart.innerHTML = liked ? "♥" : "♡";
      heart.title = liked ? "Unlike" : "Like";
      heart.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleLiked(t.id);
      });
      heartTd.appendChild(heart);

      const actionTd = document.createElement("td");
      actionTd.className = "col-action";
      actionTd.appendChild(trackActionMenu(t, allowPlaylistRemove));

      tr.appendChild(artTd);
      tr.innerHTML +=
        "<td>" +
        num +
        "</td><td>" +
        esc(t.title) +
        badge +
        "</td><td>" +
        esc(t.artist) +
        "</td><td>" +
        esc(t.album) +
        "</td><td>" +
        dur +
        "</td>";
      tr.appendChild(heartTd);
      tr.appendChild(actionTd);
      tr.addEventListener("click", () => playTrack(t, tracks));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    frag.appendChild(table);

    const total = state.viewTotal || tracks.length;
    if (total > toShow.length) {
      const note = document.createElement("div");
      note.style.color = "#b3b3b3";
      note.style.fontSize = "12px";
      note.style.marginTop = "8px";
      note.textContent =
        "Showing first " + toShow.length + " of " + formatNumber(total) +
        (isSearch ? " matches — refine your search." : " tracks.");
      frag.appendChild(note);
    }
    return frag;
  }

  function trackActionMenu(t, allowPlaylistRemove) {
    const wrap = document.createElement("div");
    wrap.className = "track-menu-wrap";
    const btn = document.createElement("button");
    btn.className = "track-menu-btn";
    btn.innerHTML = "⋮";
    btn.title = "More";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const existing = document.querySelector(".track-menu");
      if (existing) existing.remove();
      const menu = document.createElement("div");
      menu.className = "track-menu";

      if (allowPlaylistRemove && state.selectedPlaylistId) {
        const remove = document.createElement("button");
        remove.textContent = "Remove from playlist";
        remove.addEventListener("click", async (ev) => {
          ev.stopPropagation();
          await removeFromPlaylist(state.selectedPlaylistId, t.id);
          menu.remove();
        });
        menu.appendChild(remove);
      }

      const add = document.createElement("button");
      add.textContent = "Add to playlist";
      add.addEventListener("click", (ev) => {
        ev.stopPropagation();
        menu.innerHTML = "";
        if (!state.playlists.length) {
          const none = document.createElement("div");
          none.className = "menu-note";
          none.textContent = "No playlists yet";
          menu.appendChild(none);
        }
        for (const p of state.playlists) {
          const item = document.createElement("button");
          item.textContent = p.name;
          item.addEventListener("click", async (evt) => {
            evt.stopPropagation();
            await addToPlaylist(p.id, t.id);
            menu.remove();
          });
          menu.appendChild(item);
        }
        const newPl = document.createElement("button");
        newPl.textContent = "+ New playlist";
        newPl.addEventListener("click", async (evt) => {
          evt.stopPropagation();
          const name = prompt("Playlist name?");
          if (name && name.trim()) {
            const created = await createPlaylist(name.trim());
            await addToPlaylist(created.id, t.id);
          }
          menu.remove();
        });
        menu.appendChild(newPl);
      });
      menu.appendChild(add);

      const queueNext = document.createElement("button");
      queueNext.textContent = "Play next";
      queueNext.addEventListener("click", (ev) => {
        ev.stopPropagation();
        addToQueueNext(t);
        menu.remove();
      });
      menu.appendChild(queueNext);

      wrap.appendChild(menu);
      document.addEventListener(
        "click",
        function closeMenu() {
          menu.remove();
          document.removeEventListener("click", closeMenu);
        },
        { once: true }
      );
    });
    wrap.appendChild(btn);
    return wrap;
  }

  // --- Player core ---
  function getStreamUrl(id, quality, offset) {
    let url = "stream/" + id;
    const params = [];
    if (quality && quality !== "original") params.push("q=" + encodeURIComponent(quality));
    if (offset && offset > 0) params.push("t=" + encodeURIComponent(offset));
    if (params.length) url += "?" + params.join("&");
    return url;
  }

  function playContext(tracks, shuffle) {
    if (!tracks.length) return;
    state.contextQueue = tracks.slice();
    state.shuffle = shuffle;
    updateShuffleRepeatUI();
    rebuildQueue();
    state.queueIndex = 0;
    playTrack(state.queue[0], state.queue);
  }

  function rebuildQueue() {
    if (!state.contextQueue.length) {
      state.queue = [];
      return;
    }
    if (state.shuffle) {
      const current = state.currentTrack;
      const rest = state.contextQueue.filter((t) => !current || t.id !== current.id);
      for (let i = rest.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      state.queue = current ? [current, ...rest] : rest;
      if (current) state.queueIndex = 0;
    } else {
      state.queue = state.contextQueue.slice();
    }
  }

  function addToQueueNext(track) {
    const idx = state.queueIndex + 1;
    state.queue.splice(idx, 0, track);
    renderQueuePanel();
  }

  function removeFromQueue(index) {
    if (index < 0 || index >= state.queue.length) return;
    state.queue.splice(index, 1);
    if (index < state.queueIndex) state.queueIndex -= 1;
    if (index === state.queueIndex) {
      // removed currently playing track — advance
      if (state.queue[state.queueIndex]) playTrack(state.queue[state.queueIndex], state.queue);
      else if (state.queue.length) {
        state.queueIndex = Math.max(0, state.queueIndex - 1);
        playTrack(state.queue[state.queueIndex], state.queue);
      } else {
        state.currentTrack = null;
        state.isPlaying = false;
        activeAudio().pause();
        activeAudio().src = "";
      }
    }
    updatePlayerUI();
    renderMain();
    renderQueuePanel();
  }

  function moveQueueItem(oldIndex, newIndex) {
    if (oldIndex === newIndex) return;
    const item = state.queue.splice(oldIndex, 1)[0];
    state.queue.splice(newIndex, 0, item);
    if (oldIndex < state.queueIndex && newIndex >= state.queueIndex) state.queueIndex -= 1;
    else if (oldIndex > state.queueIndex && newIndex <= state.queueIndex) state.queueIndex += 1;
    else if (oldIndex === state.queueIndex) state.queueIndex = newIndex;
    renderQueuePanel();
  }

  function activeAudio() {
    return audioPool[state.activeAudioIdx];
  }

  function nextAudio() {
    return audioPool[(state.activeAudioIdx + 1) % audioPool.length];
  }

  function swapAudio() {
    state.activeAudioIdx = (state.activeAudioIdx + 1) % audioPool.length;
  }

  function playTrack(track, queue) {
    if (!track) return;
    if (queue && queue !== state.queue) {
      state.contextQueue = queue.slice();
      state.queue = queue.slice();
      state.shuffle = false;
      updateShuffleRepeatUI();
    }
    state.queueIndex = state.queue.findIndex((t) => t.id === track.id);
    if (state.queueIndex < 0) {
      state.queue = [track];
      state.contextQueue = [track];
      state.queueIndex = 0;
      state.shuffle = false;
      updateShuffleRepeatUI();
    }
    state.currentTrack = track;
    state.streamBaseOffset = 0;

    const audio = activeAudio();
    audio.src = getStreamUrl(track.id, state.quality, 0);
    audio.volume = state.volume;
    audio.play().catch(() => {});
    state.isPlaying = true;
    updatePlayerUI();
    renderMain();
    closeSidebarOnMobile();
    preloadNext();
    updateMediaSession();
    logPlayEvent(track.id, 0);
  }

  function preloadNext() {
    const next = getNextTrack(false);
    const audio = nextAudio();
    if (next && audio) {
      audio.preload = "auto";
      audio.src = getStreamUrl(next.id, state.quality, 0);
      audio.volume = state.volume;
      audio.load();
    }
  }

  function getNextTrack(advance) {
    if (!state.queue.length) return null;
    if (state.repeat === "one") return state.currentTrack;
    const idx = state.queueIndex + (advance ? 1 : 1);
    if (idx < state.queue.length) return state.queue[idx];
    if (state.repeat === "all") return state.queue[0];
    return null;
  }

  function getPrevTrack() {
    if (!state.queue.length) return null;
    if (state.repeat === "one") return state.currentTrack;
    const idx = state.queueIndex - 1;
    if (idx >= 0) return state.queue[idx];
    if (state.repeat === "all") return state.queue[state.queue.length - 1];
    return null;
  }

  function advanceToNext() {
    if (state.repeat === "one") {
      const audio = activeAudio();
      audio.currentTime = 0;
      audio.play().catch(() => {});
      return;
    }
    const upcoming = nextAudio();
    const expected = getNextTrack(false);
    if (upcoming && upcoming.src && expected && upcoming.src.includes("/stream/" + expected.id)) {
      swapAudio();
      state.queueIndex = (state.queueIndex + 1) % state.queue.length;
      state.currentTrack = state.queue[state.queueIndex];
      state.streamBaseOffset = 0;
      activeAudio().play().catch(() => {});
    } else {
      const next = getNextTrack(true);
      if (next) {
        state.queueIndex += 1;
        playTrack(next, state.queue);
        return;
      } else {
        state.isPlaying = false;
        updatePlayerUI();
        updateMediaSession();
        return;
      }
    }
    state.isPlaying = true;
    updatePlayerUI();
    renderMain();
    renderQueuePanel();
    preloadNext();
    updateMediaSession();
    if (state.currentTrack) logPlayEvent(state.currentTrack.id, 0);
  }

  function togglePlay() {
    const audio = activeAudio();
    if (!audio.src) return;
    if (state.isPlaying) audio.pause();
    else audio.play().catch(() => {});
  }

  function prevTrack() {
    const t = getPrevTrack();
    if (t) playTrack(t, state.queue);
  }

  function nextTrack() {
    const t = getNextTrack(true);
    if (t) playTrack(t, state.queue);
    else state.isPlaying = false;
    updatePlayerUI();
  }

  function effectiveTime() {
    return state.streamBaseOffset + (activeAudio().currentTime || 0);
  }

  function seekTo(e) {
    const rect = els.progressWrap.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const track = state.currentTrack;
    if (!track) return;

    if (state.quality === "original") {
      const audio = activeAudio();
      if (audio.duration && isFinite(audio.duration)) {
        audio.currentTime = ratio * audio.duration;
      }
    } else {
      if (!track.duration) return;
      const target = ratio * track.duration;
      playTrackAtOffset(track, target);
    }
  }

  function seekBy(delta) {
    const track = state.currentTrack;
    if (!track) return;
    const audio = activeAudio();
    if (state.quality === "original") {
      audio.currentTime = Math.max(0, Math.min(audio.duration || Infinity, audio.currentTime + delta));
    } else {
      playTrackAtOffset(track, Math.max(0, Math.min(track.duration || Infinity, effectiveTime() + delta)));
    }
  }

  function playTrackAtOffset(track, offset) {
    const audio = activeAudio();
    state.currentTrack = track;
    state.streamBaseOffset = offset;
    audio.src = getStreamUrl(track.id, state.quality, offset);
    audio.volume = state.volume;
    audio.play().catch(() => {});
    state.isPlaying = true;
    updatePlayerUI();
    updateMediaSession();
    preloadNext();
  }

  function applyQuality() {
    const track = state.currentTrack;
    if (!track) return;
    const wasPlaying = state.isPlaying;
    const eff = effectiveTime();

    if (state.quality === "original") {
      activeAudio().src = getStreamUrl(track.id, "original", 0);
      state.streamBaseOffset = 0;
      activeAudio().addEventListener("loadedmetadata", function onMeta() {
        activeAudio().removeEventListener("loadedmetadata", onMeta);
        if (eff > 0 && activeAudio().duration && isFinite(activeAudio().duration)) {
          activeAudio().currentTime = Math.min(eff, activeAudio().duration);
        }
        if (wasPlaying) activeAudio().play().catch(() => {});
      });
      if (!wasPlaying) activeAudio().load();
    } else {
      playTrackAtOffset(track, eff);
      return;
    }
    updatePlayerUI();
    preloadNext();
  }

  function updatePlayerUI() {
    const t = state.currentTrack;
    if (!t) {
      els.playerTitle.textContent = "—";
      els.playerArtist.textContent = "—";
      els.playerQuality.innerHTML = "";
      els.btnHeart.style.display = "none";
      els.artWrap.innerHTML =
        '<svg class="art-placeholder" viewBox="0 0 24 24" fill="#b3b3b3"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
      return;
    }
    els.playerTitle.textContent = t.title;
    els.playerArtist.textContent = t.artist;
    els.playerQuality.innerHTML = qualityBadge(t);
    els.btnHeart.style.display = "";
    updateHeartUI();
    els.iconPlay.style.display = state.isPlaying ? "none" : "";
    els.iconPause.style.display = state.isPlaying ? "" : "none";
    const img = document.createElement("img");
    img.src = "art/" + t.id;
    img.onerror = function () {
      els.artWrap.innerHTML =
        '<svg class="art-placeholder" viewBox="0 0 24 24" fill="#b3b3b3"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
    };
    els.artWrap.innerHTML = "";
    els.artWrap.appendChild(img);
  }

  function updateHeartUI() {
    const t = state.currentTrack;
    if (!t) return;
    const liked = state.likedIds.has(t.id);
    els.btnHeart.innerHTML = liked ? "♥" : "♡";
    els.btnHeart.classList.toggle("liked", liked);
    els.btnHeart.title = liked ? "Unlike" : "Like";
  }

  function updateShuffleRepeatUI() {
    els.btnShuffle.classList.toggle("active", state.shuffle);
    const icons = { off: "↻", all: "⇉", one: "⇉1" };
    els.btnRepeat.textContent = icons[state.repeat] || "↻";
    els.btnRepeat.classList.toggle("active", state.repeat !== "off");
  }

  // --- Queue panel ---
  function toggleQueuePanel() {
    state.queuePanelOpen = !state.queuePanelOpen;
    els.queuePanel.classList.toggle("open", state.queuePanelOpen);
    if (state.queuePanelOpen) renderQueuePanel();
  }

  function renderQueuePanel() {
    els.queueList.innerHTML = "";
    if (!state.queue.length) {
      els.queueList.innerHTML = '<div class="queue-empty">Queue is empty.</div>';
      return;
    }
    state.queue.forEach((t, i) => {
      const row = document.createElement("div");
      row.className = "queue-row" + (i === state.queueIndex ? " current" : "");
      row.draggable = true;
      row.dataset.index = i;
      row.appendChild(lazyArtImg(t.id, "queue-art", t.title));
      const meta = document.createElement("div");
      meta.className = "queue-meta";
      const title = document.createElement("div");
      title.className = "queue-title";
      title.textContent = t.title;
      const sub = document.createElement("div");
      sub.className = "queue-sub";
      sub.textContent = t.artist;
      meta.appendChild(title);
      meta.appendChild(sub);
      row.appendChild(meta);
      const remove = document.createElement("button");
      remove.className = "queue-remove";
      remove.innerHTML = "×";
      remove.title = "Remove";
      remove.addEventListener("click", (e) => {
        e.stopPropagation();
        removeFromQueue(i);
      });
      row.appendChild(remove);

      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", String(i));
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
        moveQueueItem(from, i);
      });
      row.addEventListener("click", () => playTrack(t, state.queue));
      els.queueList.appendChild(row);
    });
  }

  // --- Sleep timer ---
  function setSleepTimer(minutes) {
    if (state.sleepTimer) {
      clearTimeout(state.sleepTimer.timerId);
      state.sleepTimer = null;
    }
    if (!minutes) {
      els.btnSleep.classList.remove("active");
      els.btnSleep.title = "Sleep timer";
      return;
    }
    const until = Date.now() + minutes * 60 * 1000;
    const timerId = setTimeout(() => {
      state.sleepTimer = null;
      els.btnSleep.classList.remove("active");
      if (state.isPlaying) activeAudio().pause();
    }, minutes * 60 * 1000);
    state.sleepTimer = { until, timerId };
    els.btnSleep.classList.add("active");
    els.btnSleep.title = `Sleep timer: ${minutes} min`;
  }

  function updateSleepLabel() {
    if (!state.sleepTimer) return;
    const remaining = Math.max(0, Math.ceil((state.sleepTimer.until - Date.now()) / 60000));
    els.btnSleep.title = `Sleep timer: ${remaining} min remaining`;
    if (remaining <= 0) {
      els.btnSleep.classList.remove("active");
      state.sleepTimer = null;
    }
  }
  setInterval(updateSleepLabel, 60000);

  // --- MediaSession ---
  function artworkForTrack(track) {
    if (!track) return [];
    const base = location.origin + "/art/" + track.id;
    return [
      { src: base, sizes: "96x96", type: "image/jpeg" },
      { src: base, sizes: "256x256", type: "image/jpeg" },
      { src: base, sizes: "512x512", type: "image/jpeg" },
    ];
  }

  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;
    const t = state.currentTrack;
    navigator.mediaSession.metadata = t
      ? new MediaMetadata({
          title: t.title,
          artist: t.artist,
          album: t.album,
          artwork: artworkForTrack(t),
        })
      : new MediaMetadata({});
    setPositionState();
  }

  function setPositionState() {
    if (!("mediaSession" in navigator) || !("setPositionState" in navigator.mediaSession)) return;
    const audio = activeAudio();
    const track = state.currentTrack;
    if (!track || !audio.duration || !isFinite(audio.duration)) {
      try {
        navigator.mediaSession.setPositionState();
      } catch (e) {}
      return;
    }
    let duration = audio.duration;
    let position = audio.currentTime;
    if (state.quality !== "original") {
      duration = track.duration || 0;
      position = effectiveTime();
    }
    try {
      navigator.mediaSession.setPositionState({
        duration: Math.max(0, duration),
        position: Math.max(0, Math.min(position, duration)),
        playbackRate: audio.playbackRate || 1,
      });
    } catch (e) {}
  }

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.setActionHandler("play", () => togglePlay());
    navigator.mediaSession.setActionHandler("pause", () => togglePlay());
    navigator.mediaSession.setActionHandler("previoustrack", () => prevTrack());
    navigator.mediaSession.setActionHandler("nexttrack", () => nextTrack());
    navigator.mediaSession.setActionHandler("seekbackward", (details) => {
      const audio = activeAudio();
      const delta = details.seekOffset || 10;
      audio.currentTime = Math.max(0, audio.currentTime - delta);
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      const audio = activeAudio();
      const delta = details.seekOffset || 10;
      audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + delta);
    });
    navigator.mediaSession.setActionHandler("seekto", (details) => {
      if (details.seekTime == null) return;
      const audio = activeAudio();
      if (state.quality === "original") {
        audio.currentTime = details.seekTime;
      } else {
        const track = state.currentTrack;
        if (track) playTrackAtOffset(track, details.seekTime);
      }
    });
  }

  // --- Keyboard shortcuts ---
  function handleKey(e) {
    const target = e.target;
    const typing =
      target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

    if (e.key === "/" && !typing) {
      e.preventDefault();
      els.searchBox.focus();
      return;
    }
    if (e.key === " " && !typing) {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.key === "ArrowLeft" && !typing) {
      e.preventDefault();
      if (e.shiftKey) prevTrack();
      else seekBy(-10);
      return;
    }
    if (e.key === "ArrowRight" && !typing) {
      e.preventDefault();
      if (e.shiftKey) nextTrack();
      else seekBy(10);
      return;
    }
  }
  document.addEventListener("keydown", handleKey);

  // --- Events ---
  audioPool.forEach((audio) => {
    audio.addEventListener("play", () => {
      if (audio === activeAudio()) {
        state.isPlaying = true;
        updatePlayerUI();
      }
    });
    audio.addEventListener("pause", () => {
      if (audio === activeAudio()) {
        state.isPlaying = false;
        updatePlayerUI();
      }
    });
    audio.addEventListener("timeupdate", () => {
      if (audio !== activeAudio()) return;
      const current = effectiveTime();
      els.timeCurrent.textContent = formatTime(current);
      const track = state.currentTrack;
      let total = 0;
      let pct = 0;
      if (state.quality === "original") {
        total = audio.duration || 0;
        pct = total && isFinite(total) ? (audio.currentTime / total) * 100 : 0;
      } else {
        total = track && track.duration ? track.duration : 0;
        pct = total && isFinite(total) ? (current / total) * 100 : 0;
      }
      els.timeTotal.textContent = total ? formatTime(total) : "--:--";
      els.progressFill.style.width = pct + "%";
      setPositionState();
      if (track && Math.floor(current) % 5 === 0) {
        logPlayEvent(track.id, current);
      }
    });
    audio.addEventListener("loadedmetadata", () => {
      if (audio !== activeAudio()) return;
      const track = state.currentTrack;
      if (state.quality === "original") {
        els.timeTotal.textContent = formatTime(audio.duration);
      } else {
        els.timeTotal.textContent = track && track.duration ? formatTime(track.duration) : "--:--";
      }
      setPositionState();
    });
    audio.addEventListener("ended", () => {
      if (audio === activeAudio()) advanceToNext();
    });
    audio.addEventListener("error", () => {
      if (audio !== activeAudio()) return;
      els.playerNotice.textContent = "Playback error";
      setTimeout(() => (els.playerNotice.textContent = ""), 3000);
    });
  });

  els.btnPlay.addEventListener("click", togglePlay);
  els.btnPrev.addEventListener("click", prevTrack);
  els.btnNext.addEventListener("click", nextTrack);
  els.progressWrap.addEventListener("click", seekTo);

  els.btnHeart.addEventListener("click", () => {
    const t = state.currentTrack;
    if (t) toggleLiked(t.id);
  });

  els.btnQueue.addEventListener("click", toggleQueuePanel);
  els.btnCloseQueue.addEventListener("click", toggleQueuePanel);

  els.btnSleep.addEventListener("click", (e) => {
    e.stopPropagation();
    els.sleepMenu.classList.toggle("open");
  });
  els.sleepMenu.addEventListener("click", (e) => {
    if (!e.target.matches("button[data-min]")) return;
    e.stopPropagation();
    setSleepTimer(parseInt(e.target.dataset.min, 10));
    els.sleepMenu.classList.remove("open");
  });
  document.addEventListener("click", (e) => {
    if (!els.sleepWrap.contains(e.target)) els.sleepMenu.classList.remove("open");
  });

  els.btnShuffle.addEventListener("click", () => {
    state.shuffle = !state.shuffle;
    const current = state.currentTrack;
    rebuildQueue();
    if (current) {
      state.queueIndex = state.queue.findIndex((t) => t.id === current.id);
    }
    updateShuffleRepeatUI();
    renderQueuePanel();
    try { localStorage.setItem("shmearify-shuffle", state.shuffle ? "1" : "0"); } catch (e) {}
  });

  els.btnRepeat.addEventListener("click", () => {
    const modes = ["off", "all", "one"];
    state.repeat = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
    updateShuffleRepeatUI();
    try { localStorage.setItem("shmearify-repeat", state.repeat); } catch (e) {}
  });

  els.volumeSlider.addEventListener("input", () => {
    state.volume = parseFloat(els.volumeSlider.value);
    audioPool.forEach((a) => (a.volume = state.volume));
    try { localStorage.setItem("shmearify-volume", String(state.volume)); } catch (e) {}
  });

  let debounceTimer;
  els.searchBox.addEventListener("input", () => {
    renderArtists();
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      runSearch(els.searchBox.value);
    }, 250);
  });

  els.mobileToggle.addEventListener("click", () => {
    els.sidebar.classList.toggle("open");
  });
  document.addEventListener("click", (e) => {
    if (
      window.innerWidth <= 720 &&
      els.sidebar.classList.contains("open") &&
      !els.sidebar.contains(e.target) &&
      e.target !== els.mobileToggle
    ) {
      els.sidebar.classList.remove("open");
    }
  });

  els.qualitySelect.addEventListener("change", () => {
    state.quality = els.qualitySelect.value;
    try { localStorage.setItem("shmearify-quality", state.quality); } catch (e) {}
    applyQuality();
  });

  // --- Init ---
  try {
    const savedQuality = localStorage.getItem("shmearify-quality");
    if (savedQuality && ["original", "high", "normal", "low"].includes(savedQuality)) {
      state.quality = savedQuality;
      els.qualitySelect.value = savedQuality;
    }
    const savedVolume = localStorage.getItem("shmearify-volume");
    if (savedVolume != null) {
      state.volume = parseFloat(savedVolume);
      els.volumeSlider.value = state.volume;
      audioPool.forEach((a) => (a.volume = state.volume));
    }
    const savedShuffle = localStorage.getItem("shmearify-shuffle");
    if (savedShuffle != null) state.shuffle = savedShuffle === "1";
    const savedRepeat = localStorage.getItem("shmearify-repeat");
    if (savedRepeat && ["off", "all", "one"].includes(savedRepeat)) state.repeat = savedRepeat;
  } catch (e) {}
  updateShuffleRepeatUI();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  setupMediaSession();
  pollStatus();
})();
