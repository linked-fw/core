import {createNameSpace} from '../../../../../../utils/NameSpace.js';
import {loadOntologyFiles} from '../../../../../../ontology/loadOntologyFiles.js';

export const ns = createNameSpace('http://example.org/source-birds/');
export const Bird = ns('Bird');
export const Owl = ns('Owl');
export const dataFiles = ['../data/birds.ttl'];
export const loadData = () => loadOntologyFiles(import.meta.url, dataFiles);
