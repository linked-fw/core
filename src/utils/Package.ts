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
import {Prefix} from './Prefix.js';
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
let ontologies: Set<any> = new Set();
let _autoLoadOntologyData = false;
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
   * Marks this shape's instances as *dependent* (composition / no independent existence):
   * they may be cascade-deleted when reached through a `contains` property.
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
   * Used to notify LINCD.js of an ontology.
   * See also the [Ontology guides](/docs/guides/linked-code/ontologies).
   *
   * @param allFileExports - all the objects that are exported by the ontology file (use `import * as _this from "./path-to-this-file")`)
   * @param nameSpace - the result of [createNameSpace](/docs/lincd.js/modules/utils_NameSpace#createnamespace). This allows consumers to generate NamedNodes that may not be listed in this ontology if needed
   * @param prefixAndFileName - a suggested prefix chosen by you. Make sure the suggestedPrefix matches the file name and the name of the exported object that groups all entities together
   * @param loadDataFunction - a method that loads _and parses_ the raw ontology data. This means the ontology will be loaded into the local graph. The returned result is mostly a JSONLDParsePromise (from lincd-jsonld/JSONLD, not bundled in LINCD.js)
   * @param dataSource - the relative path to the raw data of the ontology
   * @example
   * Example of an Ontology File that used linkedOntology()
   * ```tsx
   * import {NamedNode} from 'lincd/models';
   * import {JSONLD} from 'lincd-jsonld/JSONLD';
   * import {createNameSpace} from 'lincd/utils/NameSpace';
   * import {linkedOntology} from '../package.js';
   * import * as _this from './my.js-ontology';
   *
   * let dataFile = '../data/my.js-ontology.json';
   * export var loadData = () => JSONLD.parsePromise(import(dataFile));
   *
   * export var ns = createNameSpace('http://www.my-ontology.com/');
   *
   * export var _self: NamedNode = ns('');
   *
   * // Classes
   * export var ExampleClass: NamedNode = ns('ExampleClass');
   *
   * // Properties
   * export var exampleProperty: NamedNode = ns('exampleProperty');
   *
   * export const myOntology = {
   *   ExampleClass,
   *   exampleProperty,
   * };
   *
   * linkedOntology(_this, ns, 'myOntology', loadData, dataFile);
   * ```
   */
  linkedOntology: (
    allFileExports,
    nameSpace: (term: string) => NodeReferenceValue,
    suggestedPrefixAndFileName: string,
    loadDataFunction?: () => Promise<any>,
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

export var DEFAULT_LIMIT = 12;

export function setDefaultPageLimit(limit: number)
{
  DEFAULT_LIMIT = limit;
}

export function autoLoadOntologyData(value: boolean)
{
  _autoLoadOntologyData = value;
  //this may be set to true after some ontologies have already indexed,
  if (_autoLoadOntologyData)
  {
    // so in that case we load all data of ontologies that are already indexed
    ontologies.forEach((ontologyExport) => {
      //see linkedOntology() where we store the data loading method under the _load key
      if (ontologyExport['_load'])
      {
        ontologyExport['_load']();
      }
    });
  }
}


export function linkedPackage(
  packageName: string,
  options?: {baseUri?: string},
): LinkedPackageObject
{
  // Declare the package's publish root before any shape/metadata IRI is built.
  // The slug is derived from `packageName`; only `baseUri` is configurable — CN
  // injects a workspace-scoped root for private packages, first-party packages
  // default to linked.cm.
  setPackagePublishConfig(packageName, options);
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
      

      // run deferred callbacks from property decorators
      if (constructor['shapeCallbacks'])
      {
        constructor['shapeCallbacks'].forEach((callback) => {
          callback(nodeShape);
        });
        const nodeCallbacks = getAndClearCallbacks(nodeShape.id);
        if(nodeCallbacks) {
          nodeCallbacks.forEach((callback) => {
            callback(nodeShape);
          });
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
   *
   * @param exports all exports of the file, simply provide "this" as value!
   * @param dataSource the path leading to the ontology's data file
   * @param nameSpace the base URI of the ontology
   * @param prefixAndFileName the file name MUST match the prefix for this ontology
   */
  let linkedOntology = function(
    exports,
    nameSpace: (term: string) => NodeReferenceValue,
    prefixAndFileName: string,
    loadData?,
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
    // });

    if (_autoLoadOntologyData)
    {
      loadData().catch((err) => {
        console.warn(
          'Could not load ontology data. Do you need to rebuild the module of the ' +
          prefixAndFileName +
          ' ontology?',
          err,
        );
      });
    }
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
corePackage.linkedShape({
  description:
    'Represents a SHACL NodeShape; defines constraints for a class of RDF nodes. Links to multiple PropertyShapes. (schema, constraint, class validation)',
})(NodeShape);
corePackage.linkedShape({
  description:
    'Represents a SHACL PropertyShape; specifies rules for one property of a NodeShape (path, datatype, cardinality). (validation rule, property constraint)',
  // A property shape has no independent existence — it is owned by its NodeShape via the
  // `contains` sh:property edge, so deleting the NodeShape cascade-deletes it.
  dependent: true,
})(PropertyShape);
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
    // No fixed valueShape: sh:path is polymorphic (a predicate IRI, an rdf:List for a
    // sequence, or a PathNode for inverse/alt/cardinality). Omitting valueShape lets the
    // create pipeline use each value's own shape. Simple paths are passed as
    // {id} node references, complex paths as List/PathNode node-data.
    path: shacl.path,
    contains: true, // a property shape owns its complex path structure (List/PathNode)
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
  {path: shacl.in, shape: ['@_linked/core', 'List'], maxCount: 1, contains: true},
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
createPropertyShape({path: shacl.group, maxCount: 1}, 'group', shacl.Literal, PropertyShape);

// PropertyShape.displayRank / displayHidden (linked_core: display vocabulary).
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

// PropertyShape.contains (linked_core:contains — persists the composition flag)
createPropertyShape(
  {path: coreOntology.contains, datatype: xsd.boolean, maxCount: 1},
  'contains',
  shacl.Literal,
  PropertyShape,
);

// NodeShape.closed / ignoredProperties / dependent
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
