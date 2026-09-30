/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Loads every shape @_linked/core defines, for their registration side effects only.
// Consumers: `import '@_linked/core/shapes/index'`. Nothing is exported from here.
//
// Shape, NodeShape, PropertyShape and List are registered by utils/Package.ts, because the
// SHACL metamodel cannot decorate itself. List.js loads it; SHACL.js alone does not.
import './SHACL.js';
import './List.js';
import './PathNode.js';
