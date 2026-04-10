export * from './client.ts';
export * as schema from './schema.ts';

// Re-export common Drizzle query helpers so consumer apps don't need
// drizzle-orm as a direct dependency. The @railforge/db package is the
// single boundary against the ORM.
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
} from 'drizzle-orm';
