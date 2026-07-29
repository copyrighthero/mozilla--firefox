/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AdsClient: "resource://newtab/lib/AdsClient.sys.mjs",
  _AdsClient: "resource://newtab/lib/AdsClient.sys.mjs",
});

const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

const PREF_UNIFIED_ADS_ADSCLIENT_ENABLED = "unifiedAds.adsClient.enabled";

add_setup(function test_setup_fog() {
  do_get_profile();
  Services.fog.initializeFOG();
});

add_task(function test_isEnabled() {
  Assert.strictEqual(
    lazy.AdsClient.isEnabled({}),
    false,
    "Gated off by default (no pref, no trainhopConfig)"
  );

  Assert.strictEqual(
    lazy.AdsClient.isEnabled(undefined),
    false,
    "Gated off when prefs are missing"
  );

  Assert.strictEqual(
    lazy.AdsClient.isEnabled({ [PREF_UNIFIED_ADS_ADSCLIENT_ENABLED]: true }),
    true,
    "Enabled by the local about:config pref"
  );

  Assert.strictEqual(
    lazy.AdsClient.isEnabled({
      trainhopConfig: { adsClient: { enabled: true } },
    }),
    true,
    "Enabled by trainhopConfig.adsClient.enabled"
  );

  Assert.strictEqual(
    lazy.AdsClient.isEnabled({
      trainhopConfig: { adsClient: { enabled: false } },
    }),
    false,
    "Disabled when trainhopConfig.adsClient.enabled is false"
  );
});

add_task(function test_getClient_singleton() {
  const adsClient = new lazy._AdsClient();

  const client = adsClient.getClient();
  Assert.ok(client, "getClient builds and returns a MozAdsClient");

  const sameClient = adsClient.getClient();
  Assert.strictEqual(
    sameClient,
    client,
    "getClient returns the same cached singleton"
  );
});

add_task(function test_buildTelemetry_recordsToGlean() {
  Services.fog.testResetFOG();

  const telemetry = new lazy._AdsClient().buildTelemetry();

  telemetry.recordBuildCacheError("empty_db_path", "the db path is empty");
  Assert.equal(
    Glean.adsClient.buildCacheError.empty_db_path.testGetValue(),
    "the db path is empty",
    "recordBuildCacheError sets ads_client.build_cache_error"
  );

  telemetry.recordClientError("request_ads", "network error");
  Assert.equal(
    Glean.adsClient.clientError.request_ads.testGetValue(),
    "network error",
    "recordClientError sets ads_client.client_error"
  );

  telemetry.recordClientOperationTotal("request_ads");
  telemetry.recordClientOperationTotal("request_ads");
  Assert.equal(
    Glean.adsClient.clientOperationTotal.request_ads.testGetValue(),
    2,
    "recordClientOperationTotal increments ads_client.client_operation_total"
  );

  telemetry.recordDeserializationError("invalid_ad_item", "expected an object");
  Assert.equal(
    Glean.adsClient.deserializationError.invalid_ad_item.testGetValue(),
    "expected an object",
    "recordDeserializationError sets ads_client.deserialization_error"
  );

  telemetry.recordHttpCacheOutcome("hit", "");
  Assert.equal(
    Glean.adsClient.httpCacheOutcome.hit.testGetValue(),
    "",
    "recordHttpCacheOutcome sets ads_client.http_cache_outcome"
  );

  // trim_failed is emitted by MozAdsTelemetryWrapper but was missing from the
  // component's own label list, so make sure it does not land in __other__.
  telemetry.recordHttpCacheOutcome("trim_failed", "trim boom");
  Assert.equal(
    Glean.adsClient.httpCacheOutcome.trim_failed.testGetValue(),
    "trim boom",
    "trim_failed is a declared label"
  );
  Assert.equal(
    Glean.adsClient.httpCacheOutcome.__other__.testGetValue(),
    null,
    "no label overflowed into __other__"
  );
});

// A trainhopped New Tab can run on a Firefox whose libxul predates these
// metrics, and the runtime registration that backfills them is not awaited.
add_task(function test_buildTelemetry_survivesMissingMetrics() {
  Services.fog.testResetFOG();

  const telemetry = new lazy._AdsClient().buildTelemetry(() => undefined);

  telemetry.recordBuildCacheError("empty_db_path", "boom");
  telemetry.recordClientError("request_ads", "boom");
  telemetry.recordClientOperationTotal("request_ads");
  telemetry.recordDeserializationError("invalid_ad_item", "boom");
  telemetry.recordHttpCacheOutcome("hit", "");

  // Reaching here means nothing threw. Also check nothing fell back to the
  // real category behind our back.
  Assert.equal(
    Glean.adsClient.clientError.request_ads.testGetValue(),
    null,
    "no string metric recorded when ads_client is not registered"
  );
  Assert.equal(
    Glean.adsClient.clientOperationTotal.request_ads.testGetValue(),
    null,
    "no counter incremented when ads_client is not registered"
  );
});

// The category is resolved per recording, so metrics registered after the
// client was built are still picked up.
add_task(function test_buildTelemetry_resolvesMetricsLate() {
  Services.fog.testResetFOG();

  let category;
  const telemetry = new lazy._AdsClient().buildTelemetry(() => category);

  telemetry.recordClientError("report_ad", "dropped while unregistered");
  Assert.equal(
    Glean.adsClient.clientError.report_ad.testGetValue(),
    null,
    "recordings before registration are dropped"
  );

  category = Glean.adsClient;
  telemetry.recordClientError("report_ad", "recorded once available");

  Assert.equal(
    Glean.adsClient.clientError.report_ad.testGetValue(),
    "recorded once available",
    "the late-registered category is used without rebuilding the client"
  );
});

add_task(async function test_getClient_doesNotLeakUniffiCallbacks() {
  // Regression guard for the retain cycle that backed out bug 2057317: the
  // context-id provider must not hold a reference back to the _AdsClient,
  // otherwise the MozAdsClient (and the telemetry callback it also holds) is
  // pinned past xpcom-shutdown and trips the UniFFI callback-leak assertion.
  // That assertion is debug/ASan-only, so this test checks the handle maps
  // directly to also catch the leak on opt builds.
  const { UnitTestObjs } = ChromeUtils.importESModule(
    "moz-src:///toolkit/components/uniffi-bindgen-gecko-js/components/generated/RustAdsClient.sys.mjs"
  );
  const telemetryHandler =
    UnitTestObjs.uniffiCallbackHandlerAdsClientMozAdsTelemetry;
  const providerHandler =
    UnitTestObjs.uniffiCallbackHandlerAdsClientMozAdsContextIdProvider;

  // Build the client in a scope we can fully release, so the only thing that
  // could keep it alive is a stray reference from one of its own callbacks.
  (() => {
    const adsClient = new lazy._AdsClient();
    const client = adsClient.getClient();
    Assert.ok(client, "AdsClient: built a client for the leak check");
    Assert.ok(
      telemetryHandler.hasRegisteredCallbacks(),
      "AdsClient: telemetry callback is registered while the client is alive"
    );
  })();

  // Once every JS reference is gone the client must be collectable, so Rust
  // drops it and deregisters both callbacks. GC/CC are nudged each poll to
  // drive the native finalizer that releases the Rust object.
  await TestUtils.waitForCondition(() => {
    Cu.forceGC();
    Cu.forceCC();
    return (
      !telemetryHandler.hasRegisteredCallbacks() &&
      !providerHandler.hasRegisteredCallbacks()
    );
  }, "AdsClient: UniFFI callbacks deregister once the dropped client is GC'd");
});
