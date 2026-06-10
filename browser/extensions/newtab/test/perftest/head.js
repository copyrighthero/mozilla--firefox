/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { HttpServer } = ChromeUtils.importESModule(
  "resource://testing-common/httpd.sys.mjs"
);

const {
  MozAdsClientBuilder,
  MozAdsCacheConfig,
  MozAdsEnvironment,
  MozAdsPlacementRequest,
  MozAdsTelemetry,
} = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustAdsClient.sys.mjs"
);

const { initialize: initRustComponents } = ChromeUtils.importESModule(
  "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustInitRustComponents.sys.mjs"
);

const FIXTURES_DIR = "fixtures";
const UAPI_FIXTURE = "uapi-shape.json";
const MARS_FIXTURE = "mars-shape.json";

// Bench harness deliberately uses a static UUID rather than calling
// ContextId.request(). The disclaimer artifact at
// artifacts/ac64-cache-semantics-disclaimer.md documents the IPC
// asymmetry between the two clients; this constant pins the variable.
const BENCH_CONTEXT_ID = "00000000-0000-4000-8000-ac64ac64ac64";

// UniFFI rejects plain objects for callback interfaces; the telemetry sink
// must be an instance of a subclass of the generated MozAdsTelemetry base.
class BenchNoopTelemetry extends MozAdsTelemetry {
  recordBuildCacheError(_label, _value) {}
  recordClientError(_label, _value) {}
  recordClientOperationTotal(_label) {}
  recordDeserializationError(_label, _value) {}
  recordHttpCacheOutcome(_label, _value) {}
}

/**
 * Borrowed from intl/benchmarks/test/xpcshell/head.js. Each metric name
 * yields three reported numbers: iterations, accumulatedTime, perCallTime.
 *
 * @param {string} metricName
 */
function measureIterations(metricName) {
  let accumulatedTime = 0;
  let iterations = 0;
  let now = 0;
  return {
    start() {
      now = ChromeUtils.now();
    },
    stop() {
      accumulatedTime += ChromeUtils.now() - now;
      iterations++;
    },
    reportMetrics() {
      const metrics = {};
      metrics[metricName + " iterations"] = iterations;
      metrics[metricName + " accumulatedTime"] = accumulatedTime;
      metrics[metricName + " perCallTime"] = accumulatedTime / iterations;
      info("perfMetrics", metrics);
    },
  };
}

async function readFixture(name) {
  const file = do_get_file(`${FIXTURES_DIR}/${name}`);
  return IOUtils.readJSON(file.path);
}

/**
 * Spin up a single HttpServer that serves both the JS-client (UAPI) and the
 * MAC-client (MARS) shapes from distinct routes. Distinct routes let
 * cross-contamination surface immediately (mars-shape only differs from
 * uapi-shape on block_key/name/url, by design).
 *
 * Routes:
 *   POST /v1/ads        -> uapi-shape.json (consumed by the JS path)
 *   POST /anyads/v1/ads -> mars-shape.json (consumed by MAC; the base URL
 *                          handed to Environment::Test is /anyads/v1/ and
 *                          MAC appends "ads".)
 */
async function setupFixtureServer() {
  const uapiBody = await readFixture(UAPI_FIXTURE);
  const marsBody = await readFixture(MARS_FIXTURE);

  const server = new HttpServer();

  const writeJson = (request, response, body) => {
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "application/json", false);
    response.write(JSON.stringify(body));
  };

  server.registerPathHandler("/v1/ads", (request, response) =>
    writeJson(request, response, uapiBody)
  );
  server.registerPathHandler("/anyads/v1/ads", (request, response) =>
    writeJson(request, response, marsBody)
  );

  server.start(-1);

  const { primaryScheme, primaryHost, primaryPort } = server.identity;
  const origin = `${primaryScheme}://${primaryHost}:${primaryPort}`;

  return {
    server,
    origin,
    jsEndpoint: `${origin}/v1/ads`,
    macBaseUrl: `${origin}/anyads/v1/`,
    async stop() {
      await new Promise(resolve => server.stop(resolve));
    },
  };
}

/**
 * Build a MozAdsClient bound to the fixture server's MARS-shape route.
 * A fresh sqlite path per call ensures a cold persistent cache; the
 * harness wipes the file between iterations rather than reusing.
 *
 * @param {string} macBaseUrl - e.g. http://127.0.0.1:PORT/anyads/v1/
 * @param {string} dbPath - absolute path to a freshly-allocated sqlite file
 */
function createMacClient(macBaseUrl, dbPath) {
  return MozAdsClientBuilder.init()
    .cacheConfig(new MozAdsCacheConfig({ dbPath }))
    .environment(new MozAdsEnvironment.Test({ url: macBaseUrl }))
    .build();
}

/**
 * MAC client tile-request payload. Tile placements are the Phase 1 surface;
 * spocs are deferred to Phase 2 per the fixtures README.
 *
 * @param {string[]} placementIds - e.g. ["newtab_tile_1", "newtab_tile_2"]
 */
function buildMacTileRequests(placementIds) {
  return placementIds.map(
    id => new MozAdsPlacementRequest({ placementId: id, iabContent: null })
  );
}

/**
 * Replicates the JS-path payload shape AdsFeed.sys.mjs sends to UAPI in
 * the non-OHTTP branch. OHTTP is deliberately excluded from Dim 3 (see
 * the disclaimer artifact for the rationale; an OHTTP variant lands in
 * Phase 3).
 *
 * @param {string[]} placementIds
 */
function buildJsRequestBody(placementIds) {
  return {
    context_id: BENCH_CONTEXT_ID,
    flags: {},
    placements: placementIds.map(p => ({ placement: p, count: 1 })),
    blocks: [],
  };
}

/**
 * Replicates the formatted-tile transform from AdsFeed._normalizeTileData
 * so the JS-baseline measurement covers the same end-state work as MAC
 * (which returns post-parse MozAdsTile objects).
 */
function normalizeJsTileResponse(responseJson) {
  const formatted = [];
  for (const tileArray of Object.values(responseJson)) {
    if (!tileArray?.length) {
      continue;
    }
    const [tile] = tileArray;
    formatted.push({
      id: tile.block_key,
      block_key: tile.block_key,
      name: tile.name,
      url: tile.url,
      click_url: tile.callbacks.click,
      image_url: tile.image_url,
      impression_url: tile.callbacks.impression,
      image_size: 200,
    });
  }
  return { tiles: formatted };
}

function freshDbPath(iteration) {
  return PathUtils.join(
    PathUtils.profileDir,
    `mac_cache_iter_${iteration}.sqlite`
  );
}

async function removeIfExists(path) {
  try {
    await IOUtils.remove(path, { ignoreAbsent: true });
  } catch (_) {
    // ignoreAbsent should already suppress, but if a stale wal/shm file
    // hangs around we don't want the next iteration to inherit it.
  }
  await IOUtils.remove(`${path}-wal`, { ignoreAbsent: true });
  await IOUtils.remove(`${path}-shm`, { ignoreAbsent: true });
}
