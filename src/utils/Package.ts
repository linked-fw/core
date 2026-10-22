/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
import {
  createPropertyShape,
  getAndClearCallbacks,
  getNodeShapeUri,
  getPackageUri,
  setPackagePublishConfig,
  NodeShape,
  PropertyShape,
} from '../shapes/SHACL.js';
import {createNodeShapeData, type NodeShapeData} from '../shapes/nodeShapeData.js';
import {Shape, type ShapeConstructor} from '../shapes/Shape.js';
import {List} from '../shapes/List.class.js';
import {PropertyGroup} from '../shapes/PropertyGroup.class.js';
import {Prefix} from './Prefix.js';
import {sharedState} from './sharedState.js';
import {coreOntology} from '../ontologies/linked-core.js';
import {rdf} from '../ontologies/rdf.js';
import {addNodeShapeToShapeClass,getShapeClass} from './ShapeClass.js';
import {shacl} from '../ontologies/shacl.js';
import {rdfs} from '../ontologies/rdfs.js';
import {xsd} from '../ontologies/xsd.js';
import type {NodeReferenceValue} from './NodeReference.js';

//global tree
declare var _linked: any;
declare var window;
declare var global;


// var packageParsePromises: Map<string,Promise<any>> = new Map();
// var loadedPackages: Set<NamedNode> = new Set();
/**
 * One `linkedOntology(...)` call, as the ontology registry records it. The ontology sync and the
 * shape check read the registry through {@link getRegisteredOntologies}.
 */
export interface OntologyRegistration {
  /** The npm name of the package that registered the ontology. */
  packageName: string;
  /** The ontology's prefix, which is also its module's file name. */
  prefix: string;
  /** The namespace function: `ns('Term')` is the term's `{id}` reference. */
  ns: (term: string) => NodeReferenceValue;
  /** Reads the package's Turtle data (`loadOntologyFiles`); absent for an ontology without data. */
  load?: () => Promise<unknown>;
  /** The data files `load` reads, relative to the ontology module; names them in errors. */
  files: string[];
  /**
   * The ontology module's exports as registered (the namespace object of terms, `ns`, …). The
   * shape check reads the `{id}` terms of a mirror package from it.
   */
  terms: Record<string, unknown>;
}

/**
 * Ontology registrations and package settings, shared by every copy of core in the runtime:
 * an ontology registered through one copy is synced by another, and `setDefaultPageLimit`
 * through either sets the limit both read.
 */
const packageState = sharedState('@_linked/core', 'Package', () => ({
  ontologies: new Set<any>(),
  /** Keyed by `packageName + prefix`, so a module evaluated twice registers once. */
  ontologyRegistry: new Map<string, OntologyRegistration>(),
  /** Package name → the namespaces it mirrors (`linkedPackage(name, {mirrors})`). */
  packageMirrors: new Map<string, string[]>(),
  defaultLimit: 12,
  /** One setter per copy of this module, keeping that copy's `DEFAULT_LIMIT` binding in step. */
  limitBindings: new Set<(limit: number) => void>(),
}));
// A container an older copy of core created lacks the fields added since.
packageState.defaultLimit ??= 12;
packageState.limitBindings ??= new Set();
packageState.ontologyRegistry ??= new Map();
packageState.packageMirrors ??= new Map();
const ontologies = packageState.ontologies;

/**
 * Every ontology registered with `linkedOntology`, in registration order. Several entries may
 * share a package (one per ontology module); the sync groups them by `packageName`.
 */
export function getRegisteredOntologies(): OntologyRegistration[] {
  return [...packageState.ontologyRegistry.values()];
}

/**
 * The namespaces each package declared it mirrors (`linkedPackage(name, {mirrors})`), by
 * package name. Read by the shape check.
 * @internal
 */
export function getPackageMirrors(): ReadonlyMap<string, string[]> {
  return packageState.packageMirrors;
}
/**
 * a map of requested property shapes for specific nodes
 * The value is a promise if it's still loading, or true if it is fully loaded
 */
// type ClassDecorator = <T extends {new (...args: any[]): {}}>(
//   constructor: T,
// ) => T;

export type ShapeConfig = {
  /**
   * The name this shape is identified by, overriding the class name.
   *
   * A shape's IRI is `<baseUri>shape/<package>/<name>`, and `Server.call`
   * routes on it — so the name is persisted data, not a label. Taking it from
   * `constructor.name` couples that data to how the code was compiled: a
   * minifier renames the class, and so does a plain name collision, because a
   * shape and the ontology term it targets deliberately share a name. Either
   * one silently changes what the shape *is*.
   *
   * Optional, and defaults to `constructor.name`, so existing shapes are
   * unaffected. Set it where the identity has to outlive the build.
   */
  name?: string;
  /**
   * A short description of the shape, what it represents and what it is used for.
   * will be stored as rdfs:comment on the shape node
   */
  description?: string;
  /**
   * @deprecated No effect on deletes. Ownership is per property: every node a `contains`
   * property reaches is deleted with its owner, whether or not its shape is
   * `dependent`. Still accepted and persisted (`core:dependent`) by shape sync.
   */
  dependent?: boolean;
  /**
   * Close the shape (sh:closed): target nodes with properties outside this shape are invalid.
   */
  closed?: boolean;
  /**
   * Properties permitted in addition to the declared ones when the shape is closed
   * (sh:ignoredProperties).
   */
  ignoredProperties?: NodeReferenceValue[];
  /**
   * This shape deliberately shares its targetClass with another shape that is not its
   * super-shape (core's `PathList` and `List` both target `rdf:List`), or borrows its parent's
   * class as a profile. Exempts the shape from the shape check's `borrowed-target-class` and
   * from being a root of its class in `subclass-without-extends`. Persisted as
   * `core:sharedTargetClass`, so a shape read back from a store keeps it.
   */
  sharedTargetClass?: boolean;
};

