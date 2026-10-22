import * as terms from './birds.js';
import {dataFiles, loadData, ns} from './birds.js';
import {linkedOntology} from '../package.js';

linkedOntology(terms, ns, 'source-birds', loadData, dataFiles);
