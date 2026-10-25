---
"@_linked/core": minor
---

Client builds no longer contain `loadOntologyFiles`'s dynamic `import()`. `@_linked/core/ontology/loadOntologyFiles` has `browser` and `react-native` export conditions that resolve to a stub, which rejects with a "server only" error; Node (`import`/`default`) still gets the real module. Core's own ontology modules now import it by that package specifier, so a Vite browser build or a Metro (Expo) export of an app on core has no `import(variable)` from it, and a React Native app no longer needs a Babel plugin to compile with Hermes.

A test environment that sets the `browser` condition (jest's `jsdom` environment, Vitest's browser environments) gets the stub too, so `loadData()` rejects there; run such tests with a Node environment.
