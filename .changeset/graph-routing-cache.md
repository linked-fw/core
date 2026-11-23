---
"@_linked/core": minor
---

Graph routing is faster: `graphRoutingFor(dataset)` keeps the routing of each dataset and hands it out again until its inputs change, instead of resolving every route and scanning every registered shape on each read, write and live-query check. A delete by id no longer walks every path of a `contains` cycle to find the graphs that may link to its subject (about 12 ms per delete with 300 shapes with dense ownership; now about 50 µs once the routing is kept, 1.7 ms when it is rebuilt). The read sets and graphs are the same as before.

The routing of a dataset is rebuilt on its next use when a route is set or unset (`setShapeGraphs`, `unsetShapeGraph`, `LinkedStorage.setDatasetForShapes(…, {graph})`), when any shape is registered or re-registered, or when the dataset's data root changes. A shape changed in place (its `NodeShapeData` edited without registering it again) is not seen: change a shape, then re-register it (`registerRuntimeShape`, or the class registration). The arrays `readGraphsForShape` and `referringGraphsForShape` return are now frozen, since every caller shares them: code that calls them directly copies one before changing it. The IR a store builds (`writeGraphs`) gets its own copy, as before.
