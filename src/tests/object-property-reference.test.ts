/**
 * An object property whose accessor is DECLARED with a primitive type.
 *
 * `@objectProperty({path: …}) get project(): string` is an accepted idiom here —
 * the accessor returns the referenced node's IRI, so the natural declared type is
 * `string`. The RDF side is still an object property, so the documented way to
 * match it is by node reference: `.equals({id})`
 * (docs/backlog/014-prefixed-uris-in-json.md lists `.where(…).equals(val)` as
 * taking `JSNonNullPrimitive | NodeReferenceValue`).
 *
 * `ToQueryBuilderObject` can only see the DECLARED type, so such a property
 * projects to a `QueryPrimitive<string>` rather than a `QueryShape`. That is
 * correct — but `QueryPrimitive.equals` used to accept only
 * `JSPrimitive | QueryBuilderObject`, so the documented `{id}` form was a type
 * error at every call site (TS2353, "'id' does not exist in type
 * 'Date | QueryBuilderObject<any, any, any>'" — the compiler lists only the
 * object-typed members of that union). Runtime always handled it:
 * `toIRExpression` turns `{id}` into a `reference_expr`, which lowers to `<iri>`.
 */
import {describe, expect, test} from '@jest/globals';
import {linkedShape} from '../package';
import {literalProperty, objectProperty} from '../shapes/SHACL';
import {Shape} from '../shapes/Shape';
import {createNameSpace} from '../utils/NameSpace';
import {captureQuery} from '../test-helpers/query-capture-store';
import {selectToSparql} from '../sparql/irToAlgebra';

import '../ontologies/rdf';
import '../ontologies/xsd';

const DOCS = 'https://example.org/documents#';
const ns = createNameSpace(DOCS);

@linkedShape
class IriRefDocument extends Shape {
  static targetClass = ns('SourceDocument');
  @objectProperty({path: ns('project'), maxCount: 1}) get project(): string { return ''; }
  @literalProperty({path: ns('checksum'), maxCount: 1}) get checksum(): string { return ''; }
}

const PROJECT = 'https://example.org/projects/p1';

describe('object property declared as a string: `.equals({id})`', () => {
  /**
   * TYPE-LEVEL: this is the whole point. Note there is NO `as any` on the shape
   * and none on the argument — before the fix this line alone failed
   * `npm run typecheck` (and ts-jest) with TS2353.
   */
  test('the documented {id} reference form type-checks', async () => {
    const sparql = selectToSparql(
      await captureQuery(() =>
        IriRefDocument.select((d) => [d.checksum])
          .where((d) => d.project.equals({id: PROJECT}))
          .exec(),
      ),
    );
    // RUNTIME: and it always compared against an IRI, never a string literal.
    expect(sparql).toContain(`FILTER(?a0_project = <${PROJECT}>)`);
    expect(sparql).not.toContain(`"${PROJECT}"`);
  });

  test('a plain string still type-checks and still compares as a literal', async () => {
    const sparql = selectToSparql(
      await captureQuery(() =>
        IriRefDocument.select((d) => [d.project])
          .where((d) => d.checksum.equals('abc'))
          .exec(),
      ),
    );
    expect(sparql).toContain('FILTER(?a0_checksum = "abc")');
  });

  test('oneOf accepts references too', async () => {
    const sparql = selectToSparql(
      await captureQuery(() =>
        IriRefDocument.select((d) => [d.checksum])
          .where((d) => d.project.oneOf([{id: PROJECT}]))
          .exec(),
      ),
    );
    expect(sparql).toContain(`<${PROJECT}>`);
  });

  /**
   * FALSIFICATION of the fix itself: the argument must NOT have been widened to
   * `any`. An arbitrary object is still rejected, and so is a reference whose
   * `id` is not a string. If either of these stops erroring, `@ts-expect-error`
   * fails the typecheck and this test goes red.
   */
  test('the argument is a node reference, not an arbitrary object', () => {
    IriRefDocument.select((d) => [d.checksum]).where((d) =>
      // @ts-expect-error - {name} is not a node reference
      d.project.equals({name: PROJECT}),
    );
    IriRefDocument.select((d) => [d.checksum]).where((d) =>
      // @ts-expect-error - a node reference's id is a string
      d.project.equals({id: 42}),
    );
    expect(true).toBe(true);
  });
});
