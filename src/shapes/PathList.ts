/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {linkedShape} from '../package.js';
import {Shape} from './Shape.js';
import {objectProperty} from './SHACL.js';
import {shacl} from '../ontologies/shacl.js';
import {rdf} from '../ontologies/rdf.js';

/**
 * A blank `rdf:List` cell of SHACL structure core writes: the members of a sequence path and the
 * operand of `sh:alternativePath`.
 *
 * Both properties are `sh:BlankNodeOrIRI`, so a cell written without an id is a blank node, and so
 * is an operator node (`PathNode`) held by `first`. That keeps a sequence path a blank list, which
 * SHACL §2.3.1 needs: an IRI as the `sh:path` value is a predicate path.
 *
 * It is a separate shape from `List` on purpose. `List.first` also holds literals (`sh:in`), so it
 * cannot be declared node-only, and making `List.rest` blank-capable would turn the tail cells of
 * every list built without ids into blank nodes. Both shapes target `rdf:List`; `List` is
 * registered first, so a lookup by `rdf:List` still returns `List`. `PathList` declares
 * `sharedTargetClass`, so the shape check does not report it as borrowing `List`'s class.
 */
@linkedShape({name: 'PathList', sharedTargetClass: true})
export class PathList extends Shape {
  static targetClass = rdf.List;

  /**
   * A predicate IRI, or an operator node (`PathNode`). Not `contains`: a predicate IRI is
   * shared. The blank-node cascade follows it, because it is blank-capable.
   */
  @objectProperty({path: rdf.first, maxCount: 1, nodeKind: shacl.BlankNodeOrIRI})
  get first(): unknown {
    return null;
  }

  @objectProperty({
    path: rdf.rest,
    maxCount: 1,
    shape: PathList,
    contains: true,
    nodeKind: shacl.BlankNodeOrIRI,
  })
  get rest(): PathList {
    return null;
  }
}
