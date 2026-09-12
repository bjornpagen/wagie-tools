# BumbleDB runtime

Wagie Tools pins the published `@bjornpagen/bumbledb@1.3.1` and
`@bjornpagen/bumbledb-log@1.3.1` packages. The pnpm lockfile records registry
integrity for the SDK, history package, and platform binaries. There are no
sibling links, local package overrides, or vendored archives.

Use Node 24+ and the repository's pinned pnpm version:

```sh
pnpm install --frozen-lockfile
pnpm check
```

Effect remains pinned to `4.0.0-rc.112`. Release-age exceptions name only the
five 1.3.1 BumbleDB packages. The core loader selects its exact matching native
package for macOS ARM64, Linux ARM64, or Linux x64. Local validation uses macOS
ARM64. Update core and Log together and independently restore a backup before
adopting a new runtime for a working ledger.

Each backup's `runtime.json` records source hashes (including migration code
and generated bindings), Node and package-manager versions, upstream package
provenance, package file hashes, and the native binary hash. The archive also
includes the canonical schema snapshot, retained requests, and private provenance.

Fresh histories use native `LocalHistory.create` with
`migrations/0000-initial/schema.json`. Ordinary startup checks the configured
schema and authority; it never initializes or upgrades a database implicitly.
`pnpm schema:check` verifies both the native snapshot and Log-generated bindings.

Log 1.3.1 uses explicit `Transition` capabilities and handwritten TypeScript.
The old transformation DSL and generated plan chains are gone. Read
[migrations](migrations.md) before changing a schema or adopting a new binding.