export type PackageMetadata = {
  id: string;
  packageName: string;
  type: NodeReferenceValue;
};

/**
 * This object, returned by [linkedPackage()](/docs/lincd.js/modules/utils_Module#linkedPackage),
 * contains the decorators to link different parts of a LINCD module.
 */
export interface LinkedPackageObject
{
  /**
   * Links a typescript class to a SHACL shape.
   * This decorator creates a SHACL shape and looks at the static property [targetClass](/docs/lincd.js/classes/shapes_Shape.Shape#targetclass)
   * The rest of the shape is typically 'shaped' by methods that use [property decorators](/docs/lincd.js/modules/utils_ShapeDecorators).
   *
   * @example
   * Example of a typescript class using the \@linkedShape decorator:
   * ```tsx
   * @linkedShape
   * export class Person extends Shape { ... }
   * ```
   * Or with options:
   * ```tsx
   * @linkedShape({ description: "..." })
   * export class Person extends Shape { ... }
   * ```
   */
  linkedShape: {
    <T extends typeof Shape>(constructor: T): void;
    <T extends typeof Shape>(config?: ShapeConfig): (constructor: T) => void;
  };
  /**
   * Use this decorator to make any other classes or functions available on demand to other LINCD modules.
   * It does not change the object it is applied on.
   * This is specifically required for their use in an open-ended LINCD application.
   *
   * @example
   * An example helper utility using the \@linkedUtil decorator:
   * ```tsx
   * @linkedUtil
   * export class Sort {
   *   static byName(persons:Person[]) {
   *     return persons.sort((p1,p2) => p1.name < p2.name ? -1 : 1)
   *   }
   * ```
   */
  linkedUtil: (constructor: any) => any;
  /**
   * Registers an ontology of this package: its prefix (registered with `Prefix`), its terms
   * (registered in the package tree under the prefix) and, when the package ships data, how to
   * read it. The data is Turtle, one file per vocabulary under `src/data/`, read by
   * `loadOntologyFiles` (`@_linked/core/ontology/loadOntologyFiles`). Nothing is loaded at
   * registration: the ontology sync (`@_linked/core/ontology/syncOntologies`) reads the data,
   * writes each package's class hierarchy into the store, and the store infers over it.
   *
   * Call it from a sibling `<prefix>.register.ts` module, never from the ontology module
   * itself (a module cannot import its own namespace once a bundler is involved).
   *
   * @param allFileExports - every export of the ontology module (`import * as terms from './my-vocab.js'`)
   * @param nameSpace - the namespace function (`createNameSpace`), so consumers can build terms the module does not list
   * @param suggestedPrefixAndFileName - the prefix; it MUST match the ontology module's file name
   * @param loadDataFunction - reads the Turtle data: `() => loadOntologyFiles(import.meta.url, files)`. Omit it for an ontology without data
   * @param dataSource - the data file(s) `loadDataFunction` reads, relative to the ontology module (named in errors)
   * @example
   * ```ts
   * // src/ontologies/my-vocab.ts
   * import {createNameSpace} from '@_linked/core/utils/NameSpace';
   * import {loadOntologyFiles} from '@_linked/core/ontology/loadOntologyFiles';
   * import type {NodeReferenceValue} from '@_linked/core/utils/NodeReference';
   *
   * export const ns = createNameSpace('http://www.my-ontology.com/');
   * export const _self: NodeReferenceValue = ns('');
   * export const dataFiles = ['../data/my-vocab.ttl'];
   * export const loadData = () => loadOntologyFiles(import.meta.url, dataFiles);
   *
   * const ExampleClass = ns('ExampleClass');
   * const exampleProperty = ns('exampleProperty');
   * export const myVocab = {ExampleClass, exampleProperty};
   *
   * // src/ontologies/my-vocab.register.ts
   * import * as terms from './my-vocab.js';
   * import {dataFiles, loadData, ns} from './my-vocab.js';
   * import {linkedOntology} from '../package.js';
   *
   * linkedOntology(terms, ns, 'my-vocab', loadData, dataFiles);
   * ```
   */
  linkedOntology: (
    allFileExports,
    nameSpace: (term: string) => NodeReferenceValue,
    suggestedPrefixAndFileName: string,
    loadDataFunction?: () => Promise<unknown>,
    dataSource?: string | string[],
  ) => void;
  /**
   * Low level method used by other decorators to write to the modules' object in the LINCD tree.
   * You should typically not need this.
   * @param exportFileName - the file name that this exported object is available under. Needs to be unique across the module.
   * @param exportedObject - the exported object (the class, constant, function, etc)
   */
  registerPackageExport: (exportedObject: any) => void;

