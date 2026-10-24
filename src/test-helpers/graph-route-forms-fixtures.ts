/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Shapes for the graph route forms (`'own'`, `dataGraph()`): a scoped package whose name needs
 * slugging, a shape named explicitly, and a sub-shape.
 */
import {linkedPackage} from '../utils/Package.js';
import {Shape} from '../shapes/Shape.js';
import {literalProperty} from '../shapes/SHACL.js';

const {linkedShape} = linkedPackage('@acme/News_Site');

export const RF = 'https://example.org/route-forms/';
const ex = (local: string) => ({id: `${RF}${local}`});

@linkedShape
export class RFArticle extends Shape {
  static targetClass = ex('Article');

  @literalProperty({path: ex('headline'), maxCount: 1})
  get headline(): string {
    return '';
  }
}

@linkedShape
export class RFNewsArticle extends RFArticle {
  static targetClass = ex('NewsArticle');
}

@linkedShape({name: 'Story'})
export class RFStoryShape extends Shape {
  static targetClass = ex('Story');
}

/** A package slugged `import`, the top segment of the managed imported graphs. */
const importPackage = linkedPackage('@acme/import');

@importPackage.linkedShape
export class RFImportedRecord extends Shape {
  static targetClass = ex('ImportedRecord');
}

/** Named in lower case: its `'own'` graph would be named exactly like an imported graph. */
@importPackage.linkedShape({name: 'wikidata-people'})
export class RFLowerNamed extends Shape {
  static targetClass = ex('LowerNamed');
}
