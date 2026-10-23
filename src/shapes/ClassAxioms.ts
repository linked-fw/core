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
 * The write side of the ontology sync: a class's `rdfs:subClassOf` edges, updated one class at a
 * time. Core-internal. It has **no targetClass** on purpose: an update by id never writes
 * `rdf:type`, so the sync adds and removes hierarchy triples without typing the class, and the
 * shape takes no part in class resolution or the shape check. Not a built-in, so shape sync
 * never writes it into a dataset.
 *
 * Used by the sync's default-graph fallback and by the removal of what that fallback wrote.
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
