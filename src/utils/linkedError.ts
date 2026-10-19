/**
 * Error identity that survives a second copy of the module that defines the error.
 *
 * `err instanceof RemoteDatasetError` is false when the error was thrown by one copy of
 * `@_linked/server` and the class was imported from another: each copy has its own class.
 * A branded class instead carries a brand, `Symbol.for('<pkg>:<ClassName>')`, on its
 * prototype. Every copy of the class carries the same symbol, so {@link isLinkedError} can
 * recognise an error from any copy. The brand is read along the error's prototype chain, so a
 * subclass instance matches its base class, as with `instanceof`.
 *
 * The convention is the symbol keys, not this module: two copies of core brand and check
 * the same keys. See https://github.com/linked-fw/cli/blob/main/docs/architecture/shared-state-and-error-brands.md.
 */

/** Static key on a branded class whose value is the class's brand symbol. */
const LINKED_ERROR_BRAND = Symbol.for('@_linked/core:errorBrand');

type ErrorClass = abstract new (...args: never[]) => Error;

/**
 * Brand an error class so {@link isLinkedError} matches its instances from any copy of the
 * defining module. Call it once, right after the class declaration.
 *
 * @param Cls  The error class.
 * @param pkg  The defining package's npm name, e.g. `'@_linked/server'`.
 * @param name The class name. Passed explicitly because a minifier may rename the class.
 * @returns The class, for `export const X = brandLinkedError(class X ..., pkg, 'X')` use.
 */
export function brandLinkedError<C extends ErrorClass>(Cls: C, pkg: string, name: string): C {
  const brand = linkedErrorBrand(pkg, name);
  Object.defineProperty(Cls, LINKED_ERROR_BRAND, {value: brand, configurable: true});
  Object.defineProperty(Cls.prototype, brand, {value: true, configurable: true});
  return Cls;
}

/**
 * `err instanceof Cls`, extended to instances of `Cls` from another copy of its module.
 *
 * Falls back to plain `instanceof` for a class that is not branded. A subclass that is not
 * branded itself does not inherit its base's brand for this check: it would otherwise match
 * every instance of the base.
 */
export function isLinkedError<C extends ErrorClass>(err: unknown, Cls: C): err is InstanceType<C> {
  if (err instanceof Cls) return true;
  if (err === null || (typeof err !== 'object' && typeof err !== 'function')) return false;
  if (!Object.prototype.hasOwnProperty.call(Cls, LINKED_ERROR_BRAND)) return false;
  const brand = (Cls as unknown as Record<symbol, symbol>)[LINKED_ERROR_BRAND];
  return (err as Record<symbol, unknown>)[brand] === true;
}

/** The brand symbol for a class: `Symbol.for('<pkg>:<name>')`. */
export function linkedErrorBrand(pkg: string, name: string): symbol {
  return Symbol.for(`${pkg}:${name}`);
}
