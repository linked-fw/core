---
"@_linked/core": patch
---

Make `asset()` idempotent when a path already contains its asset directory and
add `LinkedFileStorage.setDefaultAssetDirectory()` and
`LinkedFileStorage.getDefaultAssetDirectory()` for hosts that serve public
files outside the default `/public` path. Set the default directory to an empty
string during startup when assets are served from the URL root. See the file
storage section in `README.md` for configuration and resolution examples.
