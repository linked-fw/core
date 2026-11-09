---
"@_linked/core": minor
---

A node in a query, the root subject or a relation's value, has `isIri()` and `isBlank()` (SPARQL `isIRI` / `isBlank`): `.where((p) => p.isIri())` keeps the named subjects, `.minus((p) => p.isBlank())` leaves out the blank nodes, and `p.bestFriend.isBlank()` tests a relation's value. On a paged select the filter applies inside the page of subjects, before its LIMIT, so a page holds as many named subjects as asked.
