/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The names the query proxies answer themselves.
 *
 * `QueryShape`/`QueryShapeSet` resolve a key against their own surface (`key in
 * queryShape`) before they look for a property shape with that label, so a property
 * named after one of these is unreachable through the builder: the caller gets the DSL
 * method, and the field tracer then fails on a native function. `$`-prefixed names and
 * `and`/`or`/`not` throw at registration; the other reserved names warn (see
 * `warnOnReservedPropertyLabel`).
 *
 * Deliberately a literal, not derived from the classes: the shape registry must not
 * import the query builder (that edge would close an import cycle through `SHACL.ts`).
 * `dsl-property-name-collisions.test.ts` compares this list against the live prototypes,
 * so a DSL method added later cannot drift out of it unnoticed.
 */
export const RESERVED_QUERY_DSL_NAMES: ReadonlySet<string> = new Set([
  // node metadata (`$`-prefixed: facts about the node, not shape fields); `$graph` is reserved
  // ahead of its method
  '$graph',
  '$type',
  // prototype surface of QueryShape / QueryShapeSet (and their base)
  'add',
  'as',
  'buildPredicateExpression',
  'callPropertyShapeAccessor',
  'concat',
  'constructor',
  'countDistinct',
  'equals',
  'every',
  'getOriginalValue',
  'getPropertyPath',
  'getPropertyStep',
  'id',
  'isDefined',
  'isNotDefined',
  'limit',
  'none',
  'notOneOf',
  'oneOf',
  'preloadFor',
  'select',
  'selectAll',
  'size',
  'some',
  'str',
  'where',
  // instance fields — `in` sees these as well
  'originalValue',
  'prop',
  'property',
  'proxy',
  'queryShapes',
  'source',
  'subject',
  'wherePath',
]);

/**
 * The subset that only bites through a MULTI-VALUED hop.
 *
 * These are on `QueryShapeSet` but not on `QueryShape`, so `widget.size` resolves to the
 * property perfectly well — it is `article.widgets.size` that returns the set's size
 * instead. Which matters because `size`, `some`, `every` and `where` are among the most
 * ordinary names a domain model has, and warning about them as if they were always broken
 * trains people to ignore the warning.
 */
export const SET_CONTEXT_ONLY_NAMES: ReadonlySet<string> = new Set([
  'add',
  'buildPredicateExpression',
  'callPropertyShapeAccessor',
  'concat',
  'every',
  'none',
  'size',
  'some',
  'where',
]);

/**
 * The DSL-JSON condition combinators. A condition key is a bare string, so a property with one of
 * these labels cannot be keyed in a condition. Registering such a property throws (like a
 * `$`-prefixed name); a shape loaded as data is only reported, and the encoder writes a condition
 * on it in the S-expr form (`["=", {"@path": "and"}, …]`), which has no key to collide with.
 */
export const DSL_JSON_COMBINATOR_NAMES: ReadonlySet<string> = new Set(['and', 'or', 'not']);

export function isReservedQueryDslName(label: string | undefined): boolean {
  return !!label && RESERVED_QUERY_DSL_NAMES.has(label);
}

/** True when the name is only shadowed when the shape is reached as a set. */
export function isSetContextOnlyName(label: string | undefined): boolean {
  return !!label && SET_CONTEXT_ONLY_NAMES.has(label);
}

/** One warning per shape + label; a shape re-registered on hot reload must not spam. */
const reported = new Set<string>();

/**
 * Tell the model author about a colliding label while they can still rename it.
 *
 * `$`-prefixed names and `and`/`or`/`not` throw; the other reserved names warn. `size`, `id`
 * and `some` are legitimate names for a domain property, and the property still works
 * everywhere except the proxy-traced builder, so throwing would break existing apps on upgrade
 * over a property they may never select through the builder. The throw is in
 * `registerPropertyShape`; a shape loaded as data that has a `$`-prefixed or combinator label is
 * reported here instead.
 *
 * Two messages, because the two cases are genuinely different: a `QueryShape` member is
 * always shadowed, while a set-only member is fine until the shape is reached through a
 * multi-valued property. Saying "broken" about the second kind is how a warning gets
 * ignored.
 *
 * Both name the way out. The escape hatch already exists and is easy to miss:
 * `select(['size'])` takes the label as a string and never touches the proxy, so it
 * resolves the property whatever it is called. It accepts dot-paths too.
 */
export function warnOnReservedPropertyLabel(
  label: string | undefined,
  shapeLabel: string | undefined,
  shapeId?: string,
): void {
  if (!label) return;
  const metadata = label.startsWith('$');
  const combinator = DSL_JSON_COMBINATOR_NAMES.has(label);
  if (!metadata && !combinator && !isReservedQueryDslName(label)) return;
  const key = `${shapeId ?? shapeLabel ?? ''}#${label}`;
  if (reported.has(key)) return;
  reported.add(key);
  const owner = shapeLabel ?? shapeId ?? 'shape';
  if (combinator) {
    console.warn(
      `[linked] ${owner}.${label} is named after a DSL-JSON combinator ('${label}'). It works in ` +
        `the DSL and in fields; a DSL-JSON condition on it is written in the S-expr form ` +
        `(\`["=", {"@path": "${label}"}, …]\`), which the serializer does for you. Renaming the ` +
        `property avoids that; the RDF predicate can stay the same.`,
    );
    return;
  }
  if (metadata) {
    // A shape loaded as data is not refused (see `registerPropertyShape`), only reported.
    console.warn(
      `[linked] ${owner}.${label} cannot be read in queries: '${label}' is node metadata ` +
        `(\`$\`-prefixed names are facts about the node, not shape fields), in the DSL, a label ` +
        `select and DSL-JSON alike. Rename the property; the RDF predicate can stay the same.`,
    );
    return;
  }
  const escape = `Use \`select(['${label}'])\`, which takes the label as a string and never touches the proxy. Renaming the property also works; the RDF predicate can stay the same.`;

  if (isSetContextOnlyName(label)) {
    console.warn(
      `[linked] ${owner}.${label} is shadowed when ${owner} is reached through a ` +
        `multi-valued property: '${label}' is a method of the query builder's SET proxy, so ` +
        `\`parent.${owner.toLowerCase()}s.${label}\` returns that method. Reading it directly ` +
        `(\`select(s => s.${label})\`) is fine. ${escape}`,
    );
    return;
  }

  console.warn(
    `[linked] ${owner}.${label} shadows the query DSL: '${label}' is a method of the query ` +
      `builder, so \`select(s => s.${label})\` returns that method instead of the property ` +
      `and the query fails while tracing fields. ${escape}`,
  );
}

/** Test seam: forget which collisions were already reported. */
export function resetReservedPropertyLabelWarnings(): void {
  reported.clear();
}
