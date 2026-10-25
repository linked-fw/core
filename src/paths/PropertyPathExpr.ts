/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// ---------------------------------------------------------------------------
// PathExpr AST types
// ---------------------------------------------------------------------------

/** A simple path reference — either a raw string (prefixed/IRI) or a node ref. */
export type PathRef = string | {id: string};

/** Discriminated-object union for all SPARQL property path forms. */
export type PathExpr =
  | PathRef
  | {seq: PathExpr[]}
  | {alt: PathExpr[]}
  | {inv: PathExpr}
  | {zeroOrMore: PathExpr}
  | {oneOrMore: PathExpr}
  | {zeroOrOne: PathExpr}
  | {negatedPropertySet: (PathRef | {inv: PathRef})[]};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export const isPathRef = (expr: PathExpr): expr is PathRef =>
  typeof expr === 'string' || (typeof expr === 'object' && expr !== null && 'id' in expr && Object.keys(expr).length === 1);

export const isComplexPathExpr = (expr: PathExpr): boolean => !isPathRef(expr);

// ---------------------------------------------------------------------------
// Parser — recursive-descent for SPARQL property path grammar
// ---------------------------------------------------------------------------

/**
 * Characters that signal a string contains path operators and should be parsed.
 * Used by the normalizer to decide whether to invoke the parser.
 */
export const PATH_OPERATOR_CHARS = /[/|^*+?()!<]/;

class PathParser {
  private pos = 0;
  private readonly input: string;

  constructor(input: string) {
    this.input = input;
  }

  parse(): PathExpr {
    this.skipWhitespace();
    const result = this.parseAlt();
    this.skipWhitespace();
    if (this.pos < this.input.length) {
      this.error(`Unexpected character '${this.input[this.pos]}'`);
    }
    return result;
  }

  // alt = seq ( '|' seq )*
  private parseAlt(): PathExpr {
    const first = this.parseSeq();
    const branches: PathExpr[] = [first];
    while (this.peek() === '|') {
      this.advance(); // consume '|'
      this.skipWhitespace();
      branches.push(this.parseSeq());
    }
    return branches.length === 1 ? branches[0] : {alt: branches};
  }

  // seq = unary ( '/' unary )*
  private parseSeq(): PathExpr {
    const first = this.parseUnary();
    const steps: PathExpr[] = [first];
    while (this.peek() === '/') {
      this.advance(); // consume '/'
      this.skipWhitespace();
      steps.push(this.parseUnary());
    }
    return steps.length === 1 ? steps[0] : {seq: steps};
  }

  // unary = '^' unary | primary ( '*' | '+' | '?' )?
  private parseUnary(): PathExpr {
    this.skipWhitespace();
    if (this.peek() === '^') {
      this.advance(); // consume '^'
      this.skipWhitespace();
      const inner = this.parseUnary();
      return {inv: inner};
    }
    let expr = this.parsePrimary();
    this.skipWhitespace();
    const postfix = this.peek();
    if (postfix === '*') {
      this.advance();
      expr = {zeroOrMore: expr};
    } else if (postfix === '+') {
      this.advance();
      expr = {oneOrMore: expr};
    } else if (postfix === '?') {
      this.advance();
      expr = {zeroOrOne: expr};
    }
    this.skipWhitespace();
    return expr;
  }

  // primary = '(' alt ')' | '!' negatedPropertySet | iri
  private parsePrimary(): PathExpr {
    this.skipWhitespace();
    const ch = this.peek();

    // Grouped expression
    if (ch === '(') {
      this.advance(); // consume '('
      this.skipWhitespace();
      const inner = this.parseAlt();
      this.skipWhitespace();
      if (this.peek() !== ')') {
        this.error("Expected ')'");
      }
      this.advance(); // consume ')'
      return inner;
    }

    // Negated property set
    if (ch === '!') {
      this.advance(); // consume '!'
      this.skipWhitespace();
      return this.parseNegatedPropertySet();
    }

    // IRI or prefixed name
    return this.parseIri();
  }

