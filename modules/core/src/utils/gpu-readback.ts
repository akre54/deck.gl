// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

/**
 * GPU Texture Readback Utilities
 *
 * Provides a unified async API for reading pixels from GPU textures/framebuffers
 * that works across WebGL and WebGPU backends.
 *
 * NOTE: This abstraction should ideally live in luma.gl. Once luma.gl provides
 * a unified `device.readTextureAsync()` API, this module can be deprecated.
 *
 * @module
 */

import type {Device, Framebuffer, Texture, Buffer} from '@luma.gl/core';

export type ReadPixelsOptions = {
  /** Source X offset. Default: 0 */
  x?: number;
  /** Source Y offset. Default: 0 */
  y?: number;
  /** Width to read. Default: full width */
  width?: number;
  /** Height to read. Default: full height */
  height?: number;
};

export type ReadPixelsResult = {
  /** The pixel data */
  data: Float32Array | Uint8Array;
  /** Width of the read region */
  width: number;
  /** Height of the read region */
  height: number;
  /** Number of channels (typically 4 for RGBA) */
  channels: number;
};

/**
 * Async pixel readback from a framebuffer.
 *
 * WebGPU (first-class):
 * - Uses copyTextureToBuffer + buffer.mapAsync for true async readback
 * - Non-blocking, GPU-friendly
 *
 * WebGL (fallback):
 * - Uses readPixelsToArrayWebGL (sync) wrapped in a Promise
 * - Blocking, but provides consistent async API
 *
 * @param device - The luma.gl Device
 * @param source - Framebuffer or Texture to read from
 * @param options - Read region options
 * @returns Promise resolving to pixel data
 */
export async function readPixelsAsync(
  device: Device,
  source: Framebuffer | Texture,
  options: ReadPixelsOptions = {}
): Promise<ReadPixelsResult> {
  if (device.type === 'webgpu') {
    return readPixelsWebGPU(device, source, options);
  }
  return readPixelsWebGL(device, source, options);
}

/**
 * WebGPU async pixel readback using copyTextureToBuffer + mapAsync.
 * This is the proper async GPU readback pattern for WebGPU.
 */
async function readPixelsWebGPU(
  device: Device,
  source: Framebuffer | Texture,
  options: ReadPixelsOptions
): Promise<ReadPixelsResult> {
  // Get the texture from framebuffer if needed
  const texture = 'colorAttachments' in source
    ? (source as Framebuffer).colorAttachments[0] as Texture
    : source as Texture;

  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const width = options.width ?? texture.width;
  const height = options.height ?? texture.height;

  // Determine bytes per pixel based on texture format
  const bytesPerPixel = getBytesPerPixel(texture.format);
  const channels = 4; // RGBA

  // Calculate buffer size with row alignment (WebGPU requires 256-byte alignment)
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
  const bufferSize = bytesPerRow * height;

  // Create a buffer for readback with MAP_READ usage
  // Access the underlying WebGPU device
  const gpuDevice = (device as any).handle as GPUDevice;
  const gpuTexture = (texture as any).handle as GPUTexture;

  const readbackBuffer = gpuDevice.createBuffer({
    size: bufferSize,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  // Create command encoder and copy texture to buffer
  const commandEncoder = gpuDevice.createCommandEncoder();
  commandEncoder.copyTextureToBuffer(
    {
      texture: gpuTexture,
      origin: {x, y, z: 0}
    },
    {
      buffer: readbackBuffer,
      bytesPerRow,
      rowsPerImage: height
    },
    {width, height, depthOrArrayLayers: 1}
  );

  // Submit the copy command
  gpuDevice.queue.submit([commandEncoder.finish()]);

  // Wait for the buffer to be mappable
  await readbackBuffer.mapAsync(GPUMapMode.READ);

  // Get the data
  const mappedRange = readbackBuffer.getMappedRange();

  // Create the appropriate typed array based on format
  const isFloat = texture.format.includes('float');
  const data = isFloat
    ? new Float32Array(width * height * channels)
    : new Uint8Array(width * height * channels);

  // Copy data, handling row alignment
  const sourceArray = isFloat
    ? new Float32Array(mappedRange)
    : new Uint8Array(mappedRange);

  const srcBytesPerRow = bytesPerRow / (isFloat ? 4 : 1);
  const dstPixelsPerRow = width * channels;

  for (let row = 0; row < height; row++) {
    const srcOffset = row * srcBytesPerRow;
    const dstOffset = row * dstPixelsPerRow;
    data.set(
      sourceArray.subarray(srcOffset, srcOffset + dstPixelsPerRow),
      dstOffset
    );
  }

  // Cleanup
  readbackBuffer.unmap();
  readbackBuffer.destroy();

  return {data, width, height, channels};
}

/**
 * WebGL pixel readback using luma.gl's readPixelsToArrayWebGL.
 * Wrapped in Promise for consistent async API.
 */
async function readPixelsWebGL(
  device: Device,
  source: Framebuffer | Texture,
  options: ReadPixelsOptions
): Promise<ReadPixelsResult> {
  // Get framebuffer - if source is a texture, we need to create a temp framebuffer
  let framebuffer: Framebuffer;
  let tempFramebuffer = false;

  if ('colorAttachments' in source) {
    framebuffer = source as Framebuffer;
  } else {
    // Create temporary framebuffer from texture
    const texture = source as Texture;
    framebuffer = device.createFramebuffer({
      colorAttachments: [texture]
    });
    tempFramebuffer = true;
  }

  const texture = framebuffer.colorAttachments[0] as Texture;
  const x = options.x ?? 0;
  const y = options.y ?? 0;
  const width = options.width ?? texture.width;
  const height = options.height ?? texture.height;
  const channels = 4;

  // Determine data type based on format
  const isFloat = texture.format.includes('float');
  const data = isFloat
    ? new Float32Array(width * height * channels)
    : new Uint8Array(width * height * channels);

  // Use luma.gl's WebGL readback
  device.readPixelsToArrayWebGL(framebuffer, {
    sourceX: x,
    sourceY: y,
    sourceWidth: width,
    sourceHeight: height,
    target: data
  });

  // Cleanup temp framebuffer
  if (tempFramebuffer) {
    framebuffer.destroy();
  }

  return {data, width, height, channels};
}

/**
 * Get bytes per pixel for a texture format.
 */
function getBytesPerPixel(format: string): number {
  if (format.includes('32float')) return 16; // rgba32float
  if (format.includes('16float')) return 8;  // rgba16float
  if (format.includes('8unorm')) return 4;   // rgba8unorm
  return 4; // Default to 4 bytes
}

/**
 * Flip pixel data vertically.
 * GPU textures often have origin at bottom-left, while images expect top-left.
 */
export function flipPixelsVertically<T extends Float32Array | Uint8Array>(
  data: T,
  width: number,
  height: number,
  channels: number = 4
): T {
  const rowSize = width * channels;
  const flipped = new (data.constructor as any)(data.length) as T;

  for (let y = 0; y < height; y++) {
    const srcOffset = y * rowSize;
    const dstOffset = (height - 1 - y) * rowSize;
    flipped.set(data.subarray(srcOffset, srcOffset + rowSize), dstOffset);
  }

  return flipped;
}
