---
'@_linked/core': minor
---

Sorting never drops an instance, and an instance without a value for a sort key sorts after every instance with one, ascending and descending, for direct and nested paths alike (paged and unpaged selects, `.one()`, and a grouped select's `orderBy`). **Visible change:** an `orderBy` on a direct path used to put instances without the value first when ascending; they now come last. An `orderBy` on a nested path (`p.bestFriend.name`, `p.friends.name`) used to return only the instances that have it; it now returns them all. The SPARQL lowering makes a sort path's traversal OPTIONAL and puts `DESC(BOUND(?k))` before each key.

Also fixed: an unpaged select whose `where` holds an aggregate (`p.friends.size().equals(2)`) next to a multi-valued projection applied it per row and matched nobody; it now applies it per instance, through the same sub-SELECT of subjects a page uses. A multi-valued field of a nested entity (`Person.select((p) => p.bestFriend.nickNames)`) mapped to one value; it is now the array of all its values.
