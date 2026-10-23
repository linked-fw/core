/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The class hierarchy of a package's ontology data.
 *
 * A package ships its vocabulary as Turtle (`src/data/<name>.ttl`); the store infers over the
 * `rdfs:subClassOf` triples the ontology sync writes into a dataset, and the shape check compares
 * shape `extends` with the same hierarchy. This module reads that hierarchy out of the Turtle:
 * every `rdfs:subClassOf` between two IRIs in the default graph, nothing else. Labels, comments
 * and the rest of the vocabulary stay in the file and are never loaded into memory.
 *
 * Server only: the parse functions import `n3` dynamically, so a browser bundle that reaches this
 * module through a package's ontology module never carries the parser. `subClassClosure` is pure.
 * `loadOntologyHierarchy` fills the in-memory hierarchy (`@_linked/core/ontology/classHierarchy`).
 *
 * @module @_linked/core/ontology/hierarchy
 */

export const RDFS_SUBCLASSOF = 'http://www.w3.org/2000/01/rdf-schema#subClassOf';

/** One `s rdfs:subClassOf o` triple between two IRIs. */
export interface HierarchyTriple {
  s: string;
  o: string;
}

type Quad = {
  subject: {termType: string; value: string};
  predicate: {termType: string; value: string};
  object: {termType: string; value: string};
  graph: {termType: string; value: string};
};

type N3Module = {
  Parser: new (options?: {blankNodePrefix?: string}) => {
    parse(input: string, callback: (error: Error | null, quad: Quad | null) => void): void;
  };
  Writer: new (options?: {format?: string}) => {
    quadToString(subject: unknown, predicate: unknown, object: unknown): string;
  };
};

async function loadN3(): Promise<N3Module> {
  const mod = (await import('n3')) as unknown as N3Module & {default?: N3Module};
  return typeof mod.Parser === 'function' ? mod : (mod.default as N3Module);
}

/**
 * Parse one text, calling `onQuad` for each quad. The parser is permissive (Turtle, TriG, N3), so
 * a graph block is read and its quads dropped by the callers' default-graph filter rather than
 * failing the file. A parse error rejects with a message naming `source` (the file, when the
 * caller knows it).
 */
async function parseTurtle(
  n3: N3Module,
  text: string,
  source: string,
  onQuad: (quad: Quad) => void,
  blankNodePrefix?: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const parser = new n3.Parser(blankNodePrefix ? {blankNodePrefix} : undefined);
    let failed = false;
    parser.parse(text, (error, quad) => {
      if (failed) return;
      if (error) {
        failed = true;
        reject(new Error(`[linked] Could not parse ontology data ${source}: ${error.message}`));
        return;
      }
      if (quad) {
        onQuad(quad);
      } else {
        resolve();
      }
    });
  });
}

const sourceName = (sources: string[] | undefined, index: number): string =>
  sources?.[index] ?? `text #${index + 1}`;

const compareTriples = (a: HierarchyTriple, b: HierarchyTriple): number =>
  a.s < b.s ? -1 : a.s > b.s ? 1 : a.o < b.o ? -1 : a.o > b.o ? 1 : 0;

/**
 * The `rdfs:subClassOf` triples between IRIs in the default graph of `texts` (Turtle), deduped
 * and sorted by subject then object (code-unit order). A blank-node superclass (an OWL
 * restriction), a literal object and a triple in a named graph are dropped silently: the store's
 * view ignores them too.
 *
 * `sources` names the texts (their files) for parse errors; a parse error rejects, naming the
 * source.
 */
