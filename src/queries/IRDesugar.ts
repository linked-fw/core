import type {
  PropertyQueryStep,
  QueryPropertyPath,
  QueryStep,
  SizeStep,
  SortByPath,
  WherePath,
} from './SelectQuery.js';
import {NodeReferenceValue, type ShapeReferenceValue} from './QueryFactory.js';
import type {FieldSetEntry} from './FieldSet.js';
import type {RawGroupInput} from './GroupedSelectBuilder.js';
import {ExpressionNode, ExistsCondition} from '../expressions/ExpressionNode.js';
import type {PropertyShapeData} from '../shapes/SHACL.js';
import type {PathExpr} from '../paths/PropertyPathExpr.js';
import {isComplexPathExpr} from '../paths/PropertyPathExpr.js';

/**
 * Pipeline input type — accepts FieldSet entries directly.
 */
/** A single segment in a property path (used for MINUS property existence). */
export type PropertyPathSegment = {
  propertyShapeId: string;
};

/** A raw MINUS entry before desugaring. */
export type RawMinusEntry = {
  shapeId?: string;
  where?: WherePath;
  propertyPaths?: PropertyPathSegment[][];
};

export type RawSelectInput = {
  entries: readonly FieldSetEntry[];
  where?: WherePath;
  sortBy?: SortByPath;
  subject?: unknown;
  subjects?: unknown[];
  shape?: {shape?: {id?: string}; id?: string};
  limit?: number;
  offset?: number;
  singleResult?: boolean;
  minusEntries?: RawMinusEntry[];
  /** `.from()`: the graphs the read is restricted to (checked, as the caller named them). */
  graphs?: string[];
  /** A grouped select (`GroupedSelectBuilder`): keys by result field name, group filter, order. */
  group?: RawGroupInput;
};

export type DesugaredPropertyStep = {
  kind: 'property_step';
  propertyShapeId: string;
  pathExpr?: PathExpr;
  where?: DesugaredWhere;
  maxCount?: number;
};

export type DesugaredCountStep = {
  kind: 'count_step';
  path: DesugaredPropertyStep[];
  label?: string;
};

export type DesugaredTypeCastStep = {
  kind: 'type_cast_step';
  shapeId: string;
};

export type DesugaredStep = DesugaredPropertyStep | DesugaredCountStep | DesugaredTypeCastStep;

export type DesugaredSelectionPath = {
  kind: 'selection_path';
  steps: DesugaredStep[];
};

export type DesugaredInnerOrderBy = {
  propertyShapeId: string;
  direction: 'ASC' | 'DESC';
};

export type DesugaredSubSelect = {
  kind: 'sub_select';
  parentPath: DesugaredStep[];
  selections: DesugaredSelection;
  /** Inner LIMIT/OFFSET/ORDER BY for nested-select pagination (single-subject only). */
  innerLimit?: number;
  innerOffset?: number;
  innerOrderBy?: DesugaredInnerOrderBy[];
};

export type DesugaredCustomObjectSelect = {
  kind: 'custom_object_select';
  entries: DesugaredCustomObjectEntry[];
};

export type DesugaredCustomObjectEntry = {
  key: string;
  value: DesugaredSelection;
};

export type DesugaredExpressionSelect = {
  kind: 'expression_select';
  expressionNode: import('../expressions/ExpressionNode.js').ExpressionNode;
};

export type DesugaredMultiSelection = {
  kind: 'multi_selection';
  selections: DesugaredSelection[];
};

export type DesugaredSelection =
  | DesugaredSelectionPath
  | DesugaredSubSelect
  | DesugaredCustomObjectSelect
  | DesugaredExpressionSelect
  | DesugaredMultiSelection;

export type DesugaredExpressionWhere = {
  kind: 'where_expression';
  expressionNode: ExpressionNode;
};

export type DesugaredExistsWhere = {
  kind: 'where_exists_condition';
  existsCondition: ExistsCondition;
};

export type DesugaredWhere = DesugaredExpressionWhere | DesugaredExistsWhere;

export type DesugaredSortBy = {
  /** Per-path sort direction (parallel to `paths`). */
  directions: ('ASC' | 'DESC')[];
  paths: DesugaredSelectionPath[];
};

/** A desugared MINUS entry. */
export type DesugaredMinusEntry = {
  shapeId?: string;
  where?: DesugaredWhere;
  propertyPaths?: PropertyPathSegment[][];
};

/** The grouping of a desugared select: keys and order by result key, the group filter. */
export type DesugaredGroup = {
  keys: string[];
  having?: DesugaredWhere;
  orderBy?: {key: string; direction: 'ASC' | 'DESC'}[];
};

