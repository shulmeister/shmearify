/**
 * Shmearify client — Phase 1
 * PWA, catalog navigation, artist canonicalization display, audio-quality badges,
 * gapless dual-audio player, MediaSession, shuffle/repeat/volume.
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
  };

  const audioPool = [new Audio(), new Audio()];
  audioPool.forEach((a) => (a.preload = "metadata"));

  const els = {
    artistList: document.getElementById("artistList"),
    azScrubber: document.getElementById("azScrubber"),
    main: document.getElementById("main"),
    trackPanel: document.getElementById("trackPanel"),
    searchBox: document.getElementById("searchBox"),
    btnPlay: document.getElementById("btnPlay"),
    btnPrev: document.getElementById("btnPrev"),
    btnNext: document.getElementById("btnNext"),
    btnShuffle: document.getElementById("btnShuffle"),
    btnRepeat: document.getElementById("btnRepeat"),
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

  async function fetchJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status + " " + r.statusText);
    return r.json();
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
      await loadArtists();
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
    if (state.search.trim()) {
      runSearch(state.search, true);
    } else if (state.selectedArtist && state.selectedAlbum) {
      loadAlbumTracks(state.selectedArtist, state.selectedAlbum, true);
    } else if (state.selectedArtist) {
      loadArtistAlbums(state.selectedArtist, true);
    }
  }

  // --- Catalog loading ---
  async function loadArtistAlbums(name, silent) {
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
    state.selectedArtist = artist;
    state.selectedAlbum = album;
    try {
      state.tracks = await fetchJson(
        "api/album-tracks?artist=" + encodeURIComponent(artist) + "&album=" + encodeURIComponent(album)
      );
      state.viewTotal = state.tracks.length;
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

  let searchSeq = 0;
  async function runSearch(q, silent) {
    state.search = q;
    if (!silent) {
      state.selectedArtist = null;
      state.selectedAlbum = null;
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
      if (!state.selectedArtist) home.classList.add("active");
      home.addEventListener("click", () => {
        state.selectedArtist = null;
        state.selectedAlbum = null;
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
      if (state.selectedArtist === a.name) li.classList.add("active");
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
    if (state.search.trim()) return renderTracks();
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
    appendScanBadge(frag);
    els.trackPanel.innerHTML = "";
    els.trackPanel.appendChild(frag);
  }

  function actionButton(label, icon, onClick, secondary) {
    const btn = document.createElement("button");
    btn.className = "action-btn" + (secondary ? " secondary" : "");
    btn.innerHTML = (icon ? `<span>${icon}</span>` : "") + `<span>${esc(label)}</span>`;
    btn.addEventListener("click", onClick);
    return btn;
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

  function renderTracks() {
    const tracks = state.tracks;
    const isSearch = !!state.search.trim();
    const inAlbum = !isSearch && state.selectedArtist && state.selectedAlbum;
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
      bar.appendChild(
        actionButton("Play Show", "▶", () => playContext(state.tracks, false))
      );
      bar.appendChild(
        actionButton("Shuffle Show", "⇄", () => playContext(state.tracks, true), true)
      );
      frag.appendChild(bar);
    }

    if (tracks.length === 0) {
      const empty = document.createElement("div");
      empty.style.color = "#b3b3b3";
      empty.style.fontSize = "13px";
      empty.textContent = state.status.scanning ? "No matches yet — still indexing…" : "No tracks found.";
      frag.appendChild(empty);
    } else {
      const limit = 500;
      const toShow = tracks.slice(0, limit);

      const table = document.createElement("table");
      table.className = "track-table";
      const thead = document.createElement("thead");
      thead.innerHTML = '<tr><th>#</th><th>Title</th><th>Artist</th><th>Album</th><th></th></tr>';
      table.appendChild(thead);
      const tbody = document.createElement("tbody");

      toShow.forEach((t, i) => {
        const tr = document.createElement("tr");
        if (state.currentTrack && state.currentTrack.id === t.id) tr.classList.add("playing");
        const dur = t.duration ? formatTime(t.duration) : "--:--";
        const num = inAlbum && t.trackNo ? t.trackNo : i + 1;
        const badge = qualityBadge(t);
        tr.innerHTML =
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
    }

    appendScanBadge(frag);
    els.trackPanel.innerHTML = "";
    els.trackPanel.appendChild(frag);
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
      // Fisher-Yates shuffle
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
    // Update context if a new queue is supplied and differs from current context.
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
    preloadNext();
    updateMediaSession();
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
      els.artWrap.innerHTML =
        '<svg class="art-placeholder" viewBox="0 0 24 24" fill="#b3b3b3"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
      return;
    }
    els.playerTitle.textContent = t.title;
    els.playerArtist.textContent = t.artist;
    els.playerQuality.innerHTML = qualityBadge(t);
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

  function updateShuffleRepeatUI() {
    els.btnShuffle.classList.toggle("active", state.shuffle);
    const icons = { off: "↻", all: "⇉", one: "⇉1" };
    els.btnRepeat.textContent = icons[state.repeat] || "↻";
    els.btnRepeat.classList.toggle("active", state.repeat !== "off");
  }

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

  els.btnShuffle.addEventListener("click", () => {
    state.shuffle = !state.shuffle;
    const current = state.currentTrack;
    rebuildQueue();
    if (current) {
      state.queueIndex = state.queue.findIndex((t) => t.id === current.id);
    }
    updateShuffleRepeatUI();
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