export async function hierarchyFromTurtle(
  texts: string[],
  sources?: string[],
): Promise<HierarchyTriple[]> {
  const n3 = await loadN3();
  const seen = new Set<string>();
  const triples: HierarchyTriple[] = [];
  for (let i = 0; i < texts.length; i++) {
    await parseTurtle(n3, texts[i], sourceName(sources, i), (quad) => {
      if (quad.predicate.value !== RDFS_SUBCLASSOF) return;
      if (quad.subject.termType !== 'NamedNode' || quad.object.termType !== 'NamedNode') return;
      if (quad.graph.termType !== 'DefaultGraph') return;
      const key = `${quad.subject.value}\u0000${quad.object.value}`;
      if (seen.has(key)) return;
      seen.add(key);
      triples.push({s: quad.subject.value, o: quad.object.value});
    });
  }
  return triples.sort(compareTriples);
}

/**
 * The default-graph triples of `texts` (Turtle) as one N-Triples text: one line per triple, in
 * file order, deduped, each line ending in a newline. Each text gets its own blank-node prefix
 * (`f<i>_`), so the blank-node labels of two files never merge. A triple in a named graph is
 * dropped, as in {@link hierarchyFromTurtle}. A parse error rejects, naming the source.
 *
 * The ontology sync sends this as the body of a package's ontology graph: prefix blocks and
 * blank-node labels of several files cannot clash in N-Triples.
 */
export async function nTriplesFromTurtle(texts: string[], sources?: string[]): Promise<string> {
  const n3 = await loadN3();
  const writer = new n3.Writer({format: 'N-Triples'});
  const seen = new Set<string>();
  const lines: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    await parseTurtle(
      n3,
      texts[i],
      sourceName(sources, i),
      (quad) => {
        if (quad.graph.termType !== 'DefaultGraph') return;
        const line = writer.quadToString(quad.subject, quad.predicate, quad.object);
        if (seen.has(line)) return;
        seen.add(line);
        lines.push(line);
      },
      `f${i}_`,
    );
  }
  return lines.join('');
}

/**
 * Every IRI that is the subject of a triple in `texts`: the terms the data defines. The mirror
 * check compares the terms a package uses against this set.
 */
export async function definedTermsFromTurtle(
  texts: string[],
  sources?: string[],
): Promise<Set<string>> {
  const n3 = await loadN3();
  const defined = new Set<string>();
  for (let i = 0; i < texts.length; i++) {
    await parseTurtle(n3, texts[i], sourceName(sources, i), (quad) => {
      if (quad.subject.termType === 'NamedNode') defined.add(quad.subject.value);
    });
  }
  return defined;
}

/**
 * Class → every superclass reachable through `rdfs:subClassOf`, transitively. A class is not its
 * own superclass unless it lies on a cycle (`A ⊑ B ⊑ A`: each holds the other, and itself). Pure.
 */
export function subClassClosure(triples: HierarchyTriple[]): Map<string, Set<string>> {
  const direct = new Map<string, string[]>();
  for (const {s, o} of triples) {
    const parents = direct.get(s);
    if (parents) parents.push(o);
    else direct.set(s, [o]);
  }
  const closure = new Map<string, Set<string>>();
  for (const cls of direct.keys()) {
    const reached = new Set<string>();
    const stack = [...(direct.get(cls) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (reached.has(next)) continue;
      reached.add(next);
      for (const parent of direct.get(next) ?? []) {
        if (!reached.has(parent)) stack.push(parent);
      }
    }
    closure.set(cls, reached);
  }
  return closure;
}

/**
 * Parse the ontology data of every registered package and set the union of their
 * `rdfs:subClassOf` triples as the in-memory hierarchy (`setOntologyHierarchy` in
 * `@_linked/core/ontology/classHierarchy`), so `superClassesOf` and `subClassesOf` answer from
 * the ontology and not only from the shape tree. Returns the triples, deduped and sorted. A
 * package whose data cannot be read or parsed is left out, with the reader's warning.
 *
 * The ontology sync and the shape check call it (one parse per run); an app's boot calls it
 * whether or not the sync runs.
 */
export async function loadOntologyHierarchy(): Promise<HierarchyTriple[]> {
  const {readPackageOntologies, setHierarchyFromPackages} = await import('./registryData.js');
  const {packages} = await readPackageOntologies();
  return setHierarchyFromPackages(packages);
}
