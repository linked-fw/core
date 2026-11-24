import * as pets from './pets.js';
import {registerOntologies} from '../package.js';

registerOntologies(
  [
    {
      name: 'installed-pets',
      namespace: 'http://example.org/installed-pets/',
      terms: pets,
      data: ['../data/pets.ttl'],
      suggestedPrefix: 'pets',
    },
  ],
  import.meta.url,
);
