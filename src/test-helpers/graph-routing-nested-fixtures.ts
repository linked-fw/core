/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Shapes for graph routing across nested writes and sub-shape owners: an article that links (does
 * not own) its author, a person who owns (`contains`) an avatar, and an album that owns a cover
 * typed by a sub-shape (`NGPanorama`) of a shape read on its own (`NGPhoto`).
 */
import {linkedPackage} from '../utils/Package.js';
import {Shape} from '../shapes/Shape.js';
import {literalProperty, objectProperty} from '../shapes/SHACL.js';

const {linkedShape} = linkedPackage('graph-routing-nested-test');

export const NG = 'https://example.org/graph-routing-nested/';
const ex = (local: string) => ({id: `${NG}${local}`});

@linkedShape
export class NGImage extends Shape {
  static targetClass = ex('Image');

  @literalProperty({path: ex('url'), maxCount: 1})
  get url(): string {
    return '';
  }
}

@linkedShape
export class NGPerson extends Shape {
  static targetClass = ex('Person');

  @literalProperty({path: ex('name'), maxCount: 1})
  get name(): string {
    return '';
  }

  @objectProperty({path: ex('avatar'), shape: NGImage, maxCount: 1, contains: true})
  get avatar(): NGImage {
    return null as unknown as NGImage;
  }

  @objectProperty({path: ex('friend'), shape: NGPerson})
  get friends(): NGPerson[] {
    return [];
  }
}

@linkedShape
export class NGArticle extends Shape {
  static targetClass = ex('Article');

  @literalProperty({path: ex('title'), maxCount: 1})
  get title(): string {
    return '';
  }

  @objectProperty({path: ex('author'), shape: NGPerson, maxCount: 1})
  get author(): NGPerson {
    return null as unknown as NGPerson;
  }
}

@linkedShape
export class NGPhoto extends Shape {
  static targetClass = ex('Photo');

  @literalProperty({path: ex('caption'), maxCount: 1})
  get caption(): string {
    return '';
  }
}

@linkedShape
export class NGPanorama extends NGPhoto {
  static targetClass = ex('Panorama');
}

@linkedShape
export class NGAlbum extends Shape {
  static targetClass = ex('Album');

  @literalProperty({path: ex('title'), maxCount: 1})
  get title(): string {
    return '';
  }

  @objectProperty({path: ex('cover'), shape: NGPanorama, maxCount: 1, contains: true})
  get cover(): NGPanorama {
    return null as unknown as NGPanorama;
  }
}