export type DesugaredSelectQuery = {
  kind: 'desugared_select';
  group?: DesugaredGroup;
  shapeId?: string;
  subjectId?: string;
  subjectIds?: string[];
  singleResult?: boolean;
  limit?: number;
  offset?: number;
  selections: DesugaredSelection[];
  sortBy?: DesugaredSortBy;
  where?: DesugaredWhere;
  minusEntries?: DesugaredMinusEntry[];
};

const isShapeRef = (value: unknown): value is ShapeReferenceValue =>
  !!value && typeof value === 'object' && 'id' in value && 'shape' in value;

const isNodeRef = (value: unknown): value is NodeReferenceValue =>
  typeof value === 'object' && value !== null && 'id' in value;

/**
 * Convert PropertyShapeData segments to DesugaredPropertyStep[].
 */
const segmentsToSteps = (segments: PropertyShapeData[]): DesugaredPropertyStep[] =>
  segments.map((seg) => {
    const step: DesugaredPropertyStep = {
      kind: 'property_step' as const,
      propertyShapeId: seg.id,
    };
    if (seg.path && isComplexPathExpr(seg.path)) {
      step.pathExpr = seg.path;
    }
    if (typeof seg.maxCount === 'number') {
      step.maxCount = seg.maxCount;
    }
    return step;
  });

/**
 * Convert a FieldSetEntry directly to a DesugaredSelection.
 */
const desugarEntry = (entry: FieldSetEntry): DesugaredSelection => {
  const segments = entry.path.segments;

  // ExpressionNode → expression-as-selection (e.g. p.age.times(12))
  if (entry.expressionNode) {
    return {
      kind: 'expression_select',
      expressionNode: entry.expressionNode,
    };
  }

  // Count aggregation → DesugaredCountStep
  if (entry.aggregation === 'count') {
    if (segments.length === 0) {
      return {kind: 'selection_path', steps: []};
    }
    const lastSegment = segments[segments.length - 1];
    const countStep: DesugaredCountStep = {
      kind: 'count_step',
      path: [{kind: 'property_step', propertyShapeId: lastSegment.id}],
      label: entry.customKey || lastSegment.label,
    };
    const parentSteps = segmentsToSteps(segments.slice(0, -1));
    return {
      kind: 'selection_path',
      steps: [...parentSteps, countStep],
    };
  }

  // Zero segments → empty path
  if (segments.length === 0) {
    return {kind: 'selection_path', steps: []};
  }

  // Build property steps, attaching scopedFilter to the segment it belongs to.
  // scopedFilterIndex indicates which segment the .where() was called on;
  // defaults to the last segment for backwards compatibility.
  const filterIndex = entry.scopedFilterIndex ?? (segments.length - 1);
  const steps: DesugaredStep[] = segments.map((segment, i) => {
    const step: DesugaredPropertyStep = {
      kind: 'property_step',
      propertyShapeId: segment.id,
    };
    if (segment.path && isComplexPathExpr(segment.path)) {
      step.pathExpr = segment.path;
    }
    if (typeof segment.maxCount === 'number') {
      step.maxCount = segment.maxCount;
    }
    if (entry.scopedFilter && i === filterIndex) {
      step.where = toWhere(entry.scopedFilter);
    }
    return step;
  });

  // SubSelect → produce DesugaredSubSelect with recursive entries
  if (entry.subSelect) {
    const subEntries = entry.subSelect.entries as FieldSetEntry[];
    const subSelect: DesugaredSubSelect = {
      kind: 'sub_select',
      parentPath: steps as DesugaredPropertyStep[],
      selections: desugarSubSelectEntries(subEntries),
    };
    if (typeof entry.innerLimit === 'number') subSelect.innerLimit = entry.innerLimit;
    if (typeof entry.innerOffset === 'number') subSelect.innerOffset = entry.innerOffset;
    if (entry.innerOrderBy) {
      subSelect.innerOrderBy = entry.innerOrderBy.map((o) => ({
        propertyShapeId: o.propertyShapeId,
        direction: o.direction,
      }));
    }
    return subSelect;
  }

  // Preload → stored as preloadSubSelect (FieldSet) on the entry
  if (entry.preloadSubSelect) {
    const subEntries = entry.preloadSubSelect.entries as FieldSetEntry[];
    return {
      kind: 'sub_select',
      parentPath: steps as DesugaredPropertyStep[],
      selections: desugarSubSelectEntries(subEntries),
    };
  }

  return {kind: 'selection_path', steps};
};

/**
 * Convert sub-select FieldSetEntry[] to a single DesugaredSelection.
 */
const desugarSubSelectEntries = (entries: FieldSetEntry[]): DesugaredSelection => {
  // Check if all entries have customKey → custom object form
  const allCustom = entries.length > 0 && entries.every((e) => e.customKey);
  if (allCustom) {
    return {
      kind: 'custom_object_select',
      entries: entries.map((e) => ({
        key: e.customKey!,
        value: desugarEntry(e),
      })),
    };
  }

  const selections = entries.map((e) => desugarEntry(e));
  if (selections.length === 1) {
    return selections[0];
  }
  return {kind: 'multi_selection', selections};
};

