---
summary: Makes public asset URL resolution configurable and idempotent across development hosts and published releases.
---

# Configurable asset directory resolution

## Outcome

`asset()` now avoids inserting the same asset directory more than once and
supports a process-wide default directory configured through
`LinkedFileStorage`. This lets hosts select the URL layout they actually serve
without requiring components to know whether files live at the URL root or
under `/public`.

The existing default remains `/public`, so current consumers keep their prior
URL layout unless they opt into another directory.

## Public API

`LinkedFileStorage` adds two static methods:

- `setDefaultAssetDirectory(directory: string): string` configures the default
  directory used by `asset()` and returns the normalized value.
- `getDefaultAssetDirectory(): string` returns the current default.

Trailing slashes are removed when a directory is configured or passed directly
to `asset()`. An empty string is valid and means that relative asset paths are
served directly below the access URL.

```ts
LinkedFileStorage.setDefaultAccessURL('http://localhost:4000');
LinkedFileStorage.setDefaultAssetDirectory('');

asset('/images/banner.webp');
// http://localhost:4000/images/banner.webp
```

The optional `directory` argument still overrides the default for one call:

```ts
asset('/images/banner.webp', '/assets');
// http://localhost:4000/assets/images/banner.webp
```

## Resolution contract

`asset(path, directory?)` applies these rules in order:

1. Fully qualified HTTP(S), protocol-relative, `data:`, and `blob:` URLs pass
   through unchanged.
2. The explicit directory is used when provided; otherwise the configured
   default is used.
3. Trailing slashes are removed from the selected directory.
4. If the relative path already equals or starts with that directory, the
   helper adds only the access URL.
5. Otherwise it combines the access URL, directory, and path.

This makes repeated resolution safe. With the default configuration, resolving
`/images/banner.webp` produces `/public/images/banner.webp`, and resolving that
result again does not produce `/public/public/images/banner.webp`.

## Design decisions

The directory belongs to `LinkedFileStorage` because the access URL is already
configured there and both values describe the host's public file layout. A
component-level option would require every shared image component to reproduce
environment logic and would not protect nested calls.

The default remains `/public` to preserve existing behavior. Root-served hosts
must opt in with an empty directory during startup. The helper does not infer
the environment or inspect host names.

Idempotency is limited to the selected directory boundary. For example,
`/publicity/image.webp` is not treated as already containing `/public`.

## Files and responsibilities

- `src/utils/LinkedFileStorage.ts` owns directory configuration, normalization,
  and asset URL resolution.
- `src/tests/core-utils.test.ts` covers default and configured directories,
  repeated resolution, empty access URLs, trailing slashes, and URL passthrough.
- `README.md` documents startup configuration and resolution behavior.

## Compatibility

This is a backward-compatible public API addition. Existing calls keep using
`/public`. Explicit `asset(path, directory)` calls keep overriding the default;
their only behavioral refinement is removal of trailing directory slashes.

## Validation

The package test suite, TypeScript checks, declaration checks, and production
compile are the required release validation. The focused asset tests also guard
the process-wide configuration reset so results do not depend on test order.

## Known limits

`LinkedFileStorage` configuration is process-wide and should be set during
startup, before rendering asset URLs. The helper continues to expect relative
asset paths to begin with `/`, matching its existing contract.

## Pull request

[linked-fw/core#342](https://github.com/linked-fw/core/pull/342)

## REVIEW

The implementation was rebased onto the current `main`. Review found and fixed
test state leaking between cases and double slashes from directories ending in
`/`. The public contract and compatibility behavior are documented, and the
change is ready for a patch release after the release checks pass.
