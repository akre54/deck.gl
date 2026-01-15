// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * Minimal OpenEXR writer for HDR image export.
 *
 * Supports:
 * - HALF (float16) and FLOAT (float32) pixel types
 * - RGBA channels
 * - Scanline storage (no tiling)
 * - No compression (for simplicity and speed)
 *
 * For production use with compression, consider using a full EXR library.
 */

export type EXRChannelType = 'half' | 'float';

export type WriteEXROptions = {
  /** Pixel type: 'half' (16-bit float) or 'float' (32-bit float). Default: 'half' */
  pixelType?: EXRChannelType;
  /** Channel names. Default: ['R', 'G', 'B', 'A'] */
  channels?: string[];
};

// EXR constants
const EXR_MAGIC = 0x01312f76;
const EXR_VERSION = 2; // Version 2, single-part scanline
const EXR_VERSION_FLAGS = 0; // No flags for basic scanline

// Pixel types
const PIXEL_TYPE_UINT = 0;
const PIXEL_TYPE_HALF = 1;
const PIXEL_TYPE_FLOAT = 2;

// Compression types
const COMPRESSION_NONE = 0;

// Line order
const LINE_ORDER_INCREASING_Y = 0;

/**
 * Write pixel data to OpenEXR format.
 *
 * @param pixels Float32Array of RGBA pixel data, row-major from top-left
 * @param width Image width
 * @param height Image height
 * @param options EXR options
 * @returns ArrayBuffer containing EXR file data
 */
export function writeEXR(
  pixels: Float32Array,
  width: number,
  height: number,
  options: WriteEXROptions = {}
): ArrayBuffer {
  const pixelType = options.pixelType ?? 'half';
  const channels = options.channels ?? ['R', 'G', 'B', 'A'];
  const numChannels = channels.length;

  // Calculate sizes
  const pixelSize = pixelType === 'half' ? 2 : 4;
  const scanlineDataSize = width * numChannels * pixelSize;

  // Build header
  const header = buildHeader(width, height, channels, pixelType);

  // Calculate offset table size (one offset per scanline)
  const offsetTableSize = height * 8; // 64-bit offsets

  // Calculate total file size
  // Magic(4) + Version(4) + Header + OffsetTable + ScanlineData
  const headerSize = header.byteLength;
  const scanlineHeaderSize = 8; // y-coord (4) + pixel data size (4)
  const totalScanlineSize = (scanlineHeaderSize + scanlineDataSize) * height;
  const totalSize = 4 + 4 + headerSize + offsetTableSize + totalScanlineSize;

  // Allocate output buffer
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const uint8 = new Uint8Array(buffer);

  let offset = 0;

  // Write magic number (little-endian)
  view.setUint32(offset, EXR_MAGIC, true);
  offset += 4;

  // Write version
  view.setUint32(offset, EXR_VERSION | (EXR_VERSION_FLAGS << 8), true);
  offset += 4;

  // Write header
  uint8.set(new Uint8Array(header), offset);
  offset += headerSize;

  // Calculate and write offset table
  const offsetTableStart = offset;
  let scanlineOffset = offsetTableStart + offsetTableSize;

  for (let y = 0; y < height; y++) {
    // Write 64-bit offset (as two 32-bit values, little-endian)
    view.setUint32(offset, scanlineOffset, true);
    view.setUint32(offset + 4, 0, true); // High 32 bits
    offset += 8;
    scanlineOffset += scanlineHeaderSize + scanlineDataSize;
  }

  // Write scanline data
  for (let y = 0; y < height; y++) {
    // Write scanline y-coordinate
    view.setInt32(offset, y, true);
    offset += 4;

    // Write pixel data size
    view.setUint32(offset, scanlineDataSize, true);
    offset += 4;

    // Write pixel data (channels are stored in alphabetical order: A, B, G, R)
    // EXR stores channels separately within each scanline
    const sortedChannels = [...channels].sort();

    for (const channel of sortedChannels) {
      const channelIndex = getChannelIndex(channel);
      for (let x = 0; x < width; x++) {
        const pixelIndex = (y * width + x) * 4 + channelIndex;
        const value = pixels[pixelIndex];

        if (pixelType === 'half') {
          const halfValue = floatToHalf(value);
          view.setUint16(offset, halfValue, true);
          offset += 2;
        } else {
          view.setFloat32(offset, value, true);
          offset += 4;
        }
      }
    }
  }

  return buffer;
}

/**
 * Build EXR header as ArrayBuffer
 */
