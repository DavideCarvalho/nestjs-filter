import type { StructuredInput } from '../types.js';

/**
 * Parses a spatie-laravel-query-builder / JSON:API-style query input into the
 * library's internal {@link StructuredInput} model.
 *
 * This is an **opt-in** input format (enabled via the `inputFormat: 'spatie'`
 * module option). The default `'native'` format is unchanged. The parser is a
 * pure reshape — it does **not** enforce safety itself; its output flows through
 * the same runner pipeline as native input, so the allowlist, per-field operator
 * allowlist, and `throwOnInvalid` policy still apply.
 *
 * The input is the object produced after a query string has been decoded by
 * Express + `qs` (bracket notation expanded into nested objects):
 *
 * | Query string                         | Decoded input                                   | Mapped to                                  |
 * | ------------------------------------ | ----------------------------------------------- | ------------------------------------------ |
 * | `filter[name]=Al`                    | `{ filter: { name: 'Al' } }`                    | `{ filter: { name: 'Al' } }` (equals)      |
 * | `filter[id]=1,2,3`                   | `{ filter: { id: '1,2,3' } }`                   | `{ filter: { id: ['1','2','3'] } }` (in)   |
 * | `filter[name][contains]=Al`          | `{ filter: { name: { contains: 'Al' } } }`     | operator object → existing operator path   |
 * | `sort=-createdAt,name`               | `{ sort: '-createdAt,name' }`                   | `{ sort: '-createdAt,name' }`              |
 * | `include=posts,comments`             | `{ include: 'posts,comments' }`                 | `{ include: 'posts,comments' }`            |
 * | `fields[users]=id,name`              | `{ fields: { users: 'id,name' } }`             | `{ select: ['id','name'] }` (sparse)       |
 * | `page[number]=2&page[size]=10`       | `{ page: { number: '2', size: '10' } }`        | `{ paginate: { page: 2, size: 10 } }`      |
 * | `page[after]=cur&page[size]=10`      | `{ page: { after: 'cur', size: '10' } }`       | `{ paginate: { after, first } }` (cursor)  |
 *
 * Design notes:
 * - **Filter values**: a bare scalar is interpreted by the adapter as `equals`;
 *   a comma-separated scalar (spatie's convention for multi-value filters) is
 *   split into an array (interpreted as `in`); an object whose keys are operators
 *   passes straight through to the existing operator-object mechanism.
 * - **Sparse fieldsets** (`fields[resource]`): JSON:API keys these by resource
 *   type, but the runner applies a single SELECT to the primary entity, so the
 *   per-resource lists are flattened (deduped, order-preserving) into one
 *   `select` list and validated against the entity / allowlist downstream.
 * - **Pagination**: JSON:API page-based (`page[number]`/`page[size]`) maps to
 *   offset pagination; cursor-style (`page[after]`/`page[before]`) maps to the
 *   library's keyset pagination input.
 */
export function parseSpatieInput(input: unknown): StructuredInput {
  if (input == null || typeof input !== 'object') return {};
  const src = input as Record<string, unknown>;
  const out: StructuredInput = {};

  if (src.filter != null && typeof src.filter === 'object' && !Array.isArray(src.filter)) {
    out.filter = parseFilters(src.filter as Record<string, unknown>);
  }

  if (typeof src.sort === 'string') {
    out.sort = src.sort;
  } else if (Array.isArray(src.sort)) {
    // `sort[]=a&sort[]=-b` decodes to an array — join to the JSON:API string form.
    out.sort = src.sort.filter((s) => typeof s === 'string').join(',');
  }

  if (typeof src.include === 'string') {
    out.include = src.include;
  } else if (Array.isArray(src.include)) {
    out.include = src.include.filter((s): s is string => typeof s === 'string');
  }

  if (typeof src.search === 'string') {
    out.search = src.search;
  }

  const select = parseSparseFieldsets(src.fields);
  if (select.length > 0) {
    (out as StructuredInput & { select?: string[] }).select = select;
  }

  const paginate = parsePage(src.page);
  if (paginate) out.paginate = paginate;

  return out;
}

/**
 * Reshapes the `filter` map: scalar values become equals (with comma → array),
 * operator objects pass through unchanged, and arrays are kept as-is.
 */
function parseFilters(filter: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(filter)) {
    if (Array.isArray(value)) {
      out[field] = value;
    } else if (value != null && typeof value === 'object') {
      // Operator object (`{ contains: 'x' }`) — passed straight through; the
      // runner / adapter interprets and validates the operator keys.
      out[field] = value;
    } else if (typeof value === 'string' && value.includes(',')) {
      // spatie multi-value filter convention: comma-separated → array (IN).
      out[field] = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      out[field] = value;
    }
  }
  return out;
}

/**
 * Flattens JSON:API sparse fieldsets (`fields[resource]=a,b`) into a single
 * order-preserving, de-duplicated list of column names. Per-resource keys are
 * collapsed because the runner applies one SELECT to the primary entity; unknown
 * columns are dropped downstream when validated against entity metadata.
 */
function parseSparseFieldsets(fields: unknown): string[] {
  if (fields == null || typeof fields !== 'object' || Array.isArray(fields)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of Object.values(fields as Record<string, unknown>)) {
    const cols =
      typeof value === 'string'
        ? value.split(',')
        : Array.isArray(value)
          ? value.filter((s): s is string => typeof s === 'string')
          : [];
    for (const raw of cols) {
      const col = raw.trim();
      if (col.length > 0 && !seen.has(col)) {
        seen.add(col);
        out.push(col);
      }
    }
  }
  return out;
}

/**
 * Maps a JSON:API `page` object to the library's pagination input.
 * `page[number]`/`page[size]` → offset; `page[after]`/`page[before]` → cursor.
 */
function parsePage(page: unknown): StructuredInput['paginate'] | undefined {
  if (page == null || typeof page !== 'object' || Array.isArray(page)) return undefined;
  const p = page as Record<string, unknown>;

  const after = typeof p.after === 'string' ? p.after : undefined;
  const before = typeof p.before === 'string' ? p.before : undefined;
  const size = toInt(p.size);

  if (after !== undefined || before !== undefined) {
    if (after !== undefined) {
      return { after, ...(size !== undefined && { first: size }) };
    }
    return { before: before!, ...(size !== undefined && { last: size }) };
  }

  const number = toInt(p.number);
  if (number !== undefined || size !== undefined) {
    return { page: number ?? 0, size: size ?? 25 };
  }
  return undefined;
}

function toInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
