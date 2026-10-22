/**
 * Registers the `npm:` vocabulary with its data, so the ontology sync and the shape check read it.
 *
 * Kept out of `npm.ts` because registration needs that module's whole export namespace, and a
 * module cannot import itself once a bundler is involved (Rollup elides a static self-reference).
 * From a sibling module the same import is ordinary and survives.
 */
import * as terms from './npm.js';
import {dataFiles, loadData, ns} from './npm.js';
import {linkedOntology} from '../package.js';

linkedOntology(terms, ns, 'npm', loadData, dataFiles);
