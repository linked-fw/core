import type {IRExpression} from './IntermediateRepresentation.js';

/** Whether an IR expression holds an aggregate anywhere in its tree (`p.friends.size().gt(2)`). */
export function containsAggregate(ir: IRExpression | undefined): boolean {
  if (!ir || typeof ir !== 'object') return false;
  if (ir.kind === 'aggregate_expr') return true;
  return Object.values(ir).some((v) =>
    Array.isArray(v)
      ? v.some((x) => containsAggregate(x as IRExpression))
      : v && typeof v === 'object' && 'kind' in v && containsAggregate(v as IRExpression),
  );
}