function buildHeader(
  width: number,
  height: number,
  channels: string[],
  pixelType: EXRChannelType
): ArrayBuffer {
  const parts: Uint8Array[] = [];

  // channels attribute
  parts.push(writeAttribute('channels', 'chlist', buildChannelList(channels, pixelType)));

  // compression attribute
  parts.push(
    writeAttribute('compression', 'compression', new Uint8Array([COMPRESSION_NONE]))
  );

  // dataWindow attribute
  parts.push(
    writeAttribute('dataWindow', 'box2i', buildBox2i(0, 0, width - 1, height - 1))
  );

  // displayWindow attribute
  parts.push(
    writeAttribute('displayWindow', 'box2i', buildBox2i(0, 0, width - 1, height - 1))
  );

  // lineOrder attribute
  parts.push(
    writeAttribute('lineOrder', 'lineOrder', new Uint8Array([LINE_ORDER_INCREASING_Y]))
  );

  // pixelAspectRatio attribute
  const aspectRatio = new ArrayBuffer(4);
  new DataView(aspectRatio).setFloat32(0, 1.0, true);
  parts.push(writeAttribute('pixelAspectRatio', 'float', new Uint8Array(aspectRatio)));

  // screenWindowCenter attribute
  const center = new ArrayBuffer(8);
  const centerView = new DataView(center);
  centerView.setFloat32(0, 0.0, true);
  centerView.setFloat32(4, 0.0, true);
  parts.push(writeAttribute('screenWindowCenter', 'v2f', new Uint8Array(center)));

  // screenWindowWidth attribute
  const windowWidth = new ArrayBuffer(4);
  new DataView(windowWidth).setFloat32(0, 1.0, true);
  parts.push(writeAttribute('screenWindowWidth', 'float', new Uint8Array(windowWidth)));

  // End of header (null byte)
  parts.push(new Uint8Array([0]));

  // Concatenate all parts
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const header = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    header.set(part, offset);
    offset += part.length;
  }

  return header.buffer;
}

/**
 * Write a single header attribute
 */
function writeAttribute(
  name: string,
  type: string,
  value: Uint8Array
): Uint8Array {
  const nameBytes = stringToBytes(name);
  const typeBytes = stringToBytes(type);
  const sizeBytes = new Uint8Array(4);
  new DataView(sizeBytes.buffer).setUint32(0, value.length, true);

  const result = new Uint8Array(nameBytes.length + typeBytes.length + 4 + value.length);
  let offset = 0;
  result.set(nameBytes, offset);
  offset += nameBytes.length;
  result.set(typeBytes, offset);
  offset += typeBytes.length;
  result.set(sizeBytes, offset);
  offset += 4;
  result.set(value, offset);

  return result;
}

/**
 * Build channel list attribute value
 */
function buildChannelList(channels: string[], pixelType: EXRChannelType): Uint8Array {
  const parts: Uint8Array[] = [];
  const sortedChannels = [...channels].sort();

  for (const name of sortedChannels) {
    const nameBytes = stringToBytes(name);
    // Channel entry: name (null-terminated), pixel type (4), pLinear (1), reserved (3), xSampling (4), ySampling (4)
    const entry = new Uint8Array(nameBytes.length + 16);
    entry.set(nameBytes, 0);

    const view = new DataView(entry.buffer, entry.byteOffset);
    const dataOffset = nameBytes.length;

    // Pixel type
    view.setInt32(dataOffset, pixelType === 'half' ? PIXEL_TYPE_HALF : PIXEL_TYPE_FLOAT, true);
    // pLinear (0 = gamma-encoded, 1 = linear) - we're outputting linear
    entry[dataOffset + 4] = 1;
    // Reserved (3 bytes)
    entry[dataOffset + 5] = 0;
    entry[dataOffset + 6] = 0;
    entry[dataOffset + 7] = 0;
    // xSampling
    view.setInt32(dataOffset + 8, 1, true);
    // ySampling
    view.setInt32(dataOffset + 12, 1, true);

    parts.push(entry);
  }

  // Null terminator for channel list
  parts.push(new Uint8Array([0]));

  // Concatenate
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }

  return result;
}

/**
 * Build box2i (int bounding box)
 */
function buildBox2i(xMin: number, yMin: number, xMax: number, yMax: number): Uint8Array {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  view.setInt32(0, xMin, true);
  view.setInt32(4, yMin, true);
  view.setInt32(8, xMax, true);
  view.setInt32(12, yMax, true);
  return new Uint8Array(buffer);
}

/**
 * Convert string to null-terminated UTF-8 bytes
 */
function stringToBytes(str: string): Uint8Array {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(str);
  const result = new Uint8Array(bytes.length + 1);
  result.set(bytes, 0);
  result[bytes.length] = 0; // Null terminator
  return result;
}

/**
 * Get channel index from name (R=0, G=1, B=2, A=3)
 */
function getChannelIndex(channel: string): number {
  switch (channel.toUpperCase()) {
    case 'R':
      return 0;
    case 'G':
      return 1;
    case 'B':
      return 2;
    case 'A':
      return 3;
    default:
      return 0;
  }
}

/**
 * Convert 32-bit float to 16-bit half float.
 *
 * Based on the IEEE 754 standard conversion.
 * Handles special cases: NaN, Infinity, denormals.
 */
function floatToHalf(value: number): number {
  const floatView = new Float32Array(1);
  const int32View = new Int32Array(floatView.buffer);

  floatView[0] = value;
  const f = int32View[0];

  const sign = (f >> 16) & 0x8000;
  const exponent = ((f >> 23) & 0xff) - 127 + 15;
  const mantissa = f & 0x007fffff;

  // Handle special cases
  if (exponent <= 0) {
    // Denormal or zero
    if (exponent < -10) {
      return sign; // Too small, return signed zero
    }
    // Denormalized half
    const m = (mantissa | 0x00800000) >> (1 - exponent);
    return sign | (m >> 13);
  }

  if (exponent === 0xff - 127 + 15) {
    // Infinity or NaN
    if (mantissa === 0) {
      return sign | 0x7c00; // Infinity
    }
    return sign | 0x7c00 | (mantissa >> 13); // NaN
  }

  if (exponent > 30) {
    // Overflow, return infinity
    return sign | 0x7c00;
  }

  // Normalized half
  return sign | (exponent << 10) | (mantissa >> 13);
}
