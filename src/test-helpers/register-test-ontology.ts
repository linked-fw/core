/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {
  isRegisteredPackage,
  linkedPackage,
  setOntologyRegistration,
  type OntologyRegistration,
} from '../utils/Package.js';

/**
 * Register an ontology for a test, with its data held in memory: `load` returns the Turtle texts
 * (read again on every call, so a test may change them between syncs). A package registers with
 * `registerOntologies`, which reads data files; a test that has no files uses this instead.
 * Registers the package (`linkedPackage`) first when it is not yet.
 */
export function registerTestOntology(
  packageName: string,
  ontology: {
    name: string;
    namespace: string;
    terms?: Record<string, unknown>;
    load?: () => Promise<unknown>;
    files?: string | string[];
    suggestedPrefix?: string;
  },
): OntologyRegistration {
  if (!isRegisteredPackage(packageName)) linkedPackage(packageName);
  const files = ontology.files === undefined ? [] : Array.isArray(ontology.files) ? ontology.files : [ontology.files];
  const registration: OntologyRegistration = {
    packageName,
    name: ontology.name,
    namespace: ontology.namespace,
    files,
    terms: ontology.terms ?? {},
  };
  if (ontology.load) registration.load = ontology.load;
  if (ontology.suggestedPrefix !== undefined) registration.suggestedPrefix = ontology.suggestedPrefix;
  setOntologyRegistration(registration);
  return registration;
}
