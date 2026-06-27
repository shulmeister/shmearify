/**
 * Server-side user state for Shmearify (single user, no auth).
 * Persisted to data/user_state.json on the internal SSD with atomic tmp+rename writes.
 */

"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULT_STATE = {
  liked: [],         // [trackId, ...]
  playlists: [],     // [{ id, name, tracks: [trackId, ...] }]
  recentlyPlayed: [], // [{ id, ts }]
  resume: null,      // { id, position, ts }
};

function loadUserState(statePath) {
  try {
    if (!fs.existsSync(statePath)) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    if (Array.isArray(parsed.liked)) state.liked = parsed.liked;
    if (Array.isArray(parsed.playlists)) state.playlists = parsed.playlists;
    if (Array.isArray(parsed.recentlyPlayed)) state.recentlyPlayed = parsed.recentlyPlayed;
    if (parsed.resume && typeof parsed.resume === "object") state.resume = parsed.resume;
    return state;
  } catch (err) {
    console.error("[userstate] load failed:", err.message);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveUserState(state, statePath) {
  const tmp = statePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, statePath);
}

function ensureDataDir(statePath) {
  const dir = path.dirname(statePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function createStore(statePath) {
  ensureDataDir(statePath);
  let state = loadUserState(statePath);

  function persist() {
    saveUserState(state, statePath);
  }

  function now() {
    return Date.now();
  }

  function newPlaylistId() {
    return `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  return {
    getState() {
      // Return a deep copy so callers cannot mutate internal state by reference.
      return JSON.parse(JSON.stringify(state));
    },

    // Liked songs
    getLiked() {
      return state.liked.slice();
    },
    isLiked(id) {
      return state.liked.includes(id);
    },
    addLiked(id) {
      if (!state.liked.includes(id)) {
        state.liked.push(id);
        persist();
      }
    },
    removeLiked(id) {
      state.liked = state.liked.filter((x) => x !== id);
      persist();
    },

    // Playlists
    getPlaylists() {
      return state.playlists.map((p) => ({ id: p.id, name: p.name, trackCount: p.tracks.length }));
    },
    getPlaylist(id) {
      const p = state.playlists.find((x) => x.id === id);
      return p ? { id: p.id, name: p.name, tracks: p.tracks.slice() } : null;
    },
    createPlaylist(name) {
      const playlist = { id: newPlaylistId(), name: String(name || "My Playlist").trim(), tracks: [] };
      state.playlists.push(playlist);
      persist();
      return { id: playlist.id, name: playlist.name, tracks: [] };
    },
    renamePlaylist(id, name) {
      const p = state.playlists.find((x) => x.id === id);
      if (!p) return false;
      p.name = String(name || p.name).trim();
      persist();
      return true;
    },
    deletePlaylist(id) {
      const before = state.playlists.length;
      state.playlists = state.playlists.filter((x) => x.id !== id);
      if (state.playlists.length !== before) persist();
      return state.playlists.length !== before;
    },
    addPlaylistTrack(id, trackId) {
      const p = state.playlists.find((x) => x.id === id);
      if (!p) return false;
      if (!p.tracks.includes(trackId)) {
        p.tracks.push(trackId);
        persist();
      }
      return true;
    },
    removePlaylistTrack(id, trackId) {
      const p = state.playlists.find((x) => x.id === id);
      if (!p) return false;
      const before = p.tracks.length;
      p.tracks = p.tracks.filter((x) => x !== trackId);
      if (p.tracks.length !== before) persist();
      return true;
    },
    reorderPlaylistTracks(id, orderedIds) {
      const p = state.playlists.find((x) => x.id === id);
      if (!p) return false;
      const set = new Set(p.tracks);
      const incoming = Array.isArray(orderedIds) ? orderedIds.filter((x) => set.has(x)) : [];
      // Append any missing tracks at the end so a partial reorder is safe.
      for (const t of p.tracks) {
        if (!incoming.includes(t)) incoming.push(t);
      }
      p.tracks = incoming;
      persist();
      return true;
    },

    // Recently played
    logPlay(id) {
      if (!id) return;
      state.recentlyPlayed.unshift({ id, ts: now() });
      // Deduplicate, keeping newest timestamp for each id.
      const seen = new Set();
      const out = [];
      for (const item of state.recentlyPlayed) {
        if (!item || !item.id || seen.has(item.id)) continue;
        seen.add(item.id);
        out.push(item);
      }
      state.recentlyPlayed = out.slice(0, 100);
      persist();
    },
    getRecentlyPlayed(limit) {
      const n = Math.min(limit || 50, state.recentlyPlayed.length);
      return state.recentlyPlayed.slice(0, n);
    },

    // Resume
    setResume(id, position) {
      state.resume = { id, position: position || 0, ts: now() };
      persist();
    },
    clearResume() {
      state.resume = null;
      persist();
    },
    getResume() {
      return state.resume ? { ...state.resume } : null;
    },

    reload() {
      state = loadUserState(statePath);
    },
  };
}

module.exports = { createStore, DEFAULT_STATE };