  /**
   * Get a Shape subclass registered in this package by name.
   * Returns undefined if the shape is not registered or bundled.
   *
   * Useful for avoiding circular dependencies between shapes.
   * E.g. `getOneAs(..., getPackageShape('ImageObject'))` in Thing.ts
   * avoids importing ImageObject (which extends Thing).
   */
  getPackageShape: (name: string) => ShapeConstructor | undefined;
  /**
   * A reference to the modules' object in the LINCD tree.
   * Contains all linked components of the module.
   */
  packageExports: any;
  packageName: string;
  packageMetadata: PackageMetadata;

  /**
   * Register a file (a javascript module) and all its exported objects.
   * Specifically helpful for registering multiple functional components if you declare them without a function name
   * @param _this
   * @param _module
   */
  registerPackageModule(_module): void;
}

/**
 * The default page size. A live binding that follows `setDefaultPageLimit` calls made through
 * any copy of core; {@link getDefaultPageLimit} reads the same value.
 */
export var DEFAULT_LIMIT = packageState.defaultLimit;
packageState.limitBindings.add((limit) => {
  DEFAULT_LIMIT = limit;
});

export function setDefaultPageLimit(limit: number)
{
  packageState.defaultLimit = limit;
  packageState.limitBindings.forEach((bind) => bind(limit));
}

/** The default page size set with {@link setDefaultPageLimit} (12 unless set). */
export function getDefaultPageLimit(): number
{
  return packageState.defaultLimit;
}


