---
'@_linked/core': patch
---

Subpath imports written with a `.js` extension (`@_linked/core/<path>.js`) now resolve. The exports map had no `./*.js` entry, so `./*` turned them into `<path>.js.js` and Node, Vite and TypeScript (node16/bundler) all failed to find them. This matches the exports map of the other Linked packages.
