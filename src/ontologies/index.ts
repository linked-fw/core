/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
/**
 * Registers core's ontologies (`package.json` `linkedOntologies`), so the ontology sync and the
 * shape check read them. The package entry imports this module. It registers no prefix.
 */
import * as core from './linked-core.js';
import {registerOntologies} from '../package.js';

registerOntologies(
  [
    {
      name: 'core',
      namespace: 'https://linked.cm/ont/core/',
      terms: core,
      data: ['../data/core.ttl'],
      suggestedPrefix: 'core',
    },
  ],
  import.meta.url,
);