export function linkedPackage(
  packageName: string,
  options?: {
    baseUri?: string;
    /**
     * The namespace(s) of a published standard this package mirrors (`@_linked/schema` mirrors
     * `https://schema.org/`). Such a package holds only the standard's own terms: the shape
     * check reports every IRI in a mirrored namespace that a shape or an exported term uses and
     * the package's ontology data does not define.
     */
    mirrors?: string | string[];
  },
): LinkedPackageObject
{
  // Declare the package's publish root before any shape/metadata IRI is built.
  // The slug is derived from `packageName`; only `baseUri` is configurable — CN
  // injects a workspace-scoped root for private packages, first-party packages
  // default to linked.cm.
  setPackagePublishConfig(packageName, options);
  if (options?.mirrors) {
    const mirrors = Array.isArray(options.mirrors) ? options.mirrors : [options.mirrors];
    packageState.packageMirrors.set(packageName, mirrors);
  }
  let packageMetadata = registerPackageMetadata(packageName);
  let packageTreeObject = registerPackageInTree(packageName);

  //#Create declarators for this module
  let registerPackageExport = function(object) {
    // Plan-011 §I2 interim — "Key X was already defined" warning silenced
    // until the duplicate-instance root cause is investigated. With Vite
    // SSR resolving workspace packages from src/, package.ts evaluates
    // twice and every export key trips this warning. The overwrite is
    // safe because the second registration is the same class.
    packageTreeObject[object.name] = object;
  };

  let registerInPackageTree = function(exportName,exportedObject) {
    packageTreeObject[exportName] = exportedObject;
  };

  function registerPackageModule(_module): void
  {
    for (var key in _module.exports)
    {
      //if the exported object itself is not named or its name is _wrappedComponent
      //then we give it the same name as it's export name.
      if (
        !_module.exports[key].name ||
        _module.exports[key].name === '_wrappedComponent'
      )
      {
        Object.defineProperty(_module.exports[key],'name',{value: key});
        //manual 'hack' to set the name of the original function
        if (
          _module.exports[key]['original'] &&
          !_module.exports[key]['original']['name']
        )
        {
          Object.defineProperty(_module.exports[key]['original'],'name',{
            value: key + '_implementation',
          });
        }
      }
      registerInPackageTree(key,_module.exports[key]);
    }
  }

  //create a declarator function which Components of this module can use register themselves and add themselves to the global tree
  let linkedUtil = function(constructor) {
    //add the component class of this module to the global tree
    registerPackageExport(constructor);

    //return the original class without modifications
    return constructor;
  };

  // helper that contains the previous body; applies the decorator work to a given constructor
  function applyLinkedShape<T extends typeof Shape>(
    constructor: T,
    options?: ShapeConfig,
  ): void
  {
    if(!constructor) {
      throw new Error('Constructor is undefined, skipping registration: '+constructor?.toString().substring(0,100)+' '+JSON.stringify(options));
      return;
    }
    const callbackErrors: unknown[] = [];
    // add the component class of this module to the global tree
    registerPackageExport(constructor);

    // register the component and its shape
    Shape.registerByType(constructor);

    // Track the un-sanitized package name on the constructor so consumers
    // (e.g. LincdServerProxy) can route backend calls using the real module
    // specifier (e.g. '@_linked/server'), not the lossy URI-sanitized form
    // ('-_linked-server' — non-recoverable via decodeURIComponent).
    if (!Object.getOwnPropertyNames(constructor).includes('packageName')) {
      (constructor as any).packageName = packageName;
    }

    // if no shape object has been attached to the constructor
    if (!Object.getOwnPropertyNames(constructor).includes('shape'))
    {
      // The shape's identity. An explicit name wins; otherwise the class name,
      // which is what every existing shape relies on.
      const shapeName = options?.name ?? constructor.name;

      // A class name ending in a digit, with no explicit name given, is almost
      // always a bundler disambiguating a collision — `BackendAPIStore2` when
      // the ontology term of the same name took the binding first. The shape
      // then registers under an IRI the rest of the system will never ask for,
      // and the only symptom is a 501 several layers away. Say so here, where
      // it is cheap and early.
      if (!options?.name && /\d$/.test(constructor.name)) {
        console.warn(
          `[linked] Shape '${constructor.name}' in '${packageName}' has a name ending in a digit, ` +
            `which usually means a bundler renamed it to avoid a collision — often with the ` +
            `ontology term it targets. Its IRI will not match what consumers ask for. ` +
            `Pass an explicit name: @linkedShape({name: '...'}).`,
        );
      }

      // create a new node shape (plain metadata object) for this shapeClass
      const nodeShape: NodeShapeData = createNodeShapeData(
        getNodeShapeUri(packageName, shapeName),
      );
      // connect the typescript class to its NodeShape
      constructor.shape = nodeShape;
      // set the name
      nodeShape.label = shapeName;

      if (options)
      {
        if (options.description)
        {
          nodeShape.description = options.description;
        }
        if (options.dependent)
        {
          nodeShape.dependent = true;
        }
        if (options.closed !== undefined)
        {
          nodeShape.closed = options.closed;
        }
        if (options.ignoredProperties)
        {
          nodeShape.ignoredProperties = options.ignoredProperties;
        }
        if (options.sharedTargetClass)
        {
          nodeShape.sharedTargetClass = true;
        }
      }

      // also keep track of the reverse: nodeShape to typescript class
      addNodeShapeToShapeClass(nodeShape,constructor);

      //track what extends what (nodeShape level)
      const extendingShapeClass = Object.getPrototypeOf(
        constructor,
      ) as typeof Shape;
      const extendingShape = extendingShapeClass.shape;
      //if this shape class is extending something other then Shape
      if (extendingShape && !(extendingShapeClass === Shape)) {
        //store which nodeShape this nodeShape extends
        nodeShape.extends = {id: extendingShape.id};
      }
      

      // run deferred callbacks from property decorators. A callback that throws (a refused
      // override, possibly another shape's, compared once this one registered) does not stop
      // the others or the rest of this registration: the first error is rethrown at the end.
      if (constructor['shapeCallbacks'])
      {
        const run = (callback: (shape: NodeShapeData) => void) => {
          try {
            callback(nodeShape);
          } catch (error) {
            callbackErrors.push(error);
          }
        };
        constructor['shapeCallbacks'].forEach(run);
        const nodeCallbacks = getAndClearCallbacks(nodeShape.id);
        if(nodeCallbacks) {
          nodeCallbacks.forEach(run);
        }
        delete constructor['shapeCallbacks'];
      }
    }
    else
    {
      console.warn('This ShapeClass already has a shape: ',constructor.shape);
    }

    if (constructor.targetClass)
    {
      (constructor.shape as NodeShapeData).targetClass = constructor.targetClass;
    }
    if (callbackErrors.length > 0) throw callbackErrors[0];

    // return the original class without modifications
    // return constructor;
  }

  // Overloaded signatures to support both usages
  function linkedShape<T extends typeof Shape>(constructor: T): void;
  function linkedShape<T extends typeof Shape>(
    options?: ShapeConfig,
  ): (constructor: T) => void;
  function linkedShape(arg?: any): void | ((constructor: any) => void)
  {
    // usage as @linkedShape
    if (typeof arg === 'function')
    {
      applyLinkedShape(arg);
      return;
    }
    // usage as @linkedShape({...}) or @linkedShape()
    const options: ShapeConfig | undefined = arg;
    return function <T extends typeof Shape>(constructor: T): void {
      applyLinkedShape(constructor,options);
    };
  }

  /**
   * Registers an ontology module: its prefix, its namespace, its exported terms and, when the
   * package ships data, how to read it. See {@link LinkedPackageObject.linkedOntology}.
   *
   * @param exports all exports of the ontology module (`import * as terms from './x.js'`)
   * @param nameSpace the namespace function of the ontology
   * @param prefixAndFileName the prefix, which MUST match the module's file name
   * @param loadData reads the ontology's Turtle data: `() => loadOntologyFiles(import.meta.url, files)`
   * @param dataSource the data file(s) `loadData` reads, relative to the ontology module
   */
  let linkedOntology = function(
    exports,
    nameSpace: (term: string) => NodeReferenceValue,
    prefixAndFileName: string,
    loadData?: () => Promise<unknown>,
    dataSource?: string | string[],
  ) {
    let exportsCopy = {...exports};
    //store specifics in exports. And make sure we can detect this as an ontology later
    exportsCopy['_ns'] = nameSpace;
    exportsCopy['_prefix'] = prefixAndFileName;
    exportsCopy['_load'] = loadData;
    exportsCopy['_data'] = dataSource;

    //register the prefix here (so just calling linkedOntology with a prefix will automatically register that prefix)
    if (prefixAndFileName)
    {
      //run the namespace without any term name, this will give back a named node with just the namespace as URI, then get that URI to provide it as full URI
      Prefix.add(prefixAndFileName,nameSpace('').id);
    }

    ontologies.add(exportsCopy);
    //register all the exports under the prefix. NOTE: this means the file name HAS to match the prefix
    registerInPackageTree(prefixAndFileName,exportsCopy);

    // The registry the ontology sync and the shape check read. Keyed by package and prefix:
    // a module Vite evaluates twice, or two copies of core, register the ontology once.
    const files = dataSource === undefined ? [] : Array.isArray(dataSource) ? dataSource : [dataSource];
    const registration: OntologyRegistration = {
      packageName,
      prefix: prefixAndFileName,
      ns: nameSpace,
      files,
      terms: exportsCopy,
    };
    if (loadData) registration.load = loadData;
    packageState.ontologyRegistry.set(`${packageName}\u0000${prefixAndFileName}`, registration);
  };

  /**
   * This method is used to get a shape class in this package by its name.
   * This can be used to avoid circular dependencies between shapes.
   * @param name
   */
  let getPackageShape = (name: string): ShapeConstructor | undefined => {
    //get the named node of the node shape first,
    //then get the shape class that defines this node shape
    return getShapeClass(
      getNodeShapeUri(packageName, name),
    );
  };

  //return the declarators so the module can use them
  return {
    linkedShape,
    linkedUtil,
    linkedOntology,
    registerPackageExport,
    registerPackageModule,
    getPackageShape,
    packageExports: packageTreeObject,
    packageName: packageName,
    packageMetadata,
  } as LinkedPackageObject;
}

