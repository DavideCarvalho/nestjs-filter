# Product

## Register

product

## Users

Backend developers using NestJS (TypeScript) who need declarative, type-safe query filtering for their APIs. They work with MikroORM or TypeORM, build REST endpoints, and want to stop writing repetitive if/if/if chains to translate request params into WHERE clauses. They read docs at their desk, often with an IDE open in a split screen, looking for code they can copy-paste and adapt.

## Product Purpose

Documentation site for `@dudousxd/nestjs-filter`, a monorepo of packages that bring declarative filter classes to NestJS. The site teaches developers how to install, configure, and use the library through guides, API references, and extensive code examples. Success: a developer goes from zero to working filter in under 5 minutes, and can find any API detail within 2 clicks.

## Brand Personality

Opinionated, developer-first, bold. The library has a clear point of view (inspired by EloquentFilter and adonis-lucid-filter, redesigned for NestJS idioms). The docs should reflect that confidence: show the best way to do things, don't hedge, lead with code.

## Anti-references

- Generic auto-generated docs with a plain white sidebar and no personality (Typedoc defaults, vanilla Docusaurus with zero customization)
- Marketing-heavy docs that prioritize buzz words over substance ("revolutionary", "game-changing", newsletter popups)
- Docs that explain concepts in long prose paragraphs without showing how to use them in code
- Any docs site where you have to read 3 paragraphs before seeing a code block

## Design Principles

1. **Code first, prose second.** Every concept starts with a working code example. Explanation follows, not the other way around.
2. **Opinionated defaults, escape hatches visible.** Show the recommended way prominently. Alternatives and edge cases are accessible but don't clutter the golden path.
3. **Copy-paste ready.** Code blocks should be complete enough to paste into a real project. No pseudocode, no `// ...` elisions of critical setup.
4. **Show both ORMs.** MikroORM and TypeORM examples side by side (tabs) wherever syntax differs. Never force the reader to mentally translate.
5. **Respect the split screen.** Developers read docs next to their IDE. Dense, scannable content beats sprawling pages. Tables over paragraphs. Headings that work as anchors.

## Accessibility & Inclusion

Good defaults: sufficient contrast, keyboard navigation, semantic headings. No formal WCAG compliance target, but avoid gratuitous color-only signaling and ensure code blocks are readable in both light and dark themes.
