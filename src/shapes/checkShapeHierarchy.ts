/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/**
 * The shape check: shape `extends` and the class hierarchy must agree.
 *
 * The store infers `rdf:type` through `rdfs:subClassOf`, and SHACL targeting follows it: with
 * `A rdfs:subClassOf B` in the data, `sh:targetClass B` selects every A node. So a shape tree that
 * disagrees with the class tree validates and queries nodes its author did not mean to, or misses
 * nodes they did. One function checks the registered shapes against the hierarchy parsed from the
 * registered ontology data; `linked build` fails on its errors, the app logs its findings at boot
 * and at ontology sync, and CN's builder refuses or offers the fix.
 *
 * Kinds:
 * - `extends-without-subclass` (error): `sC extends sD` but the data does not state `C ⊑* D`.
 * - `subclass-without-extends`: `A ⊑* B` and B has a root shape sB, but sA does not extend it.
 *   An error when sB is B's only root shape and lives in sA's package or one of its
 *   dependencies; otherwise a warning. Meta classes (`rdfs:Resource`, `owl:Thing`, `rdfs:Class`,
 *   `rdf:Property`) are never B.
 * - `borrowed-target-class` (error): a shape that is not the least specific shape of its class
 *   (it borrowed its parent's), or one of several unrelated roots of a class. Exempt:
 *   `@linkedShape({sharedTargetClass: true})`.
 * - `mirror-undefined-term` (error): a package that mirrors a standard
 *   (`linkedPackage(name, {mirrors})`) uses an IRI in the mirrored namespace that its data does
 *   not define — a shape (any package) or an exported term uses it.
 * - `override-not-tightened` (warning): an override whose `sh:class` is not the inherited class
 *   or a subclass of it, and, for a shape known only as data, every other tighten-only case.
 *
 * Server side when it reads the ontology data (the reader loads `n3`); a caller passing
 * `hierarchy` and with no mirror package registered never loads it.
 *
 * @module @_linked/core/shapes/checkShapeHierarchy
 */

import {
  getAllNodeShapes,
  getShapeClass,
  getSuperShapes,
  getTargetClassId,
  isSubShapeOf,
} from '../utils/ShapeClass.js';
import {builtInShapeIris} from '../utils/ShapeCatalog.js';
import {getPackageMirrors, getRegisteredOntologies} from '../utils/Package.js';
import {subClassClosure, type HierarchyTriple} from '../ontology/hierarchy.js';
import {getPropertyShapes, type NodeShapeData} from './nodeShapeData.js';
import {getNodeShapeUri} from './SHACL.js';
import {collectPathUris} from '../paths/pathExprToSparql.js';
import {
  inheritedSamePath,
  nearestInherited,
  overrideWidenings,
  samePathReason,
} from './tightenOnly.js';

export type ShapeCheckKind =
  | 'extends-without-subclass'
  | 'subclass-without-extends'
  | 'borrowed-target-class'
  | 'mirror-undefined-term'
  | 'override-not-tightened';

export interface ShapeCheckFinding {
  kind: ShapeCheckKind;
  severity: 'error' | 'warning';
  /** The shape the finding is about. */
  shape?: string;
  /** The class or term the finding is about. */
  iri?: string;
  message: string;
}

/** Classes every class is a subclass of, or that classify vocabulary terms; never a B of direction I. */
const META_CLASSES = new Set([
  'http://www.w3.org/2000/01/rdf-schema#Resource',
  'http://www.w3.org/2002/07/owl#Thing',
  'http://www.w3.org/2000/01/rdf-schema#Class',
  'http://www.w3.org/1999/02/22-rdf-syntax-ns#Property',
]);

const KIND_ORDER: ShapeCheckKind[] = [
  'extends-without-subclass',
  'subclass-without-extends',
  'borrowed-target-class',
  'mirror-undefined-term',
  'override-not-tightened',
];

const label = (shape: NodeShapeData): string => shape.label ?? shape.id;

/** The npm package a class-backed shape was declared in; undefined for a shape known only as data. */
const packageOf = (shape: NodeShapeData): string | undefined => {
  const cls = getShapeClass(shape.id) as {packageName?: string} | undefined;
  return cls?.packageName;
};

