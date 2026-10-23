/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {Prefix} from '../utils/Prefix.js';

/**
 * The two SPARQL 1.1 Service Description terms core's graph registry uses. Core does not mirror
 * Service Description: this module has no ontology data, only the terms.
 */
const base = 'http://www.w3.org/ns/sparql-service-description#';
export const ns = (term: string): NodeReferenceValue => ({id: base + term});

export const _ontologyResource = ns('');
Prefix.add('sd', base);

const NamedGraph = ns('NamedGraph');
const name = ns('name');

export const sd = {
  _ontologyResource,
  NamedGraph,
  name,
};
