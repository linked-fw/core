import type {
  SparqlAlgebraNode,
  SparqlExpression,
  SparqlTerm,
  SparqlTriple,
  SparqlSelectPlan,
  SparqlAskPlan,
  SparqlInsertDataPlan,
  SparqlDeleteInsertPlan,
  SparqlDeleteWherePlan,
} from './SparqlAlgebra.js';
import {
  type SparqlOptions,
  formatUri,
  formatLiteral,
  escapeSparqlString,
  collectPrefixes,
  assertSafeCallName,
  sanitizeVarName,
} from './sparqlUtils.js';

// ---------------------------------------------------------------------------
// URI collector — gathers all IRIs encountered during serialization so that
// the prefix block can be built afterwards.
// ---------------------------------------------------------------------------

type UriCollector = {uris: Set<string>};

function collectUri(collector: UriCollector, uri: string): void {
  collector.uris.add(uri);
}

// ---------------------------------------------------------------------------
// Term serialization
// ---------------------------------------------------------------------------

export function serializeTerm(
  term: SparqlTerm,
  collector?: UriCollector,
): string {
  switch (term.kind) {
    case 'variable':
      return `?${sanitizeVarName(term.name)}`;
    case 'iri':
      if (collector) collectUri(collector, term.value);
      return formatUri(term.value);
    case 'literal': {
      if (term.language) {
        return `"${escapeSparqlString(term.value)}"@${term.language}`;
      }
      if (term.datatype) {
        if (collector) collectUri(collector, term.datatype);
      }
      return formatLiteral(term.value, term.datatype);
    }
    case 'path':
      if (collector && term.uris) {
        for (const uri of term.uris) collectUri(collector, uri);
      }
      return term.value;
  }
}

// ---------------------------------------------------------------------------
// Triple serialization
// ---------------------------------------------------------------------------

function serializeTriple(
  triple: SparqlTriple,
  collector?: UriCollector,
): string {
  const s = serializeTerm(triple.subject, collector);
  const p = serializeTerm(triple.predicate, collector);
  const o = serializeTerm(triple.object, collector);
  return `${s} ${p} ${o}`;
}