  // negatedPropertySet = '(' negatedItem ( '|' negatedItem )* ')' | negatedItem
  private parseNegatedPropertySet(): PathExpr {
    this.skipWhitespace();
    if (this.peek() === '(') {
      this.advance(); // consume '('
      this.skipWhitespace();
      const items = this.parseNegatedItems();
      this.skipWhitespace();
      if (this.peek() !== ')') {
        this.error("Expected ')' in negated property set");
      }
      this.advance(); // consume ')'
      return {negatedPropertySet: items};
    }
    // Single negated item
    const item = this.parseNegatedItem();
    return {negatedPropertySet: [item]};
  }

  private parseNegatedItems(): (PathRef | {inv: PathRef})[] {
    const items: (PathRef | {inv: PathRef})[] = [this.parseNegatedItem()];
    while (this.peek() === '|') {
      this.advance(); // consume '|'
      this.skipWhitespace();
      items.push(this.parseNegatedItem());
    }
    return items;
  }

  private parseNegatedItem(): PathRef | {inv: PathRef} {
    this.skipWhitespace();
    if (this.peek() === '^') {
      this.advance(); // consume '^'
      this.skipWhitespace();
      const ref = this.parseIri();
      return {inv: ref};
    }
    return this.parseIri();
  }

  // iri = '<' chars '>' | prefixedName
  //
  // A bracketed IRI with `://` stays a string: no prefixed name contains `//`, so it reads as an
  // IRI wherever it goes. One without (`<urn:prop:a>`) becomes `{id}`, because as a bare string
  // it would read as a prefixed name — the brackets are the only record that it is an IRI.
  private parseIri(): PathRef {
    this.skipWhitespace();
    if (this.peek() === '<') {
      this.advance(); // consume '<'
      const start = this.pos;
      while (this.pos < this.input.length && this.input[this.pos] !== '>') {
        this.pos++;
      }
      if (this.pos >= this.input.length) {
        this.error("Expected '>' to close IRI");
      }
      const iri = this.input.slice(start, this.pos);
      this.advance(); // consume '>'
      return iri.includes('://') ? iri : {id: iri};
    }
    return this.parsePrefixedName();
  }

  // prefixedName = PNAME_NS PNAME_LOCAL | PNAME_NS
  // We accept any characters until we hit a path operator or whitespace or end
  private parsePrefixedName(): string {
    this.skipWhitespace();
    const start = this.pos;
    while (this.pos < this.input.length && !this.isTerminator(this.input[this.pos])) {
      this.pos++;
    }
    if (this.pos === start) {
      this.error('Expected IRI or prefixed name');
    }
    return this.input.slice(start, this.pos);
  }

  private isTerminator(ch: string): boolean {
    return ch === '/' || ch === '|' || ch === '*' || ch === '+' || ch === '?' ||
      ch === '(' || ch === ')' || ch === '^' || ch === '!' || ch === ' ' ||
      ch === '\t' || ch === '\n' || ch === '\r';
  }

  private peek(): string | undefined {
    return this.pos < this.input.length ? this.input[this.pos] : undefined;
  }

  private advance(): void {
    this.pos++;
  }

  private skipWhitespace(): void {
    while (this.pos < this.input.length) {
      const ch = this.input[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        this.pos++;
      } else {
        break;
      }
    }
  }

  private error(message: string): never {
    throw new Error(
      `Property path parse error at position ${this.pos}: ${message} (input: "${this.input}")`,
    );
  }
}

/**
 * Parse a SPARQL property path string into a PathExpr AST.
 *
 * Supports: sequence (/), alternative (|), inverse (^), zeroOrMore (*),
 * oneOrMore (+), zeroOrOne (?), negatedPropertySet (!), and grouping (()).
 *
 * Does NOT resolve prefixes — raw strings are preserved in the AST.
 */
export function parsePropertyPath(input: string): PathExpr {
  if (!input || input.trim().length === 0) {
    throw new Error('Property path input must not be empty');
  }
  return new PathParser(input.trim()).parse();
}
