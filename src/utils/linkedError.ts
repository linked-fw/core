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
 * Any class whose instances are `T`: abstract or not, whatever its constructor takes, and
 * also one whose constructor is `private` (which no `new (...) => T` type accepts).
 */
type AnyClass<T = unknown> = Function & {prototype: T};

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
  return brandLinkedClass(Cls, pkg, name);
}

/**
 * Brand any class so {@link isLinkedInstance} matches its instances from any copy of the
 * defining module: `brandLinkedError` for classes that are not errors. Call it once, right
 * after the class declaration. The brand is the same `Symbol.for('<pkg>:<name>')` an error
 * class gets, so a branded error is also matched by `isLinkedInstance`.
 *
 * @param Cls  The class.
 * @param pkg  The defining package's npm name, e.g. `'@_linked/core'`.
 * @param name The class name. Passed explicitly because a minifier may rename the class.
 * @returns The class.
 */
export function brandLinkedClass<C extends AnyClass<object>>(Cls: C, pkg: string, name: string): C {
  const brand = linkedErrorBrand(pkg, name);
  Object.defineProperty(Cls, LINKED_ERROR_BRAND, {value: brand, configurable: true});
  Object.defineProperty(Cls.prototype, brand, {value: true, configurable: true});
  brandsByPrototype = new WeakMap();
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

/**
 * `value instanceof Cls`, extended to instances of `Cls` from another copy of its module.
 *
 * Use it for a value another package (or another copy of this one) may have made: a
 * `Shape`, `ShapeSet`, `QueryBuilder`, `PendingQueryContext`, `FieldSet`. It also answers
 * `Sub.prototype instanceof Cls` when passed `Sub.prototype`.
 *
 * The brand is looked up on the value's prototype chain, never read off the value itself,
 * so a proxy whose `get` trap guards unknown keys is not touched. Falls back to plain
 * `instanceof` for a class that is not branded; a subclass that is not branded itself does
 * not inherit its base's brand for this check.
 */
export function isLinkedInstance<T>(value: unknown, Cls: AnyClass<T>): value is T {
  if (value instanceof Cls) return true;
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (!Object.prototype.hasOwnProperty.call(Cls, LINKED_ERROR_BRAND)) return false;
  const brand = (Cls as unknown as Record<symbol, symbol>)[LINKED_ERROR_BRAND];
  const proto = Object.getPrototypeOf(value);
  return proto !== null && prototypeChainHasBrand(proto, brand);
}

/**
 * Per prototype, whether its chain carries each brand asked about. Most checks are misses
 * (`isLinkedInstance(x, PendingQueryContext)` on every value a builder sees), and walking the
 * chain each time made query building measurably slower; with this a repeat check is one
 * WeakMap and one Map lookup. A memo, so per copy of this module. Cleared whenever this copy
 * brands a class, so a brand added after a lookup is never hidden by it.
 */
let brandsByPrototype = new WeakMap<object, Map<symbol, boolean>>();

function prototypeChainHasBrand(proto: object, brand: symbol): boolean {
  let known = brandsByPrototype.get(proto);
  if (!known) brandsByPrototype.set(proto, (known = new Map()));
  let has = known.get(brand);
  if (has === undefined) {
    has = false;
    for (let p: object | null = proto; p; p = Object.getPrototypeOf(p)) {
      if (Object.prototype.hasOwnProperty.call(p, brand)) {
        has = true;
        break;
      }
    }
    known.set(brand, has);
  }
  return has;
}

/** The brand symbol for a class: `Symbol.for('<pkg>:<name>')`. */
export function linkedErrorBrand(pkg: string, name: string): symbol {
  return Symbol.for(`${pkg}:${name}`);
}
