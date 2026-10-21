/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {Shape} from './Shape.js';
import {literalProperty} from './SHACL.js';
import {shacl} from '../ontologies/shacl.js';
import {rdfs} from '../ontologies/rdfs.js';
import {xsd} from '../ontologies/xsd.js';

/**
 * A SHACL property group (`sh:PropertyGroup`): a labelled, ordered section that property shapes
 * join through `sh:group`, for forms and other generic renderings. Its label is `rdfs:label`
 * (inherited from `Shape`).
 *
 * This module holds the class only, and must never import `package.js`: `utils/Package.ts`
 * registers it by value, because `PropertyShape.group` names it as its value shape (as `List`
 * for `PropertyShape.in`). The public module is `PropertyGroup.ts`.
 */
export class PropertyGroup extends Shape {
  static targetClass = shacl.PropertyGroup;

  /** `rdfs:comment` — what the group holds. */
  @literalProperty({path: rdfs.comment, maxCount: 1})
  get description(): string {
    return null;
  }

  /** `sh:order` — the group's position among the groups of a shape. */
  @literalProperty({path: shacl.order, datatype: xsd.decimal, maxCount: 1})
  get order(): number {
    return null;
  }
}