function registerPackageInTree(packageName,packageExports?)
{
  //if something with this name already registered in the global tree
  if (packageName in _linked._modules)
  {
    // Plan-011 §I2 interim — silenced until the duplicate-Linked-instance
    // root cause is investigated. Vite SSR resolving workspace packages
    // from src/ for HMR causes each package.ts to evaluate twice, so this
    // warning fired ~80x per boot. Same package, same exports — the
    // Object.assign below preserves the registry correctly.
    Object.assign(_linked._modules[packageName],packageExports);
  }
  else
  {
    //initiate an empty object for this module in the global tree
    _linked._modules[packageName] = packageExports || {};
  }
  return _linked._modules[packageName];
}

function registerPackageMetadata(packageName: string): PackageMetadata
{
  if (!_linked._packages)
  {
    _linked._packages = {};
  }
  if (packageName in _linked._packages)
  {
    return _linked._packages[packageName];
  }
  const packageMetadata: PackageMetadata = {
    id: getPackageUri(packageName),
    packageName,
    type: coreOntology.Package,
  };
  _linked._packages[packageName] = packageMetadata;
  return packageMetadata;
}


export function initTree()
{
  let globalObject =
    typeof window !== 'undefined'
      ? window
      : typeof global !== 'undefined'
        ? global
        : undefined;
  // Idempotent: if the global tree is already set up (by another copy of
  // this Package.ts in the same Node process — structural under Vite SSR,
  // which evaluates the file once for its own SSR transform AND once via
  // Node's resolver when a non-Vite import path reaches @_linked/core),
  // attach to it instead of throwing. Both instances write the same
  // _modules / _packages registry shape.
  //
  // Legacy `lincd` package's Package.ts (separate file) still throws on
  // dup — that throw signals a REAL problem (legacy `lincd` should never
  // load in a clean post-eradication state).
  if (!('_linked' in globalObject))
  {
    globalObject['_linked'] = {_modules: {}, _packages: {}};
  }
}

//when this file is used, make sure the tree is initialized
initTree();

//now that this file is set up, we can link linked shapes in the core module itself
export const corePackage = linkedPackage('@_linked/core');
// NodeShape, PropertyShape and List share their names with ontology terms (shacl.NodeShape,
// shacl.PropertyShape, rdf.List), so a bundler may rename the classes. Explicit names keep
// their IRIs independent of that.
corePackage.linkedShape({
  name: 'NodeShape',
  description:
    'Represents a SHACL NodeShape; defines constraints for a class of RDF nodes. Links to multiple PropertyShapes. (schema, constraint, class validation)',
})(NodeShape);
corePackage.linkedShape({
  name: 'PropertyShape',
  description:
    'Represents a SHACL PropertyShape; specifies rules for one property of a NodeShape (path, datatype, cardinality). (validation rule, property constraint)',
  // Owned by its NodeShape through the `contains` sh:property edge: deleting the NodeShape
  // deletes it.
})(PropertyShape);
// List is registered here, by value, because PropertyShape.in below uses it as its value
// shape. Naming it by string instead would leave it unregistered for anyone who loads the
// SHACL metamodel without importing shapes/List (backlog 045).
corePackage.linkedShape({
  name: 'List',
})(List);
// PropertyGroup is registered here for the same reason: PropertyShape.group below names it as
// its value shape.
corePackage.linkedShape({
  name: 'PropertyGroup',
  description:
    'Represents a SHACL PropertyGroup: a labelled, ordered section of a shape that property shapes join through sh:group. (form section, grouping)',
})(PropertyGroup);
// ValidationReport / ValidationResult removed in core metadata rewrite

//ALL the following is to support Shape having get/set methods with property shapes
//and Shape itself having a nodeShape
//if we dont need Shape to have get/set methods (like label and type) then this can be removed
// Base Shape IRI follows the same scheme as every other core shape:
// https://linked.cm/shape/core/Shape (corePackage above declared slug 'core').
Shape.shape = createNodeShapeData(
  getNodeShapeUri('@_linked/core', 'Shape'),
);
addNodeShapeToShapeClass(Shape.shape,Shape);