/** Package → every package it depends on, transitively (itself excluded unless on a cycle). */
const dependencyClosure = (
  dependencies: Record<string, string[]> | undefined,
): ((pkg: string) => Set<string>) => {
  const cache = new Map<string, Set<string>>();
  return (pkg) => {
    const cached = cache.get(pkg);
    if (cached) return cached;
    const reached = new Set<string>();
    const stack = [...(dependencies?.[pkg] ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (reached.has(next)) continue;
      reached.add(next);
      stack.push(...(dependencies?.[next] ?? []));
    }
    cache.set(pkg, reached);
    return reached;
  };
};

/** The `{id}` IRIs among an ontology module's exports, one level into its namespace object. */
const exportedTermIris = (terms: Record<string, unknown>): string[] => {
  const out: string[] = [];
  const take = (value: unknown) => {
    const id = (value as {id?: unknown} | null)?.id;
    if (typeof id === 'string') out.push(id);
  };
  for (const [key, value] of Object.entries(terms ?? {})) {
    if (key.startsWith('_') || typeof value === 'function' || !value || typeof value !== 'object') {
      continue;
    }
    if (typeof (value as {id?: unknown}).id === 'string') {
      take(value);
    } else if (!Array.isArray(value)) {
      Object.values(value as Record<string, unknown>).forEach(take);
    }
  }
  return out;
};

/**
 * Check the registered shapes against the class hierarchy and the mirror rule.
 *
 * @param options.hierarchy the hierarchy to check against; by default, the union of every
 * registered package's ontology data (parsed through the hierarchy reader). The mirror check
 * always reads the mirror packages' data.
 * @param options.dependencies package name → the names of its direct `dependencies` and
 * `peerDependencies` (from `package.json`). Direction I's error scope is a shape's own package
 * and its transitive dependencies; without the map, only the shape's own package.
 * @returns the findings, sorted by kind, then shape, then IRI.
 */
export async function checkShapeHierarchy(options?: {
  hierarchy?: HierarchyTriple[];
  dependencies?: Record<string, string[]>;
}): Promise<ShapeCheckFinding[]> {
  const findings: ShapeCheckFinding[] = [];

  let hierarchy = options?.hierarchy;
  if (!hierarchy) {
    const {readPackageOntologies} = await import('../ontology/registryData.js');
    const {packages} = await readPackageOntologies();
    hierarchy = [...packages.values()].flatMap((p) => p.triples);
  }
  const closure = subClassClosure(hierarchy);
  const sup = (cls: string): Set<string> => closure.get(cls) ?? new Set();
  const isSubClass = (sub: string, sup_: string) => sub === sup_ || sup(sub).has(sup_);
  const depsOf = dependencyClosure(options?.dependencies);

  const builtIns = new Set(builtInShapeIris());
  // Core's built-ins, the shapes core generates at sync time, and the ontology sync's internal
  // write shape (no targetClass by design) are not checked.
  const internal = getNodeShapeUri('@_linked/core', 'ClassAxioms');
  const skipped = (shape: NodeShapeData) =>
    builtIns.has(shape.id) || !!shape.generated || shape.id === internal;
  const shapes = [...getAllNodeShapes().values()].filter((s) => !skipped(s));
  const clsOf = (shape: NodeShapeData) => getTargetClassId(shape);
  /** Super-shapes that are domain shapes: the framework `Shape` root and built-ins left out. */
  const ancestorsOf = (shape: NodeShapeData) => getSuperShapes(shape).filter((s) => !builtIns.has(s.id));
  /** The class the shape declares itself, not one it inherits. */
  const ownClassOf = (shape: NodeShapeData): string | undefined => {
    const cls = clsOf(shape);
    if (!cls) return undefined;
    const parent = ancestorsOf(shape)[0];
    return parent && clsOf(parent) === cls ? undefined : cls;
  };
  /** The package whose ontology owns a class's namespace, when one is registered. */
  const namespaceOwner = (cls: string): string | undefined => {
    let best: {pkg: string; ns: string} | undefined;
    for (const registration of getRegisteredOntologies()) {
      let ns: string | undefined;
      try {
        ns = registration.ns?.('')?.id;
      } catch {
        ns = undefined;
      }
      if (ns && cls.startsWith(ns) && (!best || ns.length > best.ns.length)) {
        best = {pkg: registration.packageName, ns};
      }
    }
    return best?.pkg;
  };

  // 1. extends-without-subclass
  for (const shape of shapes) {
    const parentId = shape.extends?.id;
    if (!parentId) continue;
    const parent = getAllNodeShapes().get(parentId);
    if (!parent || builtIns.has(parentId)) continue;
    const c = clsOf(shape);
    const d = clsOf(parent);
    if (!c || !d || isSubClass(c, d)) continue;
    const owner = namespaceOwner(c);
    findings.push({
      kind: 'extends-without-subclass',
      severity: 'error',
      shape: shape.id,
      iri: c,
      message:
        `${label(shape)} extends ${label(parent)}, but its class ${c} is not a subclass of ` +
        `${d}. State <${c}> rdfs:subClassOf <${d}> in ` +
        `${owner ? `the ontology data of ${owner}` : 'the ontology data of the package that owns it'}, ` +
        `or stop extending ${label(parent)}.`,
    });
  }

  // 2. subclass-without-extends
  const sharesClass = (s: NodeShapeData) => !!s.sharedTargetClass;
  for (const shape of shapes) {
    const a = ownClassOf(shape);
    if (!a) continue;
    const ancestors = ancestorsOf(shape);
    const pkg = packageOf(shape);
    for (const b of sup(a)) {
      if (META_CLASSES.has(b) || b === a) continue;
      const roots = shapesForClass(b).filter((r) => !sharesClass(r) && !skipped(r));
      if (roots.length === 0) continue;
      if (roots.some((root) => root.id === shape.id || isSubShapeOf(shape, root))) continue;
      // The missing link belongs to the lowest shape responsible: an ancestor whose class is
      // already B or under B.
      const delegated = ancestors.some((t) => {
        const tc = clsOf(t);
        return !!tc && isSubClass(tc, b);
      });
      if (delegated) continue;
      const rootPkg = roots.length === 1 ? packageOf(roots[0]) : undefined;
      const inScope =
        !!pkg && !!rootPkg && (rootPkg === pkg || depsOf(pkg).has(rootPkg));
      const rootNames = roots.map(label).join(', ');
      findings.push({
        kind: 'subclass-without-extends',
        severity: inScope ? 'error' : 'warning',
        shape: shape.id,
        iri: b,
        message:
          `${label(shape)} targets ${a}, a subclass of ${b}, whose shape ` +
          `${roots.length === 1 ? `is ${rootNames}` : `roots are ${rootNames}`}; ` +
          `make ${label(shape)} extend ${roots.length === 1 ? rootNames : 'one of them'}.`,
      });
    }
  }

  // 3. borrowed-target-class
  const byClass = new Map<string, NodeShapeData[]>();
  for (const shape of shapes) {
    if (sharesClass(shape)) continue;
    const cls = clsOf(shape);
    if (!cls) continue;
    const group = byClass.get(cls);
    if (group) group.push(shape);
    else byClass.set(cls, [shape]);
  }
  for (const [cls, group] of byClass) {
    if (group.length < 2) continue;
    const ids = new Set(group.map((s) => s.id));
    const roots = group.filter((s) => !getSuperShapes(s).some((p) => ids.has(p.id)));
    for (const shape of group) {
      const isRoot = roots.includes(shape);
      if (isRoot && roots.length === 1) continue;
      findings.push({
        kind: 'borrowed-target-class',
        severity: 'error',
        shape: shape.id,
        iri: cls,
        message: isRoot
          ? `${label(shape)} is one of several unrelated shapes targeting ${cls} ` +
            `(${roots.map(label).join(', ')}); give each its own class, or declare ` +
            `@linkedShape({sharedTargetClass: true}) where sharing is intended.`
          : `${label(shape)} inherits the class ${cls} of the shape it extends instead of ` +
            `declaring its own; give it its own class (rdfs:subClassOf ${cls}), or declare ` +
            `@linkedShape({sharedTargetClass: true}) for a profile.`,
      });
    }
  }

  // 4. mirror-undefined-term
  const mirrors = getPackageMirrors();
  if (mirrors.size > 0) {
    const {readPackageOntologies} = await import('../ontology/registryData.js');
    const {definedTermsFromTurtle} = await import('../ontology/hierarchy.js');
    const {packages} = await readPackageOntologies({packages: [...mirrors.keys()]});
    const registrations = getRegisteredOntologies();
    // Candidate IRIs from shapes, collected once: shape id → IRIs it uses.
    const shapeIris = shapes.map((shape) => {
      const iris = new Set<string>();
      if (shape.targetClass?.id) iris.add(shape.targetClass.id);
      for (const ps of getPropertyShapes(shape)) {
        if (ps.path) collectPathUris(ps.path).forEach((iri) => iris.add(iri));
        if (ps.datatype?.id) iris.add(ps.datatype.id);
        if (ps.class?.id) iris.add(ps.class.id);
      }
      return {shape, iris};
    });
    for (const [pkg, namespaces] of mirrors) {
      const hasData = registrations.some((r) => r.packageName === pkg && typeof r.load === 'function');
      const data = packages.get(pkg);
      // Unreadable data was warned about by the reader; it cannot be checked.
      if (hasData && !data) continue;
      const defined = data
        ? await definedTermsFromTurtle(data.texts, data.sources)
        : new Set<string>();
      const mirrored = (iri: string) =>
        namespaces.some((ns) => iri.startsWith(ns) && iri !== ns) && !defined.has(iri);
      const reported = new Set<string>();
      const report = (iri: string, shape?: NodeShapeData) => {
        const key = `${shape?.id ?? ''}\u0000${iri}`;
        if (reported.has(key)) return;
        reported.add(key);
        findings.push({
          kind: 'mirror-undefined-term',
          severity: 'error',
          ...(shape ? {shape: shape.id} : {}),
          iri,
          message:
            `${shape ? `${label(shape)} uses` : `${pkg} exports`} ${iri}, which ${pkg} mirrors ` +
            `but its ontology data does not define. A package that mirrors a standard holds only ` +
            `the standard's terms: move the term to a package of its own namespace.`,
        });
      };
      for (const registration of registrations.filter((r) => r.packageName === pkg)) {
        exportedTermIris(registration.terms).filter(mirrored).forEach((iri) => report(iri));
      }
      for (const {shape, iris} of shapeIris) {
        [...iris].filter(mirrored).forEach((iri) => report(iri, shape));
      }
    }
  }

  // 5. override-not-tightened
  for (const shape of shapes) {
    const ancestors = getSuperShapes(shape);
    if (ancestors.length === 0) continue;
    const dataOnly = !getShapeClass(shape.id);
    for (const property of getPropertyShapes(shape)) {
      const base = nearestInherited(ancestors, property.label);
      const reasons: string[] = [];
      if (base) {
        if (
          base.class?.id &&
          property.class?.id &&
          !isSubClass(property.class.id, base.class.id)
        ) {
          reasons.push(
            `class ${property.class.id} is not ${base.class.id} or a subclass of it.`,
          );
        }
        if (dataOnly) {
          overrideWidenings(base, property).forEach((w) => reasons.push(w.reason));
        }
      } else if (dataOnly) {
        const other = inheritedSamePath(ancestors, property);
        if (other) reasons.push(samePathReason(other));
      }
      for (const reason of reasons) {
        findings.push({
          kind: 'override-not-tightened',
          severity: 'warning',
          shape: shape.id,
          iri: property.id || undefined,
          message: `Override ${label(shape)}.${property.label} widens the inherited property: ${reason}`,
        });
      }
    }
  }

  const kindIndex = (kind: ShapeCheckKind) => KIND_ORDER.indexOf(kind);
  const cmp = (a?: string, b?: string) => ((a ?? '') < (b ?? '') ? -1 : (a ?? '') > (b ?? '') ? 1 : 0);
  return findings.sort(
    (a, b) =>
      kindIndex(a.kind) - kindIndex(b.kind) ||
      cmp(a.shape, b.shape) ||
      cmp(a.iri, b.iri) ||
      cmp(a.message, b.message),
  );
}

/**
 * The least specific registered shapes whose class is exactly `cls`. Computed here rather than
 * through `getShapesForTargetClass`, which drops nothing: a shape declaring `sharedTargetClass`
 * must not hide a real root behind it.
 */
function shapesForClass(cls: string): NodeShapeData[] {
  const candidates = [...getAllNodeShapes().values()].filter(
    (shape) => !shape.sharedTargetClass && getTargetClassId(shape) === cls,
  );
  const ids = new Set(candidates.map((s) => s.id));
  return candidates.filter((s) => !getSuperShapes(s).some((p) => ids.has(p.id)));
}
