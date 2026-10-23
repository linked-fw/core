/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The one way framework code loads a module of an installed or workspace package it discovered
 * at runtime (stores, ontology register modules, shapes, providers). See
 * `docs/architecture/loading-package-modules.md`.
 *
 * Server only: frontends import package modules statically. It lives in its own module so that
 * frontend bundlers never see its `import(variable)`.
 *
 * @module @_linked/core/utils/importPackageModule
 */

/** A module loader installed by the host (linked start): takes a package specifier. */
export type ModuleLoader = (target: string) => Promise<unknown>;

/**
 * Where the host installs its {@link ModuleLoader}, on `globalThis`. `linked start` (dev) sets it,
 * because there the app runs in Vite's SSR module runner, and a native `import()` would load a
 * second copy of a package the runner bundles (cli reports 014–017).
 */
export const MODULE_LOADER_KEY = Symbol.for('@_linked/core:importModule');

type Url = {pathToFileURL(path: string): URL};

/** A POSIX absolute path, a Windows drive path (`C:\…`, `C:/…`) or a UNC path (`\\server\…`). */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;

/**
 * Load a package module the way the running host does. Framework code that discovers and imports
 * package modules must use this.
 *
 * `target` is a package specifier (`<name>/<subpath>`), and that is what goes through the loader
 * the host installed (Vite in development), unchanged; the loader is read on every call, so the
 * host may install it after this module was evaluated. Without one, the specifier is Node's
 * `import()`.
 *
 * An absolute file path (or a `file:` URL) is always Node's `import()`, by its `file:` URL, also
 * when a loader is installed: a host loader is only promised to take specifiers, and a file path
 * would bypass the package resolution that keeps one copy per package. Import by specifier where
 * the package exports the module.
 *
 * @example
 * ```ts
 * import {importPackageModule} from '@_linked/core/utils/importPackageModule';
 *
 * const mod = await importPackageModule('@_linked/fuseki/shapes/FusekiStore');
 * ```
 */
export function importPackageModule(target: string): Promise<unknown> {
  if (isFileTarget(target)) return nativeImport(target);
  const loader = installedModuleLoader();
  if (loader) return loader(target);
  return nativeImport(target);
}

/**
 * The {@link ModuleLoader} the host installed at {@link MODULE_LOADER_KEY}, or undefined when
 * there is none (a production build, plain Node, tests). Read on every call. For framework code
 * that loads differently with a host loader than without (`registerInstalledOntologies` imports by
 * specifier then); to load a module, call {@link importPackageModule}.
 */
export function installedModuleLoader(): ModuleLoader | undefined {
  const loader = (globalThis as Record<symbol, unknown>)[MODULE_LOADER_KEY];
  return typeof loader === 'function' ? (loader as ModuleLoader) : undefined;
}

function isFileTarget(target: string): boolean {
  return ABSOLUTE_PATH.test(target) || target.startsWith('file:');
}

async function nativeImport(target: string): Promise<unknown> {
  if (!ABSOLUTE_PATH.test(target)) {
    return import(/* @vite-ignore */ /* webpackIgnore: true */ target);
  }
  const nodeUrl = 'node:url';
  const {pathToFileURL} = (await import(/* @vite-ignore */ /* webpackIgnore: true */ nodeUrl)) as Url;
  return import(/* @vite-ignore */ /* webpackIgnore: true */ pathToFileURL(target).href);
}
