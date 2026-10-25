import type {NodeReferenceValue} from '../utils/NodeReference.js';
import {createNameSpace} from '../utils/NameSpace.js';
import {Prefix} from '../utils/Prefix.js';
// Through the package specifier, not a relative path: the `browser` and `react-native` export
// conditions of this subpath give a client build the stub, and a relative import ignores them.
import {loadOntologyFiles} from '@_linked/core/ontology/loadOntologyFiles';

/** This ontology's data, relative to this module (Turtle, copied into `lib/` by the build). */
export const dataFiles = ['../data/npm.ttl'];

/** Reads this ontology's data (server only). */
export const loadData = () => loadOntologyFiles(import.meta.url, dataFiles);

const base = 'http://purl.org/on/npm/';
export const ns = createNameSpace(base);
Prefix.add('npm', base);

const packageName: NodeReferenceValue = ns('packageName');
const version: NodeReferenceValue = ns('version');

export const npm = {
  version,
  packageName,
};
