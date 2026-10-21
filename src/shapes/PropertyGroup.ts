/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
// Registers PropertyGroup (together with the rest of the SHACL metamodel), so importing this
// module on its own is enough to make it resolvable. The class lives in PropertyGroup.class.ts
// because utils/Package.ts needs it by value.
import '../utils/Package.js';
import {PropertyGroup} from './PropertyGroup.class.js';

export {PropertyGroup};
