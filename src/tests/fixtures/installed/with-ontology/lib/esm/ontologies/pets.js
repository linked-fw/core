import {createNameSpace} from '../../../../../../../utils/NameSpace.js';
import {loadOntologyFiles} from '../../../../../../../ontology/loadOntologyFiles.js';

export const ns = createNameSpace('http://example.org/installed-pets/');
export const Pet = ns('Pet');
export const Cat = ns('Cat');
export const dataFiles = ['../data/pets.ttl'];
export const loadData = () => loadOntologyFiles(import.meta.url, dataFiles);
