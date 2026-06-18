/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/* globals add_setup, add_task, Assert, do_get_profile, info */

"use strict";

const perfMetadata = {
  owner: "AC-64 / Hans Zhao",
  name: "AdsClient.dim3.coldCache.reverse",
  description:
    "AC-64 dim3 cold-cache benchmark (MAC vs JS) — reverse order (JS then MAC), counterbalanced with forward file.",
  options: {
    default: {
      perfherder: true,
      perfherder_metrics: [
        { name: "AdsClient.MAC.dim3.coldCache iterations", unit: "iterations" },
        { name: "AdsClient.MAC.dim3.coldCache accumulatedTime", unit: "ms" },
        { name: "AdsClient.MAC.dim3.coldCache perCallTime", unit: "ms" },
        { name: "AdsClient.JS.dim3.coldCache iterations", unit: "iterations" },
        { name: "AdsClient.JS.dim3.coldCache accumulatedTime", unit: "ms" },
        { name: "AdsClient.JS.dim3.coldCache perCallTime", unit: "ms" },
      ],
      verbose: true,
    },
  },
  tags: ["ac-64", "ads-client", "mac"],
};

/**
 * AC-64 Dim 3 cold-cache benchmark — REVERSE order variant.
 *
 * Mirror of perftest_adsClient_dim3.js with the two add_task() blocks
 * swapped (JS first, MAC second). Used together with the forward file
 * to counterbalance xpcshell within-process warm-up bias: in the forward
 * file the JS variant pays no JIT / IC / GC initialisation cost (MAC
 * paid it); here the MAC variant rides on JS's warm-up. Pairing both
 * outputs cancels the order effect to first order.
 *
 * Metric names are kept identical to the forward file so per-arm stats
 * are computed across files; output directories are separated to keep
 * forward / reverse perfherder JSON distinguishable.
 */

const ITERATIONS = 20;
const TILE_PLACEMENTS = ["newtab_tile_1", "newtab_tile_2"];

add_setup(async function () {
  do_get_profile();
  await initRustComponents(PathUtils.profileDir);
});

add_task(async function dim3_js_coldCache() {
  const fixture = await setupFixtureServer();
  const bench = measureIterations("AdsClient.JS.dim3.coldCache");

  try {
    const body = JSON.stringify(buildJsRequestBody(TILE_PLACEMENTS));
    const headers = { "Content-Type": "application/json" };

    for (let i = 0; i < ITERATIONS; i++) {
      bench.start();
      const response = await fetch(fixture.jsEndpoint, {
        method: "POST",
        headers,
        body,
      });
      const raw = await response.json();
      const normalized = normalizeJsTileResponse(raw);
      bench.stop();

      Assert.equal(
        normalized.tiles.length,
        TILE_PLACEMENTS.length,
        `JS iteration ${i}: expected ${TILE_PLACEMENTS.length} normalized tiles`
      );
      Assert.ok(
        normalized.tiles[0].block_key.startsWith("ac64-uapi-"),
        `JS iteration ${i}: tile_1 should come from uapi-shape fixture`
      );
    }
  } finally {
    await fixture.stop();
  }

  bench.reportMetrics();
});

add_task(async function dim3_mac_coldCache() {
  info("dim3_mac probe: setting up fixture server");
  const fixture = await setupFixtureServer();
  info(`dim3_mac probe: fixture ready, macBaseUrl=${fixture.macBaseUrl}`);
  const bench = measureIterations("AdsClient.MAC.dim3.coldCache");

  try {
    const macRequests = buildMacTileRequests(TILE_PLACEMENTS);
    info("dim3_mac probe: tile requests built");
    for (let i = 0; i < ITERATIONS; i++) {
      const dbPath = freshDbPath(`mac_${i}`);
      await removeIfExists(dbPath);
      info(`dim3_mac probe: iter ${i} creating client, dbPath=${dbPath}`);
      const client = createMacClient(fixture.macBaseUrl, dbPath);
      info(`dim3_mac probe: iter ${i} client built; calling requestTileAds`);

      bench.start();
      const response = await client.requestTileAds(macRequests, null);
      bench.stop();
      info(`dim3_mac probe: iter ${i} requestTileAds returned`);

      Assert.equal(
        response.size,
        TILE_PLACEMENTS.length,
        `MAC iteration ${i}: expected ${TILE_PLACEMENTS.length} placements`
      );
      const macTile1 = response.get("newtab_tile_1");
      Assert.ok(
        macTile1 &&
          macTile1.blockKey &&
          macTile1.blockKey.startsWith("ac64-mars-"),
        `MAC iteration ${i}: tile_1 should come from mars-shape fixture`
      );

      await removeIfExists(dbPath);
    }
  } finally {
    await fixture.stop();
  }

  bench.reportMetrics();
});
