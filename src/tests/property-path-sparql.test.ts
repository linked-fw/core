import {pathExprToSparql, collectPathUris} from '../paths/pathExprToSparql';
import type {PathExpr} from '../paths/PropertyPathExpr';
import {selectPlanToSparql} from '../sparql/algebraToString';
import type {SparqlSelectPlan} from '../sparql/SparqlAlgebra';

import {Prefix} from '../utils/Prefix';

// Ensure rdf prefix is registered for prefix-shortening tests
import '../ontologies/rdf';

// A string step is written as a prefixed name only when its prefix is registered.
const EX = 'http://ex.test/';
Prefix.add('ex', EX);

describe('pathExprToSparql', () => {
  // ------ Simple refs ------

  it('renders a prefixed name', () => {
    expect(pathExprToSparql('ex:name')).toBe('ex:name');
  });

  it('writes a step with an unregistered prefix as an IRI', () => {
    expect(pathExprToSparql('zz:name')).toBe('<zz:name>');
  });

  it('renders a full IRI string in angle brackets', () => {
    expect(pathExprToSparql('http://example.org/name')).toBe('<http://example.org/name>');
  });

  it('renders an {id} ref in angle brackets', () => {
    expect(pathExprToSparql({id: 'http://example.org/name'})).toBe('<http://example.org/name>');
  });

  // ------ Sequence ------

  it('renders a sequence path', () => {
    expect(pathExprToSparql({seq: ['ex:friend', 'ex:name']})).toBe('ex:friend/ex:name');
  });

  it('renders a three-element sequence', () => {
    expect(pathExprToSparql({seq: ['ex:a', 'ex:b', 'ex:c']})).toBe('ex:a/ex:b/ex:c');
  });

  // ------ Alternative ------

  it('renders an alternative path', () => {
    expect(pathExprToSparql({alt: ['ex:friend', 'ex:colleague']})).toBe('ex:friend|ex:colleague');
  });

  // ------ Inverse ------

  it('renders an inverse path', () => {
    expect(pathExprToSparql({inv: 'ex:parent'})).toBe('^ex:parent');
  });

  it('renders inverse of full IRI', () => {
    expect(pathExprToSparql({inv: {id: 'http://example.org/parent'}})).toBe('^<http://example.org/parent>');
  });

  // ------ Repetition ------

  it('renders zeroOrMore', () => {
    expect(pathExprToSparql({zeroOrMore: 'ex:broader'})).toBe('ex:broader*');
  });

  it('renders oneOrMore', () => {
    expect(pathExprToSparql({oneOrMore: 'ex:broader'})).toBe('ex:broader+');
  });

  it('renders zeroOrOne', () => {
    expect(pathExprToSparql({zeroOrOne: 'ex:middleName'})).toBe('ex:middleName?');
  });

  // ------ Negated property set ------

  it('renders single negated property', () => {
    expect(pathExprToSparql({negatedPropertySet: ['ex:parent']})).toBe('!ex:parent');
  });

  it('renders multi-item negated property set', () => {
    expect(pathExprToSparql({negatedPropertySet: ['ex:parent', 'ex:child']})).toBe('!(ex:parent|ex:child)');
  });

  it('renders negated property set with inverse', () => {
    expect(pathExprToSparql({negatedPropertySet: ['ex:parent', {inv: 'ex:child'}]})).toBe('!(ex:parent|^ex:child)');
  });

  // ------ Precedence / grouping ------

  it('parenthesizes alt within seq', () => {
    // (ex:a | ex:b) / ex:c
    const expr: PathExpr = {seq: [{alt: ['ex:a', 'ex:b']}, 'ex:c']};
    expect(pathExprToSparql(expr)).toBe('(ex:a|ex:b)/ex:c');
  });

  it('does not parenthesize seq within alt', () => {
    // ex:a/ex:b | ex:c  — seq binds tighter than alt
    const expr: PathExpr = {alt: [{seq: ['ex:a', 'ex:b']}, 'ex:c']};
    expect(pathExprToSparql(expr)).toBe('ex:a/ex:b|ex:c');
  });

  it('parenthesizes seq under postfix operator', () => {
    // (ex:a / ex:b)*
    const expr: PathExpr = {zeroOrMore: {seq: ['ex:a', 'ex:b']}};
    expect(pathExprToSparql(expr)).toBe('(ex:a/ex:b)*');
  });

  it('parenthesizes alt under postfix operator', () => {
    // (ex:a | ex:b)+
    const expr: PathExpr = {oneOrMore: {alt: ['ex:a', 'ex:b']}};
    expect(pathExprToSparql(expr)).toBe('(ex:a|ex:b)+');
  });

  // ------ Complex combinations ------

  it('renders (ex:a|^ex:b)/ex:c+', () => {
    const expr: PathExpr = {
      seq: [
        {alt: ['ex:a', {inv: 'ex:b'}]},
        {oneOrMore: 'ex:c'},
      ],
    };
    expect(pathExprToSparql(expr)).toBe('(ex:a|^ex:b)/ex:c+');
  });

  it('renders ^ex:parent/ex:name', () => {
    const expr: PathExpr = {seq: [{inv: 'ex:parent'}, 'ex:name']};
    expect(pathExprToSparql(expr)).toBe('^ex:parent/ex:name');
  });

  it('renders full IRI sequence', () => {
    const expr: PathExpr = {
      seq: [
        {id: 'http://example.org/friend'},
        {id: 'http://example.org/name'},
      ],
    };
    expect(pathExprToSparql(expr)).toBe('<http://example.org/friend>/<http://example.org/name>');
  });
});

