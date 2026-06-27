/**
 * Artist canonicalization for Shmearify.
 *
 * Non-destructive, index-only deduplication: case / whitespace / punctuation
 * variants of the same artist name are merged under one canonical display name.
 * True misspellings are NOT auto-merged; they are emitted as a review list.
 */

"use strict";

function removeDiacritics(str) {
  return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function canonicalArtist(name) {
  let s = String(name || "");
  s = removeDiacritics(s).toLowerCase().trim();
  // smart quotes -> straight
  s = s
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036]/g, '"');
  // treat punctuation / separators as whitespace consistently
  s = s.replace(/[_\\/.,;:!?&+()\[\]{}|]/g, " ");
  // collapse whitespace
  s = s.replace(/\s+/g, " ").trim();
  // strip control chars and zero-width chars, but keep all other letters/digits/quotes
  s = s.replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200d\ufeff]/g, "").trim();
  // If normalization erased everything (e.g. "!!!"), fall back to a trimmed lowercased original
  // so genuinely-different non-Latin / symbol names do not collapse into one empty key.
  if (!s) {
    s = String(name || "").toLowerCase().trim().replace(/\s+/g, " ").trim() || "__empty__";
  }
  return s;
}

function displayScore(name, count) {
  let score = count * 1000;
  const trimmed = String(name).trim();
  const words = trimmed.split(/\s+/).filter(Boolean);
  // prefer title-cased forms
  const titleCased =
    words.length > 0 &&
    words.every((w) => w.length === 0 || w[0] === w[0].toUpperCase() || /^\W/.test(w));
  if (titleCased) score += 50;
  // prefer punctuation-rich / "proper" forms (R.E.M. vs REM, etc.)
  if (/[.,&]/.test(trimmed)) score += 15;
  // prefer accented / non-ASCII forms when counts are close
  if (/[^\u0000-\u007f]/.test(trimmed)) score += 25;
  // penalize ALL CAPS
  if (trimmed === trimmed.toUpperCase()) score -= 30;
  // slight preference for longer, more complete names
  score += Math.min(trimmed.length, 40);
  return score;
}

function loadAliases(aliasesPath) {
  try {
    const fs = require("fs");
    if (!fs.existsSync(aliasesPath)) return {};
    const raw = fs.readFileSync(aliasesPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch (err) {
    // ignore malformed aliases file
  }
  return {};
}

/**
 * Build a canonical-name map from an iterable of { name, count }.
 * Returns { map: Map(normalizedKey -> canonicalName), groups: Map(normalizedKey -> [{name,count}]) }.
 */
function buildCanonicalMap(artists, aliases) {
  const counts = new Map();
  for (const { name, count } of artists) {
    counts.set(name, (counts.get(name) || 0) + (count || 0));
  }

  const groups = new Map(); // normalized key -> [{name, count}]
  for (const [name, count] of counts) {
    const key = canonicalArtist(name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ name, count });
  }

  const aliasMap = new Map();
  if (aliases && typeof aliases === "object") {
    for (const [rawKey, value] of Object.entries(aliases)) {
      const key = canonicalArtist(rawKey);
      if (key) aliasMap.set(key, String(value).trim());
    }
  }

  const canonByKey = new Map();
  for (const [key, variants] of groups) {
    let name;
    if (aliasMap.has(key)) {
      name = aliasMap.get(key);
    } else {
      const sorted = variants.slice().sort((a, b) => displayScore(b.name, b.count) - displayScore(a.name, a.count));
      name = sorted[0].name.trim();
    }
    canonByKey.set(key, name);
  }

  // Aliases can force different normalized keys to merge to the same display name.
  // Resolve conflicts by total track count.
  const nameToKey = new Map();
  const totalForKey = (key) => groups.get(key).reduce((s, v) => s + v.count, 0);
  for (const [key, name] of canonByKey) {
    if (!nameToKey.has(name)) {
      nameToKey.set(name, key);
    } else if (totalForKey(key) > totalForKey(nameToKey.get(name))) {
      nameToKey.set(name, key);
    }
  }

  const map = new Map();
  for (const [key, name] of canonByKey) {
    const winnerKey = nameToKey.get(name);
    map.set(key, canonByKey.get(winnerKey));
  }

  return { map, groups };
}

function applyCanonicalNames(tracks, canonMap) {
  for (const t of tracks) {
    const key = canonicalArtist(t.artist);
    if (canonMap.has(key)) t.artist = canonMap.get(key);
  }
}

// Levenshtein optimized for short strings; returns actual distance for <=1, else 2.
function levenshtein1(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let i = 0;
  let j = 0;
  let diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] !== b[j]) {
      diff++;
      if (diff > 1) return 2;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else {
        i++;
        j++;
      }
    } else {
      i++;
      j++;
    }
  }
  if (i < a.length || j < b.length) diff++;
  return diff;
}

function findReviewPairs(keys) {
  const arr = Array.from(keys).filter((k) => k.length > 0).sort();
  const buckets = new Map();
  for (const k of arr) {
    const b = k.length >= 2 ? k.slice(0, 2) : k;
    if (!buckets.has(b)) buckets.set(b, []);
    buckets.get(b).push(k);
  }
  const pairs = [];
  for (const bucket of buckets.values()) {
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = bucket[i];
        const b = bucket[j];
        if (Math.abs(a.length - b.length) <= 1 && levenshtein1(a, b) <= 1) {
          pairs.push([a, b]);
        }
      }
    }
  }
  return pairs;
}

module.exports = {
  canonicalArtist,
  buildCanonicalMap,
  applyCanonicalNames,
  findReviewPairs,
  loadAliases,
};
