# Eigen regressions

Promoted regressions preserve the provenance of a real failure while rerunning
the referenced scenario against fresh deterministic payment worlds.

The Stage 4 live regression is:

```bash
pnpm eigen regress \
  regressions/refund-timeout-before-side-effect-live-001.yaml \
  --agents openai-refund-v2,openai-refund-v3 \
  --runs 10
```

This command requires `OPENAI_API_KEY` and `OPENAI_MODEL`. It is intentionally
not part of `pnpm check`. Use `pnpm regression-demo` for the fully offline,
scripted-model comparison.

The evidence JSON is an immutable byte-for-byte archive of the original live
trace. The manifest records both the original report path and the archive
checksum. Do not format or rewrite evidence files.
