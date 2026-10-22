/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * Reads the ontology data of every registered package, for the ontology sync and the shape
 * check. Server only (the hierarchy reader loads `n3`).
 *
 * @internal
 */

import {getRegisteredOntologies, type OntologyRegistration} from '../utils/Package.js';
import {hierarchyFromTurtle, type HierarchyTriple} from './hierarchy.js';
import {setOntologyHierarchy} from './classHierarchy.js';

/** One package's ontology data: its Turtle texts, their file names and the parsed hierarchy. */
export interface PackageOntologyData {
  packageName: string;
  /** The Turtle text of every data file of every ontology the package registered. */
  texts: string[];
  /** `files` of each text, prefixed with the ontology's prefix, for error messages. */
  sources: string[];
  /** The `rdfs:subClassOf` triples of the package's data, deduped and sorted. */
  triples: HierarchyTriple[];
}

const isTexts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Registrations grouped by package, in registration order, skipping entries an older copy of core wrote without a package name. */
export function registrationsByPackage(
  registrations: OntologyRegistration[] = getRegisteredOntologies(),
): Map<string, OntologyRegistration[]> {
  const byPackage = new Map<string, OntologyRegistration[]>();
  for (const registration of registrations) {
    if (!registration?.packageName) {
      console.warn(
        `[linked] An ontology registration without a package name was skipped (prefix ` +
          `${registration?.prefix ?? '?'}): it was made by an older copy of @_linked/core.`,
      );
      continue;
    }
    const list = byPackage.get(registration.packageName);
    if (list) list.push(registration);
    else byPackage.set(registration.packageName, [registration]);
  }
  return byPackage;
}

/**
 * Load and parse the ontology data of every registered package that has any (`load` set on at
 * least one of its registrations), or of `packages` only. A package whose `load` rejects, does
 * not resolve to Turtle text (an unconverted JSON package) or does not parse is skipped with one
 * warning naming the package (and the file, when known) and listed in `skipped`.
 */
export async function readPackageOntologies(options?: {
  packages?: string[];
}): Promise<{packages: Map<string, PackageOntologyData>; skipped: string[]}> {
  const only = options?.packages ? new Set(options.packages) : undefined;
  const packages = new Map<string, PackageOntologyData>();
  const skipped: string[] = [];
  for (const [packageName, registrations] of registrationsByPackage()) {
    if (only && !only.has(packageName)) continue;
    const withData = registrations.filter((r) => typeof r.load === 'function');
    if (withData.length === 0) continue;
    const texts: string[] = [];
    const sources: string[] = [];
    let ok = true;
    for (const registration of withData) {
      let loaded: unknown;
      try {
        loaded = await registration.load!();
      } catch (error) {
        console.warn(
          `[linked] Could not read the ontology data of ${packageName} (${registration.prefix}, ` +
            `${registration.files.join(', ') || 'no file named'}); the package is skipped: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        ok = false;
        break;
      }
      if (!isTexts(loaded)) {
        console.warn(
          `[linked] ontology data of ${packageName} (${registration.prefix}) is not Turtle text; ` +
            `skipped — convert src/data to .ttl`,
        );
        ok = false;
        break;
      }
      loaded.forEach((text, i) => {
        texts.push(text);
        sources.push(`${registration.prefix}: ${registration.files[i] ?? `text #${i + 1}`}`);
      });
    }
    if (!ok) {
      skipped.push(packageName);
      continue;
    }
    let triples: HierarchyTriple[];
    try {
      triples = await hierarchyFromTurtle(texts, sources);
    } catch (error) {
      console.warn(
        `[linked] The ontology data of ${packageName} does not parse; the package is skipped: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      skipped.push(packageName);
      continue;
    }
    packages.set(packageName, {packageName, texts, sources, triples});
  }
  return {packages, skipped};
}

/**
 * The union of the packages' triples, deduped and sorted, set as the in-memory hierarchy
 * (`setOntologyHierarchy`) and returned. Shared by `loadOntologyHierarchy` and the ontology sync,
 * so a sync parses the data once.
 */
export function setHierarchyFromPackages(
  packages: Map<string, PackageOntologyData>,
): HierarchyTriple[] {
  const seen = new Set<string>();
  const triples: HierarchyTriple[] = [];
  for (const data of packages.values()) {
    for (const triple of data.triples) {
      const key = `${triple.s}\u0000${triple.o}`;
      if (seen.has(key)) continue;
      seen.add(key);
      triples.push(triple);
    }
  }
  triples.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.o < b.o ? -1 : a.o > b.o ? 1 : 0));
  setOntologyHierarchy(triples);
  return triples;
}
