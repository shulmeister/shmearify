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
    pendingOriginalSeek: null, // seek target to apply after original-quality metadata loads

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
    homeFilter: "all",    // all | music | artists | albums

    // Output / casting state
    castSdkLoaded: false,
    castAvailable: false,
    castSession: null,
    audioSinkId: "",
    audioOutputDevices: [],
  };

  const audioPool = [new Audio(), new Audio()];
  audioPool.forEach((a) => {
    a.preload = "metadata";
    a.setAttribute("x-webkit-airplay", "allow");
  });

  const els = {
    artistList: document.getElementById("artistList"),
    libraryList: document.getElementById("libraryList"),
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
    btnCloseQueue: document.getElementById("btnCloseQueue"),
    btnSleep: document.getElementById("btnSleep"),
    sleepWrap: document.getElementById("sleepWrap"),
    sleepMenu: document.getElementById("sleepMenu"),
    outputWrap: document.getElementById("outputWrap"),
    btnOutput: document.getElementById("btnOutput"),
    outputMenu: document.getElementById("outputMenu"),
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
    sidebar: document.getElementById("sidebar"),
    qualitySelect: document.getElementById("qualitySelect"),
    volumeSlider: document.getElementById("volumeSlider"),
    queuePanel: document.getElementById("queuePanel"),
    queueList: document.getElementById("queueList"),
    // New redesign elements
    greeting: document.getElementById("greeting"),
    pillTabs: document.getElementById("pillTabs"),
    navList: document.querySelector(".nav-list"),
    btnAddPlaylist: document.getElementById("btnAddPlaylist"),
    nowPlaying: document.getElementById("nowPlaying"),
    npAlbum: document.getElementById("npAlbum"),
    npCover: document.getElementById("npCover"),
    npTitle: document.getElementById("npTitle"),
    npArtist: document.getElementById("npArtist"),
    btnNpHeart: document.getElementById("btnNpHeart"),
    btnNpMore: document.getElementById("btnNpMore"),
    btnNpShare: document.getElementById("btnNpShare"),
    btnOpenQueue: document.getElementById("btnOpenQueue"),
    npQueueList: document.getElementById("npQueueList"),
    mobilePlayerPill: document.getElementById("mobilePlayerPill"),
    btnMppShare: document.getElementById("btnMppShare"),
    btnMppOutput: document.getElementById("btnMppOutput"),
    mppCover: document.getElementById("mppCover"),
    mppTitle: document.getElementById("mppTitle"),
    mppArtist: document.getElementById("mppArtist"),
    mppEq: document.getElementById("mppEq"),
    btnMppPause: document.getElementById("btnMppPause"),
    mobileTabBar: document.getElementById("mobileTabBar"),
    btnThemeToggle: document.getElementById("btnThemeToggle"),
    themeIconSun: document.getElementById("themeIconSun"),
    themeIconMoon: document.getElementById("themeIconMoon"),
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

  // --- Sharing ---
  const SHARE_BASE_URL = "https://shmearify.coloradocareassist.com/";

  function getShareUrl(pathWithQuery) {
    // For local development, use the current origin so tests can verify end-to-end.
    if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
      return location.origin + "/" + pathWithQuery;
    }
    return SHARE_BASE_URL + pathWithQuery;
  }

  function buildTrackShareUrl(id) {
    return getShareUrl("?track=" + encodeURIComponent(id));
  }

  function buildAlbumShareUrl(artist, album) {
    return getShareUrl(
      "?artist=" + encodeURIComponent(artist) + "&album=" + encodeURIComponent(album)
    );
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
  }

  function shareFallbackMenu(url, title, anchor) {
    const existing = document.querySelector(".share-fallback-menu");
    if (existing) existing.remove();

    const menu = document.createElement("div");
    menu.className = "share-fallback-menu";
    const subject = encodeURIComponent(title || "Shmearify");
    const body = encodeURIComponent("Check this out on Shmearify: " + url);
    const items = [
      {
        label: "Copy link",
        icon: "🔗",
        action: async () => {
          await copyToClipboard(url);
          menu.remove();
        },
      },
      { label: "Email", icon: "✉️", href: "mailto:?subject=" + subject + "&body=" + body },
      { label: "WhatsApp", icon: "💬", href: "https://wa.me/?text=" + body },
      { label: "SMS", icon: "📱", href: "sms:?&body=" + body },
    ];

    for (const item of items) {
      const el = document.createElement(item.href ? "a" : "button");
      el.className = "share-fallback-item";
      el.innerHTML = `<span>${item.icon}</span><span>${esc(item.label)}</span>`;
      if (item.href) {
        el.href = item.href;
        el.target = "_blank";
        el.rel = "noopener";
      }
      el.addEventListener("click", (e) => {
        if (item.action) {
          e.preventDefault();
          item.action();
        } else {
          menu.remove();
        }
      });
      menu.appendChild(el);
    }

    menu.style.position = "fixed";
    menu.style.zIndex = "100";
    if (anchor) {
      const rect = anchor.getBoundingClientRect();
      menu.style.top = rect.bottom + 8 + "px";
      menu.style.right = window.innerWidth - rect.right + "px";
    } else {
      menu.style.bottom = "92px";
      menu.style.right = "16px";
    }

    document.body.appendChild(menu);
    setTimeout(() => {
      document.addEventListener(
        "click",
        function closeMenu(e) {
          if (menu.contains(e.target)) return;
          menu.remove();
          document.removeEventListener("click", closeMenu);
        },
        { once: true }
      );
    }, 0);
  }

  async function shareTrack(track, anchor) {
    if (!track) return;
    const url = buildTrackShareUrl(track.id);
    const title = track.title + " · " + track.artist;
    const text = "Listen to " + track.title + " by " + track.artist + " on Shmearify";
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
      } catch (e) {
        // User cancelled or share failed; ignore.
      }
    } else {
      shareFallbackMenu(url, title, anchor);
    }
  }

  async function shareAlbum(artist, album, anchor) {
    const url = buildAlbumShareUrl(artist, album);
    const title = album + " · " + artist;
    const text = "Listen to " + album + " by " + artist + " on Shmearify";
    if (navigator.share) {
      try {
        await navigator.share({ title, text, url });
      } catch (e) {
        // ignore
      }
    } else {
      shareFallbackMenu(url, title, anchor);
    }
  }

  let noticeTimeout = null;
  function showNotice(msg) {
    if (!els.playerNotice) return;
    clearTimeout(noticeTimeout);
    els.playerNotice.textContent = msg;
    noticeTimeout = setTimeout(() => {
      els.playerNotice.textContent = "";
    }, 3000);
  }

  // --- Audio output / casting (progressive enhancement) ---

  function buildAbsoluteStreamUrl(id, quality, offset) {
    return new URL(getStreamUrl(id, quality, offset), location.href).href;
  }

  function getCastMimeType(track, quality) {
    if (quality && quality !== "original") return "audio/mpeg";
    const ext = (track.relPath && track.relPath.split(".").pop() || "").toLowerCase();
    const map = {
      mp3: "audio/mpeg",
      m4a: "audio/mp4",
      aac: "audio/aac",
      flac: "audio/flac",
      wav: "audio/wav",
      ogg: "audio/ogg",
    };
    return map[ext] || "audio/mpeg";
  }

  function hasRemotePlayback() {
    const audio = activeAudio();
    return !!(audio && audio.remote && typeof audio.remote.prompt === "function");
  }

  function hasAirPlayPicker() {
    return typeof activeAudio().webkitShowPlaybackTargetPicker === "function";
  }

  function promptRemotePlayback() {
    const audio = activeAudio();
    if (!audio || !audio.remote || typeof audio.remote.prompt !== "function") return false;
    audio.remote.prompt().catch((err) => {
      if (err && err.name !== "NotAllowedError" && err.name !== "AbortError") {
        showNotice("Output picker failed: " + (err.message || err));
      }
    });
    return true;
  }

  function promptAirPlay() {
    const audio = activeAudio();
    if (typeof audio.webkitShowPlaybackTargetPicker !== "function") return false;
    try {
      audio.webkitShowPlaybackTargetPicker();
      return true;
    } catch (e) {
      return false;
    }
  }

  function castCurrentTrack() {
    const track = state.currentTrack;
    if (!track) {
      showNotice("Play a track before casting");
      return;
    }
    if (!window.cast || !window.cast.framework) {
      showNotice("Cast is not ready");
      return;
    }
    const ctx = window.cast.framework.CastContext.getInstance();
    const session = ctx.getCurrentSession();
    if (!session) {
      ctx.requestSession()
        .then(() => loadCastMedia(track))
        .catch((err) => {
          if (err && err.errorCode !== "cancel" && err.code !== "cancel") {
            showNotice("Cast failed: " + (err.description || err.message || err));
          }
        });
    } else {
      loadCastMedia(track);
    }
  }

  function loadCastMedia(track) {
    if (!window.cast || !window.cast.framework) return;
    const ctx = window.cast.framework.CastContext.getInstance();
    const session = ctx.getCurrentSession();
    if (!session) return;
    const url = buildAbsoluteStreamUrl(track.id, state.quality, 0);
    const mime = getCastMimeType(track, state.quality);
    const mediaInfo = new window.chrome.cast.media.MediaInfo(url, mime);
    mediaInfo.metadata = new window.chrome.cast.media.MusicTrackMediaMetadata();
    mediaInfo.metadata.title = track.title || "";
    mediaInfo.metadata.artist = track.artist || "";
    mediaInfo.metadata.albumName = track.album || "";
    const request = new window.chrome.cast.media.LoadRequest(mediaInfo);
    request.autoplay = true;
    session.loadMedia(request).then(() => {
      const device = session.getCastDevice();
      showNotice(device ? "Casting to " + device.friendlyName : "Casting");
    }).catch((err) => {
      showNotice("Cast failed: " + (err.description || err.message || err));
    });
  }

  function initCastContext() {
    if (!window.cast || !window.cast.framework) return;
    try {
      const ctx = window.cast.framework.CastContext.getInstance();
      ctx.setOptions({
        receiverApplicationId: window.chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID,
        autoJoinPolicy: window.chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
      });
      state.castAvailable = true;
      updateOutputButton();
    } catch (e) {
      // Cast initialization failed; leave button hidden.
    }
  }

  function initCastSdk() {
    if (state.castSdkLoaded) return;
    // Cast SDK requires HTTPS (or localhost) and a supported browser.
    if (location.protocol !== "https:" && location.hostname !== "localhost" && location.hostname !== "127.0.0.1") return;
    if (!window.chrome) return;
    state.castSdkLoaded = true;
    window.__onGCastApiAvailable = function (available) {
      if (available) initCastContext();
    };
    const s = document.createElement("script");
    s.src = "https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1";
    s.async = true;
    document.head.appendChild(s);
  }

  function updateOutputButton() {
    const visible = hasRemotePlayback() || state.castAvailable || hasAirPlayPicker() || activeAudio().setSinkId || state.audioOutputDevices.length > 0;
    if (els.outputWrap) els.outputWrap.style.display = visible ? "flex" : "none";
    if (els.btnMppOutput) els.btnMppOutput.style.display = visible ? "flex" : "none";
  }

  async function enumerateAudioOutputs(requestLabels) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.enumerateDevices !== "function") {
      updateOutputButton();
      return;
    }
    try {
      let devices = await navigator.mediaDevices.enumerateDevices();
      devices = devices.filter((d) => d.kind === "audiooutput");
      if (requestLabels && devices.length && !devices[0].label) {
        try {
          await navigator.mediaDevices.getUserMedia({ audio: true });
          devices = await navigator.mediaDevices.enumerateDevices();
          devices = devices.filter((d) => d.kind === "audiooutput");
        } catch (e) {
          // Permission denied; keep device IDs without labels.
        }
      }
      state.audioOutputDevices = devices;
    } catch (e) {
      state.audioOutputDevices = [];
    }
    updateOutputButton();
  }

  if (navigator.mediaDevices && typeof navigator.mediaDevices.addEventListener === "function") {
    navigator.mediaDevices.addEventListener("devicechange", () => enumerateAudioOutputs(false));
  }

  async function setAudioOutput(deviceId) {
    const audio = activeAudio();
    if (!audio || typeof audio.setSinkId !== "function") return;
    try {
      await audio.setSinkId(deviceId);
      state.audioSinkId = deviceId;
      // Apply the same sink to both pool audios so gapless/preload use the same output.
      audioPool.forEach((a) => {
        if (typeof a.setSinkId === "function") a.setSinkId(deviceId).catch(() => {});
      });
      showNotice("Audio output updated");
    } catch (err) {
      showNotice("Could not change audio output");
    }
  }

  function createOutputMenuItem(label, icon, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "output-menu-item";
    btn.innerHTML = (icon ? '<span class="output-menu-icon">' + icon + "</span>" : "") + '<span class="output-menu-label">' + esc(label) + "</span>";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  function createOutputMenuHint(text) {
    const div = document.createElement("div");
    div.className = "output-menu-hint";
    div.textContent = text;
    return div;
  }

  function closeOutputMenu() {
    if (els.outputMenu) {
      els.outputMenu.classList.remove("open");
      els.outputMenu.style.left = "";
      els.outputMenu.style.top = "";
    }
    if (els.btnOutput) els.btnOutput.setAttribute("aria-expanded", "false");
    if (els.btnMppOutput) els.btnMppOutput.setAttribute("aria-expanded", "false");
  }

  async function renderOutputMenu() {
    if (!els.outputMenu) return;
    els.outputMenu.innerHTML = "";

    // Ensure output-device labels are available when the menu is opened.
    if (activeAudio().setSinkId && state.audioOutputDevices.length && !state.audioOutputDevices[0].label) {
      await enumerateAudioOutputs(true);
    }

    // Prefer the unified Remote Playback API picker when available.
    if (hasRemotePlayback()) {
      els.outputMenu.appendChild(createOutputMenuItem("AirPlay / Cast / Bluetooth…", "📡", () => {
        closeOutputMenu();
        promptRemotePlayback();
      }));
    } else {
      if (state.castAvailable) {
        els.outputMenu.appendChild(createOutputMenuItem("Chromecast…", "📺", () => {
          closeOutputMenu();
          castCurrentTrack();
        }));
      }
      if (hasAirPlayPicker()) {
        els.outputMenu.appendChild(createOutputMenuItem("AirPlay…", "🎧", () => {
          closeOutputMenu();
          promptAirPlay();
        }));
      }
    }

    // Bluetooth / OS-level audio routing hint.
    els.outputMenu.appendChild(createOutputMenuHint("Bluetooth and wired audio are handled by your device."));

    // Desktop Chrome output-device picker via setSinkId.
    if (activeAudio().setSinkId && state.audioOutputDevices.length) {
      const sep = document.createElement("div");
      sep.className = "output-menu-separator";
      els.outputMenu.appendChild(sep);
      state.audioOutputDevices.forEach((device) => {
        const label = device.label || (device.deviceId === "default" ? "Default" : "Output device");
        const active = state.audioSinkId === device.deviceId || (!state.audioSinkId && device.deviceId === "default");
        els.outputMenu.appendChild(createOutputMenuItem((active ? "✓ " : "") + label, "", () => {
          closeOutputMenu();
          setAudioOutput(device.deviceId);
        }));
      });
    }

    if (!els.outputMenu.children.length) {
      els.outputMenu.appendChild(createOutputMenuHint("No external audio options available on this browser."));
    }
  }

  function positionOutputMenu(anchor) {
    if (!els.outputMenu || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const menuRect = els.outputMenu.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - (menuRect.width || 210) / 2;
    let top = rect.top - (menuRect.height || 160) - 8;
    // Keep inside viewport.
    left = Math.max(8, Math.min(left, window.innerWidth - (menuRect.width || 210) - 8));
    top = Math.max(8, top);
    els.outputMenu.style.left = left + "px";
    els.outputMenu.style.top = top + "px";
  }

  async function toggleOutputMenu(e, anchor) {
    if (e) e.stopPropagation();
    if (!els.outputMenu) return;
    const isOpen = els.outputMenu.classList.contains("open");
    closeOutputMenu();
    if (!isOpen) {
      await renderOutputMenu();
      els.outputMenu.classList.add("open");
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(() => positionOutputMenu(anchor || els.btnOutput || els.btnMppOutput));
      } else {
        positionOutputMenu(anchor || els.btnOutput || els.btnMppOutput);
      }
      if (els.btnOutput) els.btnOutput.setAttribute("aria-expanded", "true");
      if (els.btnMppOutput) els.btnMppOutput.setAttribute("aria-expanded", "true");
      setTimeout(() => {
        document.addEventListener("click", function closeOnClickOutside(ev) {
          if ((els.outputWrap && els.outputWrap.contains(ev.target)) || (els.btnMppOutput && els.btnMppOutput.contains(ev.target))) return;
          closeOutputMenu();
          document.removeEventListener("click", closeOnClickOutside);
        });
      }, 0);
    }
  }

  // Deterministic cover-art gradient used when real art is missing.
  function hashString(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
    }
    return h >>> 0;
  }

  function coverGradient(seed) {
    const h = hashString(String(seed));
    const h1 = h % 360;
    const h2 = (h1 + 35 + (h % 40)) % 360;
    const x = 12 + (h % 30);
    const y = 8 + ((h >> 3) % 26);
    return `radial-gradient(130% 120% at ${x}% ${y}%, oklch(0.66 0.16 ${h1}) 0%, oklch(0.45 0.15 ${h2}) 42%, oklch(0.24 0.09 ${h2}) 74%, oklch(0.15 0.05 ${h1}) 100%)`;
  }

  function setCover(el, trackId, opts) {
    opts = opts || {};
    el.innerHTML = "";
    el.style.background = "var(--cover-fallback)";
    if (!trackId) return;
    const img = document.createElement("img");
    img.alt = opts.alt || "";
    img.dataset.src = "art/" + trackId;
    img.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
    img.style.width = "100%";
    img.style.height = "100%";
    img.style.objectFit = "cover";
    img.style.display = "block";
    img.style.opacity = "0";
    img.style.transition = "opacity 0.25s ease";
    img.onerror = function () {
      img.style.display = "none";
      el.style.background = coverGradient(String(trackId));
    };
    img.onload = function () {
      img.style.opacity = "1";
    };
    el.appendChild(img);
    if (opts.lazy !== false) {
      artObserver.observe(img);
    } else {
      img.src = img.dataset.src;
      img.removeAttribute("data-src");
    }
  }

  function greetingText() {
    const hour = new Date().getHours();
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
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
    img.style.opacity = "0";
    img.style.transition = "opacity 0.25s ease";
    img.onload = function () { this.style.opacity = "1"; };
    img.onerror = function () {
      this.style.display = "none";
      const parent = this.parentElement;
      if (parent) parent.style.background = coverGradient(String(trackId));
    };
    artObserver.observe(img);
    return img;
  }

  // Guard against rapid repeated like/playlist mutations while a request is in flight.
  const pendingLikes = new Set();

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
    if (pendingLikes.has(id)) return;
    pendingLikes.add(id);
    try {
      if (state.likedIds.has(id)) {
        await apiDelete("api/liked/" + encodeURIComponent(id));
        state.likedIds.delete(id);
        if (state.view === "liked") {
          state.tracks = state.tracks.filter((t) => t.id !== id);
          state.viewTotal = state.tracks.length;
        }
      } else {
        await postJson("api/liked/" + encodeURIComponent(id));
        state.likedIds.add(id);
      }
    } catch (e) {
      // Leave local state unchanged on failure so the UI stays consistent.
    } finally {
      pendingLikes.delete(id);
    }
    updateHeartUI();
    renderLibrary();
    renderMain();
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
  let deepLinkHandled = false;
  let pollCount = 0;

  async function handleDeepLink() {
    if (deepLinkHandled) return;
    deepLinkHandled = true;
    const params = new URLSearchParams(location.search);
    const trackId = params.get("track");
    const artist = params.get("artist");
    const album = params.get("album");
    if (trackId) {
      try {
        const track = await fetchJson("api/track/" + encodeURIComponent(trackId));
        if (track) playTrack(track, [track]);
      } catch (e) {
        // Track may not exist; leave the app on the current view.
      }
    } else if (artist && album) {
      await loadAlbumTracks(artist, album);
    }
  }

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
      renderGreeting();
      renderPills();
      handleDeepLink();
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
    return { album, count: al.count, coverId: al.coverId, date, year, venue, city };
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
      more.className = "more";
      more.textContent = "+" + formatNumber(list.length - shown.length) + " more — keep typing to narrow";
      frag.appendChild(more);
    } else if (!q && state.artists.length === 0) {
      const empty = document.createElement("li");
      empty.className = "more";
      empty.textContent = "Loading artists…";
      frag.appendChild(empty);
    }

    els.artistList.innerHTML = "";
    els.artistList.appendChild(frag);
  }

  function renderLibrary() {
    const frag = document.createDocumentFragment();

    const items = [
      { key: "liked", label: "Liked Songs", seed: "liked" },
      { key: "recently", label: "Recently Played", seed: "recently" },
    ];

    for (const item of items) {
      const li = document.createElement("li");
      const active = state.view === item.key;
      if (active) li.classList.add("active");
      const cover = document.createElement("span");
      cover.className = "lib-icon";
      cover.style.width = "28px";
      cover.style.height = "28px";
      cover.style.borderRadius = "6px";
      cover.style.background = coverGradient(item.seed);
      li.appendChild(cover);
      const label = document.createElement("span");
      label.className = "lib-label";
      label.textContent = item.label;
      li.appendChild(label);
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
      if (active) li.classList.add("active");
      const cover = document.createElement("span");
      cover.className = "lib-icon";
      cover.style.width = "28px";
      cover.style.height = "28px";
      cover.style.borderRadius = "6px";
      cover.style.background = coverGradient("playlist:" + p.name);
      li.appendChild(cover);
      const label = document.createElement("span");
      label.className = "lib-label";
      label.textContent = p.name;
      li.appendChild(label);
      const count = document.createElement("span");
      count.className = "lib-count";
      count.textContent = p.trackCount;
      li.appendChild(count);
      li.title = `${p.name} · ${p.trackCount} tracks`;
      li.addEventListener("click", () => {
        loadPlaylistView(p.id);
        renderArtists();
        closeSidebarOnMobile();
      });
      frag.appendChild(li);
    }

    els.libraryList.innerHTML = "";
    els.libraryList.appendChild(frag);
  }

  function closeSidebarOnMobile() {
    if (window.innerWidth <= 760) {
      els.sidebar.classList.remove("open");
    }
  }

  function updateNavActive() {
    if (!els.navList) return;
    const homeLi = els.navList.querySelector('li[data-nav="home"]');
    if (homeLi) homeLi.classList.toggle("active", state.view === "home" && !state.search.trim());
  }

  function updateMobileTabActive() {
    if (!els.mobileTabBar) return;
    els.mobileTabBar.querySelectorAll(".tab-item").forEach((item) => item.classList.remove("active"));
    if (state.view === "home" && !state.search.trim()) {
      const home = els.mobileTabBar.querySelector('.tab-item[data-tab="home"]');
      if (home) home.classList.add("active");
    } else if (state.view === "liked") {
      const lib = els.mobileTabBar.querySelector('.tab-item[data-tab="library"]');
      if (lib) lib.classList.add("active");
    }
  }

  function renderMain() {
    updateNavActive();
    updateMobileTabActive();
    if (state.view !== "home") {
      if (els.greeting) els.greeting.innerHTML = "";
      if (els.pillTabs) els.pillTabs.innerHTML = "";
    }
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

  function renderGreeting() {
    if (!els.greeting) return;
    els.greeting.innerHTML = "";
    const main = document.createElement("div");
    main.className = "greeting";
    main.textContent = greetingText();
    const sub = document.createElement("div");
    sub.className = "greeting-sub";
    sub.textContent =
      formatNumber(state.artists.length) +
      " artists · " +
      formatNumber(state.status.trackCount || 0) +
      " tracks";
    els.greeting.appendChild(main);
    els.greeting.appendChild(sub);
  }

  function activePillKey() {
    if (state.view === "liked") return "music";
    if (state.view === "recently") return "albums";
    if (state.view === "home" && state.homeFilter === "artists") return "artists";
    return "all";
  }

  function renderPills() {
    if (!els.pillTabs) return;
    const isMobile = window.innerWidth <= 760;
    const pills = isMobile
      ? [
          { key: "all", label: "All" },
          { key: "artists", label: "Artists" },
          { key: "albums", label: "Albums" },
        ]
      : [
          { key: "all", label: "All" },
          { key: "music", label: "Music" },
          { key: "artists", label: "Artists" },
        ];
    els.pillTabs.innerHTML = "";
    const active = activePillKey();
    for (const p of pills) {
      const btn = document.createElement("button");
      btn.className = "pill" + (active === p.key ? " active" : "");
      btn.textContent = p.label;
      btn.addEventListener("click", () => {
        state.selectedArtist = null;
        state.selectedAlbum = null;
        state.selectedPlaylistId = null;
        state.search = "";
        state.albumFilter = "";
        els.searchBox.value = "";
        if (p.key === "music") {
          loadLikedView();
        } else if (p.key === "albums") {
          loadRecentlyView();
        } else {
          state.view = "home";
          state.homeFilter = p.key;
          renderArtists();
          renderMain();
        }
        renderPills();
      });
      els.pillTabs.appendChild(btn);
    }
  }

  function renderHome() {
    const frag = document.createDocumentFragment();
    renderGreeting();
    renderPills();

    if (state.homeFilter === "artists") {
      const header = document.createElement("div");
      header.className = "main-header";
      header.textContent = "Artists";
      frag.appendChild(header);
      const grid = document.createElement("div");
      grid.className = "cards";
      const shown = state.artists.slice(0, ARTIST_RENDER_CAP);
      for (const a of shown) {
        const card = document.createElement("button");
        card.className = "track-card";
        const artWrap = document.createElement("div");
        artWrap.className = "card-art-wrap";
        artWrap.style.background = coverGradient(a.name);
        card.appendChild(artWrap);
        const title = document.createElement("div");
        title.className = "card-title";
        title.textContent = a.name;
        const sub = document.createElement("div");
        sub.className = "card-sub";
        sub.textContent = a.count + (a.count === 1 ? " track" : " tracks");
        card.appendChild(title);
        card.appendChild(sub);
        card.addEventListener("click", () => loadArtistAlbums(a.name));
        grid.appendChild(card);
      }
      frag.appendChild(grid);
      appendScanBadge(frag);
      els.trackPanel.innerHTML = "";
      els.trackPanel.appendChild(frag);
      return;
    }

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
    const artWrap = document.createElement("div");
    artWrap.className = "card-art-wrap";
    artWrap.appendChild(lazyArtImg(t.id, "card-art", t.title));
    card.appendChild(artWrap);
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
    const art = document.createElement("div");
    art.className = "album-art";
    if (al.coverId) {
      art.appendChild(lazyArtImg(al.coverId, "album-art", al.album));
    } else {
      art.style.background = coverGradient(al.album);
    }
    row.appendChild(art);
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
      bar.appendChild(
        actionButton("Share", "⇧", () => {
          if (state.selectedArtist && state.selectedAlbum) {
            shareAlbum(state.selectedArtist, state.selectedAlbum);
          }
        }, true)
      );
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
      const artWrap = document.createElement("div");
      artWrap.className = "row-art";
      artWrap.style.background = coverGradient(String(t.id));
      artWrap.style.overflow = "hidden";
      artWrap.style.borderRadius = "var(--radius-sm)";
      artWrap.appendChild(lazyArtImg(t.id, "row-art", t.title));
      artTd.appendChild(artWrap);

      const numTd = document.createElement("td");
      numTd.textContent = num;

      const titleTd = document.createElement("td");
      titleTd.innerHTML = esc(t.title) + badge;

      const artistTd = document.createElement("td");
      artistTd.textContent = t.artist;

      const albumTd = document.createElement("td");
      albumTd.textContent = t.album;

      const durTd = document.createElement("td");
      durTd.textContent = dur;

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
      tr.appendChild(numTd);
      tr.appendChild(titleTd);
      tr.appendChild(artistTd);
      tr.appendChild(albumTd);
      tr.appendChild(durTd);
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
          renderMain();
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

      const share = document.createElement("button");
      share.textContent = "Share";
      share.addEventListener("click", (ev) => {
        ev.stopPropagation();
        shareTrack(t, btn);
        menu.remove();
      });
      menu.appendChild(share);

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
        updateMediaSession();
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
    state.pendingOriginalSeek = null;

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
    state.pendingOriginalSeek = null;
    audio.src = getStreamUrl(track.id, state.quality, offset);
    audio.volume = state.volume;
    audio.play().catch(() => {});
    state.isPlaying = true;
    updatePlayerUI();
    updateMediaSession();
    preloadNext();
    logPlayEvent(track.id, 0);
  }

  function applyQuality() {
    const track = state.currentTrack;
    if (!track) return;
    const wasPlaying = state.isPlaying;
    const eff = effectiveTime();

    if (state.quality === "original") {
      activeAudio().src = getStreamUrl(track.id, "original", 0);
      state.streamBaseOffset = 0;
      // Stash the desired seek position; the global loadedmetadata handler will apply it once.
      state.pendingOriginalSeek = { until: eff, playAfter: wasPlaying };
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
        '<svg class="art-placeholder" viewBox="0 0 24 24" fill="#9a97ab"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>';
      renderRightPanel();
      renderMobilePill();
      return;
    }
    els.playerTitle.textContent = t.title;
    els.playerArtist.textContent = t.artist;
    els.playerQuality.innerHTML = qualityBadge(t);
    els.btnHeart.style.display = "";
    updateHeartUI();
    els.iconPlay.style.display = state.isPlaying ? "none" : "";
    els.iconPause.style.display = state.isPlaying ? "" : "none";
    setCover(els.artWrap, t.id, { alt: t.title, lazy: false });
    renderRightPanel();
    renderMobilePill();
  }

  function renderRightPanel() {
    if (!els.nowPlaying) return;
    const t = state.currentTrack;
    if (!t) {
      els.npAlbum.textContent = "";
      els.npCover.innerHTML = "";
      els.npTitle.textContent = "—";
      els.npArtist.textContent = "—";
      els.btnNpHeart.style.display = "none";
      els.npQueueList.innerHTML = "";
      return;
    }
    els.npAlbum.textContent = t.album || "";
    setCover(els.npCover, t.id, { alt: t.album || t.title, lazy: false });
    els.npTitle.textContent = t.title;
    els.npArtist.textContent = t.artist;
    els.btnNpHeart.style.display = "";
    const liked = state.likedIds.has(t.id);
    els.btnNpHeart.innerHTML = liked ? "♥" : "♡";
    els.btnNpHeart.classList.toggle("liked", liked);
    els.btnNpHeart.title = liked ? "Unlike" : "Like";

    els.npQueueList.innerHTML = "";
    const upcoming = state.queue.slice(state.queueIndex + 1, state.queueIndex + 6);
    if (!upcoming.length) {
      els.npQueueList.innerHTML = '<div style="color:var(--text-muted-4);font-size:12px;">Queue is empty.</div>';
      return;
    }
    for (const q of upcoming) {
      const row = document.createElement("div");
      row.className = "np-queue-row";
      const art = document.createElement("div");
      art.className = "np-queue-art";
      setCover(art, q.id, { alt: q.title, lazy: false });
      row.appendChild(art);
      const meta = document.createElement("div");
      meta.className = "np-queue-meta";
      const title = document.createElement("div");
      title.className = "np-queue-title";
      title.textContent = q.title;
      const sub = document.createElement("div");
      sub.className = "np-queue-artist";
      sub.textContent = q.artist;
      meta.appendChild(title);
      meta.appendChild(sub);
      row.appendChild(meta);
      row.addEventListener("click", () => playTrack(q, state.queue));
      els.npQueueList.appendChild(row);
    }
  }

  function renderMobilePill() {
    if (!els.mobilePlayerPill) return;
    const t = state.currentTrack;
    if (!t) {
      els.mobilePlayerPill.style.display = "none";
      return;
    }
    els.mobilePlayerPill.style.display = "flex";
    els.mppTitle.textContent = t.title;
    els.mppArtist.textContent = t.artist;
    setCover(els.mppCover, t.id, { alt: t.title, lazy: false });
    els.mppEq.classList.toggle("playing", state.isPlaying);
    const icon = els.btnMppPause.querySelector("svg");
    if (icon) {
      icon.innerHTML = state.isPlaying
        ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>'
        : '<path d="M8 5v14l11-7z"/>';
    }
  }

  function updateHeartUI() {
    const t = state.currentTrack;
    if (!t) return;
    const liked = state.likedIds.has(t.id);
    els.btnHeart.innerHTML = liked ? "♥" : "♡";
    els.btnHeart.classList.toggle("liked", liked);
    els.btnHeart.title = liked ? "Unlike" : "Like";
    if (els.btnNpHeart) {
      els.btnNpHeart.innerHTML = liked ? "♥" : "♡";
      els.btnNpHeart.classList.toggle("liked", liked);
      els.btnNpHeart.title = liked ? "Unlike" : "Like";
    }
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
    renderRightPanel();
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
      const delta = details.seekOffset || 10;
      seekBy(-delta);
    });
    navigator.mediaSession.setActionHandler("seekforward", (details) => {
      const delta = details.seekOffset || 10;
      seekBy(delta);
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
        if (state.pendingOriginalSeek && audio.duration && isFinite(audio.duration)) {
          const target = Math.min(state.pendingOriginalSeek.until, audio.duration);
          if (target > 0) audio.currentTime = target;
          if (state.pendingOriginalSeek.playAfter) audio.play().catch(() => {});
          state.pendingOriginalSeek = null;
        }
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

  if (els.btnOutput) {
    els.btnOutput.addEventListener("click", (e) => toggleOutputMenu(e, els.btnOutput));
  }

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

  // Sidebar / nav-list interactions
  if (els.navList) {
    els.navList.addEventListener("click", (e) => {
      const li = e.target.closest("li[data-nav]");
      if (!li) return;
      const nav = li.dataset.nav;
      els.navList.querySelectorAll("li").forEach((item) => item.classList.toggle("active", item === li));
      if (nav === "home") {
        state.view = "home";
        state.homeFilter = "all";
        state.selectedArtist = null;
        state.selectedAlbum = null;
        state.selectedPlaylistId = null;
        state.search = "";
        state.albumFilter = "";
        els.searchBox.value = "";
        renderPills();
        renderArtists();
        renderMain();
      } else if (nav === "search") {
        els.searchBox.focus();
        if (window.innerWidth <= 760) els.sidebar.classList.add("open");
      }
      closeSidebarOnMobile();
    });
  }

  if (els.btnAddPlaylist) {
    els.btnAddPlaylist.addEventListener("click", async () => {
      const name = prompt("Playlist name?");
      if (name && name.trim()) {
        await createPlaylist(name.trim());
        renderLibrary();
      }
    });
  }

  document.addEventListener("click", (e) => {
    if (
      window.innerWidth <= 760 &&
      els.sidebar.classList.contains("open") &&
      !els.sidebar.contains(e.target)
    ) {
      els.sidebar.classList.remove("open");
    }
  });

  if (els.btnNpHeart) {
    els.btnNpHeart.addEventListener("click", () => {
      const t = state.currentTrack;
      if (t) toggleLiked(t.id);
    });
  }
  if (els.btnNpShare) {
    els.btnNpShare.addEventListener("click", (e) => {
      e.stopPropagation();
      const t = state.currentTrack;
      if (t) shareTrack(t, els.btnNpShare);
    });
  }
  if (els.btnNpMore) {
    els.btnNpMore.addEventListener("click", toggleQueuePanel);
  }
  if (els.btnOpenQueue) {
    els.btnOpenQueue.addEventListener("click", toggleQueuePanel);
  }

  if (els.mobileTabBar) {
    els.mobileTabBar.addEventListener("click", (e) => {
      const item = e.target.closest(".tab-item");
      if (!item) return;
      const tab = item.dataset.tab;
      if (tab === "theme") {
        toggleTheme();
        return;
      }
      els.mobileTabBar.querySelectorAll(".tab-item").forEach((t) => t.classList.remove("active"));
      item.classList.add("active");
      if (tab === "home") {
        state.view = "home";
        state.homeFilter = "all";
        state.selectedArtist = null;
        state.selectedAlbum = null;
        state.selectedPlaylistId = null;
        state.search = "";
        state.albumFilter = "";
        els.searchBox.value = "";
        renderPills();
        renderArtists();
        renderMain();
      } else if (tab === "search") {
        els.searchBox.focus();
        els.sidebar.classList.add("open");
      } else if (tab === "library") {
        state.view = "liked";
        loadLikedView();
      }
    });
  }

  if (els.mobilePlayerPill) {
    els.mobilePlayerPill.addEventListener("click", (e) => {
      if (e.target.closest("#btnMppPause") || e.target.closest("#btnMppShare") || e.target.closest("#btnMppOutput")) return;
      // Could expand full player here; for now just show queue panel.
      toggleQueuePanel();
    });
    if (els.btnMppPause) {
      els.btnMppPause.addEventListener("click", (e) => {
        e.stopPropagation();
        togglePlay();
      });
    }
    if (els.btnMppShare) {
      els.btnMppShare.addEventListener("click", (e) => {
        e.stopPropagation();
        const t = state.currentTrack;
        if (t) shareTrack(t, els.btnMppShare);
      });
    }
    if (els.btnMppOutput) {
      els.btnMppOutput.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleOutputMenu(e, els.btnMppOutput);
      });
    }
  }

  function toggleTheme() {
    const isLight = document.body.classList.toggle("theme-light");
    document.body.classList.toggle("theme-dark", !isLight);
    try { localStorage.setItem("shmearify-theme", isLight ? "light" : "dark"); } catch (e) {}
    if (els.themeIconSun && els.themeIconMoon) {
      els.themeIconSun.style.display = isLight ? "none" : "";
      els.themeIconMoon.style.display = isLight ? "" : "none";
    }
  }

  window.addEventListener("resize", () => {
    renderPills();
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
    const savedTheme = localStorage.getItem("shmearify-theme");
    if (savedTheme === "light") {
      document.body.classList.add("theme-light");
      document.body.classList.remove("theme-dark");
      if (els.themeIconSun && els.themeIconMoon) {
        els.themeIconSun.style.display = "none";
        els.themeIconMoon.style.display = "";
      }
    }
  } catch (e) {}
  updateShuffleRepeatUI();
  renderPills();

  // Initialize output/casting capabilities progressively.
  enumerateAudioOutputs();
  initCastSdk();
  updateOutputButton();

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    });
  }

  setupMediaSession();
  pollStatus();
})();
