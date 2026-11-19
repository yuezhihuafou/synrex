import type { ReviewChangesResult, ReviewFile } from "./review-checkpoints.js";

// MCP Apps metadata is shipped with the tool response, even when the model sees
// only the short text summary. Sending a multi-megabyte binary Git patch here
// can needlessly saturate the host's response/stream and browser renderer.
const MAX_INLINE_PATCH_BYTES = 96 * 1024;
const MAX_INLINE_FILES = 200;
const MAX_FILE_PATH_CHARS = 240;

export function reviewCardPayload(review: ReviewChangesResult) {
  const patchBytes = Buffer.byteLength(review.patch, "utf8");
  const patchOmitted = patchBytes > MAX_INLINE_PATCH_BYTES;
  const files = review.files.slice(0, MAX_INLINE_FILES).map((file): ReviewFile => ({
    ...file,
    path: file.path.slice(0, MAX_FILE_PATH_CHARS),
    ...(file.previousPath ? { previousPath: file.previousPath.slice(0, MAX_FILE_PATH_CHARS) } : {}),
  }));
  const omittedFileCount = review.files.length - files.length;
  return {
    reviewRef: review.reviewRef,
    summary: patchOmitted || omittedFileCount > 0
      ? { ...review.summary, patchOmitted, omittedFileCount }
      : review.summary,
    files,
    payload: { patch: patchOmitted ? "" : review.patch },
  };
}
