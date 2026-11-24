import * as birds from './birds.js';
import {registerOntologies} from '../package.js';

registerOntologies(
  [{name: 'source-birds', namespace: 'http://example.org/source-birds/', terms: birds, data: ['../data/birds.ttl']}],
  import.meta.url,
);
