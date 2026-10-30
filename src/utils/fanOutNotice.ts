/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The notice `LinkedStorage` logs when a shapeless read, sent without a dataset, goes to more
 * than one dataset (see `LinkedStorage.triplesQuery` and `LinkedStorage.askQuery`).
 *
 * Such a read is correct, but it costs a query per dataset, and the caller usually knows which
 * dataset it means. The notice says so once per call site: the first stack frame outside core,
 * as `file:line:column`. Without such a frame it says so once per kind of read: a builder awaited
 * without `.exec()` (`await TriplesBuilder.forNode({id})`) is run by its `then()` from a microtask,
 * where the caller is no longer on the stack; so is a bundle that inlines core, or an engine
 * without `Error.stack`.
 */

/** The shapeless reads `LinkedStorage` sends to every dataset it knows. */
export type FanOutKind = 'triples' | 'ask';

/** The call sites (or, without one, the kinds) already noticed in this process. */
const noticed = new Set<string>();

const advice: Record<FanOutKind, {what: string; how: string; fix: string}> = {
  triples: {
    what: 'A subject read (TriplesBuilder.forNode({id})) names no dataset and no graph',
    how: 'read it in each and joined the answers',
    fix:
      'To read one dataset, pass it: .exec(dataset). To read only some graphs, name them: ' +
      '.from(graph).',
  },
  ask: {
    what: 'A shapeless ask (Shape.exists(iri), AskBuilder.forNode(iri)) names no dataset',
    how: 'asked them in turn until one answered true',
    fix: 'To ask one dataset, pass it: Shape.exists(iri, dataset) or .exec(dataset).',
  },
};

/** `path:line:column` of one stack line (V8's `at f (loc)` / `at loc`, or `f@loc`), if any. */
const locationOf = (line: string): string | undefined =>
  /(?:^|[\s(@])((?:[a-z][\w+.-]*:\/\/|\/|[A-Za-z]:[\\/])[^\s()]*:\d+:\d+)\)?\s*$/.exec(line)?.[1];

const fileOf = (location: string): string => location.replace(/:\d+:\d+$/, '');

/**
 * The first frame of the current stack outside core, or undefined.
 *
 * Core is the directory this module sits in, one level up (`src/` in source, `lib/esm/` or
 * `lib/cjs/` built). Core's own `tests/` directory counts as outside: it calls core the way an
 * app does. When this module's path has no `utils/` directory (a bundle), core is its file.
 */
function callSite(): string | undefined {
  // V8 keeps 10 frames by default, and the routing alone (dispatch, builder, the down-levelled
  // `async` helpers of the built code) can take more than that before the caller's frame.
  const errorClass = Error as {stackTraceLimit?: number};
  const limit = errorClass.stackTraceLimit;
  if (typeof limit === 'number') errorClass.stackTraceLimit = Math.max(limit, 50);
  let stack: string | undefined;
  try {
    stack = new Error().stack;
  } finally {
    if (typeof limit === 'number') errorClass.stackTraceLimit = limit;
  }
  const locations = (stack ?? '')
    .split('\n')
    .map(locationOf)
    .filter((l): l is string => l !== undefined);
  const own = locations[0];
  if (!own) return undefined;
  const ownFile = fileOf(own);
  const root = /^(.*)[\\/]utils[\\/][^\\/]+$/.exec(ownFile)?.[1];
  const insideCore = (file: string) =>
    root === undefined
      ? file === ownFile
      : file.startsWith(root) &&
        /^[\\/]/.test(file.slice(root.length)) &&
        !/^[\\/]tests[\\/]/.test(file.slice(root.length));
  return locations.find((l) => !insideCore(fileOf(l)));
}

/**
 * Log, once per call site, that a shapeless read of `kind` was sent to `count` datasets.
 *
 * Call it synchronously from the routing method, before its first `await`: after one, the
 * caller's frames are gone from the stack.
 */
export function noticeFanOut(kind: FanOutKind, count: number): void {
  const site = callSite();
  const key = site ? `${kind} ${site}` : kind;
  if (noticed.has(key)) return;
  noticed.add(key);
  const {what, how, fix} = advice[kind];
  console.warn(
    `[linked] ${what}, so LinkedStorage sent it to all ${count} datasets it knows and ${how}` +
      (site
        ? ` (at ${site}). ${fix} This notice shows once per call site.`
        : `. ${fix} The call site is not on the stack (a builder awaited without .exec() runs ` +
          `from a microtask), so this notice shows once for all such reads.`),
  );
}

/** @internal Forget every notice (tests). */
export function resetFanOutNotices(): void {
  noticed.clear();
}
