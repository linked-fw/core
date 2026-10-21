// A shape file an app deep-imports: it loads the package module and its ontology's terms, but
// not the register module, so the package's ontology is not registered by importing it.
import {packageName} from '../package.js';
import {Cat} from '../ontologies/pets.js';

export const CatShape = {packageName, targetClass: Cat};
