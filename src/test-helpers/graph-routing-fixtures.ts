/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Shapes for the graph-routing tests: an album that owns (`contains`) its cover photo, and a
 * panorama sub-shape of the photo.
 */
import {linkedPackage} from '../utils/Package.js';
import {Shape} from '../shapes/Shape.js';
import {literalProperty, objectProperty} from '../shapes/SHACL.js';

const {linkedShape} = linkedPackage('graph-routing-test');

export const GR = 'https://example.org/graph-routing/';
const ex = (local: string) => ({id: `${GR}${local}`});

@linkedShape
export class GRPhoto extends Shape {
  static targetClass = ex('Photo');

  @literalProperty({path: ex('caption'), maxCount: 1})
  get caption(): string {
    return '';
  }
}

@linkedShape
export class GRPanorama extends GRPhoto {
  static targetClass = ex('Panorama');
}

@linkedShape
export class GRAlbum extends Shape {
  static targetClass = ex('Album');

  @literalProperty({path: ex('title'), maxCount: 1})
  get title(): string {
    return '';
  }

  @objectProperty({path: ex('cover'), shape: GRPhoto, maxCount: 1, contains: true})
  get cover(): GRPhoto {
    return null as unknown as GRPhoto;
  }

  @objectProperty({path: ex('related'), shape: GRAlbum})
  get related(): GRAlbum[] {
    return [];
  }
}
