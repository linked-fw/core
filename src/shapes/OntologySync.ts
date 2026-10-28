/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {linkedShape} from '../package.js';
import {Shape} from './Shape.js';
import {literalProperty} from './SHACL.js';
import {coreOntology} from '../ontologies/linked-core.js';
import {xsd} from '../ontologies/xsd.js';

/**
 * The record the `'default'` graph mode of the ontology sync (`@_linked/core/ontology/syncOntologies`)
 * keeps in the default graph: the combined hash of the ontology it last wrote there, on one node
 * (`DEFAULT_GRAPH_ONTOLOGY_NODE`), so an unchanged ontology is skipped. A built-in shape: every
 * dataset holds it, like the SHACL metamodel.
 */
// Named explicitly: the class shares its name with the ontology term coreOntology.OntologySync.
@linkedShape({
  name: 'OntologySync',
  description:
    "The combined hash of the ontology the 'default' graph mode of ontology sync last wrote into the default graph. (ontology sync)",
})
export class OntologySync extends Shape {
  static targetClass = coreOntology.OntologySync;

  /** The combined hash (`defaultGraphOntologyHash`). */
  @literalProperty({path: coreOntology.ontologyHash, datatype: xsd.string, maxCount: 1})
  get ontologyHash(): string {
    return null;
  }
}
