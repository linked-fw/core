/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {SelectBuilder, QueryBuilderJSON} from '../queries/QueryBuilder.js';
import type {CountBuilder} from '../queries/CountBuilder.js';
import type {AskBuilder} from '../queries/AskBuilder.js';
import {isContextRefJSON, resolveContextId, CONTEXT_REF_KEY} from '../queries/ContextRef.js';

/** A builder that can go live: a select, a count, or an ask. */
export type LiveBuilder = SelectBuilder<any, any, any> | CountBuilder | AskBuilder;
export type LiveQueryKind = 'select' | 'count' | 'ask';

/**
 * The part of a query that varies per instance of a template: what it is
 * applied to, and how it is windowed. Everything else is the template.
 *
 * `contextName` is recorded next to the resolved `subject` so the store can
 * re-key an instance when that query context changes (`subscribeQueryContext`).
 * `vars` is reserved for query variables; nothing fills it yet.
 */
export type InstanceParams = {
  subject?: string;
  subjects?: string[];
  contextName?: string;
  one?: boolean;
  limit?: number;
  offset?: number;
  vars?: Record<string, unknown>;
};

export type SplitQuery = {
  kind: LiveQueryKind;
  /** The subject-less, window-less query (DSL-JSON). Identity of the template. */
  templateJson: Record<string, unknown>;
  params: InstanceParams;
};

const PARAM_KEYS = ['subject', 'subjects', 'one', 'limit', 'offset'] as const;

export function kindOf(query: LiveBuilder): LiveQueryKind {
  return (query as {__queryKind: LiveQueryKind}).__queryKind;
}

/**
 * Split a query into its template (identity) and its instance params.
 *
 * Works on the DSL-JSON, so it does not depend on builder internals: a select's
 * `subject`/`subjects`/`one`/`limit`/`offset` are params; a `{@ctx}` subject is
 * recorded as `contextName` and resolved to an id when the context is set.
 * Count and ask builders cannot be rebound (they carry their subject in their
 * spec), so their subject stays in the template; only a context reference is
 * lifted into params so a context change creates a fresh instance.
 */
export function splitQuery(query: LiveBuilder): SplitQuery {
  const kind = kindOf(query);
  const json = query.toJSON() as Record<string, unknown>;
  const params: InstanceParams = {};

  const liftContext = (subject: unknown): string | undefined => {
    if (isContextRefJSON(subject)) {
      const name = (subject as unknown as Record<string, string>)[CONTEXT_REF_KEY];
      params.contextName = name;
      return resolveContextId(name, false);
    }
    return typeof subject === 'string' ? subject : undefined;
  };

  if (kind === 'select') {
    const templateJson: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(json)) {
      if (!(PARAM_KEYS as readonly string[]).includes(k)) templateJson[k] = v;
    }
    const j = json as QueryBuilderJSON;
    const subject = liftContext(j.subject);
    if (subject) params.subject = subject;
    if (j.subjects && j.subjects.length) params.subjects = [...j.subjects];
    if (j.one && !subject && !params.contextName) params.one = true; // `.for(id)`/`.for(ctx)` imply one; keep the key minimal
    if (j.limit !== undefined) params.limit = j.limit;
    if (j.offset !== undefined) params.offset = j.offset;
    return {kind, templateJson, params};
  }

  // count / ask: the subject is part of the template; only a context ref is lifted.
  const subject = liftContext(json.subject);
  if (params.contextName && subject) params.subject = subject;
  return {kind, templateJson: json, params};
}

const templateKeyMemo = new WeakMap<object, string>();

/** Canonical identity of a query's template, memoized per builder instance (builders are immutable). */
export function templateKey(query: LiveBuilder): string {
  const cached = templateKeyMemo.get(query as object);
  if (cached) return cached;
  const key = stableStringify(splitQuery(query).templateJson);
  templateKeyMemo.set(query as object, key);
  return key;
}

export function paramsKey(params: InstanceParams): string {
  return stableStringify(params);
}

/** Apply instance params to a template builder. Count/ask builders are returned as they are. */
export function bindParams(query: LiveBuilder, params: InstanceParams): LiveBuilder {
  if (kindOf(query) !== 'select') return query;
  let b = query as SelectBuilder<any, any, any>;
  if (params.subject) {
    b = b.for(params.subject) as SelectBuilder<any, any, any>;
  } else if (params.subjects && params.subjects.length) {
    b = b.forAll(params.subjects);
  } else {
    b = b.forAll();
    if (params.one) b = b.one() as SelectBuilder<any, any, any>;
  }
  if (params.limit !== undefined) b = b.limit(params.limit);
  if (params.offset !== undefined) b = b.offset(params.offset);
  return b;
}

/** JSON with object keys in sorted order at every depth, so equal values give equal strings. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}
