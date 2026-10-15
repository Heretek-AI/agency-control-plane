# verify-stage.md — Wave Verification Checklist

Every wave MUST satisfy ALL items below. QA and Drift Guard enforce this file.
No merge to `main` without every box checked and `VERDICT: PASS` recorded.

## 1. Green Build

- [ ] `make check` exits 0 (`bun install` + `bun run check` + `bun test`, zero failures).
- [ ] `bun run check` (typecheck + lint) reports zero warnings, zero errors.
- [ ] All `<diagnostics>` fixed immediately; none outstanding.

## 2. Acceptance Scripts

- [ ] Wave accept script exits 0:
  - Wave 1 → `bash scripts/accept/wave-1.sh`
  - Wave 2 → `bash scripts/accept/wave-2.sh`
  - Wave 3 → `bash scripts/accept/wave-3.sh`
- [ ] Full `make accept` (all three waves) exits 0 before final Wave 3 merge.

## 3. QA Red-Proof Sabotage (`docs/evidence/wave-<N>/red-proofs.log`)

QA MUST break the code, prove the tests catch it, then restore cleanly.
Each sabotage entry records: what was broken, failing test output, restore command.

- [ ] Wave 1:
  - [ ] Revert `limits.ts` so 429/`gousagelimiterror` on `tier-1-opencode` returns
        `pause-missions` → `limits.test.ts` FAILS → restore with `git checkout --`.
  - [ ] Break `pathsOverlap` in `scheduler.ts` (e.g. `return false`) →
        `scheduler.test.ts` FAILS → restore cleanly.
- [ ] Wave 2:
  - [ ] Break 2-phase allocation (skip `allocating` record) or salvage-ref anchoring →
        `worktrees-landing.test.ts` FAILS → restore cleanly.
  - [ ] Break ticket single-use/TTL or loopback guard → `server-api.test.ts` FAILS →
        restore cleanly.
- [ ] Wave 3:
  - [ ] Leak passphrase into `fleet-store`/`localStorage`/DOM → `approval-invariant.test.ts`
        FAILS → restore cleanly.
- [ ] Log restored-cleanly proof (`git status --short` clean for sabotaged paths) in
  `docs/evidence/wave-<N>/red-proofs.log`.

## 4. Drift-Guard Gate (Binding)

- [ ] `VERDICT: PASS` present in `docs/reports/wave-<N>-verification.md`.
- [ ] `VERDICT: FAIL` (or missing verdict) BLOCKS the merge unconditionally.
- [ ] Max 3 rework cycles per wave (Programmer → QA → Drift Guard = 1 cycle).
      After 3 failed cycles, halt and escalate with evidence.

## 5. Zero-Stub Grep (must print nothing)

```sh
grep -rn --include='*.ts' --include='*.tsx' --include='*.sh' -E 'TODO|FIXME|XXX|HACK|return true;|echo "passed"|\|\| true|catch *\(.*\) *\{\}' dispatcher web scripts || true
```

- [ ] Grep output empty (no TODOs, no dummy passes, no swallowed errors, no `set +e`).
- [ ] Every interface/struct/function/route/test contains exact logic.

## 6. Scope Refusal Check

- [ ] No `SwarmOS` code (`src/omni`, `swarmos-plugin.ts`) present.
- [ ] No AST parsers or domain MCP tools present.
- [ ] All new files live under `dispatcher/`, `web/`, `docs/`, `scripts/`, or repo-root
      configs (`package.json`, `tsconfig.json`, `Makefile`, `AGENTS.md`).
- [ ] Invariant I1 holds: `grep -rn 'passphrase' web/src/state web/src/components`
      shows no storage of the passphrase outside `web/src/security/approval-client.ts`
      closure usage.

## 7. Wave Deliverables Present

- [ ] Wave 1: `dispatcher/src/{model,wildcard,scheduler,limits,audit}.ts`,
      `dispatcher/test/{scheduler.test.ts,limits.test.ts}`, `scripts/accept/wave-1.sh`,
      `docs/reports/wave-1.md`.
- [ ] Wave 2: `dispatcher/src/{worktrees,landing,event-bus,approval-tickets,server}.ts`,
      `dispatcher/test/{worktrees-landing.test.ts,server-api.test.ts}`,
      `scripts/accept/wave-2.sh`, `docs/reports/wave-2.md`.
- [ ] Wave 3: `web/src/state/fleet-store.ts`, `web/src/security/approval-client.ts`,
      all 5 components + `app.tsx`, `web/test/{approval-invariant.test.ts,ui-components.test.ts}`,
      `scripts/accept/wave-3.sh`, `docs/reports/wave-3.md`.
