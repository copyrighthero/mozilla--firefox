/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

/**
 * AC-64 Dim 3 cold-cache benchmark.
 *
 * One iteration = one client-side fetch of the two tile placements
 * (newtab_tile_1 + newtab_tile_2) against a localhost fixture server,
 * starting with no persistent cache present.
 *
 * For MAC: a fresh sqlite file is allocated per iteration. The cost
 * measured is the requestTileAds() call only; client construction is
 * excluded.
 *
 * For JS: a single POST + JSON.parse + tile normalization, matching
 * AdsFeed.sys.mjs's non-OHTTP branch. ContextId.request() is replaced
 * with a static UUID (see disclaimer artifact for IPC-asymmetry rationale).
 *
 * Both clients share the same HttpServer instance; routes are distinct,
 * so a misrouted iteration surfaces as a fixture-content assertion fail.
 */

const ITERATIONS = 20;
const TILE_PLACEMENTS = ["newtab_tile_1", "newtab_tile_2"];

add_setup(async function () {
  do_get_profile();
  // Bootstraps viaduct and the rest of the Rust runtime services. Without
  // this, MozAdsClient operations crash with a main-thread assertion the
  // first time the Rust side tries to make an HTTP call. See
  // toolkit/components/passwordmgr/storage-rust.sys.mjs for the canonical
  // call site in production code.
  await initRustComponents(PathUtils.profileDir);
});

// AC-64: skip .telemetry() in the builder chain so the Rust constructor
// uses MozAdsTelemetryWrapper::noop() and never fires a Sync callback into
// JS. This sidesteps the main-thread/Sync vtable dispatch crash without
// touching vendored code; symbolicated stack confirmed the fire site was
// AdsClient::new -> MozAdsTelemetryWrapper::record -> Sync callback shim.
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
        Object.keys(response).length,
        TILE_PLACEMENTS.length,
        `MAC iteration ${i}: expected ${TILE_PLACEMENTS.length} placements`
      );
      Assert.ok(
        response.newtab_tile_1.blockKey?.startsWith("ac64-mars-"),
        `MAC iteration ${i}: tile_1 should come from mars-shape fixture`
      );

      await removeIfExists(dbPath);
    }
  } finally {
    await fixture.stop();
  }

  bench.reportMetrics();
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
