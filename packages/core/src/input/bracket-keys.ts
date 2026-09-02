/**
 * Does this input look like a query object whose bracket notation was never expanded?
 *
 * A structured query travels on a GET as `filter[where][0][field]=status`. Whether the server hands
 * that to the app as `{ filter: { where: [...] } }` or as the literal key
 * `'filter[where][0][field]'` is a property of the HTTP layer, not of the request — and **Express 5
 * changed the default**, from the `qs` ("extended") parser to `simple`, which does neither nesting
 * nor arrays. A route that read a nested filter under NestJS 11 reads a bag of flat strings under
 * NestJS 12 with no error anywhere.
 *
 * That failure is silent in the worst direction: the keys carrying the predicates are simply not
 * recognised, so the query runs UNFILTERED and answers with every row — which reads exactly like a
 * successful request.
 */
function hasBracketKeys(input: Record<string, unknown>): boolean {
  for (const key of Object.keys(input)) {
    if (key.includes('[') && key.endsWith(']')) return true;
  }
  return false;
}

/** `a[b][0][c]` → `['a', 'b', '0', 'c']`; `include[]` → `['include', '']`. */
function segments(key: string): string[] | null {
  const head = key.slice(0, key.indexOf('['));
  if (!head) return null;
  const rest = key.slice(head.length);
  const out = [head];
  const pattern = /\[([^[\]]*)\]/g;
  let consumed = 0;
  let match = pattern.exec(rest);
  while (match) {
    out.push(match[1] as string);
    consumed += match[0].length;
    match = pattern.exec(rest);
  }
  // Anything the bracket grammar did not account for means this is not a path we understand — a
  // column literally named `weird[` , say. Leave such a key alone rather than reshaping it.
  return consumed === rest.length ? out : null;
}

/** Assign `value` at `path` inside `root`, creating arrays for numeric segments and objects for the
 *  rest. An empty segment (`[]`) appends. */
function assign(root: Record<string, unknown>, path: string[], value: unknown): void {
  let node: Record<string, unknown> | unknown[] = root;
  for (let i = 0; i < path.length; i++) {
    const segment = path[i] as string;
    const last = i === path.length - 1;
    const nextIsIndex = !last && (path[i + 1] === '' || /^\d+$/.test(path[i + 1] as string));

    if (segment === '') {
      // `include[]=a&include[]=b` — the container is whatever the parent already made.
      if (Array.isArray(node)) node.push(value);
      return;
    }
    if (Array.isArray(node)) {
      const index = Number(segment);
      if (last) {
        node[index] = value;
        return;
      }
      node[index] ??= nextIsIndex ? [] : {};
      node = node[index] as Record<string, unknown> | unknown[];
      continue;
    }
    if (last) {
      node[segment] = value;
      return;
    }
    node[segment] ??= nextIsIndex ? [] : {};
    node = node[segment] as Record<string, unknown> | unknown[];
  }
}

/**
 * Expand bracket-encoded flat keys into the nested shape the rest of the library reads.
 *
 * A no-op — the same object, by reference — when nothing is bracket-encoded, which is every request
 * on a host whose query parser already did this (`qs`, Fastify, a JSON body). So this changes
 * nothing for those, and rescues the ones where the HTTP layer left the work undone.
 *
 * Keys are expanded in the order they arrive, so a duplicate key's last value wins, matching `qs`.
 */
export function expandBracketKeys(input: Record<string, unknown>): Record<string, unknown> {
  if (!hasBracketKeys(input)) return input;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const path = key.includes('[') ? segments(key) : null;
    if (!path) {
      out[key] = value;
      continue;
    }
    // A repeated `x[]=a&x[]=b` may already have been collapsed into an array by the HTTP layer;
    // spread it so the append branch sees one value at a time.
    if (path.at(-1) === '' && Array.isArray(value)) {
      for (const item of value) assign(out, path, item);
      continue;
    }
    assign(out, path, value);
  }
  return out;
}
