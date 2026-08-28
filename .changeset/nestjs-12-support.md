---
'@dudousxd/nestjs-filter': patch
'@dudousxd/nestjs-filter-mikro-orm': patch
'@dudousxd/nestjs-filter-typeorm': patch
---

Verify support for NestJS 12.

The peer ranges already read `>=10.0.0`, so NestJS 12 was admitted without a change; what moves
here is the dev dependencies, which now sit on the 12.x line so the suite actually runs against
NestJS 12 rather than only claiming to support it. `@nestjs/typeorm` follows onto its own 12.x
release.

No source change was needed. NestJS 12 ships its core packages as pure ESM and these packages are
already `"type": "module"`; none of them implements a `PipeTransform`, so the `ArgumentMetadata`
generic added in v12 does not reach this code, and none subclasses `ConsoleLogger`. The example and
integration apps move to 12 alongside the packages, so a single copy of `@nestjs/core` stays in the
tree and `ModuleRef` resolves to the class the container registered.
