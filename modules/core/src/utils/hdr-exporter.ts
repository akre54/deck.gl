// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Device, Framebuffer, Texture} from '@luma.gl/core';
import {readPixelsAsync, flipPixelsVertically} from './gpu-readback';

export type HDRExporterProps = {
  /** Width of the HDR render target */
  width: number;
  /** Height of the HDR render target */
  height: number;
  /** Float format to use: 'rgba16float' (default) or 'rgba32float' */
  format?: 'rgba16float' | 'rgba32float';
};

/**
 * HDRExporter provides HDR (High Dynamic Range) framebuffer rendering
 * and pixel readback for export workflows.
 *
 * Supports both WebGPU (first-class, async) and WebGL (fallback).
 *
 * Use this class to:
 * 1. Create a float framebuffer for HDR rendering
 * 2. Read back float pixel data after rendering
 * 3. Integrate with Deck.gl's `_framebuffer` prop
 *
 * @example
 * ```typescript
 * const exporter = new HDRExporter(device, { width: 1920, height: 1080 });
 *
 * deck.setProps({
 *   _framebuffer: exporter.framebuffer,
 *   onAfterRender: async () => {
 *     const pixels = await exporter.readPixelsAsync();
 *     // Process or encode pixels
 *   }
 * });
 * ```
 */
export class HDRExporter {
  readonly device: Device;
  readonly width: number;
  readonly height: number;
  readonly format: 'rgba16float' | 'rgba32float';

  private _texture: Texture;
  private _framebuffer: Framebuffer;

  constructor(device: Device, props: HDRExporterProps) {
    this.device = device;
    this.width = props.width;
    this.height = props.height;
    this.format = props.format ?? 'rgba16float';

    // Check if the device supports float render targets
    if (!device.isTextureFormatRenderable(this.format)) {
      throw new Error(
        `HDRExporter: Device does not support rendering to ${this.format}. ` +
          'Float render targets require EXT_color_buffer_float extension (WebGL) ' +
          'or float32-filterable feature (WebGPU).'
      );
    }

    // Create HDR texture
    this._texture = device.createTexture({
      format: this.format,
      width: this.width,
      height: this.height,
      // WebGPU requires COPY_SRC for texture readback
      usage: device.type === 'webgpu'
        ? 0x01 | 0x04 | 0x10 // COPY_SRC | TEXTURE_BINDING | RENDER_ATTACHMENT
        : undefined,
      sampler: {
        minFilter: 'nearest',
        magFilter: 'nearest',
        addressModeU: 'clamp-to-edge',
        addressModeV: 'clamp-to-edge'
      }
    });

    // Create framebuffer with HDR color attachment and depth buffer
    this._framebuffer = device.createFramebuffer({
      id: 'hdr-exporter',
      colorAttachments: [this._texture],
      depthStencilAttachment: 'depth16unorm'
    });
  }

  /** The HDR framebuffer to pass to Deck's `_framebuffer` prop */
  get framebuffer(): Framebuffer {
    return this._framebuffer;
  }

  /** The HDR texture used as the color attachment */
  get texture(): Texture {
    return this._texture;
  }

  /**
   * Resize the HDR render target.
   * Call this if the output dimensions change.
   */
  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) {
      return;
    }

    // @ts-expect-error - Modifying readonly
    this.width = width;
    // @ts-expect-error - Modifying readonly
    this.height = height;

    // Resize framebuffer (which resizes attachments)
    this._framebuffer.resize({width, height});
  }

  /**
   * Read pixels from the HDR framebuffer asynchronously.
   * Returns linear float RGBA values (not gamma-encoded).
   *
   * This is the preferred method - works on both WebGPU and WebGL.
   * - WebGPU: True async readback using copyTextureToBuffer + mapAsync
   * - WebGL: Sync readback wrapped in Promise
   *
   * @returns Promise<Float32Array> of RGBA pixel data, row-major from bottom-left
   */
  async readPixelsAsync(): Promise<Float32Array> {
    const result = await readPixelsAsync(this.device, this._framebuffer);
    return result.data as Float32Array;
  }

  /**
   * Read pixels and flip Y-axis asynchronously.
   * GPU textures have origin at bottom-left, most image formats expect top-left.
   *
   * @returns Promise<Float32Array> of RGBA pixel data, row-major from top-left
   */
  async readPixelsFlippedAsync(): Promise<Float32Array> {
    const pixels = await this.readPixelsAsync();
    return flipPixelsVertically(pixels, this.width, this.height, 4);
  }

  /**
   * Synchronous pixel readback (WebGL only, deprecated).
   *
   * @deprecated Use readPixelsAsync() instead for cross-platform support.
   * This method only works on WebGL and will throw on WebGPU.
   *
   * @returns Float32Array of RGBA pixel data, row-major from bottom-left
   */
  readPixels(): Float32Array {
    if (this.device.type === 'webgpu') {
      throw new Error(
        'HDRExporter.readPixels(): Synchronous readback is not supported on WebGPU. ' +
          'Use readPixelsAsync() instead.'
      );
    }

    const pixelBuffer = new Float32Array(this.width * this.height * 4);
    this.device.readPixelsToArrayWebGL(this._framebuffer, {
      sourceX: 0,
      sourceY: 0,
      sourceWidth: this.width,
      sourceHeight: this.height,
      target: pixelBuffer
    });

    return pixelBuffer;
  }

  /**
   * Synchronous pixel readback with Y-flip (WebGL only, deprecated).
   *
   * @deprecated Use readPixelsFlippedAsync() instead for cross-platform support.
   */
  readPixelsFlipped(): Float32Array {
    const pixels = this.readPixels();
    return flipPixelsVertically(pixels, this.width, this.height, 4);
  }

  /**
   * Clean up GPU resources.
   * Call this when the exporter is no longer needed.
   */
  destroy(): void {
    this._framebuffer.destroy();
    this._texture.destroy();
  }
}
