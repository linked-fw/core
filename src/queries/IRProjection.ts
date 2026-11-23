import type {DesugaredSelectionPath, DesugaredWhere} from './IRDesugar.js';
import {IRAliasScope} from './IRAliasScope.js';
import type {IRExpression, IRProjectionItem, IRResultMapEntry} from './IntermediateRepresentation.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';

/**
 * Callback invoked when a property step with an inline `.where()` is encountered
 * during path lowering. The callback receives the traversal alias (target entity)
 * and the desugared where predicate so the caller can canonicalize and lower it.
 */
export type InlineFilterCallback = (
  traverseAlias: string,
  where: DesugaredWhere,
) => void;

export type ProjectionPathLoweringOptions = {
  rootAlias: string;
  /** `where`: the step's inline filter; a filtered step's traversal is not shared with others. */
  resolveTraversal: (fromAlias: string, propertyShapeId: string, pathExpr?: PathExpr, maxCount?: number, where?: DesugaredWhere) => string;
};

export type CanonicalProjectionResult = {
  projection: IRProjectionItem[];
  resultMap?: IRResultMapEntry[];
};

export type ProjectionPathInput =
  | DesugaredSelectionPath
  | {
      path: DesugaredSelectionPath;
      key?: string;
    };

/** Derives a result key name from the last step of a selection path. */
export const projectionKeyFromPath = (path: DesugaredSelectionPath): string => {
  if (!path.steps.length) return 'value';
  const lastStep = path.steps[path.steps.length - 1];
  if (lastStep.kind === 'property_step') return lastStep.propertyShapeId;
  if (lastStep.kind === 'count_step') return lastStep.label || 'count';
  if (lastStep.kind === 'type_cast_step') return lastStep.shapeId;
  return 'value';
};

/**
 * Lowers a single desugared selection path into an IR expression,
 * creating traversal aliases for intermediate property steps.
 *
 * When `onInlineFilter` is provided, property steps with `.where()` will
 * force a traversal creation and invoke the callback with the traversal
 * alias and the where predicate. For last steps with `.where()`, an
 * `alias_expr` is returned instead of a `property_expr`.
 */
export const lowerSelectionPathExpression = (
  path: DesugaredSelectionPath,
  options: ProjectionPathLoweringOptions,
  onInlineFilter?: InlineFilterCallback,
): IRExpression => {
  if (path.steps.length === 0) {
    return {kind: 'alias_expr', alias: options.rootAlias};
  }

  let currentAlias = options.rootAlias;

  for (let i = 0; i < path.steps.length; i++) {
    const step = path.steps[i];
    const isLast = i === path.steps.length - 1;

    if (step.kind === 'property_step') {
      if (step.where && onInlineFilter) {
        // Force traversal creation for step with inline where
        currentAlias = options.resolveTraversal(currentAlias, step.propertyShapeId, step.pathExpr, step.maxCount, step.where);
        onInlineFilter(currentAlias, step.where);
        if (isLast) {
          return {kind: 'alias_expr', alias: currentAlias};
        }
        continue;
      }

      if (isLast) {
        const expr: IRExpression = {
          kind: 'property_expr',
          sourceAlias: currentAlias,
          property: step.propertyShapeId,
        };
        if (step.pathExpr) {
          (expr as import('./IntermediateRepresentation.js').IRPropertyExpression).pathExpr = step.pathExpr;
        }
        if (typeof step.maxCount === 'number') {
          (expr as import('./IntermediateRepresentation.js').IRPropertyExpression).maxCount = step.maxCount;
        }
        return expr;
      }

      currentAlias = options.resolveTraversal(currentAlias, step.propertyShapeId, step.pathExpr, step.maxCount);
      continue;
    }

    if (step.kind === 'count_step') {
      // A filtered size (`p.friends.where(…).size()`) counts the members the filter keeps: the
      // members are a traversal of their own, filtered like any filtered step, and counted as
      // nodes. (A plain size counts the property's values.)
      const filtered = step.path.length === 1 && step.path[0].where ? step.path[0] : undefined;
      if (filtered && onInlineFilter) {
        const memberAlias = options.resolveTraversal(currentAlias, filtered.propertyShapeId, filtered.pathExpr, filtered.maxCount, filtered.where);
        onInlineFilter(memberAlias, filtered.where!);
        return {kind: 'aggregate_expr', name: 'count', args: [{kind: 'alias_expr', alias: memberAlias}]};
      }
      if (step.path.some((s) => s.where)) {
        throw new Error('A filtered size() can only be lowered with its filter: this path has none to attach it to.');
      }
      return {
        kind: 'aggregate_expr',
        name: 'count',
        args: step.path.map((propertyStep) => ({
          kind: 'property_expr',
          sourceAlias: currentAlias,
          property: propertyStep.propertyShapeId,
        })),
      };
    }
  }

  return {kind: 'alias_expr', alias: currentAlias};
};

/**
 * Builds projection items and a result map from an array of selection paths.
 * Each path gets a unique alias and is lowered into an IR expression.
 */
export const buildCanonicalProjection = (
  selections: ProjectionPathInput[],
  options: ProjectionPathLoweringOptions,
  scope = new IRAliasScope('projection'),
): CanonicalProjectionResult => {
  const projection: IRProjectionItem[] = [];
  const entries: IRResultMapEntry[] = [];

  selections.forEach((selection) => {
    const path = 'path' in selection ? selection.path : selection;
    const key = 'path' in selection ? selection.key : undefined;
    const resultKey = key || projectionKeyFromPath(path);
    const binding = scope.generateAlias(resultKey);
    projection.push({
      alias: binding.alias,
      expression: lowerSelectionPathExpression(path, options),
    });
    entries.push({
      key: resultKey,
      alias: binding.alias,
    });
  });

  return {
    projection,
    resultMap: entries,
  };
};