//Here we can register the properties of the Shape class itself
//We can't do that inside of Shape because it would cause circular dependencies
createPropertyShape({
    path: rdfs.label,
    //TODO: multiple labels should be possible
    maxCount: 1,//currently get label is implemented to return a single value
  },
  'label',
  shacl.Literal,
  Shape,
);
createPropertyShape(
  {
    path: rdf.type,
    shape: Shape,
  },
  'type',
  shacl.IRI,
  Shape,
);

createPropertyShape(
  {
    path: shacl.property,
    shape: PropertyShape,
    contains: true, // a NodeShape owns its property shapes (cascade on delete)
  },
  'properties',
  shacl.IRI,
  NodeShape,
);

createPropertyShape({
      path: rdfs.comment,
      maxCount: 1,
    },'description',shacl.Literal, NodeShape);

createPropertyShape({
  path: rdf.type,
  maxCount: 1,
  shape: Shape,
},'type',shacl.IRI, NodeShape);

createPropertyShape(
  {
    path: shacl.targetClass,
    shape: Shape, //should be rdfs Class, but that's currently not available in LINCD. So queries currently cannot continue after accessing targetClass
    maxCount: 1,
  },
  'targetClass',
  shacl.IRI,
  NodeShape,
);

createPropertyShape({
  path: shacl.targetNode,
  shape: Shape,//actually returns a NamedNode... is this correct then? Should we define or use a rdfs Class that matches the potential values?
},'targetNode',shacl.IRI, NodeShape);

createPropertyShape({
  path: coreOntology.isExtending,
  shape: NodeShape,
},'extends',shacl.IRI, NodeShape);

//currently path accepts multiple values, so its a multi-value property
//these values will be consequent properties that follow each other. Other property paths are not supported yet.
createPropertyShape(
  {
    // No fixed valueShape: sh:path is polymorphic (a predicate IRI, a PathList for a
    // sequence, or a PathNode for inverse/alt/cardinality). Omitting valueShape lets the
    // create pipeline use each value's own shape. Simple paths are passed as
    // {id} node references, complex paths as PathList/PathNode node-data.
    path: shacl.path,
    // Not `contains`: a predicate path is a shared IRI. A complex path's operator node or
    // sequence list is written without an id, so it becomes a blank node, as SHACL requires,
    // and the blank-node cascade deletes it with the property shape.
    nodeKind: shacl.BlankNodeOrIRI,
  },
  'path',
  shacl.IRI,
  PropertyShape,
);

createPropertyShape(
  {
    path: shacl.node,
    shape: NodeShape,
    maxCount: 1,
  },
  'valueShape',
  shacl.IRI,
  PropertyShape,
);

createPropertyShape(
  {
    maxCount: 1,
    path: shacl.nodeKind,
    shape: Shape, //actually returns a NamedNode. Queries currently cannot continue after accessing nodeKind
  },
  'nodeKind',
  shacl.IRI,
  PropertyShape,
);

createPropertyShape(
  {
    path: shacl.datatype,
    shape: Shape,
    maxCount: 1,
  },
  'datatype',
  shacl.IRI,
  PropertyShape,
);

//PropertyShape.maxCount
createPropertyShape(
  {
    path: shacl.maxCount,
    datatype: xsd.integer,
    maxCount: 1,
  },
  'maxCount',
  shacl.Literal,
  PropertyShape,
);

//PropertyShape.minCount
createPropertyShape(
  {
    path: shacl.minCount,
    datatype: xsd.integer,
    maxCount: 1,
  },
  'minCount',
  shacl.Literal,
  PropertyShape,
);

//PropertyShape.name
createPropertyShape(
  {
    path: shacl.name,
    maxCount: 1,
  },
  'name',
  shacl.Literal,
  PropertyShape,
);

//PropertyShape.description
createPropertyShape(
  {
    path: shacl.description,
    maxCount: 1,
  },
  'description',
  shacl.Literal,
  PropertyShape,
);

// ---------------------------------------------------------------------------
// Remaining SHACL meta-model accessors for shape serialization.
// Labels match the PropertyShapeData / NodeShapeData fields so syncShapes() can
// build the create-pipeline data directly. `sh:in` is owned (contains, valueShape List).
// ---------------------------------------------------------------------------

// PropertyShape.class
createPropertyShape(
  {path: shacl.class, shape: Shape, maxCount: 1},
  'class',
  shacl.IRI,
  PropertyShape,
);

// PropertyShape.in → an rdf:List (owned)
createPropertyShape(
  {path: shacl.in, shape: List, maxCount: 1, contains: true},
  'in',
  shacl.IRI,
  PropertyShape,
);

