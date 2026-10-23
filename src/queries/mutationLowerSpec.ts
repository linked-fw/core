/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * IR-free "lowering specs" — the minimal, plain description each mutation
 * builder hands to `lower()` so the canonical-IR construction can live entirely
 * in the IR tier. The builders depend only on these types (no IR), keeping the
 * IR pipeline reachable solely through `lower()`.
 */
import type {Shape, ShapeConstructor} from '../shapes/Shape.js';
import type {UpdatePartial} from './QueryFactory.js';
import type {WherePath} from './SelectQuery.js';
import type {NodeId} from './MutationQuery.js';
import type {PendingQueryContext} from './QueryContext.js';

export interface CreateLowerSpec<S extends Shape = Shape> {
  shapeClass: ShapeConstructor<S>;
  /** The create data, with any fixed id already injected as `__id`. */
  data: UpdatePartial<S>;
  /** The graph `.into()` names (server-side only; never serialized). */
  into?: string;
}

export interface UpdateLowerSpec<S extends Shape = Shape> {
  shapeClass: ShapeConstructor<S>;
  data: UpdatePartial<S>;
  mode: 'for' | 'forAll' | 'where';
  /** Resolved target id (id-based update); the builder already resolved any context. */
  targetId?: string;
  /** A pre-evaluated where path (where-mode). */
  wherePath?: WherePath;
  /** Create-or-replace: lowers to an upsert mutation. Only valid with mode 'for'. */
  upsert?: boolean;
  /** The graph `.into()` names (server-side only; never serialized). */
  into?: string;
}

export interface DeleteLowerSpec<S extends Shape = Shape> {
  shapeClass: ShapeConstructor<S>;
  /** Ids to delete: concrete ids/`{id}` refs, or unresolved context refs (resolved at lower). */
  ids?: (NodeId | PendingQueryContext)[];
  mode: 'ids' | 'all' | 'where';
  wherePath?: WherePath;
  /** The graph `.into()` names (server-side only; never serialized). */
  into?: string;
  /** @internal Delete by ids that keeps the incoming links (see `IRDeleteMutation.keepIncoming`). */
  keepIncoming?: boolean;
}
