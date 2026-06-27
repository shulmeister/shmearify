#!/usr/bin/env node
"use strict";

/**
 * Scan the library cache and print artist duplicate groups that would be merged,
 * plus the near-pair review list. Does not start the server.
 */

const fs = require("fs");
const path = require("path");
const { buildCanonicalMap, findReviewPairs, loadAliases } = require("../lib/canonical");

const CACHE_PATH = process.env.CACHE_PATH || path.join(__dirname, "..", "library-cache.json");
const ALIASES_PATH = process.env.ALIASES_PATH || path.join(__dirname, "..", "data", "artist_aliases.json");

function main() {
  if (!fs.existsSync(CACHE_PATH)) {
    console.error("Cache not found:", CACHE_PATH);
    process.exit(1);
  }

  const tracks = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  if (!Array.isArray(tracks)) {
    console.error("Invalid cache format");
    process.exit(1);
  }

  const counts = new Map();
  for (const t of tracks) {
    const a = t.artist || "Unknown Artist";
    counts.set(a, (counts.get(a) || 0) + 1);
  }

  const artists = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
  const aliases = loadAliases(ALIASES_PATH);
  const { map, groups } = buildCanonicalMap(artists, aliases);

  let mergedGroups = 0;
  let mergedArtists = 0;
  for (const [key, variants] of groups) {
    if (variants.length > 1) {
      mergedGroups++;
      mergedArtists += variants.length;
      const total = variants.reduce((s, v) => s + v.count, 0);
      const canonical = map.get(key);
      console.log(`\n[${canonical}]  ← ${variants.length} variants, ${total} tracks`);
      for (const v of variants.sort((a, b) => b.count - a.count)) {
        console.log(`    "${v.name}"  ${v.count}`);
      }
    }
  }

  console.log(`\n---\nTotal: ${artists.length} raw artists -> ${new Set(map.values()).size} canonical artists`);
  console.log(`Auto-merged: ${mergedGroups} groups (${mergedArtists} raw names)`);

  const pairs = findReviewPairs(map.keys());
  if (pairs.length) {
    console.log(`\nReview pairs (edit-distance <= 1, NOT auto-merged): ${pairs.length}`);
    for (const [a, b] of pairs) {
      const atotal = (groups.get(a) || []).reduce((s, v) => s + v.count, 0);
      const btotal = (groups.get(b) || []).reduce((s, v) => s + v.count, 0);
      console.log(`  "${a}" (${atotal})  <->  "${b}" (${btotal})`);
    }
  } else {
    console.log("\nNo edit-distance <= 1 review pairs.");
  }
}

main();
