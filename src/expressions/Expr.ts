import {ExpressionNode, toIRExpression} from './ExpressionNode.js';
import type {ExpressionInput, PropertyRefMap} from './ExpressionNode.js';
import {isLinkedInstance} from '../utils/linkedError.js';

function wrap(input: ExpressionInput): ExpressionNode {
  return isLinkedInstance(input, ExpressionNode)
    ? input
    : new ExpressionNode(toIRExpression(input));
}

/**
 * Merge the unresolved property-ref maps of all ExpressionNode inputs, so
 * proxy-traced references (e.g. `p.name`) inside a directly-constructed
 * function expression still resolve to real aliases during lowering.
 */
function mergedRefs(inputs: readonly ExpressionInput[]): PropertyRefMap {
  const merged = new Map<string, readonly string[]>();
  for (const input of inputs) {
    if (isLinkedInstance(input, ExpressionNode)) {
      for (const [k, v] of input._refs) merged.set(k, v);
    }
  }
  return merged;
}

/**
 * `Expr` — static builders for expressions that have **no natural fluent host**.
 *
 * The fluent form (`p.age.plus(1)`, `p.name.matches(/^A/)`) is the one true way to
 * build a *property-first* expression; every arithmetic/comparison/string/date/hash
 * operation lives there. `Expr` deliberately does **not** mirror them — that
 * duplication is what drifted (two names for one op). `Expr` carries only the
 * operations that can't start from a property proxy:
 *
 * - `now()`        — nullary; there is nothing to chain off.
 * - `ifThen(c,t,e)`— ternary conditional; the condition is not a natural receiver.
 * - `firstDefined(…)` — variadic COALESCE; no natural first operand.
 * - `concat(…)`    — variadic; also reads best literal-first (`Expr.concat('Hi ', p.name)`).
 * - `not(x)`       — prefix negation; `Expr.not(cond)` reads better than `cond.not()`.
 */
export const Expr = {
  /** SPARQL `NOW()` — the current dateTime. */
  now(): ExpressionNode {
    return new ExpressionNode({kind: 'function_expr', name: 'NOW', args: []});
  },

  /** SPARQL `CONCAT(...)` — string concatenation of two or more parts. */
  concat(...parts: ExpressionInput[]): ExpressionNode {
    if (parts.length < 2) {
      throw new Error('Expr.concat() requires at least 2 arguments');
    }
    return new ExpressionNode(
      {
        kind: 'function_expr',
        name: 'CONCAT',
        args: parts.map(toIRExpression),
      },
      mergedRefs(parts),
    );
  },

  /** SPARQL `COALESCE(...)` — the first bound/defined value among two or more. */
  firstDefined(...args: ExpressionInput[]): ExpressionNode {
    if (args.length < 2) {
      throw new Error('Expr.firstDefined() requires at least 2 arguments');
    }
    return new ExpressionNode(
      {
        kind: 'function_expr',
        name: 'COALESCE',
        args: args.map(toIRExpression),
      },
      mergedRefs(args),
    );
  },

  /** SPARQL `IF(cond, then, else)`. */
  ifThen(
    cond: ExpressionInput,
    thenVal: ExpressionInput,
    elseVal: ExpressionInput,
  ): ExpressionNode {
    return new ExpressionNode(
      {
        kind: 'function_expr',
        name: 'IF',
        args: [toIRExpression(cond), toIRExpression(thenVal), toIRExpression(elseVal)],
      },
      mergedRefs([cond, thenVal, elseVal]),
    );
  },

  /** Prefix logical negation — `Expr.not(p.name.equals('Alice'))`. */
  not(a: ExpressionInput): ExpressionNode {
    return wrap(a).not();
  },
} as const;
