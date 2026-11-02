/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {Prefix} from '../utils/Prefix.js';

/**
 * The W3C PROV-O term core's graph registry uses (`NamedGraph.attributedTo`). Core does not
 * mirror PROV-O: this module has no ontology data, only the term.
 */
const base = 'http://www.w3.org/ns/prov#';
export const ns = (term: string): NodeReferenceValue => ({id: base + term});

export const _ontologyResource = ns('');
Prefix.add('prov', base);

const wasAttributedTo = ns('wasAttributedTo');

export const prov = {
  _ontologyResource,
  wasAttributedTo,
};
