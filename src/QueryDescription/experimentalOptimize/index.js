// @flow
/* eslint-disable no-use-before-define */

import type { AppSchema, TableName } from '../../Schema'
import type { QueryDescription, Where, On } from '../type'

// where()s first
// … but where()s with oneOf/notIn last (because it could be a long array)
// then on()s
// … but on()s querying has_manys before on()s querying belongs_tos
// … merge on()s querying the same table

// Goal:
// - order clauses such that heaviest to execute clauses are last
// - order clauses such that we filter out as many records as possible early
//
// It's hard to do this well without knowing the histogram of different values. SQLite can do this
// out of the box, so we probably don't have to worry about it at all. But for Loki, something
// might still be better than nothing...
//
// However we might be able to use information about schema to guess which fields are cheap to query (indexed)
//
// One simple way to aid in reordering is to allow users to pass Q.likely(), Q.unlikely(), but
// if we want users to add such information, they might as well manually tune the query order
// themselves, no?

type OptimizeQueryDescriptionOptions = $Exact<{
  query: QueryDescription,
  table: TableName<any>,
  schema: AppSchema,
}>
export default function optimizeQueryDescription(
  options: OptimizeQueryDescriptionOptions,
): QueryDescription {
  const { query, table, schema } = options
  const optimizedQuery = { ...query }
  optimizedQuery.where = optimizeWhere(query.where, table, schema)
  return optimizedQuery
}

type score = number // lower number = higher priority
type CondEntry = [Where, score]
const DEFAULT_SCORE = 1
const INDEXED_MULTIPLIER = 0.1 // rationale: indexed fields are faster to query
const EQ_MULTIPLIER = 0.5 // rationale: equality yields fewer results than lt/gt
const ON_MULTPLIER = 5
function optimizeWhere(conditions: Where[], table: TableName<any>, schema: AppSchema): Where[] {
  const optimized: CondEntry[] = []
  const ons: { [table: string]: On } = {}

  const tableSchema = schema.tables[table]

  conditions.forEach((condition) => {
    switch (condition.type) {
      case 'where': {
        const isIndexed = tableSchema.columns[condition.left]?.isIndexed
        const isEq = condition.comparison.operator === 'eq'
        optimized.push([
          condition,
          DEFAULT_SCORE * (isIndexed ? INDEXED_MULTIPLIER : 1) * (isEq ? EQ_MULTIPLIER : 1),
        ])
        break
      }
      case 'on': {
        const existing = ons[condition.table]
        if (existing) {
          existing.conditions = [...existing.conditions, ...condition.conditions]
        } else {
          const on = { ...condition }
          ons[condition.table] = on
          optimized.push([on, ON_MULTPLIER])
        }
        break
      }
      default: {
        optimized.push([condition, DEFAULT_SCORE])
        break
      }
    }
  })

  // sort by score
  optimized.sort(([, a], [, b]) => a - b)

  return optimized.map(([condition]) => condition)
}
