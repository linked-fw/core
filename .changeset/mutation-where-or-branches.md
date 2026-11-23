---
'@_linked/core': patch
---

A delete or update where (`deleteWhere`, `DeleteBuilder.from(…).where`, `update(…).where`) with `or` changed too few subjects: every triple it read was required, so `deleteWhere((p) => p.name.equals('Bob').or(p.bestFriend.hobby.equals('Golf')))` skipped Bob when he had no best friend, and `p.hobby.isNotDefined()` matched nothing. A property or relation only some branches read, or one `isNotDefined()` reads, is now optional, as in a select's where.
