import * as terms from './pets.js';
import {dataFiles, loadData, ns} from './pets.js';
import {linkedOntology} from '../package.js';

linkedOntology(terms, ns, 'installed-pets', loadData, dataFiles);
