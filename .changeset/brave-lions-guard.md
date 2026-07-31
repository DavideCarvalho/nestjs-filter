---
'@dudousxd/nestjs-filter-codegen': patch
---

Arm the client peer guard: `>= 1.25.0`, the release that actually ships `.extent()`.

The guard could not be written until now, and the two earlier attempts are worth recording because the reason is not obvious. Codegen emits a third type argument for the typed builder, which an older client cannot accept — the pairing reads as `Expected 1-2 type arguments, but got 3`, pointing into generated code nobody wrote. Naming the required client version in the peer range is the fix, so that the package manager objects first, with a range, instead of `tsc` objecting last, in a file the author did not write.

But a peer range naming an unpublished version is not a guard, it is a broken install: pnpm resolves this peer against the **registry**, not the workspace, so `>= 1.18.0` written before 1.18.0 existed — and later `>= 1.25.0` written inside the release PR, while 1.25.0 was still unpublished — both left the lockfile unresolvable and failed CI before a single test ran. Being in the same workspace as the client does not help; the range has to name something the registry already has.

So it can only be armed after the fact, which is what this is.
