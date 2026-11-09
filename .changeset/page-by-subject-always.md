---
"@_linked/core": patch
---

`limit`/`offset` and `.one()` now page over subjects whenever a row carries any value besides its subject, whatever the path's declared `maxCount`. Data can hold more values than its shape allows (a `maxCount: 1` label in two languages); a row LIMIT then counted such a subject twice, so a page held fewer subjects than asked. Ties on the sort key are broken by the subject IRI on every page, and an `offset` without an `orderBy` pages in subject order, so consecutive pages neither repeat nor skip a subject. A select of subjects only keeps its plain LIMIT.
