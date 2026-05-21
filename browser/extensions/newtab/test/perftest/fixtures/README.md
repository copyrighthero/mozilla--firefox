# AC-64 fixtures

Hard-coded MARS-shape and UAPI-shape ad responses used by the
[Dim 3 cold-cache benchmark](../perftest_adsClient_dim3.js).

## Why two files, not one

Phase 1 deliberately keeps the two shapes in separate files even though
they happen to be byte-identical for the tile case. Unification (single
seed + two handler wrappers) is a Phase 2 cleanup; this layout is
optimized for getting one number on the board first.

## What's intentional

- **Ports are `:0` placeholders**. The HttpServer in `head.js` picks a
  random port at startup; the benchmark harness rewrites these URLs
  before serving. Don't trust the literal port.
- **`block_key`, `name`, and `url` deliberately differ between the two
  files** so any mix-up (JS path served MARS-shape, or vice versa) is
  immediately visible in failed assertions.
- **Only tiles, no spocs**. Spoc fixtures and the `requestSpocAds`
  benchmark are deferred to Phase 2. Tiles are the highest-frequency
  ad surface and the simplest data shape.

## Wire format reference

Both clients parse a flat top-level object keyed by placement_id, each
value an array of ad records:

```
{
  "<placement_id>": [{ ...ad-record-fields }],
  ...
}
```

The MARS-side struct definitions are in
`third_party/application-services/components/ads-client/src/mars/ad_response.rs`
(`AdTile`, `AdSpoc`, `AdImage`, `AdCallbacks`). The JS-side normalization
is in `browser/extensions/newtab/lib/AdsFeed.sys.mjs` (`_normalizeTileData`).
