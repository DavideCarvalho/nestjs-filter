import Link from 'next/link';
import {
  ArrowRight,
  Braces,
  Database,
  Filter,
  FlaskConical,
  ListFilter,
  ShieldCheck,
  Sparkles,
  Terminal,
  Wand2,
} from 'lucide-react';

const GITHUB_URL = 'https://github.com/DavideCarvalho/nestjs-filter';

export default function HomePage() {
  return (
    <main className="relative flex flex-1 flex-col overflow-hidden">
      <BackgroundTexture />
      <Hero />
      <FilterShowcase />
      <FeatureGrid />
      <OperatorStrip />
      <WireItIn />
      <FinalCta />
    </main>
  );
}

/* -------------------------------------------------------------------------- */
/*  Background — dot grid + sky "query" glow, CSS only                         */
/* -------------------------------------------------------------------------- */

function BackgroundTexture() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <div
        className="absolute inset-0 opacity-[0.35] dark:opacity-[0.5]"
        style={{
          backgroundImage:
            'radial-gradient(circle at center, var(--color-fd-border) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
          maskImage:
            'radial-gradient(ellipse 80% 60% at 50% 0%, black 20%, transparent 75%)',
          WebkitMaskImage:
            'radial-gradient(ellipse 80% 60% at 50% 0%, black 20%, transparent 75%)',
        }}
      />
      <div
        className="absolute -top-40 left-1/2 h-[36rem] w-[60rem] -translate-x-1/2 rounded-full blur-[120px]"
        style={{
          background:
            'radial-gradient(circle, rgb(14 165 233 / 0.18) 0%, rgb(14 165 233 / 0.05) 40%, transparent 70%)',
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Hero                                                                        */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col items-center px-4 pb-10 pt-20 text-center sm:pt-28">
      <div className="in-stagger flex flex-col items-center">
        <span className="mb-6 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-card/60 px-3 py-1 font-mono text-xs text-fd-muted-foreground backdrop-blur">
          <span className="relative flex h-2 w-2">
            <span className="animate-in-blink absolute inline-flex h-2 w-2 rounded-full bg-sky-400" />
          </span>
          eloquent-filter, redesigned for NestJS
        </span>

        <h1 className="max-w-3xl text-balance text-4xl font-semibold tracking-tight sm:text-6xl">
          Stop writing{' '}
          <span className="bg-gradient-to-r from-sky-500 to-cyan-400 bg-clip-text text-transparent">
            if/if/if chains.
          </span>
        </h1>

        <p className="mt-6 max-w-2xl text-pretty text-lg text-fd-muted-foreground">
          Declarative, ORM-agnostic filter classes for NestJS. One decorator in
          your controller reads query params, validates them, dispatches to
          filter methods, and hands you a ready-to-execute query builder —
          with 22 operators, auto-fields, and a typed client-side builder for
          your frontend team. MikroORM <em>and</em> TypeORM.
        </p>

        <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="group inline-flex items-center gap-2 rounded-lg bg-sky-500 px-5 py-2.5 font-medium text-zinc-950 shadow-[0_0_24px_-6px] shadow-sky-500/50 transition-all hover:bg-sky-400 hover:shadow-sky-400/60"
          >
            Get started
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <Link
            href="/docs/getting-started"
            className="rounded-lg border border-fd-border bg-fd-card/40 px-5 py-2.5 font-medium backdrop-blur transition-colors hover:bg-fd-accent"
          >
            Install in 5 minutes
          </Link>
          <a
            href={GITHUB_URL}
            className="rounded-lg border border-fd-border bg-fd-card/40 px-5 py-2.5 font-medium backdrop-blur transition-colors hover:bg-fd-accent"
          >
            GitHub
          </a>
        </div>

        <p className="mt-6 font-mono text-xs text-fd-muted-foreground">
          4 packages on npm · 22 operators · MikroORM + TypeORM adapters
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Filter showcase — the centerpiece. The if-chain everyone has written vs.   */
/*  the filter class, rendered in the product's dark editor palette in both    */
/*  site themes.                                                                */
/* -------------------------------------------------------------------------- */

interface CodeToken {
  text: string;
  cls?: string;
}

const BEFORE_LINES: readonly { tokens: CodeToken[] }[] = [
  {
    tokens: [
      { text: 'async ', cls: 'text-sky-400' },
      { text: 'findUsers', cls: 'text-cyan-300' },
      { text: '(query: UserQuery) {' },
    ],
  },
  {
    tokens: [
      { text: '  const qb = ' },
      { text: 'this', cls: 'text-sky-400' },
      { text: ".repo.createQueryBuilder('u');" },
    ],
  },
  { tokens: [] },
  {
    tokens: [
      { text: '  if ', cls: 'text-sky-400' },
      { text: '(query.name) {' },
    ],
  },
  { tokens: [{ text: '    qb.andWhere({ name: { $like: `%${query.name}%` } });' }] },
  { tokens: [{ text: '  }' }] },
  {
    tokens: [
      { text: '  if ', cls: 'text-sky-400' },
      { text: '(query.email) {' },
    ],
  },
  { tokens: [{ text: '    qb.andWhere({ email: query.email });' }] },
  { tokens: [{ text: '  }' }] },
  {
    tokens: [
      { text: '  if ', cls: 'text-sky-400' },
      { text: '(query.active !== ' },
      { text: 'undefined', cls: 'text-sky-400' },
      { text: ') {' },
    ],
  },
  { tokens: [{ text: '    qb.andWhere({ active: query.active });' }] },
  { tokens: [{ text: '  }' }] },
  { tokens: [{ text: '  // ...20 more fields', cls: 'text-zinc-600' }] },
  { tokens: [] },
  {
    tokens: [
      { text: '  return ', cls: 'text-sky-400' },
      { text: 'qb.getResultList();' },
    ],
  },
  { tokens: [{ text: '}' }] },
];

const AFTER_LINES: readonly { tokens: CodeToken[] }[] = [
  {
    tokens: [
      { text: '@Filterable', cls: 'text-cyan-300' },
      { text: '({ entity: User })' },
    ],
  },
  {
    tokens: [
      { text: 'export class ', cls: 'text-sky-400' },
      { text: 'UserFilter', cls: 'text-amber-300' },
      { text: ' extends ', cls: 'text-sky-400' },
      { text: 'MikroOrmFilter', cls: 'text-amber-300' },
      { text: '<User> {' },
    ],
  },
  {
    tokens: [
      { text: '  @FilterFor', cls: 'text-cyan-300' },
      { text: '()' },
    ],
  },
  {
    tokens: [
      { text: '  name', cls: 'text-cyan-300' },
      { text: '(v: string) {' },
    ],
  },
  {
    tokens: [
      { text: '    this', cls: 'text-sky-400' },
      { text: '.' },
      { text: 'whereLike', cls: 'text-cyan-300' },
      { text: "('name', v);" },
    ],
  },
  { tokens: [{ text: '  }' }] },
  { tokens: [] },
  {
    tokens: [
      { text: '  @FilterFor', cls: 'text-cyan-300' },
      { text: '()' },
    ],
  },
  {
    tokens: [
      { text: '  status', cls: 'text-cyan-300' },
      { text: '(v: string[]) {' },
    ],
  },
  {
    tokens: [
      { text: '    this', cls: 'text-sky-400' },
      { text: '.' },
      { text: 'whereIn', cls: 'text-cyan-300' },
      { text: "('status', v);" },
    ],
  },
  { tokens: [{ text: '  }' }] },
  { tokens: [{ text: '}' }] },
  { tokens: [] },
  { tokens: [{ text: '// Controller: one line', cls: 'text-zinc-600' }] },
  {
    tokens: [
      { text: '@Get', cls: 'text-cyan-300' },
      { text: '() ' },
      { text: 'list', cls: 'text-cyan-300' },
      { text: '(' },
      { text: '@ApplyFilter', cls: 'text-cyan-300' },
      { text: '(UserFilter) qb) {' },
    ],
  },
  {
    tokens: [
      { text: '  return ', cls: 'text-sky-400' },
      { text: 'qb.getResultList();' },
    ],
  },
  { tokens: [{ text: '}' }] },
];

function CodePane({
  title,
  badge,
  badgeCls,
  lines,
  dimmed,
}: {
  title: string;
  badge: string;
  badgeCls: string;
  lines: readonly { tokens: CodeToken[] }[];
  dimmed?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/40 ring-1 ring-white/5">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-4 py-3">
        <span className="size-3 rounded-full bg-zinc-700" />
        <span className="size-3 rounded-full bg-zinc-700" />
        <span className="size-3 rounded-full bg-zinc-700" />
        <span className="ml-3 font-mono text-xs text-zinc-500">{title}</span>
        <span className={`ml-auto font-mono text-[11px] ${badgeCls}`}>{badge}</span>
      </div>
      <pre className={`overflow-x-auto p-4 font-mono text-[12.5px] leading-relaxed ${dimmed ? 'opacity-60' : ''}`}>
        <code>
          {lines.map((line, lineIndex) => (
            <div key={lineIndex} className="whitespace-pre">
              {line.tokens.map((token, tokenIndex) => (
                <span key={tokenIndex} className={token.cls ?? 'text-zinc-300'}>
                  {token.text}
                </span>
              ))}
              {line.tokens.length === 0 ? ' ' : null}
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}

function FilterShowcase() {
  return (
    <section className="mx-auto w-full max-w-6xl px-4 pb-24">
      <div className="relative">
        {/* glow halo under the panes */}
        <div
          aria-hidden
          className="absolute -inset-x-10 -bottom-8 top-10 -z-10 rounded-[2rem] bg-sky-500/10 blur-3xl"
        />
        <div className="grid gap-4 lg:grid-cols-2">
          <CodePane
            title="users.service.ts"
            badge="✗ without nestjs-filter"
            badgeCls="text-zinc-500"
            lines={BEFORE_LINES}
            dimmed
          />
          <CodePane
            title="user.filter.ts"
            badge="✓ with nestjs-filter"
            badgeCls="text-sky-400"
            lines={AFTER_LINES}
          />
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Feature grid                                                                */
/* -------------------------------------------------------------------------- */

interface Feature {
  icon: typeof Filter;
  title: string;
  body: string;
  accent: string;
}

const FEATURES: readonly Feature[] = [
  {
    icon: Filter,
    title: '@ApplyFilter decorator',
    body: 'One decorator in your controller. It reads query params (GET) or body (POST), validates with class-validator, dispatches to filter methods, and hands you back a ready-to-execute query builder.',
    accent: 'text-sky-400',
  },
  {
    icon: Wand2,
    title: 'Auto-fields',
    body: 'For simple equality and operator filters, skip writing methods entirely: declare autoFields with an allowlist and WHERE clauses are generated from query params automatically.',
    accent: 'text-cyan-400',
  },
  {
    icon: ListFilter,
    title: '22 built-in operators',
    body: 'equals, contains, gte, between, in, isNull, isAnyOf and friends — composable with AND/OR logic via bracket notation, for auto-fields and custom @FilterFor methods alike.',
    accent: 'text-violet-400',
  },
  {
    icon: Braces,
    title: 'Client-side query builder',
    body: 'A fluent, type-safe API for building filter queries in the browser or Node. Zero dependencies, generates the exact format the server expects. Ship it to your frontend team.',
    accent: 'text-emerald-400',
  },
  {
    icon: Database,
    title: 'ORM-agnostic core',
    body: 'First-class MikroORM and TypeORM adapters over a shared core. Filter classes express intent (whereLike, whereIn); the adapter translates to your query builder.',
    accent: 'text-amber-400',
  },
  {
    icon: ShieldCheck,
    title: 'Validated input',
    body: 'Filter payloads run through class-validator before any method fires. Unknown fields are rejected by the allowlist — clients only ever filter what you exposed.',
    accent: 'text-rose-400',
  },
];

function FeatureGrid() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-20">
      <div className="mb-10 text-center">
        <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
          Filtering as a first-class citizen
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-fd-muted-foreground">
          Six guarantees, one mental model. Query-string in, validated and
          composable query builder out.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <FeatureCard key={feature.title} feature={feature} />
        ))}
      </div>
    </section>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  return (
    <div className="group relative overflow-hidden rounded-xl border border-fd-border bg-fd-card/50 p-5 backdrop-blur transition-colors hover:border-sky-500/40">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
        style={{
          background:
            'radial-gradient(120px circle at top right, rgb(14 165 233 / 0.1), transparent 70%)',
        }}
      />
      <div className="relative">
        <span className="inline-flex size-9 items-center justify-center rounded-lg border border-fd-border bg-fd-background/60">
          <Icon className={`size-4.5 ${feature.accent}`} />
        </span>
        <h3 className="mt-4 font-medium">{feature.title}</h3>
        <p className="mt-2 text-sm leading-relaxed text-fd-muted-foreground">
          {feature.body}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Operator strip — all 22, as chips                                          */
/* -------------------------------------------------------------------------- */

const OPERATORS: readonly string[] = [
  'equals',
  'notEquals',
  'contains',
  'iContains',
  'notContains',
  'startsWith',
  'endsWith',
  'gte',
  'lte',
  'gt',
  'lt',
  'between',
  'notBetween',
  'in',
  'notIn',
  'isAnyOf',
  'isNull',
  'isNotNull',
  'isEmpty',
  'isNotEmpty',
  'exists',
  'notExists',
];

function OperatorStrip() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-24">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {OPERATORS.map((operator) => (
          <span
            key={operator}
            className="rounded-md border border-fd-border bg-fd-card/50 px-2.5 py-1 font-mono text-xs text-fd-muted-foreground backdrop-blur transition-colors hover:border-sky-500/40 hover:text-fd-foreground"
          >
            {operator}
          </span>
        ))}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Wire it in — client builder snippet with window chrome                     */
/* -------------------------------------------------------------------------- */

const CLIENT_LINES: readonly { tokens: CodeToken[] }[] = [
  {
    tokens: [
      { text: 'import', cls: 'text-sky-400' },
      { text: ' { filterQuery } ' },
      { text: 'from', cls: 'text-sky-400' },
      { text: " '@dudousxd/nestjs-filter-client'", cls: 'text-teal-300' },
      { text: ';' },
    ],
  },
  { tokens: [] },
  {
    tokens: [
      { text: 'const query = ' },
      { text: 'filterQuery', cls: 'text-cyan-300' },
      { text: '()' },
    ],
  },
  {
    tokens: [
      { text: '  .' },
      { text: 'contains', cls: 'text-cyan-300' },
      { text: "('name', 'Al')" },
    ],
  },
  {
    tokens: [
      { text: '  .' },
      { text: 'gte', cls: 'text-cyan-300' },
      { text: "('age', 18)" },
    ],
  },
  {
    tokens: [
      { text: '  .' },
      { text: 'in', cls: 'text-cyan-300' },
      { text: "('status', ['active', 'pending'])" },
    ],
  },
  {
    tokens: [
      { text: '  .' },
      { text: 'build', cls: 'text-cyan-300' },
      { text: '();' },
    ],
  },
  { tokens: [] },
  { tokens: [{ text: '// => name[contains]=Al&age[gte]=18', cls: 'text-zinc-600' }] },
  { tokens: [{ text: '//    &status[in]=active,pending', cls: 'text-zinc-600' }] },
];

function WireItIn() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-24">
      <div className="grid items-center gap-10 lg:grid-cols-2">
        <div>
          <span className="font-mono text-xs uppercase tracking-wider text-sky-500">
            Same language on both ends
          </span>
          <h2 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            The frontend speaks filter too.
          </h2>
          <p className="mt-4 text-fd-muted-foreground">
            <code className="rounded bg-fd-muted px-1.5 py-0.5 font-mono text-sm">filterQuery()</code>{' '}
            builds the exact query format the server expects — fluent, typed,
            zero dependencies. No more hand-assembled query strings drifting
            out of sync with the backend&apos;s parser.
          </p>
          <Link
            href="/docs/getting-started"
            className="mt-6 inline-flex items-center gap-2 font-medium text-sky-500 transition-colors hover:text-sky-400"
          >
            Full setup guide
            <ArrowRight className="size-4" />
          </Link>
        </div>

        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-xl shadow-black/30 ring-1 ring-white/5">
          <div className="flex items-center gap-2 border-b border-zinc-800 bg-zinc-900/70 px-4 py-2.5">
            <Terminal className="size-3.5 text-zinc-500" />
            <span className="font-mono text-xs text-zinc-500">search-form.tsx</span>
          </div>
          <pre className="overflow-x-auto p-4 font-mono text-[13px] leading-relaxed">
            <code>
              {CLIENT_LINES.map((line, lineIndex) => (
                <div key={lineIndex} className="whitespace-pre">
                  {line.tokens.map((token, tokenIndex) => (
                    <span
                      key={tokenIndex}
                      className={token.cls ?? 'text-zinc-300'}
                    >
                      {token.text}
                    </span>
                  ))}
                  {line.tokens.length === 0 ? ' ' : null}
                </div>
              ))}
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Final CTA                                                                   */
/* -------------------------------------------------------------------------- */

function FinalCta() {
  return (
    <section className="mx-auto w-full max-w-5xl px-4 pb-28">
      <div className="relative overflow-hidden rounded-2xl border border-fd-border bg-fd-card/60 px-6 py-14 text-center backdrop-blur">
        <div
          aria-hidden
          className="absolute inset-0 -z-10"
          style={{
            background:
              'radial-gradient(ellipse 60% 100% at 50% 0%, rgb(14 165 233 / 0.14), transparent 70%)',
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 -z-10 opacity-[0.4]"
          style={{
            backgroundImage:
              'radial-gradient(circle at center, var(--color-fd-border) 1px, transparent 1px)',
            backgroundSize: '20px 20px',
            maskImage: 'radial-gradient(ellipse 70% 80% at 50% 50%, black, transparent 80%)',
            WebkitMaskImage:
              'radial-gradient(ellipse 70% 80% at 50% 50%, black, transparent 80%)',
          }}
        />
        <span className="inline-flex items-center gap-2 font-mono text-xs text-sky-500">
          <Sparkles className="size-4" />
          <Filter className="size-4" />
          <FlaskConical className="size-4" />
        </span>
        <h2 className="mx-auto mt-4 max-w-2xl text-balance text-3xl font-semibold tracking-tight sm:text-4xl">
          Zero to filtering in under 5 minutes.
        </h2>
        <p className="mx-auto mt-3 max-w-xl text-fd-muted-foreground">
          Install the core, pick your ORM adapter, write one filter class —
          and delete the if-chain for good.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/docs"
            className="group inline-flex items-center gap-2 rounded-lg bg-sky-500 px-6 py-2.5 font-medium text-zinc-950 shadow-[0_0_24px_-6px] shadow-sky-500/50 transition-all hover:bg-sky-400 hover:shadow-sky-400/60"
          >
            Get started
            <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Link>
          <a
            href={GITHUB_URL}
            className="rounded-lg border border-fd-border bg-fd-background/40 px-6 py-2.5 font-medium transition-colors hover:bg-fd-accent"
          >
            Star on GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
