import type {IFileStore, SaveFileOptions} from '../interfaces/IFileStore.js';
import type {Readable} from 'stream';

/**
 * Well-known file store purposes shipped with core.
 *
 * Core itself never writes to `appAssets`; it lives here as the documented
 * convention (plan 011 D4) so the CLI and apps agree on the same key without a
 * shared runtime dependency. Any *new* purpose's constant belongs in the
 * runtime package that owns the concept, not here and not in the CLI.
 */
export const FileStorePurposes = {
  /** User-generated files. Resolves to the default store unless split out. */
  uploads: 'uploads',
  /** Built app bundles published by `linked build-app`. */
  appAssets: 'appAssets',
} as const;

export type FileStorePurpose =
  (typeof FileStorePurposes)[keyof typeof FileStorePurposes];

export interface FileStorePurposeInfo {
  description?: string;
}

export interface FileStorePurposeListing {
  purpose: string;
  description?: string;
  configured: boolean;
}

export abstract class LinkedFileStorage {
  private static defaultStore: IFileStore;
  private static url: string; // default accessURL
  private static assetDirectory = '/public';

  /** Purpose → the store configured for it. */
  private static stores: Map<string, IFileStore> = new Map();
  /** Every declared purpose, configured or not. */
  private static purposes: Map<string, FileStorePurposeInfo> = new Map();
  /** Purposes already reported as falling back, so the log fires once each. */
  private static loggedFallbacks: Set<string> = new Set();

  static get accessURL(): string {
    // check if default store is not set, return default accessURL
    if (!this.defaultStore) {
      return this.url;
    }

    return this.defaultStore.accessURL;
  }

  static setDefaultAccessURL(accessURL: string): string {
    return (this.url = accessURL);
  }

  static setDefaultAssetDirectory(directory: string): string {
    return (this.assetDirectory = directory);
  }

  static getDefaultAssetDirectory(): string {
    return this.assetDirectory;
  }

  static getDefaultStore(): IFileStore {
    return this.defaultStore;
  }

  /**
   * Configure the default store: the fallback for *every* purpose, `uploads`
   * included.
   *
   * It deliberately writes no entry into the purpose → store map, so `uploads`
   * behaves exactly like `appAssets`: an explicit `setStore('uploads', other)`
   * wins whenever it is called, before or after this, and `hasStore('uploads')`
   * stays false until such a call is made.
   */
  static setDefaultStore(store: IFileStore) {
    this.defaultStore = store;

    if (this.defaultStore.init) {
      this.defaultStore.init();
    }
  }

  /** @deprecated use {@link LinkedFileStorage.getDefaultStore} */
  static getDefaultDataset(): IFileStore {
    return this.getDefaultStore();
  }

  /** @deprecated use {@link LinkedFileStorage.setDefaultStore} */
  static setDefaultDataset(dataset: IFileStore) {
    this.setDefaultStore(dataset);
  }

  /**
   * Declare a purpose without configuring a store for it.
   *
   * A package that *reads* a purpose the app may leave unconfigured registers
   * it in the same module that exports its constant, so importing the constant
   * is the registration and ordering resolves itself.
   */
  static registerPurpose(purpose: string, info: FileStorePurposeInfo = {}) {
    const existing = this.purposes.get(purpose);
    // Keep an existing description rather than blanking it on a re-register.
    this.purposes.set(purpose, {
      description: info.description ?? existing?.description,
    });
  }

  /** Configure the store for a purpose. Also registers the purpose. */
  static setStore(purpose: string, store: IFileStore) {
    this.registerPurpose(purpose);
    this.stores.set(purpose, store);

    if (store.init) {
      store.init();
    }
  }

  /**
   * Resolve the store for a purpose (plan 011 D2):
   * - configured        → that store;
   * - registered, not configured → the default store, logged once;
   * - not registered    → throws.
   *
   * Unregistered throws on purpose: only a registry can tell "the app did not
   * split this purpose out" apart from a typo. Without it, `'appAsset'` would
   * silently write release bundles into the uploads store.
   *
   * The returned store is a **live reference**, resolved once at call time. A
   * caller that holds on to a store returned through the default-store fallback
   * keeps that object even after a later `setStore(purpose, other)`; call
   * `getStore` again per operation if the configuration can change at runtime.
   */
  static getStore(purpose: string): IFileStore {
    const configured = this.stores.get(purpose);
    if (configured) {
      return configured;
    }

    if (!this.purposes.has(purpose)) {
      throw new Error(
        `Unknown file store purpose '${purpose}'. Register it with LinkedFileStorage.setStore(), ` +
          `or import the package that defines it. Known purposes: ${
            this.listPurposes()
              .map((entry) => entry.purpose)
              .join(', ') || '(none)'
          }`,
      );
    }

    if (!this.defaultStore) {
      throw new Error(
        `No file store is configured for purpose '${purpose}', and no default store is configured. ` +
          `Call LinkedFileStorage.setStore('${purpose}', store) or LinkedFileStorage.setDefaultStore(store).`,
      );
    }

    if (!this.loggedFallbacks.has(purpose)) {
      this.loggedFallbacks.add(purpose);
      // `debug`, not `info`: falling back is the normal configuration for an
      // app that runs one store, so this must not read as a problem or show up
      // in default-level logs. It stays available when diagnosing which store a
      // purpose actually resolved to.
      console.debug(
        `[LinkedFileStorage] Purpose '${purpose}' has no dedicated store; using the default store.`,
      );
    }

    return this.defaultStore;
  }

