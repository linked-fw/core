/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {NodeShapeData, PropertyShapeData} from '../shapes/nodeShapeData.js';
import {getActiveShapeCatalog} from './ShapeClass.js';
import {brandLinkedError} from './linkedError.js';

/**
 * Where an unresolved shape was met: the shape IRI that could not be resolved and, when a
 * property pointed at it, that property and the shape that declares it. `catalog` is the
 * active catalog's `name`, absent in the global registry or for an unnamed catalog.
 */
export interface UnresolvedShapeDetails {
  shapeIri: string;
  property?: string;
  propertyIri?: string;
  ownerShapeIri?: string;
  catalog?: string;
}

/**
 * The error core throws when a shape IRI does not resolve, carrying the IRIs as fields so a
 * host can map it without parsing the message. It stays a plain `Error` (`name` is
 * `'Error'`): only the message and the fields are added. Match it with
 * `isLinkedError(err, UnresolvedShapeError)`, which also recognises one thrown by another copy
 * of core.
 */
export class UnresolvedShapeError extends Error implements UnresolvedShapeDetails {
  readonly shapeIri: string;
  readonly property?: string;
  readonly propertyIri?: string;
  readonly ownerShapeIri?: string;
  readonly catalog?: string;

  constructor(message: string, details: UnresolvedShapeDetails) {
    super(message);
    this.shapeIri = details.shapeIri;
    if (details.property !== undefined) this.property = details.property;
    if (details.propertyIri !== undefined) this.propertyIri = details.propertyIri;
    if (details.ownerShapeIri !== undefined) this.ownerShapeIri = details.ownerShapeIri;
    if (details.catalog !== undefined) this.catalog = details.catalog;
  }
}
brandLinkedError(UnresolvedShapeError, '@_linked/core', 'UnresolvedShapeError');

/**
 * The details for a property whose value shape does not resolve. The owner is the property's
 * `parentNodeShape`, or `owner` when the caller knows it better (a path walk).
 */
export function unresolvedValueShapeDetails(
  ps: PropertyShapeData,
  owner?: NodeShapeData,
): UnresolvedShapeDetails {
  const ownerShapeIri = owner?.id ?? ps.parentNodeShape?.id;
  const catalog = getActiveShapeCatalog()?.name;
  return {
    shapeIri: ps.valueShape?.id ?? '',
    property: ps.label,
    ...(ps.path && typeof ps.path === 'object' && 'id' in ps.path && typeof ps.path.id === 'string'
      ? {propertyIri: ps.path.id}
      : {}),
    ...(ownerShapeIri ? {ownerShapeIri} : {}),
    ...(catalog !== undefined ? {catalog} : {}),
  };
}

/** The details for a shape named directly (a query's or mutation's own shape). */
export function topLevelDetails(shapeIri: string): UnresolvedShapeDetails {
  const catalog = getActiveShapeCatalog()?.name;
  return {shapeIri, ...(catalog !== undefined ? {catalog} : {})};
}

/**
 * Why the shape is missing, in words: `property 'home' of '<owner>' points at it; not among the
 * shapes in scope 'p1#main'`. The scope is named only while a scoped `ShapeCatalog` is active
 * (`withShapeCatalog`); against the global registry the text ends after "points at it". Each
 * error keeps its own leading sentence and appends this; empty when there is nothing to add.
 */
export function describeUnresolved(details: UnresolvedShapeDetails): string {
  const parts: string[] = [];
  if (details.property !== undefined) {
    parts.push(
      details.ownerShapeIri
        ? `property '${details.property}' of '${details.ownerShapeIri}' points at it`
        : `property '${details.property}' points at it`,
    );
  }
  if (getActiveShapeCatalog() !== undefined) {
    parts.push(
      details.catalog !== undefined
        ? `not among the shapes in scope '${details.catalog}'`
        : 'not among the shapes in scope',
    );
  }
  return parts.join('; ');
}

/** `<prefix> (<why>)` as an {@link UnresolvedShapeError}; just `<prefix>` when there is no why. */
export function unresolvedShapeError(
  prefix: string,
  details: UnresolvedShapeDetails,
): UnresolvedShapeError {
  const why = describeUnresolved(details);
  return new UnresolvedShapeError(why ? `${prefix} (${why})` : prefix, details);
}

/** The error for a property whose `valueShape` does not resolve. */
export function unresolvedValueShapeError(
  prefix: string,
  ps: PropertyShapeData,
  owner?: NodeShapeData,
): UnresolvedShapeError {
  return unresolvedShapeError(prefix, unresolvedValueShapeDetails(ps, owner));
}
