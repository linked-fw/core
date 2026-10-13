/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {linkedShape} from '../package.js';
import {Shape} from './Shape.js';
import {objectProperty} from './SHACL.js';
import {shacl} from '../ontologies/shacl.js';
import {coreOntology} from '../ontologies/linked-core.js';
import {PathList} from './PathList.js';

/**
 * Operator node for SHACL property paths that are NOT a simple predicate or a sequence:
 * inverse (`sh:inversePath`), alternative (`sh:alternativePath` → an `rdf:List`), and the
 * cardinality forms (`sh:zeroOrMorePath`/`sh:oneOrMorePath`/`sh:zeroOrOnePath`).
 *
 * Every slot is `sh:BlankNodeOrIRI`, as is `PropertyShape.path`, so an operator node written
 * without an id is an untyped blank node: the only form SHACL §2.3.1 defines, a blank node that is
 * the subject of exactly one triple (see `serializePathToNodeData`). The blank-node cascade
 * follows these blank-capable slots on delete / replace. The class stays `dependent`, with
 * `contains` slots and its `core:PathNode` type, for the IRI-named, typed nodes versions before
 * 2.30 wrote: the typed cascade removes those on the next sync.
 * Operands are polymorphic (a predicate IRI, a nested `PathNode`, or a `PathList`), so no fixed
 * `valueShape` is declared except for `alternativePath`, which is always a `PathList`.
 */
const BLANK_OR_IRI = shacl.BlankNodeOrIRI;

// Named explicitly: the class shares its name with the ontology term coreOntology.PathNode,
// and a bundler resolving that collision renames the class (PathNode2), which would change
// the shape's IRI.
@linkedShape({name: 'PathNode', dependent: true})
export class PathNode extends Shape {
  static targetClass = coreOntology.PathNode;

  @objectProperty({path: shacl.inversePath, maxCount: 1, contains: true, nodeKind: BLANK_OR_IRI})
  get inversePath(): unknown {
    return null;
  }

  @objectProperty({
    path: shacl.alternativePath,
    maxCount: 1,
    shape: PathList,
    contains: true,
    nodeKind: BLANK_OR_IRI,
  })
  get alternativePath(): PathList {
    return null;
  }

  @objectProperty({path: shacl.zeroOrMorePath, maxCount: 1, contains: true, nodeKind: BLANK_OR_IRI})
  get zeroOrMorePath(): unknown {
    return null;
  }

  @objectProperty({path: shacl.oneOrMorePath, maxCount: 1, contains: true, nodeKind: BLANK_OR_IRI})
  get oneOrMorePath(): unknown {
    return null;
  }

  @objectProperty({path: shacl.zeroOrOnePath, maxCount: 1, contains: true, nodeKind: BLANK_OR_IRI})
  get zeroOrOnePath(): unknown {
    return null;
  }
}
