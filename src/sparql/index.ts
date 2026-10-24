// Types
export type * from './SparqlAlgebra.js';
export type {SparqlOptions} from './sparqlUtils.js';

// Utilities
export {
  formatUri,
  formatLiteral,
  escapeSparqlString,
  collectPrefixes,
  generateEntityUri,
} from './sparqlUtils.js';

// IR → Algebra conversion (Layer 1)
export {
  selectToAlgebra,
  askToAlgebra,
  countToAlgebra,
  createToAlgebra,
  updateToAlgebra,
  upsertToAlgebra,
  deleteToAlgebra,
  mintNestedIds,
} from './irToAlgebra.js';

// High-level IR → SPARQL string (convenience wrappers)
export {
  selectToSparql,
  askToSparql,
  countToSparql,
  createToSparql,
  updateToSparql,
  upsertToSparql,
  deleteToSparql,
} from './irToAlgebra.js';

// Algebra → SPARQL string serialization (layer 3)
export {
  serializeAlgebraNode,
  serializeExpression,
  serializeTerm,
  selectPlanToSparql,
  askPlanToSparql,
  insertDataPlanToSparql,
  deleteInsertPlanToSparql,
  deleteWherePlanToSparql,
} from './algebraToString.js';

// Result mapping
export {
  mapSparqlSelectResult,
  mapSparqlAskResult,
  mapSparqlCountResult,
  mapSparqlCreateResult,
  mapSparqlUpdateResult,
  isSparqlSelectResults,
} from './resultMapping.js';
export type {
  SparqlJsonResults,
  SparqlAskResults,
  SparqlQueryResults,
  SparqlBinding,
} from './resultMapping.js';

// Dataset base class
export {SparqlDataset, SparqlStore} from './SparqlDataset.js';
