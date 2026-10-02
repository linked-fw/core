---
"@_linked/core": minor
---

Add `SaveFileOptions.preservePath` for generated release artifacts whose object keys must remain identical to their manifest paths. File-store implementations should store safe keys verbatim and reject absolute or traversal paths instead of silently sanitising them.
