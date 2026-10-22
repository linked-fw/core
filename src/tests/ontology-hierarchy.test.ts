import {describe, expect, test} from '@jest/globals';
import {
  RDFS_SUBCLASSOF,
  definedTermsFromTurtle,
  hierarchyFromTurtle,
  subClassClosure,
} from '../ontology/hierarchy';

const PREFIXES = `
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix ex: <http://example.org/> .
`;

describe('hierarchyFromTurtle', () => {
  test('reads rdfs:subClassOf between IRIs from several files, deduped and sorted', async () => {
    const a = `${PREFIXES}
ex:Dog rdfs:subClassOf ex:Mammal ; rdfs:label "Dog" .
ex:Cat rdfs:subClassOf ex:Mammal .
ex:Mammal rdfs:subClassOf ex:Animal .
`;
    const b = `${PREFIXES}
ex:Cat rdfs:subClassOf ex:Mammal .
ex:Cat rdfs:subClassOf ex:Pet .
ex:Animal a owl:Class .
`;
    const triples = await hierarchyFromTurtle([a, b]);
    expect(triples).toEqual([
      {s: 'http://example.org/Cat', o: 'http://example.org/Mammal'},
      {s: 'http://example.org/Cat', o: 'http://example.org/Pet'},
      {s: 'http://example.org/Dog', o: 'http://example.org/Mammal'},
      {s: 'http://example.org/Mammal', o: 'http://example.org/Animal'},
    ]);
  });

  test('drops a blank-node superclass, a literal object and anything else', async () => {
    const text = `${PREFIXES}
ex:Dog rdfs:subClassOf ex:Animal .
ex:Dog rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasOwner ] .
ex:Dog rdfs:subClassOf "Animal" .
ex:Dog rdfs:subPropertyOf ex:Animal .
ex:hasOwner rdfs:domain ex:Dog ; rdfs:range ex:Person .
`;
    expect(await hierarchyFromTurtle([text])).toEqual([
      {s: 'http://example.org/Dog', o: 'http://example.org/Animal'},
    ]);
  });

  test('ignores triples in a named graph', async () => {
    const text = `${PREFIXES}
ex:Dog rdfs:subClassOf ex:Animal .
ex:g { ex:Cat rdfs:subClassOf ex:Animal . }
`;
    expect(await hierarchyFromTurtle([text])).toEqual([
      {s: 'http://example.org/Dog', o: 'http://example.org/Animal'},
    ]);
  });

  test('sorts by subject then object in code-unit order', async () => {
    const text = `${PREFIXES}
ex:b rdfs:subClassOf ex:Z .
ex:b rdfs:subClassOf ex:a .
ex:B rdfs:subClassOf ex:a .
`;
    const triples = await hierarchyFromTurtle([text]);
    expect(triples.map((t) => `${t.s} ${t.o}`)).toEqual([
      'http://example.org/B http://example.org/a',
      'http://example.org/b http://example.org/Z',
      'http://example.org/b http://example.org/a',
    ]);
  });

  test('a parse error names the source', async () => {
    const bad = `${PREFIXES}\nex:Dog rdfs:subClassOf .\n`;
    await expect(
      hierarchyFromTurtle([`${PREFIXES}ex:A rdfs:subClassOf ex:B .`, bad], ['a.ttl', 'b.ttl']),
    ).rejects.toThrow(/ontology data b\.ttl/);
    await expect(hierarchyFromTurtle([bad])).rejects.toThrow(/text #1/);
  });

  test('an empty text yields no triples', async () => {
    expect(await hierarchyFromTurtle([''])).toEqual([]);
    expect(await hierarchyFromTurtle([])).toEqual([]);
  });

  test('exports the predicate IRI', () => {
    expect(RDFS_SUBCLASSOF).toBe('http://www.w3.org/2000/01/rdf-schema#subClassOf');
  });
});

describe('definedTermsFromTurtle', () => {
  test('returns every IRI subject', async () => {
    const text = `${PREFIXES}
ex:Dog rdfs:subClassOf ex:Animal .
ex:name a owl:DatatypeProperty .
[] a owl:Restriction .
`;
    const defined = await definedTermsFromTurtle([text]);
    expect([...defined].sort()).toEqual(['http://example.org/Dog', 'http://example.org/name']);
  });
});

describe('subClassClosure', () => {
  test('collects every transitive superclass, not the class itself', () => {
    const closure = subClassClosure([
      {s: 'Dog', o: 'Mammal'},
      {s: 'Mammal', o: 'Animal'},
      {s: 'Animal', o: 'Thing'},
      {s: 'Cat', o: 'Mammal'},
      {s: 'Cat', o: 'Pet'},
    ]);
    expect([...closure.get('Dog')!].sort()).toEqual(['Animal', 'Mammal', 'Thing']);
    expect([...closure.get('Cat')!].sort()).toEqual(['Animal', 'Mammal', 'Pet', 'Thing']);
    expect([...closure.get('Animal')!]).toEqual(['Thing']);
    expect(closure.has('Thing')).toBe(false);
  });

  test('terminates on a cycle; each member holds the other and itself', () => {
    const closure = subClassClosure([
      {s: 'A', o: 'B'},
      {s: 'B', o: 'A'},
      {s: 'B', o: 'C'},
    ]);
    expect([...closure.get('A')!].sort()).toEqual(['A', 'B', 'C']);
    expect([...closure.get('B')!].sort()).toEqual(['A', 'B', 'C']);
  });
});
