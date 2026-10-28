/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {linkedShape} from '../package.js';
import {Shape} from './Shape.js';
import {objectProperty} from './SHACL.js';
import {rdfs} from '../ontologies/rdfs.js';

/**
 * A class's `rdfs:subClassOf` edges, updated one class at a time: how the hierarchy probe writes
 * and removes its default-graph axiom. Core-internal. It has **no targetClass** on purpose: an update by id of such a shape never
 * writes `rdf:type` nor requires one (an update of a shape with a targetClass changes only a typed
 * node), so the probe adds and removes a hierarchy triple without typing the class, and the
 * shape takes no part in class resolution or the shape check. Not a built-in, so shape sync
 * never writes it into a dataset.
 *
 * @internal
 */
@linkedShape({name: 'ClassAxioms'})
export class ClassAxioms extends Shape {
  // The values are class IRIs, written as references; `Shape` is the metamodel's convention for
  // an IRI-valued property with no shape of its own (as `NodeShape.targetClass`).
  @objectProperty({path: rdfs.subClassOf, shape: Shape})
  get subClassOf(): unknown {
    return null;
  }
}
