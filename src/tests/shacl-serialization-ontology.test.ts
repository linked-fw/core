/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {describe, expect, test} from '@jest/globals';
import {shacl} from '../ontologies/shacl';
import {coreOntology} from '../ontologies/linked-core';
import {Prefix} from '../utils/Prefix';

const SH = 'http://www.w3.org/ns/shacl#';
const LC = 'https://linked.cm/ont/core/';

describe('ontology terms', () => {
  test('shacl predicates present', () => {
    expect(shacl.equals.id).toBe(`${SH}equals`);
    expect(shacl.disjoint.id).toBe(`${SH}disjoint`);
    expect(shacl.hasValue.id).toBe(`${SH}hasValue`);
    expect(shacl.defaultValue.id).toBe(`${SH}defaultValue`);
    expect(shacl.order.id).toBe(`${SH}order`);
    expect(shacl.group.id).toBe(`${SH}group`);
    expect(shacl.closed.id).toBe(`${SH}closed`);
    expect(shacl.ignoredProperties.id).toBe(`${SH}ignoredProperties`);
  });

  test('core terms present', () => {
    expect(coreOntology.contains.id).toBe(`${LC}contains`);
    expect(coreOntology.dependent.id).toBe(`${LC}dependent`);
    expect(coreOntology.PathNode.id).toBe(`${LC}PathNode`);
  });

  test('with core: in the prefix map, core terms compact to core:', () => {
    expect(Prefix.toPrefixed(`${LC}displayRank`)).toBe('core:displayRank');
    expect(Prefix.toFull('core:displayRank')).toBe(`${LC}displayRank`);
    // Core registers no prefix itself: the deprecated linked_core alias is gone.
    expect(() => Prefix.toFull('linked_core:displayRank')).toThrow('Unknown prefix "linked_core"');
  });
});
