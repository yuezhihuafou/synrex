# Real test-fix-verify demo for Synrex

This disposable sample has one **intentional failing boundary test**; it is not
a failing Synrex production test.

Run `node --test` here to observe the failure. Open the project in Synrex
from an approved workspace root and ask ChatGPT to diagnose it, make a minimal
fix and re-run tests. Keep the actual command receipts and Git diff for the
recording. The expected code fix changes `>` to `>=` in `shipping.mjs`.

After the demo, reset your disposable copy, not the Synrex source tree.
See [the recording guide](../../docs/launch/PUBLIC_DEMO.md).
