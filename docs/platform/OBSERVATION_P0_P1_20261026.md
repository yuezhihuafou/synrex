# Synrex observation P0/P1 implementation record — 2026-10-26

## Source identities and isolation

- Baseline: canonical `origin/main` = `a49b2d5bf2c268ec1acde2c89baf94a6e71837d0`
  at isolated swy1 worktree `DevSpace-94b56b49`.
- Pinned swy1 service: `20261026-synrex-learning-agy-c148b6a`,
  source `c148b6a331fd8162b6bc32b5fbff6aa11172155c`; **not modified**.
- Media origin: gateway `feat/gateway-parallel-v1` =
  `a3333d142b96c0d8624e0789c1e5ac14d71e3e26`, imported through a
  24,262-byte scoped Git bundle without moving gateway's dirty checkout.
- Main and pinned release have different histories. This work does not merge
  either complete history into the other and must not silently replace
  production's newer capabilities.

## Implemented in the candidate

1. Selectively reuse `media-read.ts`, `ros2-camera-read.ts` and the
   read-only ROS2 Python helper, retaining video time-window/compare support.
2. Add conservative image preview compression, including on ROS2 one-shot
   captures, to keep returned image blocks small and retrievable.
3. Preserve MCP image blocks in batch reads and remote batch fan-out.
4. Attach source-independent observation ID, locator, timestamps and preview
   provenance to image/video/ROS2 responses without creating a new database.
5. Add targeted media, metadata, cross-node routing and actual in-memory
   MCP server tests.

## First cross-node visual evidence

Using the existing connected Synrex MCP gateway route, the host read two
JPEG previews stored in an **isolated gateway worktree**:

- Before: `v11-review-ui-before.png` (247,322 bytes), generated preview
  `before-preview.jpg` (21,340 bytes).
- After: `v11-review-ui-after.png`, generated preview
  `after-preview.jpg` (17,918 bytes).

Both arrived at the GPT host as real `image/jpeg` blocks. Visual inspection
of the returned images distinguished six iframe-backed UI call cards before
from two afterwards. This validates **the existing cross-node transport path
plus explicitly preprocessed images**. The candidate's automatic compression
was independently tested through its local MCP server; the combined new
candidate has not been deployed to the live cross-node route.

## Remaining distinctions

- ROS2 tests are read-only and mocked unless a real topic is explicitly
  provided. No RGB camera topic, image-time TF transform, semantic object
  detection, or robot motion result was verified during this integration.
- Observations show capture provenance, not autonomous visual reasoning after
  a ChatGPT turn ends. Future document/desktop/simulator adapters can reuse
  this envelope without becoming mandatory Synrex dependencies.
- All changes are in the isolated worktree until tested, reviewed and
  separately integrated. Production cutover is not part of P0/P1.
