import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {createNameSpace} from '../utils/NameSpace.js';
import {Prefix} from '../utils/Prefix.js';
// Through the package specifier, not a relative path: the `browser` and `react-native` export
// conditions of this subpath give a client build the stub, and a relative import ignores them.
import {loadOntologyFiles} from '@_linked/core/ontology/loadOntologyFiles';

/** This ontology's data, relative to this module (Turtle, copied into `lib/` by the build). */
export const dataFiles = ['../data/core.ttl'];

/** Reads this ontology's data (server only). */
export const loadData = () => loadOntologyFiles(import.meta.url, dataFiles);

// The @_linked/core framework vocabulary. First-party ontology IRIs follow Create Now
// arch-02 §"Public ontology namespace":
//   https://linked.cm/ont/{ontologySlug}/{localName}
// where ontologySlug defaults to the owning package's publicSlug (`@_linked/core` -> `core`)
// and the prefix label equals the ontologySlug. Previously `https://linked.cm/ont/linked-core/`
// (prefix `linked_core`), a leftover of a reverted slug derivation.
export const ns = createNameSpace('https://linked.cm/ont/core/');
export const _self: NodeReferenceValue = ns('');
// @deprecated prefix alias: keeps `linked_core:` prefixed names resolving (to the NEW IRIs).
// It does not make the old full IRIs match. Registered BEFORE `core` because the last add
// wins for IRI -> prefix compaction, so output always uses `core:`.
Prefix.add('linked_core', _self.id);
Prefix.add('core', _self.id);

const Package = ns('Package');
// The kinds of package (`rdfs:subClassOf core:Package`): one that holds an ontology (and may carry
// shapes for its own terms), and one that holds assets.
const OntologyPackage = ns('OntologyPackage');
const AssetPackage = ns('AssetPackage');
const ShapeClass = ns('ShapeClass');
const definesShape = ns('definesShape');
const moduleProperty = ns('module');
const usesShapeClass = ns('usesShapeClass');
const editInline = ns('editInline');
const isExtending = ns('isExtending');

// Containment / lifecycle vocabulary.
//   contains  — property characteristic: the subject owns the value through this property
//               (composition); the owned walk follows it.
//   dependent — shape characteristic, deprecated: no effect (persisted for older shapes).
//   PathNode  — class for SHACL property-path operator nodes (sh:inversePath/alternativePath/…).
const contains = ns('contains');
const dependent = ns('dependent');
const PathNode = ns('PathNode');

// Display vocabulary. SHACL has `sh:order` and `sh:group`, which say how properties
// are arranged; it has no way to say how *important* a property is, which is what a
// renderer needs when it can only show one, three or six of them. `displayRank` is
// that: a single linear rank per property, lower = more important, from which every
// truncated context ("show the top 3") derives. `displayHidden` removes a property
// from generic rendering without changing its cardinality or its meaning.
//
// Placement is deliberate (backlog-029): this is an ecosystem SHACL extension that
// materializes onto the pure `sh:NodeShape` and therefore travels with an ejected
// app — NOT the CN-proprietary `code:` vocab, which describes source-code structure.
const displayRank = ns('displayRank');
const displayHidden = ns('displayHidden');

// Provenance marker: a NodeShape core generates at sync time from another shape's code
// (today the `<propertyShape>.singleOwner` constraint derived from `contains`), rather than one a
// developer declared. Catalog readers skip shapes with `core:generated true`.
const generated = ns('generated');

// Ownership edge from a NodeShape to the shapes core generated from it at sync time (the
// single-owner constraint of each `contains` property). It is `contains`, so deleting the
// shape deletes them, and sync writes them nested in the shape's own create.
const generatedShape = ns('generatedShape');

// Content hash of everything shape sync writes for a NodeShape (the shape, its property shapes,
// lists, paths and generated shapes), stored on the NodeShape. A sync skips a shape whose stored
// hash equals the hash of what it would write.
const shapeHash = ns('shapeHash');

// A NodeShape that shares its targetClass on purpose (`@linkedShape({sharedTargetClass: true})`),
// so the shape check does not report it as borrowing another shape's class.
const sharedTargetClass = ns('sharedTargetClass');

// Ontology sync (`syncOntologies`): in the `'default'` graph mode one `core:OntologySync` node in
// the default graph records the combined hash of the ontology written there (`core:ontologyHash`),
// so an unchanged ontology is skipped.
const OntologySync = ns('OntologySync');
const ontologyHash = ns('ontologyHash');

// Named graphs (`shapes/NamedGraph.ts`): the classes of graph-registry records (each
// `rdfs:subClassOf sd:NamedGraph`) and the record fields core adds to SPARQL Service Description.
const OntologyGraph = ns('OntologyGraph');
const ShapesGraph = ns('ShapesGraph');
const DraftGraph = ns('DraftGraph');
const contentHash = ns('contentHash');
const feedsHierarchy = ns('feedsHierarchy');
const packageTerm = ns('package');
const version = ns('version');
// A shared ontology or shape graph (one graph for every package, `utils/graphTargets.ts`) records
// each package's part as `"{npm name} {sha256 hex}"`.
const packageHash = ns('packageHash');

export const coreOntology = {
  Package,
  OntologyPackage,
  AssetPackage,
  ShapeClass,
  definesShape,
  module: moduleProperty,
  usesShapeClass,
  editInline,
  isExtending,
  contains,
  dependent,
  PathNode,
  displayRank,
  displayHidden,
  generated,
  generatedShape,
  shapeHash,
  sharedTargetClass,
  OntologySync,
  ontologyHash,
  OntologyGraph,
  ShapesGraph,
  DraftGraph,
  contentHash,
  feedsHierarchy,
  package: packageTerm,
  version,
  packageHash,
};
