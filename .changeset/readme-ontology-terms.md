---
'@_linked/core': patch
---

README: new "Using ontology terms" section (under Shapes). Import a vocabulary module as a
namespace (`import * as schema from '@_linked/schema/ontologies/schema'`), prefer its accessors
over `{id}`, and use `{id}` only for a namespace without a module. No code changed.