/**
 * Convert top-level FieldSetEntry[] to DesugaredSelection[].
 */
const desugarFieldSetEntries = (entries: readonly FieldSetEntry[]): DesugaredSelection[] => {
  // Check if all entries have customKey → wrap in single custom object
  const allCustom = entries.length > 0 && entries.every((e) => e.customKey);
  if (allCustom) {
    return [{
      kind: 'custom_object_select',
      entries: (entries as FieldSetEntry[]).map((e) => ({
        key: e.customKey!,
        value: desugarEntry(e),
      })),
    }];
  }

  return (entries as FieldSetEntry[]).map((e) => desugarEntry(e));
};

const isSizeStep = (step: QueryStep): step is SizeStep => 'count' in step;
const isPropertyStep = (step: QueryStep): step is PropertyQueryStep =>
  'property' in step && !('count' in step);

/**
 * Convert a where-clause QueryPropertyPath to a DesugaredSelectionPath.
 */
const toSelectionPath = (path: QueryPropertyPath): DesugaredSelectionPath => ({
  kind: 'selection_path',
  steps: path.map((step): DesugaredStep => {
    if (isSizeStep(step)) {
      return {
        kind: 'count_step',
        path: step.count.filter(isPropertyStep).map((s) => ({
          kind: 'property_step' as const,
          propertyShapeId: s.property.id,
        })),
        label: step.label,
      };
    }
    if (isShapeRef(step)) {
      return {
        kind: 'type_cast_step',
        shapeId: step.id,
      };
    }
    if (isPropertyStep(step)) {
      const result: DesugaredPropertyStep = {
        kind: 'property_step',
        propertyShapeId: step.property.id,
      };
      if (step.where) {
        result.where = toWhere(step.where);
      }
      return result;
    }
    throw new Error('Unsupported step in where path');
  }),
});

export const toWhere = (path: WherePath): DesugaredWhere => {
  // ExistsCondition-based WHERE (from .some()/.every()/.none()) — passthrough to lowering
  if ('existsCondition' in path) {
    return {
      kind: 'where_exists_condition',
      existsCondition: (path as {existsCondition: ExistsCondition}).existsCondition,
    };
  }
  // ExpressionNode-based WHERE — passthrough to lowering
  if ('expressionNode' in path) {
    return {
      kind: 'where_expression',
      expressionNode: (path as {expressionNode: ExpressionNode}).expressionNode,
    };
  }
  throw new Error('Unknown WherePath kind in desugar');
};


const toSortBy = (query: RawSelectInput): DesugaredSortBy | undefined => {
  if (!query.sortBy) {
    return undefined;
  }

  return {
    directions: query.sortBy.directions,
    paths: query.sortBy.paths.map((path) => ({
      kind: 'selection_path' as const,
      steps: path.segments.map((seg) => {
        const step: DesugaredPropertyStep = {
          kind: 'property_step' as const,
          propertyShapeId: seg.id,
        };
        if (seg.path && isComplexPathExpr(seg.path)) {
          step.pathExpr = seg.path;
        }
        return step;
      }),
    })),
  };
};

/**
 * Converts a RawSelectInput (FieldSet entries + where/sort) into a DesugaredSelectQuery.
 */
export const desugarSelectQuery = (query: RawSelectInput): DesugaredSelectQuery => {
  const selections = desugarFieldSetEntries(query.entries);

  const subjectId =
    query.subject && typeof query.subject === 'object' && 'id' in query.subject
      ? (query.subject as NodeReferenceValue).id
      : undefined;

  const subjectIds = query.subjects
    ? query.subjects.reduce<string[]>((acc, s) => {
        if (typeof s === 'object' && s !== null && 'id' in s) {
          acc.push((s as NodeReferenceValue).id);
        } else if (typeof s === 'string') {
          acc.push(s);
        }
        return acc;
      }, [])
    : undefined;

  return {
    kind: 'desugared_select',
    shapeId: query.shape?.shape?.id || query.shape?.id,
    subjectId,
    subjectIds,
    singleResult: query.singleResult,
    limit: query.limit,
    offset: query.offset,
    selections,
    sortBy: toSortBy(query),
    where: query.where ? toWhere(query.where) : undefined,
    minusEntries: query.minusEntries?.map((entry) => ({
      shapeId: entry.shapeId,
      where: entry.where ? toWhere(entry.where) : undefined,
      propertyPaths: entry.propertyPaths,
    })),
    ...(query.group
      ? {
          group: {
            keys: [...query.group.keys],
            ...(query.group.having ? {having: toWhere(query.group.having)} : {}),
            ...(query.group.orderBy ? {orderBy: query.group.orderBy.map((o) => ({...o}))} : {}),
          },
        }
      : {}),
  };
};
