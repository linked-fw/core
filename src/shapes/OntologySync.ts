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
 * What the ontology sync (`@_linked/core/ontology/syncOntologies`) last wrote into a dataset for
 * one package: the package's class hierarchy as sorted N-Triples lines and their content hash.
 * One node per package, at `https://linked.cm/ont/core/ontologySync/<encodeURIComponent(name)>`.
 * A built-in shape: every dataset holds it, like the SHACL metamodel.
 *
 * @deprecated The sync writes package ontology graphs; this node is written only by its
 * default-graph fallback (a store without graph queries), and removed by the sync once the
 * package's graph is written.
 */
// Named explicitly: the class shares its name with the ontology term coreOntology.OntologySync.
@linkedShape({
  name: 'OntologySync',
  description:
    'What the ontology sync last wrote into this dataset for one package: its rdfs:subClassOf triples and their hash. (ontology sync, class hierarchy)',
})
export class OntologySync extends Shape {
  static targetClass = coreOntology.OntologySync;

  /** The npm name of the package. */
  @literalProperty({path: coreOntology.packageName, datatype: xsd.string, maxCount: 1})
  get packageName(): string {
    return null;
  }

  /** SHA-256 (hex) of `linked-ontology-sync/1\n` + `ontologyTriples`. */
  @literalProperty({path: coreOntology.ontologyHash, datatype: xsd.string, maxCount: 1})
  get ontologyHash(): string {
    return null;
  }

  /** The package's `rdfs:subClassOf` triples as sorted N-Triples lines, joined with `\n`. */
  @literalProperty({path: coreOntology.ontologyTriples, datatype: xsd.string, maxCount: 1})
  get ontologyTriples(): string {
    return null;
  }
}
