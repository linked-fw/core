// Pure parser + dispatcher for linked.{backend,frontend}.datasets.json.
//
// Per the spec in docs/backlog/016-ejection-export-flow.md:
//
//   {
//     "datasets": {
//       "<alias>": {
//         "store":  "<npm-import-path>",
//         "config": { /* passed verbatim to the store's constructor */ }
//       }
//     }
//   }
//
// `store` is an npm import path string (e.g. "@_linked/fuseki/shapes/FusekiStore").
// `config` is the store class's own concern — the runtime never inspects it.
// `${VAR}` / `${VAR:-default}` placeholders inside string values are resolved
// against an env map at parse time.
//
// Graph routing is not configured here: it lives in the app's code
// (`LinkedStorage.setDatasetForShapes(store, shapes, {graph})`, see
// `utils/graphRouting.ts`). This file holds what changes per deployment.

/** One entry under `datasets`. Keyed by alias name in the parent object. */
export interface DatasetEntry {
  /** npm import path to the IDataset class — e.g. "@_linked/fuseki/shapes/FusekiStore". */
  store: string;
  /** Constructor argument forwarded to the store class. Shape is store-specific. */
  config: Record<string, unknown>;
}

/** Top-level structure of linked.{backend,frontend}.datasets.json. */
export interface DatasetsConfig {
  /** Alias → store entry. */
  datasets: Record<string, DatasetEntry>;
  /** Reserved for future top-level sections (fileStorage, services, etc.). */
  [section: string]: unknown;
}

/**
 * Parse + env-resolve a raw datasets config object.
 *
 * - Requires a top-level `datasets` object (other top-level sections are passed
 *   through unchanged for future extension).
 * - Resolves `${VAR}` and `${VAR:-default}` placeholders against `env` recursively
 *   across all string leaves.
 * - Strips keys starting with `_` (treated as comments / `_note` fields).
 * - Throws on a referenced env var with no default that is unset or empty.
 *
 * Pure + browser-safe — no file I/O, no dynamic imports. Use this on both
 * backend and frontend. The companion `loadStores` (separate file) does the
 * runtime dynamic-import dispatch for the backend.
 *
 * @example Backend
 * ```ts
 * import rawConfig from './linked.backend.datasets.json' assert { type: 'json' };
 * const config = parseDatasetsConfig(rawConfig, process.env);
 * ```
 *
 * @example Frontend
 * ```ts
 * import rawConfig from './linked.frontend.datasets.json' assert { type: 'json' };
 * // No runtime env in the browser; pass empty {}
 * const config = parseDatasetsConfig(rawConfig, {});
 * const appData = new BackendAPIStore(config.datasets.appData.config);
 * ```
 *
 * @param raw   Parsed JSON object (or anything object-shaped). Throws otherwise.
 * @param env   Env map. Defaults to {} (no interpolation).
 * @returns     Typed, env-resolved {@link DatasetsConfig}.
 * @throws      On missing/malformed `datasets`, on malformed alias entry, or
 *              on an unresolved `${VAR}` with no default.
 */
export function parseDatasetsConfig(
  raw: unknown,
  env: Record<string, string | undefined> = {},
): DatasetsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      'Invalid datasets config: expected a top-level JSON object',
    );
  }
  const resolved = resolveInterpolations(raw, env) as Record<string, unknown>;
  const datasets = resolved.datasets;
  if (!datasets || typeof datasets !== 'object' || Array.isArray(datasets)) {
    throw new Error(
      'Invalid datasets config: missing or malformed "datasets" section',
    );
  }
  for (const [alias, entry] of Object.entries(datasets)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(
        `Invalid datasets config: alias "${alias}" must be an object`,
      );
    }
    const e = entry as DatasetEntry;
    if (typeof e.store !== 'string' || !e.store) {
      throw new Error(
        `Invalid datasets config: alias "${alias}" is missing a string "store" (npm import path)`,
      );
    }
    if (e.config !== undefined && (typeof e.config !== 'object' || Array.isArray(e.config))) {
      throw new Error(
        `Invalid datasets config: alias "${alias}" "config" must be an object if present`,
      );
    }
    if (e.config === undefined) e.config = {};
  }
  return resolved as DatasetsConfig;
}

function resolveInterpolations(
  value: unknown,
  env: Record<string, string | undefined>,
): unknown {
  if (typeof value === 'string') return resolveString(value, env);
  if (Array.isArray(value)) {
    return value.map((v) => resolveInterpolations(v, env));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (key.startsWith('_')) continue; // _note, _comment, ...
      out[key] = resolveInterpolations(
        (value as Record<string, unknown>)[key],
        env,
      );
    }
    return out;
  }
  return value;
}

// Matches ${VAR} or ${VAR:-default}. VAR is uppercase alphanum + underscore.
// Default text may contain anything except `}`.
const INTERP_RE = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

function resolveString(
  input: string,
  env: Record<string, string | undefined>,
): string {
  return input.replace(INTERP_RE, (_full, varName: string, defaultValue?: string) => {
    const v = env[varName];
    if (v !== undefined && v !== '') return v;
    if (defaultValue !== undefined) return defaultValue;
    throw new Error(
      `Required env var "${varName}" is not set and has no default (referenced in datasets config)`,
    );
  });
}

