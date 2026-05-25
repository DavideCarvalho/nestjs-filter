---
name: nestjs-filter
description: Declarative, ORM-agnostic filter classes for NestJS.
---

<!-- SEED: re-run /impeccable document once there's code to capture the actual tokens and components. -->

# Design System: nestjs-filter

## 1. Overview

**Creative North Star: "The Terminal Manifest"**

A documentation site that treats code as the primary language and prose as annotation. Every surface feels like it could exist inside a well-configured terminal: high contrast, mono-forward typography, dense information without clutter. The personality is opinionated and direct; the same confidence the library has in its API choices carries through to how the docs present themselves.

This is not a marketing site. There are no hero gradients, no animated particle backgrounds, no "trusted by 10,000 developers" counters. It is a reference that a developer keeps open in a split pane next to their IDE, and it needs to feel native to that context.

The system explicitly rejects: generic auto-generated docs with a plain white sidebar and no personality, marketing-heavy docs that prioritize buzz words over substance, and docs that explain concepts in long prose paragraphs without showing how to use them in code. If you have to read 3 paragraphs before seeing a code block, the page has failed.

**Key Characteristics:**
- Code blocks are the dominant visual element on every page
- Monospace typography is a first-class citizen, not subordinate to body text
- Tinted neutrals with a single restrained accent; color is structural, never decorative
- Dense, scannable layout that respects split-screen reading
- Responsive motion (copy feedback, smooth transitions) without choreography

## 2. Colors

A restrained palette of tinted neutrals with one accent used sparingly for interactive elements and emphasis. The accent earns attention through rarity, not saturation.

### Primary
- **Accent** [to be resolved during implementation]: Interactive elements only: links, active sidebar items, primary buttons, focus rings. Maximum 10% of any given screen.

### Neutral
- **Surface** [to be resolved during implementation]: Page background. Not pure white or pure black; tinted toward the accent hue at minimal chroma.
- **Surface Elevated** [to be resolved during implementation]: Code blocks, aside backgrounds, cards. Distinguishable from Surface at a glance.
- **Text Primary** [to be resolved during implementation]: Body text, headings. High contrast against Surface.
- **Text Secondary** [to be resolved during implementation]: Labels, metadata, sidebar inactive items. Readable but receding.
- **Border** [to be resolved during implementation]: Dividers, code block borders, table rules. Visible but quiet.

### Named Rules
**The 10% Rule.** The accent color appears on no more than 10% of any given viewport. Links, active states, and focus rings. Its rarity is the point; overuse collapses it into noise.

## 3. Typography

**Display Font:** [sans-serif to be chosen at implementation; direction: geometric/humanist with personality, e.g. Plus Jakarta Sans, Satoshi, or Geist Sans]
**Body Font:** Same as display (single sans stack)
**Code Font:** JetBrains Mono or equivalent mono with ligatures

**Character:** Mono-forward. Code is the primary language of this site. The sans-serif carries headings and explanatory prose, but monospace has equal visual weight and often dominates the page. The pairing should feel like an IDE that grew navigation.

### Hierarchy
- **Display** (bold, large clamp): Page titles, hero tagline. Rare.
- **Headline** (semibold, medium): Section headings (h2). The entry point for scanning.
- **Title** (medium, slightly smaller): Subsection headings (h3). Anchor targets.
- **Body** (regular, 16px, line-height 1.6, max-width 65-75ch): Prose between code blocks. Compact but readable.
- **Label** (medium, small, slight letter-spacing): Sidebar items, table headers, badge text.
- **Code** (regular, 14-15px, line-height 1.5): Inline and block code. The workhorse.

### Named Rules
**The Code Parity Rule.** Monospace text receives the same visual care as body text: comfortable line height, sufficient contrast, generous padding in code blocks. Code is not a second-class citizen rendered in a cramped dark box.

## 4. Elevation

Flat by default. Depth is conveyed through background tint shifts (Surface vs Surface Elevated), not shadows. Code blocks and asides sit on the elevated surface; everything else is flush.

No box-shadows on cards, sidebars, or navigation. Hover states use background color shift, not lift. Focus uses ring/outline treatment with the accent color.

### Named Rules
**The No-Shadow Rule.** Shadows are prohibited. Surfaces distinguish themselves through tonal steps only. If a container needs to stand out, it gets a tinted background or a 1px border, never a shadow.

## 5. Components

Components section omitted (no custom components exist yet in the Starlight setup). Re-run `/impeccable document` after implementing custom CSS to capture button, nav, code block, and aside treatments.

## 6. Do's and Don'ts

### Do:
- **Do** lead every guide page with a working code example before any prose explanation (PRODUCT.md principle: "Code first, prose second").
- **Do** show MikroORM and TypeORM examples in tabs wherever syntax differs (PRODUCT.md principle: "Show both ORMs").
- **Do** keep code blocks complete and copy-paste ready: imports, decorator, class, method (PRODUCT.md principle: "Copy-paste ready").
- **Do** use monospace for all technical identifiers inline (`@FilterFor`, `QueryBuilder<User>`, `FilterRunner`), even in headings.
- **Do** use tinted neutral backgrounds for code blocks and asides; distinguish them from page background through tonal shift, not borders or shadows.

### Don't:
- **Don't** use generic auto-generated doc styling with a plain white sidebar and no personality (PRODUCT.md anti-reference).
- **Don't** write marketing buzz words: "revolutionary", "game-changing", "blazing fast" (PRODUCT.md anti-reference).
- **Don't** write 3 paragraphs of explanation before showing a code block (PRODUCT.md anti-reference).
- **Don't** use `border-left` greater than 1px as a colored accent stripe on aside boxes or callouts.
- **Don't** use shadows on any surface. Elevation is tonal, not physical.
- **Don't** use gradient text or glassmorphism.
- **Don't** truncate code examples with `// ...` for critical setup lines. Show the full import, the full decorator, the full method.
