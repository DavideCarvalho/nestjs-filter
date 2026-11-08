/**
 * The English text of every message the filter library sends to a client, by
 * key. Looked up as `filter.<key>` through `@nestjs/i18n` when the app has it,
 * and used as is otherwise. `i18n/en.json` ships the same messages for apps to
 * merge into their own catalogs (`@nestjs/i18n` has no per-library catalogs),
 * and a test keeps the two in sync.
 *
 * Placeholders are `{name}`; `{{` and `}}` are literal braces — the syntax of
 * `@nestjs/i18n`'s default formatter.
 */
export const FILTER_MESSAGES = {
  validationFailed: 'Filter input validation failed.',
  groupByCountSpecRequired:
    'groupByCount requires a `{{ field }}` specification (with an optional positive numeric `bucket`).',
  invalidGroupByCountField: 'Invalid groupByCount field: "{field}".',
  invalidExtentField: 'Invalid extent field: "{field}".',
  histogramSpecRequired:
    'histogram requires a `{{ field }}` specification (with an optional positive `buckets` count).',
  invalidHistogramField: 'Invalid histogram field: "{field}".',
  histogramFieldNotNumeric:
    'Invalid histogram field: "{field}" is a {type} column and histogram buckets are numeric (FLOOR(value / width)). Use `extent` for its range, or `groupByCount` to group by its values.',
  histogramFieldIsDate:
    'Invalid histogram field: "{field}" measures dates and histogram buckets are numeric (FLOOR(value / width)). Use `extent` for its range.',
  histogramFieldNotFinite:
    'Invalid histogram field: "{field}" did not measure to a finite number, so it cannot be bucketed.',
  unknownFilterColumn: 'Unknown filter column: "{field}".',
  operatorNotAllowed: 'Operator "{operator}" is not allowed on field "{field}".',
  invalidSortField: 'Invalid sort field: "{field}".',
  invalidDistinctField: 'Invalid distinct field: "{field}".',
} as const;

export type FilterMessageKey = keyof typeof FILTER_MESSAGES;

/** Fills `{name}` placeholders the way `@nestjs/i18n`'s default formatter does. */
export function formatFilterMessage(message: string, args: Record<string, unknown> = {}): string {
  return message.replace(/\{\{|\}\}|\{(\w+)\}/g, (match, name: string | undefined) => {
    if (match === '{{') return '{';
    if (match === '}}' || name === undefined) return '}';
    return Object.hasOwn(args, name) ? String(args[name]) : match;
  });
}
