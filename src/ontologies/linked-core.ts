/*
 * The @_linked/core framework vocabulary: its terms, each with its full IRI. First-party ontology
 * IRIs follow the public ontology namespace `https://linked.cm/ont/{name}/{localName}`.
 *
 * Registered (with its data, `../data/core.ttl`) by `./index.ts`. This module holds only terms and
 * imports nothing; the `core` prefix it suggests is data (`vann:preferredNamespacePrefix`), and an
 * app adds it to its own prefix map.
 */

const Package = {id: 'https://linked.cm/ont/core/Package'};
// The kinds of package (`rdfs:subClassOf core:Package`): one that holds an ontology (and may carry
// shapes for its own terms), and one that holds assets.
const OntologyPackage = {id: 'https://linked.cm/ont/core/OntologyPackage'};
const AssetPackage = {id: 'https://linked.cm/ont/core/AssetPackage'};
const ShapeClass = {id: 'https://linked.cm/ont/core/ShapeClass'};
const definesShape = {id: 'https://linked.cm/ont/core/definesShape'};
const moduleProperty = {id: 'https://linked.cm/ont/core/module'};
const usesShapeClass = {id: 'https://linked.cm/ont/core/usesShapeClass'};
const editInline = {id: 'https://linked.cm/ont/core/editInline'};
const isExtending = {id: 'https://linked.cm/ont/core/isExtending'};

// Containment / lifecycle vocabulary.
//   contains  — property characteristic: the subject owns the value through this property
//               (composition); the owned walk follows it.
//   dependent — shape characteristic, deprecated: no effect (persisted for older shapes).
//   PathNode  — class for SHACL property-path operator nodes (sh:inversePath/alternativePath/…).
const contains = {id: 'https://linked.cm/ont/core/contains'};
const dependent = {id: 'https://linked.cm/ont/core/dependent'};
const PathNode = {id: 'https://linked.cm/ont/core/PathNode'};

// Display vocabulary. SHACL has `sh:order` and `sh:group`, which say how properties
// are arranged; it has no way to say how *important* a property is, which is what a
// renderer needs when it can only show one, three or six of them. `displayRank` is
// that: a single linear rank per property, lower = more important, from which every
// truncated context ("show the top 3") derives. `displayHidden` removes a property
// from generic rendering without changing its cardinality or its meaning.
//
// Placement is deliberate (backlog-029): this is an ecosystem SHACL extension that
// materializes onto the pure `sh:NodeShape` and therefore travels with an ejected
// app — NOT an app's own `code:` vocab, which describes source-code structure.
const displayRank = {id: 'https://linked.cm/ont/core/displayRank'};
const displayHidden = {id: 'https://linked.cm/ont/core/displayHidden'};

// Provenance marker: a NodeShape core generates at sync time from another shape's code
// (today the `<propertyShape>.singleOwner` constraint derived from `contains`), rather than one a
// developer declared. Catalog readers skip shapes with `core:generated true`.
const generated = {id: 'https://linked.cm/ont/core/generated'};

// Ownership edge from a NodeShape to the shapes core generated from it at sync time (the
// single-owner constraint of each `contains` property). It is `contains`, so deleting the
// shape deletes them, and sync writes them nested in the shape's own create.
const generatedShape = {id: 'https://linked.cm/ont/core/generatedShape'};

// Content hash of everything shape sync writes for a NodeShape (the shape, its property shapes,
// lists, paths and generated shapes), stored on the NodeShape. A sync skips a shape whose stored
// hash equals the hash of what it would write.
const shapeHash = {id: 'https://linked.cm/ont/core/shapeHash'};

// A NodeShape that shares its targetClass on purpose (`@linkedShape({sharedTargetClass: true})`),
// so the shape check does not report it as borrowing another shape's class.
const sharedTargetClass = {id: 'https://linked.cm/ont/core/sharedTargetClass'};

// Ontology sync (`syncOntologies`): in the `'default'` graph mode one `core:OntologySync` node in
// the default graph records the combined hash of the ontology written there (`core:ontologyHash`),
// so an unchanged ontology is skipped.
const OntologySync = {id: 'https://linked.cm/ont/core/OntologySync'};
const ontologyHash = {id: 'https://linked.cm/ont/core/ontologyHash'};

// Ontology status: the stage an ontology is at (`core:OntologyStatus`), one of three public
// individuals, stated on the ontology as `adms:status` (ADMS's own status vocabulary has none of
// these stages).
const OntologyStatus = {id: 'https://linked.cm/ont/core/OntologyStatus'};
const Draft = {id: 'https://linked.cm/ont/core/Draft'};
const ReadyForReview = {id: 'https://linked.cm/ont/core/ReadyForReview'};
const Published = {id: 'https://linked.cm/ont/core/Published'};

// Named graphs (`shapes/NamedGraph.ts`): the classes of graph-registry records (each
// `rdfs:subClassOf sd:NamedGraph`) and the record fields core adds to SPARQL Service Description.
const OntologyGraph = {id: 'https://linked.cm/ont/core/OntologyGraph'};
const ShapesGraph = {id: 'https://linked.cm/ont/core/ShapesGraph'};
const DraftGraph = {id: 'https://linked.cm/ont/core/DraftGraph'};
const contentHash = {id: 'https://linked.cm/ont/core/contentHash'};
const feedsHierarchy = {id: 'https://linked.cm/ont/core/feedsHierarchy'};
const packageTerm = {id: 'https://linked.cm/ont/core/package'};
const version = {id: 'https://linked.cm/ont/core/version'};
// A shared ontology or shape graph (one graph for every package, `utils/graphTargets.ts`) records
// each package's part as `"{npm name} {sha256 hex}"`.
const packageHash = {id: 'https://linked.cm/ont/core/packageHash'};

// The component index (`lib/esm/data/components.ttl`, written by `linked build` from a package's
// `components/index`): each linked component the package exports, with its export name, its start
// shape, its query's shape and its query in the wire format (`QueryBuilder.toJSON()`, an
// `rdf:JSON` literal). `ComponentsGraph` is the registry class of the graph a host keeps it in.
const Component = {id: 'https://linked.cm/ont/core/Component'};
const SetComponent = {id: 'https://linked.cm/ont/core/SetComponent'};
const ComponentsGraph = {id: 'https://linked.cm/ont/core/ComponentsGraph'};
const definesComponent = {id: 'https://linked.cm/ont/core/definesComponent'};
const exportName = {id: 'https://linked.cm/ont/core/exportName'};
const startShape = {id: 'https://linked.cm/ont/core/startShape'};
const queryShape = {id: 'https://linked.cm/ont/core/queryShape'};
const query = {id: 'https://linked.cm/ont/core/query'};
// The commit a graph's content was built from (a `ComponentsGraph` of a package branch).
const commit = {id: 'https://linked.cm/ont/core/commit'};

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
  OntologyStatus,
  Draft,
  ReadyForReview,
  Published,
  OntologyGraph,
  ShapesGraph,
  DraftGraph,
  contentHash,
  feedsHierarchy,
  package: packageTerm,
  version,
  packageHash,
  Component,
  SetComponent,
  ComponentsGraph,
  definesComponent,
  exportName,
  startShape,
  queryShape,
  query,
  commit,
};