function serializeTriples(
  triples: SparqlTriple[],
  collector?: UriCollector,
): string {
  return triples
    .map((t) => serializeTriple(t, collector) + ' .')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Expression serialization
// ---------------------------------------------------------------------------

// SPARQL binary-operator precedence (higher binds tighter): multiplicative >
// additive > relational. Used to parenthesize nested `binary_expr` operands so
// arithmetic groups correctly (`(a+b)*c`, not `a+b*c`) and relational chains
// (`a=b=c`, a non-associative syntax error) get parenthesized.
const RELATIONAL_OPS = new Set(['=', '!=', '<', '>', '<=', '>=']);
function binaryPrecedence(op: string): number {
  if (op === '*' || op === '/') return 3;
  if (op === '+' || op === '-') return 2;
  if (RELATIONAL_OPS.has(op)) return 1;
  return 0;
}

/**
 * Serialize a `binary_expr` operand, wrapping it in parens when omitting them
 * would change how SPARQL parses the expression.
 */
function wrapBinaryOperand(
  operand: SparqlExpression,
  parentOp: string,
  side: 'left' | 'right',
  collector?: UriCollector,
): string {
  const s = serializeExpression(operand, collector);
  // Logical (&&/||) binds looser than any binary operator → always parenthesize.
  if (operand.kind === 'logical_expr') return `(${s})`;
  if (operand.kind !== 'binary_expr') return s;
  const parentIsRel = RELATIONAL_OPS.has(parentOp);
  const childIsRel = RELATIONAL_OPS.has(operand.op);
  // Relational is non-associative in SPARQL: any relational-in-relational needs parens.
  if (parentIsRel && childIsRel) return `(${s})`;
  const pc = binaryPrecedence(operand.op);
  const pp = binaryPrecedence(parentOp);
  const needs = side === 'left' ? pc < pp : pc <= pp;
  return needs ? `(${s})` : s;
}

export function serializeExpression(
  expr: SparqlExpression,
  collector?: UriCollector,
): string {
  switch (expr.kind) {
    case 'variable_expr':
      return `?${sanitizeVarName(expr.name)}`;

    case 'iri_expr':
      if (collector) collectUri(collector, expr.value);
      return formatUri(expr.value);

    case 'literal_expr': {
      if (expr.datatype && collector) collectUri(collector, expr.datatype);
      return formatLiteral(expr.value, expr.datatype);
    }

    case 'binary_expr': {
      const left = wrapBinaryOperand(expr.left, expr.op, 'left', collector);
      const right = wrapBinaryOperand(expr.right, expr.op, 'right', collector);
      return `${left} ${expr.op} ${right}`;
    }

    case 'logical_expr': {
      const op = expr.op === 'and' ? '&&' : '||';
      const parts = expr.exprs.map((e) => {
        const s = serializeExpression(e, collector);
        // Parenthesize OR children inside AND (AND binds tighter than OR)
        if (expr.op === 'and' && e.kind === 'logical_expr' && e.op === 'or') {
          return `(${s})`;
        }
        return s;
      });
      return parts.join(` ${op} `);
    }

    case 'not_expr':
      return `!(${serializeExpression(expr.inner, collector)})`;

    case 'function_expr': {
      assertSafeCallName(expr.name);
      const args = expr.args
        .map((a) => serializeExpression(a, collector))
        .join(', ');
      return `${expr.name}(${args})`;
    }

    case 'aggregate_expr': {
      assertSafeCallName(expr.name);
      const args = expr.args
        .map((a) => serializeExpression(a, collector))
        .join(', ');
      const distinctPrefix = expr.distinct ? 'DISTINCT ' : '';
      // Uppercased here rather than in the IR: this one line covers COUNT/SUM/AVG/
      // MIN/MAX and any aggregate added later, while the IR keeps carrying a plain
      // lowercase name (`'count'`) that other consumers can match on without
      // case-folding. It also puts the aggregate in the same voice as every other
      // keyword this file emits (SELECT, DISTINCT, GROUP BY, HAVING, …).
      // `function_expr` is deliberately left alone: its names arrive already in
      // their correct SPARQL spelling, which is not uniformly uppercase (`isBlank`,
      // `isIRI`), so case-folding there would corrupt them.
      return `${expr.name.toUpperCase()}(${distinctPrefix}${args})`;
    }

    case 'exists_expr': {
      const inner = serializeAlgebraNode(expr.pattern, collector);
      const prefix = expr.negated ? 'NOT EXISTS' : 'EXISTS';
      return `${prefix} {\n${indent(inner)}\n}`;
    }

    case 'bound_expr':
      return `BOUND(?${sanitizeVarName(expr.variable)})`;

    case 'in_expr': {
      // Empty list: `IN ()` matches nothing, `NOT IN ()` matches everything —
      // fold to a boolean constant rather than emit an empty parenthesis list.
      if (expr.list.length === 0) return expr.negated ? 'true' : 'false';
      const val = serializeExpression(expr.value, collector);
      const items = expr.list.map((e) => serializeExpression(e, collector)).join(', ');
      return `${val} ${expr.negated ? 'NOT IN' : 'IN'} (${items})`;
    }
  }
}

// ---------------------------------------------------------------------------
// Algebra node serialization
// ---------------------------------------------------------------------------

export function serializeAlgebraNode(
  node: SparqlAlgebraNode,
  collector?: UriCollector,
): string {
  switch (node.type) {
    case 'bgp':
      return serializeTriples(node.triples, collector);

    case 'join': {
      const left = serializeAlgebraNode(node.left, collector);
      const right = serializeAlgebraNode(node.right, collector);
      return `${left}\n${right}`;
    }

    case 'left_join': {
      const left = serializeAlgebraNode(node.left, collector);
      const right = serializeAlgebraNode(node.right, collector);
      let optionalBlock = `OPTIONAL {\n${indent(right)}\n}`;
      if (node.condition) {
        const cond = serializeExpression(node.condition, collector);
        // OPTIONAL with filter: OPTIONAL { pattern FILTER(cond) }
        // Re-build to include filter inside the OPTIONAL block
        optionalBlock = `OPTIONAL {\n${indent(right)}\n  FILTER(${cond})\n}`;
      }
      // If left side is empty (e.g. UPDATE WHERE with all-OPTIONAL triples),
      // omit the empty prefix to avoid blank lines
      return left ? `${left}\n${optionalBlock}` : optionalBlock;
    }

    case 'filter': {
      const inner = serializeAlgebraNode(node.inner, collector);
      const expr = serializeExpression(node.expression, collector);
      return `${inner}\nFILTER(${expr})`;
    }

    case 'union': {
      const left = serializeAlgebraNode(node.left, collector);
      const right = serializeAlgebraNode(node.right, collector);
      return `{\n${indent(left)}\n}\nUNION\n{\n${indent(right)}\n}`;
    }

    case 'minus': {
      const left = serializeAlgebraNode(node.left, collector);
      const right = serializeAlgebraNode(node.right, collector);
      return `${left}\nMINUS {\n${indent(right)}\n}`;
    }

    case 'extend': {
      const inner = serializeAlgebraNode(node.inner, collector);
      const expr = serializeExpression(node.expression, collector);
      return `${inner}\nBIND(${expr} AS ?${sanitizeVarName(node.variable)})`;
    }

    case 'graph': {
      if (collector) collectUri(collector, node.iri);
      const inner = serializeAlgebraNode(node.inner, collector);
      return `GRAPH ${formatUri(node.iri)} {\n${indent(inner)}\n}`;
    }

    case 'values': {
      const values = node.iris
        .map((iri) => {
          if (collector) collectUri(collector, iri);
          return formatUri(iri);
        })
        .join(' ');
      return `VALUES ?${sanitizeVarName(node.variable)} { ${values} }`;
    }

    case 'subselect': {
      const innerBody = serializeAlgebraNode(node.inner, collector);
      const projection = node.projection.map((v) => `?${sanitizeVarName(v)}`).join(' ');
      const lines: string[] = [`SELECT ${projection} WHERE {`];
      lines.push(indent(innerBody));
      lines.push('}');
      const trailing: string[] = [];
      if (node.orderBy && node.orderBy.length > 0) {
        const orderParts = node.orderBy.map((cond) => {
          const expr = serializeExpression(cond.expression, collector);
          return `${cond.direction}(${expr})`;
        });
        trailing.push(`ORDER BY ${orderParts.join(' ')}`);
      }
      if (node.limit !== undefined) {
        trailing.push(`LIMIT ${node.limit}`);
      }
      if (node.offset !== undefined) {
        trailing.push(`OFFSET ${node.offset}`);
      }
      const subSelectStr = trailing.length > 0
        ? `${lines.join('\n')} ${trailing.join(' ')}`
        : lines.join('\n');
      return `{\n${indent(subSelectStr)}\n}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function indent(text: string, level: number = 1): string {
  const prefix = '  '.repeat(level);
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

function buildPrefixBlock(usedUris: Set<string>): string {
  const prefixes = collectPrefixes([...usedUris]);
  const lines = Object.entries(prefixes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, uri]) => `PREFIX ${prefix}: <${uri}>`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Top-level plan serializers
// ---------------------------------------------------------------------------

export function selectPlanToSparql(
  plan: SparqlSelectPlan,
  _options?: SparqlOptions,
): string {
  const collector: UriCollector = {uris: new Set()};

  // 1. Serialize WHERE body
  const body = serializeAlgebraNode(plan.algebra, collector);

  // 2. Build SELECT line
  const projectionParts = plan.projection.map((item) => {
    if (item.kind === 'variable') {
      return `?${sanitizeVarName(item.name)}`;
    } else {
      // aggregate or expression projection: (expr AS ?alias)
      const expr = serializeExpression(item.expression, collector);
      return `(${expr} AS ?${sanitizeVarName(item.alias)})`;
    }
  });

  const distinctStr = plan.distinct ? 'DISTINCT ' : '';
  const selectLine = `SELECT ${distinctStr}${projectionParts.join(' ')}`;

  // 3. Build WHERE block
  const whereBlock = `WHERE {\n${indent(body)}\n}`;

  // 4. Build trailing clauses
  const clauses: string[] = [];

  if (plan.groupBy && plan.groupBy.length > 0) {
    clauses.push(
      `GROUP BY ${plan.groupBy.map((v) => `?${sanitizeVarName(v)}`).join(' ')}`,
    );
  }

  if (plan.having) {
    const havingExpr = serializeExpression(plan.having, collector);
    clauses.push(`HAVING(${havingExpr})`);
  }

  if (plan.orderBy && plan.orderBy.length > 0) {
    const orderParts = plan.orderBy.map((cond) => {
      const expr = serializeExpression(cond.expression, collector);
      return `${cond.direction}(${expr})`;
    });
    clauses.push(`ORDER BY ${orderParts.join(' ')}`);
  }

  if (plan.limit !== undefined) {
    clauses.push(`LIMIT ${plan.limit}`);
  }

  if (plan.offset !== undefined) {
    clauses.push(`OFFSET ${plan.offset}`);
  }

  // 5. Build PREFIX block (after collecting all URIs)
  const prefixBlock = buildPrefixBlock(collector.uris);

  // 6. Assemble
  const parts: string[] = [];
  if (prefixBlock) parts.push(prefixBlock);
  parts.push(selectLine);
  parts.push(whereBlock);
  parts.push(...clauses);

  return parts.join('\n');
}

/**
 * Serializes a {@link SparqlAskPlan} to `ASK WHERE { … }`.
 *
 * The same WHERE body as {@link selectPlanToSparql}, with the projection line and
 * every solution modifier removed — `ASK` accepts none of them.
 */
export function askPlanToSparql(
  plan: SparqlAskPlan,
  _options?: SparqlOptions,
): string {
  const collector: UriCollector = {uris: new Set()};

  // 1. Serialize WHERE body (collects the URIs the prefix block is built from)
  const body = serializeAlgebraNode(plan.algebra, collector);

  // 2. Build PREFIX block (after collecting all URIs)
  const prefixBlock = buildPrefixBlock(collector.uris);

  // 3. Assemble
  const parts: string[] = [];
  if (prefixBlock) parts.push(prefixBlock);
  parts.push(`ASK WHERE {\n${indent(body)}\n}`);

  return parts.join('\n');
}

export function insertDataPlanToSparql(
  plan: SparqlInsertDataPlan,
  _options?: SparqlOptions,
): string {
  const collector: UriCollector = {uris: new Set()};

  let triplesStr: string;
  if (plan.graph) {
    if (collector) collectUri(collector, plan.graph);
    const innerTriples = serializeTriples(plan.triples, collector);
    triplesStr = `GRAPH ${formatUri(plan.graph)} {\n${indent(innerTriples)}\n}`;
  } else {
    triplesStr = serializeTriples(plan.triples, collector);
  }

  const body = `INSERT DATA {\n${indent(triplesStr)}\n}`;

  const prefixBlock = buildPrefixBlock(collector.uris);
  const parts: string[] = [];
  if (prefixBlock) parts.push(prefixBlock);
  parts.push(body);
  return parts.join('\n');
}

export function deleteInsertPlanToSparql(
  plan: SparqlDeleteInsertPlan,
  _options?: SparqlOptions,
): string {
  const collector: UriCollector = {uris: new Set()};

  // DELETE block
  const deleteTriples = serializeTriples(plan.deletePatterns, collector);
  const deletePart = `DELETE {\n${indent(deleteTriples)}\n}`;

  // INSERT block (may be empty)
  let insertPart = '';
  if (plan.insertPatterns.length > 0) {
    const insertTriples = serializeTriples(plan.insertPatterns, collector);
    insertPart = `INSERT {\n${indent(insertTriples)}\n}\n`;
  }

  // WHERE block
  const whereBody = serializeAlgebraNode(plan.whereAlgebra, collector);
  const wherePart = `WHERE {\n${indent(whereBody)}\n}`;

  const prefixBlock = buildPrefixBlock(collector.uris);
  const parts: string[] = [];
  if (prefixBlock) parts.push(prefixBlock);
  parts.push(deletePart);
  if (insertPart) parts.push(insertPart.trimEnd());
  parts.push(wherePart);
  return parts.join('\n');
}

export function deleteWherePlanToSparql(
  plan: SparqlDeleteWherePlan,
  _options?: SparqlOptions,
): string {
  const collector: UriCollector = {uris: new Set()};

  const body = serializeAlgebraNode(plan.patterns, collector);

  let content: string;
  if (plan.graph) {
    if (collector) collectUri(collector, plan.graph);
    content = `GRAPH ${formatUri(plan.graph)} {\n${indent(body)}\n}`;
  } else {
    content = body;
  }

  const result = `DELETE WHERE {\n${indent(content)}\n}`;

  const prefixBlock = buildPrefixBlock(collector.uris);
  const parts: string[] = [];
  if (prefixBlock) parts.push(prefixBlock);
  parts.push(result);
  return parts.join('\n');
}
