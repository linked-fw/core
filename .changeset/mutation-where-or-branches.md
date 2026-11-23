---
'@_linked/core': patch
---

**Behaviour change:** a delete or update where with `or` or `isNotDefined()` now deletes or updates more subjects than before: the ones it always described. For example, `Person.deleteWhere((p) => p.hobby.isNotDefined())` used to delete nothing and now deletes every person without a hobby. Review such mutations before upgrading.

A delete or update where (`deleteWhere`, `DeleteBuilder.from(…).where`, `update(…).where`) with `or` changed too few subjects: every triple it read was required, so `deleteWhere((p) => p.name.equals('Bob').or(p.bestFriend.hobby.equals('Golf')))` skipped Bob when he had no best friend, and `p.hobby.isNotDefined()` matched nothing. A property or relation only some branches read, or one `isNotDefined()` reads, is now optional, as in a select's where.