describe('pathExprToSparql with IRTraversePattern integration', () => {
  // These tests verify that the pathExprToSparql output is correct
  // for use as a SPARQL property path predicate in triple patterns.
  // The integration with irToAlgebra is tested indirectly via the
  // IRTraversePattern.pathExpr → SparqlTerm {kind: 'path'} flow.

  it('produces valid SPARQL for inverse traversal', () => {
    const sparql = pathExprToSparql({inv: {id: 'http://ex.org/parent'}});
    expect(sparql).toBe('^<http://ex.org/parent>');
    // This would appear in SPARQL as: ?a0 ^<http://ex.org/parent> ?a1
  });

  it('produces valid SPARQL for alternative traversal', () => {
    const sparql = pathExprToSparql({
      alt: [{id: 'http://ex.org/friend'}, {id: 'http://ex.org/colleague'}],
    });
    expect(sparql).toBe('<http://ex.org/friend>|<http://ex.org/colleague>');
  });

  it('produces valid SPARQL for zero-or-more with IRI', () => {
    const sparql = pathExprToSparql({zeroOrMore: {id: 'http://ex.org/broader'}});
    expect(sparql).toBe('<http://ex.org/broader>*');
  });
});

describe('pathExprToSparql prefix shortening', () => {
  // rdf prefix is registered via import '../ontologies/rdf' above

  it('shortens full IRI to prefixed form when prefix is registered', () => {
    const sparql = pathExprToSparql({id: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'});
    expect(sparql).toBe('rdf:type');
  });

  it('shortens {id} refs in a sequence path', () => {
    const expr: PathExpr = {
      seq: [
        {id: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'},
        {id: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#value'},
      ],
    };
    expect(pathExprToSparql(expr)).toBe('rdf:type/rdf:value');
  });

  it('shortens full IRI string refs when prefix is registered', () => {
    expect(pathExprToSparql('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')).toBe('rdf:type');
  });

  it('preserves prefixed-name string refs as-is', () => {
    expect(pathExprToSparql('rdf:type')).toBe('rdf:type');
  });

  it('falls back to <full-uri> when no prefix matches', () => {
    expect(pathExprToSparql({id: 'http://unknown.org/foo'})).toBe('<http://unknown.org/foo>');
  });
});

describe('collectPathUris', () => {
  it('collects full IRI from string ref', () => {
    expect(collectPathUris('http://example.org/name')).toEqual(['http://example.org/name']);
  });

  it('collects full IRI from {id} ref', () => {
    expect(collectPathUris({id: 'http://example.org/name'})).toEqual(['http://example.org/name']);
  });

  it('collects the full IRI of a prefixed-name string ref', () => {
    expect(collectPathUris('ex:name')).toEqual([`${EX}name`]);
  });

  it('collects all IRIs from sequence', () => {
    const expr: PathExpr = {
      seq: [{id: 'http://ex.org/a'}, {id: 'http://ex.org/b'}],
    };
    expect(collectPathUris(expr)).toEqual(['http://ex.org/a', 'http://ex.org/b']);
  });

  it('collects IRIs from nested expressions', () => {
    const expr: PathExpr = {
      seq: [
        {inv: {id: 'http://ex.org/parent'}},
        {oneOrMore: {id: 'http://ex.org/child'}},
      ],
    };
    expect(collectPathUris(expr)).toEqual(['http://ex.org/parent', 'http://ex.org/child']);
  });

  it('collects IRIs from alternative', () => {
    const expr: PathExpr = {alt: [{id: 'http://ex.org/a'}, {id: 'http://ex.org/b'}]};
    expect(collectPathUris(expr)).toEqual(['http://ex.org/a', 'http://ex.org/b']);
  });

  it('collects IRIs from negatedPropertySet', () => {
    const expr: PathExpr = {
      negatedPropertySet: [{id: 'http://ex.org/a'}, {inv: {id: 'http://ex.org/b'}}],
    };
    expect(collectPathUris(expr)).toEqual(['http://ex.org/a', 'http://ex.org/b']);
  });

  it('expands prefixed names in a mixed expression', () => {
    const expr: PathExpr = {seq: ['ex:a', {id: 'http://ex.org/b'}]};
    expect(collectPathUris(expr)).toEqual([`${EX}a`, 'http://ex.org/b']);
  });
});

describe('path term PREFIX block integration', () => {
  // Verify that URIs inside path terms produce PREFIX declarations
  // when serialized through algebraToString.

  it('includes PREFIX declarations for path URIs', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}, {kind: 'variable', name: 'a1'}],
      algebra: {
        type: 'bgp',
        triples: [{
          subject: {kind: 'variable', name: 'a0'},
          predicate: {
            kind: 'path',
            value: 'rdf:type/rdf:value',
            uris: [
              'http://www.w3.org/1999/02/22-rdf-syntax-ns#type',
              'http://www.w3.org/1999/02/22-rdf-syntax-ns#value',
            ],
          },
          object: {kind: 'variable', name: 'a1'},
        }],
      },
    };
    const sparql = selectPlanToSparql(plan);
    expect(sparql).toContain('PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>');
    expect(sparql).toContain('?a0 rdf:type/rdf:value ?a1');
  });

  it('does not produce PREFIX block when path has no registered prefixes', () => {
    const plan: SparqlSelectPlan = {
      type: 'select',
      projection: [{kind: 'variable', name: 'a0'}, {kind: 'variable', name: 'a1'}],
      algebra: {
        type: 'bgp',
        triples: [{
          subject: {kind: 'variable', name: 'a0'},
          predicate: {
            kind: 'path',
            value: '<http://unknown.org/a>/<http://unknown.org/b>',
            uris: ['http://unknown.org/a', 'http://unknown.org/b'],
          },
          object: {kind: 'variable', name: 'a1'},
        }],
      },
    };
    const sparql = selectPlanToSparql(plan);
    expect(sparql).not.toContain('PREFIX');
    expect(sparql).toContain('?a0 <http://unknown.org/a>/<http://unknown.org/b> ?a1');
  });
});
