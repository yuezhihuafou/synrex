# Visual media inspection through Synrex

**Status:** P1 development candidate on isolated swy1 worktree (2026-10-26).
These instructions describe the candidate source, not the pinned production
service. No public MCP/OAuth release was changed during the P1 implementation.

Synrex's existing `read` tool supplies actual MCP image content to the calling
host, not a filesystem path or a textual base64 dump.

- **Image:** `read({workspaceId, path: "docs/assets/screenshot.png"})` returns a
  real MCP image block. Files up to 120,000 bytes use Pi's original reader;
  larger files are decoded as bounded, lossy JPEG previews with the original
  file unchanged. Images in `read.files` batches survive aggregation; encoded
  bytes are never placed in `structuredContent`.
- **Video:** `read({workspaceId, path: "clips/run.mp4"})` returns four sampled
  visual frames by default (short clips yield fewer); use `frames: 1..6` on a
  peer exposing the updated tool schema. Captions contain timestamps. The
  frames are JPEG MCP image blocks; audio is **not** transcribed. Supported:
  MP4, MOV, M4V, MKV, WebM, AVI, MPEG. Video requires `ffmpeg` and `ffprobe`
  installed on the execution peer. Read videos individually with `read.path`,
  not in `read.files` batches.

- **Video interval:** `read({workspaceId, path: "clips/run.mp4", startSeconds: 2,
  endSeconds: 4, frames: 4})` samples a selected segment. Older coordinator
  schemas can use `clips/run.mp4#t=2,4` as the `path` argument instead.
- **Frame comparison:** `read({workspaceId, path: "clips/run.mp4",
  startSeconds: 2, endSeconds: 3, compare: true})` returns two frames plus a
  third pixel-difference image. Older hosts use `clips/run.mp4#compare=2,3`.
  Lighting and camera motion also appear in the difference; this is not 3-D
  motion tracking or a calibrated pose measurement.
- **ROS2 snapshot:** `read({workspaceId, rosTopic:
  "/camera/color/image_raw"})` subscribes once to `sensor_msgs/msg/Image` or
  `sensor_msgs/msg/CompressedImage` on the execution peer hosting the workspace.
  Older hosts use `read({workspaceId, path:
  "ros2:///camera/color/image_raw"})`. Returns one actual JPEG content block
  plus original `frame_id`, header timestamp in nanoseconds, encoding and topic.
  Requires `rclpy`, `sensor_msgs` and `ffmpeg` on the node running the tool.
  `SYNREX_ROS_PYTHON` may point to its configured ROS2 Python interpreter.
  Correct ROS_DOMAIN_ID/DDS discovery and the publisher are also required.
  No robot command, service request, TF lookup or inferred base pose occurs.

**Observation envelope (v1):** media `read` responses include
`structuredContent.observation` with observation ID, source kind/locator,
workspace ID, capture time, image count, MIME types and preview flag. ROS2
captures additionally retain the original message's `frame_id` and header
timestamp (ns). This is provenance only, **not** proof that an image is fresh,
an object was detected, or a task succeeded. Capture times and ROS2 header
times may use different clocks. The GPT host performs semantic interpretation.
No long-running vision daemon, separate agent, new database, or self-waking
ChatGPT loop was added.

### Gateway reading the swy1 RealSense without ROS2 on gateway

The gateway runtime can stream its read-only Python subscriber through the
existing SSH connection into the running `ur5_ros2_humble_dev` container on
swy1. Configure **only gateway's** Synrex service with:

```
SYNREX_ROS_SNAPSHOT_SSH_TARGET=<ssh-user>@<trusted-swy1-host>
SYNREX_ROS_SNAPSHOT_CONTAINER=ur5_ros2_humble_dev
```

The SSH target/container are operator-side settings, never provided through
the model-facing tool. There is no remote file upload, daemon, service restart,
sensor configuration change, or ROS publisher. Each call creates one bounded
subscriber in the already-running container and streams the JPEG/metadata back
over SSH stdin/stdout. The subscriber sources the ROS Humble environment,
uses sensor-data QoS, and exits after one image or a short timeout.

Verified image topic on swy1 (2026-10-23):
`/camera/wrist_camera/depth/image_rect_raw` (`sensor_msgs/msg/Image`, 16UC1,
frame `wrist_camera_depth_optical_frame`). The depth image is mapped to a
**relative-depth pseudocolor visualization** using the 2nd/98th percentile
of positive finite pixels; its color scale is *not calibrated in meters*.
Original encoding, timestamp and frame identity are preserved in metadata.
An RGB image topic was not observed during inspection. Do not infer camera
motion or base-frame coordinates from the depth image without image-time TF.

The legacy swy1 MCP coordinator can route a path such as
`ros2:///camera/wrist_camera/depth/image_rect_raw` to the gateway workspace;
`rosTopic` is optional on newer tool schemas. Remote subscription requires
the preexisting passwordless SSH identity and Docker permissions on swy1.

Video inspection limits: input ≤ 512 MiB, each encoded frame ≤ 120,000 bytes,
aggregate frames ≤ 180,000 bytes (before base64), longest edge ≤ 768 px,
ffprobe 5s timeout and bounded ffmpeg decoding. Adaptive resolution keeps
the combined sequence well below the peer's 2 MiB JSON limit and reduces
host-side transfer failures; sample fewer frames or shorter clips if details
cannot fit the budget. Sampled frames are not a substitute for frame-accurate
temporal reasoning or inspecting a complete video sequence.

Still image and ROS2 preview JPEG payloads are capped at 120,000 bytes; when
necessary, previews are rescaled or an explicit error is returned. This lower
budget is informed by measured MCP image transfer problems with larger PNGs;
it is not a measured universal host limit. Use a separate crop or retained
source file for detailed visual inspection.

Media access follows the same workspace-relative allowed-path checks as text
reads; it does not add an upload server, second media database, or a hidden
vision model. The ChatGPT host must support MCP image content rendering. An
older coordinator might expose only the old read schema (`frames` then defaults
to four) or still discard images from coordinator-side batch aggregation.
On older swy1 coordinators, use one media path at a time and the compatible
video fragment forms above for intervals and comparisons until schema support
is verified in the actual connected host.
