#!/usr/bin/env python3
"""Read one ROS2 sensor_msgs image and emit bounded JSON/MCP-ready JPEG data.

Observation only: this node never publishes, calls a service or moves a robot.
The original header timestamp/frame_id are reported without claiming TF.
"""
import argparse
import base64
import json
import subprocess
import sys
import time


def jpeg_from_raw(data, width, height, stride, encoding, is_bigendian=False):
    formats = {"rgb8": ("rgb24", 3), "bgr8": ("bgr24", 3),
               "mono8": ("gray", 1), "rgba8": ("rgba", 4), "bgra8": ("bgra", 4)}
    if encoding in ("16UC1", "mono16", "32FC1"):
        # Display-only depth rendering. Never report normalized pixels as depth
        # measurements; the original unit remains in the encoding metadata.
        import numpy as np
        import cv2
        dtype = (">u2" if is_bigendian else "<u2") if encoding != "32FC1" else (">f4" if is_bigendian else "<f4")
        channel_bytes = 4 if encoding == "32FC1" else 2
        if stride < width * channel_bytes or len(data) < stride * height:
            raise ValueError("Invalid depth image stride or truncated data")
        matrix = np.ndarray((height, width), dtype=np.dtype(dtype), buffer=bytes(data), strides=(stride, channel_bytes))
        valid = np.isfinite(matrix) & (matrix > 0)
        output = np.zeros((height, width), dtype=np.uint8)
        if np.any(valid):
            lo, hi = np.percentile(matrix[valid], [2, 98])
            if hi > lo:
                output[valid] = np.clip((matrix[valid].astype(np.float32) - lo) * (255.0 / (hi - lo)), 1, 255).astype(np.uint8)
            else:
                output[valid] = 128
        visual = cv2.applyColorMap(output, cv2.COLORMAP_TURBO)
        visual[~valid] = 0
        scale = min(1.0, 768.0 / max(width, height))
        if scale < 1:
            visual = cv2.resize(visual, (max(1, round(width * scale)), max(1, round(height * scale))), interpolation=cv2.INTER_AREA)
        ok, jpeg = cv2.imencode(".jpg", visual, [cv2.IMWRITE_JPEG_QUALITY, 75])
        if not ok:
            raise ValueError("Failed to encode depth visualization")
        return jpeg.tobytes()
    if encoding not in formats:
        raise ValueError("Unsupported raw encoding: " + encoding + ". Use image_transport/compressed or rgb8/bgr8/mono8/rgba8/bgra8.")
    pixel_format, channels = formats[encoding]
    row_bytes = width * channels
    if stride < row_bytes or len(data) < stride * height:
        raise ValueError("Invalid ROS image stride or truncated data")
    pixels = b"".join(bytes(data[y * stride:y * stride + row_bytes]) for y in range(height))
    args = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
            "-f", "rawvideo", "-pix_fmt", pixel_format, "-s", f"{width}x{height}",
            "-i", "pipe:0", "-frames:v", "1", "-vf",
            "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
            "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"]
    return subprocess.run(args, input=pixels, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=True, timeout=6).stdout


def jpeg_from_compressed(data, fmt):
    fmt_lower = fmt.lower()
    if "jpeg" not in fmt_lower and "jpg" not in fmt_lower and "png" not in fmt_lower:
        raise ValueError("Compressed image format must be JPEG or PNG")
    return subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error",
                           "-threads", "1", "-f", "image2pipe", "-i", "pipe:0",
                           "-frames:v", "1", "-vf",
                           "scale='min(768,iw)':'min(768,ih)':force_original_aspect_ratio=decrease",
                           "-q:v", "5", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
                          input=bytes(data), stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                          check=True, timeout=6).stdout


def bounded_jpeg(jpg):
    """Keep ROS snapshots within the same conservative inline image budget
    used by file previews. The source image is never treated as geometry.
    """
    if len(jpg) <= 120_000:
        return jpg
    if len(jpg) > 8 * 1024 * 1024:
        raise ValueError("JPEG capture exceeds 8 MiB decoding limit")
    for edge, quality in ((768, 8), (640, 10), (512, 12), (384, 14)):
        result = subprocess.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-threads", "1",
             "-f", "image2pipe", "-i", "pipe:0", "-frames:v", "1",
             "-vf", f"scale={edge}:{edge}:force_original_aspect_ratio=decrease",
             "-q:v", str(quality), "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"],
            input=jpg, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True, timeout=6)
        jpg = result.stdout
        if len(jpg) <= 120_000:
            return jpg
    raise ValueError("ROS image preview exceeds 120 KiB transport budget")


def convert_image(message, compressed):
    if compressed:
        jpg = jpeg_from_compressed(message.data, message.format)
        fmt = message.format
        width = None
        height = None
    else:
        width = int(message.width)
        height = int(message.height)
        if width <= 0 or height <= 0 or width > 4096 or height > 4096:
            raise ValueError("ROS image dimensions are invalid or too large")
        if len(message.data) > 32 * 1024 * 1024:
            raise ValueError("Raw ROS image exceeds 32 MiB")
        fmt = message.encoding
        jpg = jpeg_from_raw(message.data, width, height, int(message.step), fmt, bool(message.is_bigendian))
    jpg = bounded_jpeg(jpg)
    if len(jpg) < 4 or len(jpg) > 120_000 or jpg[:2] != b"\xff\xd8":
        raise ValueError("Captured JPEG exceeds 120 KiB or is invalid")
    header = message.header
    stamp = header.stamp
    stamp_ns = int(stamp.sec) * 1000000000 + int(stamp.nanosec)
    return {"mimeType": "image/jpeg", "data": base64.b64encode(jpg).decode("ascii"),
            "topicFrameId": str(header.frame_id), "stampNanoseconds": str(stamp_ns),
            "width": width, "height": height, "encoding": fmt,
            "visualization": "relative-depth-pseudocolor" if fmt in ("16UC1", "mono16", "32FC1") else "standard-image"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("topic")
    parser.add_argument("--timeout", type=float, default=6.0)
    options = parser.parse_args()
    if not options.topic.startswith("/") or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_/" for c in options.topic):
        raise ValueError("ROS2 image topic must be an absolute name using letters, digits, _ or /")
    try:
        import rclpy
        from rclpy.qos import qos_profile_sensor_data
        from sensor_msgs.msg import Image, CompressedImage
    except ImportError as error:
        raise RuntimeError("rclpy/sensor_msgs unavailable on this node; use a ROS2-enabled execution peer") from error
    rclpy.init(args=None)
    node = rclpy.create_node("synrex_image_observer", enable_rosout=False)
    received = []
    try:
        deadline = time.monotonic() + min(8.0, max(0.5, options.timeout))
        subscription = None
        compressed = False
        while time.monotonic() < deadline:
            if subscription is None:
                types = dict(node.get_topic_names_and_types()).get(options.topic, [])
                if "sensor_msgs/msg/CompressedImage" in types:
                    compressed = True
                    message_type = CompressedImage
                elif "sensor_msgs/msg/Image" in types:
                    message_type = Image
                else:
                    rclpy.spin_once(node, timeout_sec=0.1)
                    continue
                subscription = node.create_subscription(message_type, options.topic,
                    lambda message: received.append(message), qos_profile_sensor_data)
            rclpy.spin_once(node, timeout_sec=0.1)
            if received:
                output = convert_image(received[0], compressed)
                output["topic"] = options.topic
                print(json.dumps(output, separators=(",", ":")))
                return
        raise TimeoutError("No ROS2 image arrived on topic " + options.topic + " before timeout")
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