// PropertyShape pair constraints (values are property IRIs)
// Labelled `equalsConstraint`, not `equals`: `equals` is a query-builder method, so a
// property under that label is unreachable through the DSL (backlog 041). The name also
// matches the `PropertyShapeData` field. The predicate stays sh:equals.
createPropertyShape({path: shacl.equals, shape: Shape, maxCount: 1}, 'equalsConstraint', shacl.IRI, PropertyShape);
createPropertyShape({path: shacl.disjoint, shape: Shape, maxCount: 1}, 'disjoint', shacl.IRI, PropertyShape);
createPropertyShape({path: shacl.lessThan, shape: Shape, maxCount: 1}, 'lessThan', shacl.IRI, PropertyShape);
createPropertyShape(
  {path: shacl.lessThanOrEquals, shape: Shape, maxCount: 1},
  'lessThanOrEquals',
  shacl.IRI,
  PropertyShape,
);

// PropertyShape.hasValue (literal or IRI — generic)
createPropertyShape({path: shacl.hasValue, maxCount: 1}, 'hasValue', null, PropertyShape);

// PropertyShape.defaultValue (literal or IRI — generic, mirrors hasValue).
// getResult() already emits `defaultValue`, but without this registration the
// property is not queryable and a query referencing it throws before executing.
createPropertyShape({path: shacl.defaultValue, maxCount: 1}, 'defaultValue', null, PropertyShape);

// PropertyShape value-range / string-length / pattern constraints (report 021 §3, G5).
// The range constraints carry no fixed datatype — the literal is typed from the JS value
// (integer/double), mirroring the constrained property's own datatype. Length is an integer;
// pattern is the regex source string.
createPropertyShape({path: shacl.minInclusive, maxCount: 1}, 'minInclusive', shacl.Literal, PropertyShape);
createPropertyShape({path: shacl.maxInclusive, maxCount: 1}, 'maxInclusive', shacl.Literal, PropertyShape);
createPropertyShape({path: shacl.minExclusive, maxCount: 1}, 'minExclusive', shacl.Literal, PropertyShape);
createPropertyShape({path: shacl.maxExclusive, maxCount: 1}, 'maxExclusive', shacl.Literal, PropertyShape);
createPropertyShape(
  {path: shacl.minLength, datatype: xsd.integer, maxCount: 1},
  'minLength',
  shacl.Literal,
  PropertyShape,
);
createPropertyShape(
  {path: shacl.maxLength, datatype: xsd.integer, maxCount: 1},
  'maxLength',
  shacl.Literal,
  PropertyShape,
);
createPropertyShape(
  {path: shacl.pattern, datatype: xsd.string, maxCount: 1},
  'pattern',
  shacl.Literal,
  PropertyShape,
);

// PropertyShape.order / group
createPropertyShape(
  {path: shacl.order, datatype: xsd.integer, maxCount: 1},
  'order',
  shacl.Literal,
  PropertyShape,
);
// sh:group names a PropertyGroup node (an IRI), as SHACL defines it.
createPropertyShape(
  {path: shacl.group, shape: PropertyGroup, maxCount: 1},
  'group',
  shacl.IRI,
  PropertyShape,
);

// PropertyShape.displayRank / displayHidden (core: display vocabulary).
// These materialize onto the pure sh:NodeShape and so travel with an ejected app.
createPropertyShape(
  {path: coreOntology.displayRank, datatype: xsd.integer, maxCount: 1},
  'displayRank',
  shacl.Literal,
  PropertyShape,
);
createPropertyShape(
  {path: coreOntology.displayHidden, datatype: xsd.boolean, maxCount: 1},
  'displayHidden',
  shacl.Literal,
  PropertyShape,
);

// PropertyShape.contains (core:contains — persists the composition flag)
createPropertyShape(
  {path: coreOntology.contains, datatype: xsd.boolean, maxCount: 1},
  'contains',
  shacl.Literal,
  PropertyShape,
);

// NodeShape.closed / ignoredProperties / dependent (deprecated, persisted only)
createPropertyShape(
  {path: shacl.closed, datatype: xsd.boolean, maxCount: 1},
  'closed',
  shacl.Literal,
  NodeShape,
);
createPropertyShape(
  {path: shacl.ignoredProperties, shape: Shape},
  'ignoredProperties',
  shacl.IRI,
  NodeShape,
);
createPropertyShape(
  {path: coreOntology.dependent, datatype: xsd.boolean, maxCount: 1},
  'dependent',
  shacl.Literal,
  NodeShape,
);

// NodeShape.sharedTargetClass (core:sharedTargetClass — `@linkedShape({sharedTargetClass: true})`:
// the shape shares its targetClass on purpose; the shape check does not report it as borrowed).
createPropertyShape(
  {path: coreOntology.sharedTargetClass, datatype: xsd.boolean, maxCount: 1},
  'sharedTargetClass',
  shacl.Literal,
  NodeShape,
);

// NodeShape.targetObjectsOf (sh:targetObjectsOf — values are predicate IRIs),
// NodeShape.generated (core:generated — marks a shape core generates at sync time,
// e.g. the `<propertyShape>.singleOwner` constraint, so catalog readers can skip it) and
// NodeShape.generatedShapes (core:generatedShape — the shape owns the shapes generated from
// it: `contains`, so deleting the shape deletes them).
createPropertyShape(
  {path: shacl.targetObjectsOf, shape: Shape},
  'targetObjectsOf',
  shacl.IRI,
  NodeShape,
);
createPropertyShape(
  {path: coreOntology.generated, datatype: xsd.boolean, maxCount: 1},
  'generated',
  shacl.Literal,
  NodeShape,
);
createPropertyShape(
  {path: coreOntology.generatedShape, shape: NodeShape, contains: true},
  'generatedShapes',
  shacl.IRI,
  NodeShape,
);

