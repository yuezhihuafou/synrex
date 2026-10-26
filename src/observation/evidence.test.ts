import assert from "node:assert/strict";
import test from "node:test";
import { captureObservation, withObservationEvidence } from "./evidence.js";

test("generic observations preserve image blocks and ROS source time without mixing data into metadata", () => {
  const data = "iVBORw0KGgo=";
  const original = {
    content: [{ type: "text", text: "camera frame" }, { type: "image", data, mimeType: "image/jpeg" }],
    structuredContent: { result: "camera frame", media: { stampNanoseconds: "1810000000000000001", frameId: "optical" } },
  };
  const result = withObservationEvidence(original, {
    kind: "ros2.image", locator: "/camera/image_raw", workspaceId: "ws_test",
  });
  assert.deepEqual(result.content, original.content);
  assert.equal(result.structuredContent.observation.status, "captured");
  assert.equal(result.structuredContent.observation.sourceTimestampNanoseconds, "1810000000000000001");
  assert.equal(result.structuredContent.observation.sourceFrameId, "optical");
  assert.equal(result.structuredContent.observation.imageCount, 1);
  assert.ok(!JSON.stringify(result.structuredContent).includes(data));
  assert.ok(!("goalVerified" in result.structuredContent.observation));
});

test("observation identifiers are per capture and source type stays open for future adapters", () => {
  const input = { content: [{ type: "text", text: "fixture" }] };
  const source = { kind: "arbitrary.future.sensor", locator: "peer://resource", workspaceId: "ws_test" };
  const first = withObservationEvidence(input, source);
  const second = withObservationEvidence(input, source);
  assert.notEqual(first.structuredContent.observation.observationId, second.structuredContent.observation.observationId);
  assert.equal(first.structuredContent.observation.imageCount, 0);
  assert.equal(first.structuredContent.observation.source.kind, "arbitrary.future.sensor");
});

test("capture adapter is source-agnostic and does not report a failed capture as successful", async () => {
  const source = { kind: "document.render", locator: "report.pdf#page=3", workspaceId: "ws_test" };
  const captured = await captureObservation({ capture: async () => ({
    content: [{ type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" }],
  }) }, source, { previewOnly: true });
  assert.equal(captured.structuredContent.observation.source.kind, "document.render");
  assert.equal(captured.structuredContent.observation.previewOnly, true);
  await assert.rejects(captureObservation({ capture: async () => {
    throw new Error("camera offline");
  } }, source), /camera offline/);
  await assert.rejects(captureObservation({ capture: async () => ({
    content: [{ type: "text", text: "sensor unavailable" }], isError: true,
  }) }, source), /Failed capture/);
});
