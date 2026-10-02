---
summary: Adds the preservePath file-store contract for generated release artifacts whose manifest object keys must remain exact.
---

# Preserved file-store paths

## Outcome

`SaveFileOptions` now exposes an optional `preservePath` flag. It is intended for generated artifacts—particularly
application releases—whose URLs already contain an exact object key recorded in a manifest.

## Contract

When `preservePath` is `true`, an `IFileStore` implementation must do one of two things:

1. store the supplied safe object key verbatim; or
2. reject the key.

It must not silently lowercase, sanitise, suffix, or otherwise rewrite the key. Bundle chunk references are generated
before publication, so changing a key during storage produces a release whose own URLs do not resolve.

Filesystem-backed implementations must reject absolute paths, traversal segments, and platform-specific paths that
could escape the configured storage root. The option is not a bypass for path safety.

## Intended usage

```ts
await releaseStore.saveFile(
  'releases/1.2.3/public/bundles/main-AbC123.js',
  bytes,
  {
    mimeType: 'application/javascript',
    preservePath: true,
    preventDuplicates: false,
  },
);
```

Ordinary browser/user uploads should leave `preservePath` unset. Those inputs continue through each store's normal
filename hygiene and duplicate behavior.

## Package responsibilities

- `@_linked/core` owns the portable `SaveFileOptions` contract.
- Each concrete file-store package validates and implements the contract for its backend.
- Release publishers opt in only after validating their manifest paths.

`@_linked/server` implements this behavior for `LocalFileStore`; object-store implementations can preserve safe object
keys according to their own platform rules.

## Compatibility

The field is optional, so existing callers and implementations remain source-compatible. Stores that do not yet honor
the flag must be upgraded before they are used as exact-key release destinations.

## Validation

The full Jest run completed 1,938 tests successfully but two Fuseki shape-sync cases exceeded their five-second timeout
while the suite ran in parallel. The affected suite passed all three cases when rerun alone. Package test typechecking,
the production build, and whitespace validation pass. Concrete exact-path and unsafe-path behavior is tested by the
`@_linked/server` `LocalFileStore` suite.

## REVIEW

The interface addition is intentionally narrow and contains no storage implementation logic. Documentation makes the
security boundary explicit: exact preservation applies only after path validation. The change is ready for a minor
release because it adds a backward-compatible public option.