// NodeShape.shapeHash (core:shapeHash — the content hash shape sync stores on each shape it
// writes, so the next sync can skip an unchanged shape; see syncShapes.ts).
createPropertyShape(
  {path: coreOntology.shapeHash, datatype: xsd.string, maxCount: 1},
  'shapeHash',
  shacl.Literal,
  NodeShape,
);

// The terms of the generated single-owner constraint (`singleOwnerConstraint.ts`):
// `sh:qualifiedValueShape [ sh:or ( [ sh:class A ] [ sh:class B ] ) ]` and
// `sh:qualifiedMaxCount`. The qualified shape and the `sh:or` list are written without ids, so
// they are blank nodes, deleted with their property shape by the blank-node cascade. The list
// cells are `PathList`s (blank-capable `rdf:List` cells); like `sh:path`, `orShapes` declares no
// value shape (`PathList.ts` imports `package.js`, which loads this module), so the create uses each value's own shape.
createPropertyShape(
  {path: shacl.qualifiedValueShape, shape: NodeShape, maxCount: 1, nodeKind: shacl.BlankNodeOrIRI},
  'qualifiedValueShape',
  shacl.BlankNodeOrIRI,
  PropertyShape,
);
createPropertyShape(
  {path: shacl.qualifiedMaxCount, datatype: xsd.integer, maxCount: 1},
  'qualifiedMaxCount',
  shacl.Literal,
  PropertyShape,
);
createPropertyShape(
  {path: shacl.class, shape: Shape, maxCount: 1},
  'class',
  shacl.IRI,
  NodeShape,
);
createPropertyShape(
  {path: shacl.or, maxCount: 1, nodeKind: shacl.BlankNodeOrIRI},
  // `or` is reserved (a DSL-JSON combinator), so the accessor is `orShapes`.
  'orShapes',
  shacl.BlankNodeOrIRI,
  NodeShape,
);

// ---------------------------------------------------------------------------
// The rest of the SHACL Core vocabulary of node and property shapes, so a shape authored
// elsewhere (a builder, an imported SHACL file) round-trips through the metamodel. The
// logical constraints use `andShapes`, `notShape` and `xoneShapes`: `and`, `or` and `not` are
// reserved labels (DSL-JSON combinators).
// ---------------------------------------------------------------------------

/** Registers one property shape on each of NodeShape and PropertyShape. */
const onBoth = (
  config: Parameters<typeof createPropertyShape>[0],
  label: string,
  nodeKind: NodeReferenceValue,
) => {
  createPropertyShape({...config}, label, nodeKind, NodeShape);
  createPropertyShape({...config}, label, nodeKind, PropertyShape);
};

// NodeShape.name (sh:name). The NodeShape's description stays rdfs:comment: SHACL defines
// sh:name and sh:description for property shapes.
createPropertyShape({path: shacl.name, maxCount: 1}, 'name', shacl.Literal, NodeShape);
createPropertyShape(
  {path: shacl.targetSubjectsOf, shape: Shape},
  'targetSubjectsOf',
  shacl.IRI,
  NodeShape,
);
onBoth({path: shacl.deactivated, datatype: xsd.boolean, maxCount: 1}, 'deactivated', shacl.Literal);
// One sh:message per language.
onBoth({path: shacl.message}, 'message', shacl.Literal);
onBoth({path: shacl.severity, shape: Shape, maxCount: 1}, 'severity', shacl.IRI);
// sh:and / sh:xone hold an rdf:List of shapes; like `orShapes`, no fixed value shape.
createPropertyShape(
  {path: shacl.and, maxCount: 1, nodeKind: shacl.BlankNodeOrIRI},
  'andShapes',
  shacl.BlankNodeOrIRI,
  NodeShape,
);
createPropertyShape(
  {path: shacl.xone, maxCount: 1, nodeKind: shacl.BlankNodeOrIRI},
  'xoneShapes',
  shacl.BlankNodeOrIRI,
  NodeShape,
);
createPropertyShape(
  {path: shacl.not, shape: NodeShape, maxCount: 1},
  'notShape',
  shacl.IRI,
  NodeShape,
);

// PropertyShape.flags (the sh:pattern flags), languageIn (an owned rdf:List, as `in`),
// uniqueLang, qualifiedMinCount and nested property shapes (sh:property, owned).
createPropertyShape({path: shacl.flags, datatype: xsd.string, maxCount: 1}, 'flags', shacl.Literal, PropertyShape);
createPropertyShape(
  {path: shacl.languageIn, shape: List, maxCount: 1, contains: true},
  'languageIn',
  shacl.IRI,
  PropertyShape,
);
createPropertyShape(
  {path: shacl.uniqueLang, datatype: xsd.boolean, maxCount: 1},
  'uniqueLang',
  shacl.Literal,
  PropertyShape,
);
createPropertyShape(
  {path: shacl.qualifiedMinCount, datatype: xsd.integer, maxCount: 1},
  'qualifiedMinCount',
  shacl.Literal,
  PropertyShape,
);
createPropertyShape(
  {path: shacl.property, shape: PropertyShape, contains: true},
  'properties',
  shacl.IRI,
  PropertyShape,
);