  /**
   * Whether a store was *explicitly configured* for this purpose.
   *
   * The default-store fallback is deliberately ignored: `hasStore(p)` is false
   * while `getStore(p)` still returns a usable store via the default. Use this
   * to ask "did the app split this purpose out?", never as a guard before
   * `getStore` — that would skip a perfectly working fallback.
   */
  static hasStore(purpose: string): boolean {
    return this.stores.has(purpose);
  }

  /** Every declared purpose, with whether it has its own store. */
  static listPurposes(): FileStorePurposeListing[] {
    return Array.from(this.purposes.entries()).map(([purpose, info]) => ({
      purpose,
      description: info.description,
      configured: this.stores.has(purpose),
    }));
  }

  /** The access URL of the store resolved for this purpose. */
  static accessURLFor(purpose: string): string {
    return this.getStore(purpose).accessURL;
  }

  static deleteFile(filePath: string): Promise<void> {
    return this.defaultStore.deleteFile(filePath);
  }

  static fileExists(filePath: string): Promise<boolean> {
    return this.defaultStore.fileExists(filePath);
  }

  static getFile(filePath: string): Promise<Buffer> {
    return this.defaultStore.getFile(filePath);
  }

  static listFiles(prefix?: string): Promise<string[]> {
    return this.defaultStore.listFiles(prefix);
  }

  static saveFile(
    filePath: string,
    fileContent: string | Uint8Array | Buffer | Readable,
    options?: SaveFileOptions | string,
    /**
     * Forwarded exactly as given. No default here on purpose: "unspecified"
     * must reach the store so it can apply its own default.
     */
    preventDuplicates?: boolean,
  ): Promise<string> {
    return this.defaultStore.saveFile(
      filePath,
      fileContent,
      options,
      preventDuplicates,
    );
  }

  /**
   * Clears the module-global registry and default store.
   * For tests only — the registry is process-wide state.
   *
   * @internal
   */
  static resetForTests() {
    this.stores.clear();
    this.purposes.clear();
    this.loggedFallbacks.clear();
    this.defaultStore = undefined as unknown as IFileStore;
    this.url = undefined as unknown as string;
    this.assetDirectory = '/public';
    registerWellKnownPurposes();
  }
}

/** The purposes core ships with are declared at module load. */
function registerWellKnownPurposes() {
  LinkedFileStorage.registerPurpose(FileStorePurposes.uploads, {
    description: 'User-generated files. Falls back to the default store.',
  });
  LinkedFileStorage.registerPurpose(FileStorePurposes.appAssets, {
    description: 'Built app bundles published by `linked build-app`.',
  });
}

registerWellKnownPurposes();

/**
 * Get the full path of an asset based on the way LinkedFileStorage is configured
 * Returns accessURL + directory (/public by default) + path
 * @param path asset path
 * @param directory asset directory (optional, default is /public)
 * @returns asset url. e.g. https://cdn.example.com/public/image.png
 */
export function asset(
  path: string,
  directory: string = LinkedFileStorage.getDefaultAssetDirectory(),
): string {
  // Some callers pass a raw app-relative path like `/images/foo.webp`, while
  // others may already have a fully qualified asset URL from an earlier
  // `asset(...)` call or backend response normalization. Keep this helper
  // idempotent so shared card/image components can safely call `asset(...)`
  // without duplicating the access URL prefix.
  if (/^(?:[a-z]+:)?\/\//i.test(path) || path.startsWith('data:') || path.startsWith('blob:')) {
    return path;
  }

  const accessURL = LinkedFileStorage.accessURL;
  const normalizedDirectory = directory.replace(/\/+$/, '');
  if (
    normalizedDirectory &&
    (path === normalizedDirectory || path.startsWith(`${normalizedDirectory}/`))
  ) {
    return accessURL + path;
  }
  const assetUrl = accessURL + directory + path;
  return assetUrl;
}
