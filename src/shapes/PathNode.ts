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
import {List} from './List.js';

/**
 * Operator node for SHACL property paths that are NOT a simple predicate or a sequence:
 * inverse (`sh:inversePath`), alternative (`sh:alternativePath` → an `rdf:List`), and the
 * cardinality forms (`sh:zeroOrMorePath`/`sh:oneOrMorePath`/`sh:zeroOrOnePath`).
 *
 * Each operator edge is `contains` (the operand subtree is owned), and the node itself is
 * `dependent`, so a property-shape's complex `sh:path` cascade-cleans on delete/replace.
 * Operands are polymorphic (a predicate IRI, a nested `PathNode`, or a `List`), so no fixed
 * `valueShape` is declared except for `alternativePath`, which is always an `rdf:List`.
 */
// Named explicitly: the class shares its name with the ontology term coreOntology.PathNode,
// and a bundler resolving that collision renames the class (PathNode2), which would change
// the shape's IRI.
@linkedShape({name: 'PathNode', dependent: true})
export class PathNode extends Shape {
  static targetClass = coreOntology.PathNode;

  @objectProperty({path: shacl.inversePath, maxCount: 1, contains: true})
  get inversePath(): unknown {
    return null;
  }

  @objectProperty({path: shacl.alternativePath, maxCount: 1, shape: List, contains: true})
  get alternativePath(): List {
    return null;
  }

  @objectProperty({path: shacl.zeroOrMorePath, maxCount: 1, contains: true})
  get zeroOrMorePath(): unknown {
    return null;
  }

  @objectProperty({path: shacl.oneOrMorePath, maxCount: 1, contains: true})
  get oneOrMorePath(): unknown {
    return null;
  }

  @objectProperty({path: shacl.zeroOrOnePath, maxCount: 1, contains: true})
  get zeroOrOnePath(): unknown {
    return null;
  }
}
