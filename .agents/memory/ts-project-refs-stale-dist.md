---
name: TS project references stale dist output
description: A composite/project-references TS package can report a false "has no exported member" error after you add a new export, until dependents are rebuilt.
---

In a pnpm monorepo using TypeScript project references (composite packages
with a `dist/` output and `.tsbuildinfo`), adding a new export to a shared
package (e.g. a new Drizzle table export) can cause a downstream package's
`tsc --noEmit` to fail with "Module has no exported member X" or "Output
file ... has not been built from source file ...", even though the export
is clearly present in source.

**Why:** the shared package's stale `dist/*.d.ts` (built before the new
export existed) is what TS resolves against under project references, not
the live source — incremental `.tsbuildinfo` caching can mask this further.

**How to apply:** if you hit an inexplicable "no exported member" error
after changing a shared lib package, don't assume the import is wrong —
run `tsc -b <shared-pkg> <dependents...> --force` (or delete the stale
`dist/` and `.tsbuildinfo` files) to force a real rebuild before debugging
further.
