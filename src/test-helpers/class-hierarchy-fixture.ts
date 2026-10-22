/**
 * Load a live test dataset's class hierarchy, as the ontology sync would.
 *
 * Core relies on the store's RDFS class inference over the synced `rdfs:subClassOf` triples: a
 * subclass instance carries its superclasses' types only once the dataset holds them. A live
 * fixture with a subclass instance writes its hierarchy after clearing the dataset, either the
 * registered shape tree's edges (which the shape check requires the ontology data to state) or
 * explicit triples.
 */
import type {HierarchyTriple} from '../ontology/hierarchy';
import {getAllNodeShapes, getSuperShapes, getTargetClassId} from '../utils/ShapeClass';
import {executeSparqlUpdate} from './fuseki-test-store';

const RDFS_SUBCLASS_OF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

/** `C ⊑ D` for every registered shape targeting C whose nearest super-shape targets D ≠ C. */
export function shapeTreeHierarchy(): HierarchyTriple[] {
  const out = new Map<string, HierarchyTriple>();
  for (const shape of getAllNodeShapes().values()) {
    const s = getTargetClassId(shape);
    const parent = getSuperShapes(shape)[0];
    const o = parent ? getTargetClassId(parent) : undefined;
    if (s && o && s !== o) out.set(`${s} ${o}`, {s, o});
  }
  return [...out.values()];
}

/** Insert `rdfs:subClassOf` triples into the test dataset (default: the shape tree's). */
export async function insertClassHierarchy(
  triples: HierarchyTriple[] = shapeTreeHierarchy(),
): Promise<void> {
  if (triples.length === 0) return;
  const body = triples.map(({s, o}) => `<${s}> <${RDFS_SUBCLASS_OF}> <${o}> .`).join('\n');
  await executeSparqlUpdate(`INSERT DATA {\n${body}\n}`);
}
