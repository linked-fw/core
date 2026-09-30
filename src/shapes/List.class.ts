/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {Shape} from './Shape.js';
import {linkedProperty, objectProperty} from './SHACL.js';
import {rdf} from '../ontologies/rdf.js';

/**
 * SHACL/RDF ordered-list cell shape (`rdf:List`).
 *
 * A list is a chain of cells: `first` holds the value, `rest` points to the next cell
 * (or `rdf:nil`). The cell is `dependent` (it has no independent existence) and `rest` is
 * a `contains` edge, so deleting/replacing a list cascade-cleans the whole spine — while
 * `first` is NOT a `contains` edge, so the list's *contents* (shared IRIs/values) are kept.
 *
 * This module holds the class only, and must never import `package.js`: `utils/Package.ts`
 * imports it to register `List` by value (as it does NodeShape and PropertyShape) and to use
 * it as the value shape of `PropertyShape.in`. Importing `package.js` from here would be a
 * cycle, with `corePackage` still uninitialised when this module evaluates. The public module
 * is `List.ts`, which loads the registration.
 */
export class List<T = unknown> extends Shape {
  static targetClass = rdf.List;

  @linkedProperty({path: rdf.first, maxCount: 1})
  get first(): T {
    return null;
  }

  @objectProperty({path: rdf.rest, maxCount: 1, shape: List, contains: true})
  get rest(): List<T> {
    return null;
  }
}
