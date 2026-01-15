// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {Framebuffer} from '@luma.gl/core';
import type Deck from '../lib/deck';
import type {DeckProps} from '../lib/deck';
import {HDRExporter} from './hdr-exporter';
import {writeEXR, type WriteEXROptions} from './exr-writer';
import {flipPixelsVertically} from './gpu-readback';

export type HDRRenderLoopProps = {
  /** Deck instance to render */
  deck: Deck;
  /** HDR exporter instance */
  exporter: HDRExporter;
  /** EXR encoding options */
  exrOptions?: WriteEXROptions;
  /** Callback when frame rendering starts */
  onFrameStart?: (frame: number) => void;
  /** Callback when frame rendering completes */
  onFrameComplete?: (frame: number, pixels: Float32Array) => void;
  /** Callback to update scene for a given frame (e.g., update animation time) */
  onUpdateFrame?: (frame: number, deck: Deck) => void | Promise<void>;
};

export type RenderSequenceOptions = {
  /** Starting frame number. Default: 0 */
  startFrame?: number;
  /** Ending frame number (inclusive). Required. */
  endFrame: number;
  /** Frames per second (for time-based animations). Default: 30 */
  fps?: number;
};

/**
 * HDRRenderLoop manages frame-by-frame HDR rendering for export workflows.
 *
 * Supports both WebGPU (first-class) and WebGL backends.
 *
 * Similar to Noodles.gl's render loop pattern, this class:
 * 1. Moves the playhead (via onUpdateFrame callback)
 * 2. Renders the scene to an HDR framebuffer
 * 3. Outputs the buffer as EXR data
 *
 * @example
 * ```typescript
 * const exporter = new HDRExporter(device, { width: 1920, height: 1080 });
 * const renderLoop = new HDRRenderLoop({
 *   deck,
 *   exporter,
 *   onUpdateFrame: (frame, deck) => {
 *     // Update animation state
 *     deck.setProps({ viewState: getViewStateForFrame(frame) });
 *   }
 * });
 *
 * // Render all frames
 * for await (const { frame, exrBuffer } of renderLoop.renderSequence({ endFrame: 300 })) {
 *   await fs.writeFile(`frame_${frame.toString().padStart(4, '0')}.exr`, Buffer.from(exrBuffer));
 * }
 * ```
 */
export class HDRRenderLoop {
  readonly deck: Deck;
  readonly exporter: HDRExporter;
  readonly exrOptions: WriteEXROptions;

  private _onFrameStart?: (frame: number) => void;
  private _onFrameComplete?: (frame: number, pixels: Float32Array) => void;
  private _onUpdateFrame?: (frame: number, deck: Deck) => void | Promise<void>;
  private _originalFramebuffer: Framebuffer | null | undefined = null;
  private _isRendering = false;

  constructor(props: HDRRenderLoopProps) {
    this.deck = props.deck;
    this.exporter = props.exporter;
    this.exrOptions = props.exrOptions ?? {};
    this._onFrameStart = props.onFrameStart;
    this._onFrameComplete = props.onFrameComplete;
    this._onUpdateFrame = props.onUpdateFrame;
  }

  /**
   * Render a single frame and return EXR data.
   *
   * @param frame Frame number
   * @returns Promise resolving to EXR buffer
   */
  async renderFrame(frame: number): Promise<ArrayBuffer> {
    this._onFrameStart?.(frame);

    // Update scene for this frame
    if (this._onUpdateFrame) {
      await this._onUpdateFrame(frame, this.deck);
    }

    // Render to HDR framebuffer and read pixels (async for WebGPU support)
    const pixels = await this._renderToHDR();

    this._onFrameComplete?.(frame, pixels);

    // Encode to EXR (flipped for correct orientation)
    const flippedPixels = flipPixelsVertically(pixels, this.exporter.width, this.exporter.height, 4);
    const exrBuffer = writeEXR(
      flippedPixels,
      this.exporter.width,
      this.exporter.height,
      this.exrOptions
    );

    return exrBuffer;
  }

  /**
   * Render a sequence of frames.
   * Returns an async generator yielding frame data.
   *
   * @param options Sequence options
   */
  async *renderSequence(
    options: RenderSequenceOptions
  ): AsyncGenerator<{frame: number; exrBuffer: ArrayBuffer; pixels: Float32Array}> {
    const startFrame = options.startFrame ?? 0;
    const endFrame = options.endFrame;

    if (this._isRendering) {
      throw new Error('HDRRenderLoop: A render sequence is already in progress');
    }

    this._isRendering = true;

    try {
      // Save original framebuffer state
      this._beginExport();

      for (let frame = startFrame; frame <= endFrame; frame++) {
        this._onFrameStart?.(frame);

        // Update scene for this frame
        if (this._onUpdateFrame) {
          await this._onUpdateFrame(frame, this.deck);
        }

        // Render to HDR framebuffer and read pixels (async for WebGPU support)
        const pixels = await this._renderToHDR();

        this._onFrameComplete?.(frame, pixels);

        // Encode to EXR (flipped for correct orientation)
        const flippedPixels = flipPixelsVertically(pixels, this.exporter.width, this.exporter.height, 4);
        const exrBuffer = writeEXR(
          flippedPixels,
          this.exporter.width,
          this.exporter.height,
          this.exrOptions
        );

        yield {frame, exrBuffer, pixels: flippedPixels};
      }
    } finally {
      // Restore original framebuffer state
      this._endExport();
      this._isRendering = false;
    }
  }

  /**
   * Get raw pixel data for current frame without EXR encoding.
   */
  async capturePixels(): Promise<Float32Array> {
    const pixels = await this._renderToHDR();
    return flipPixelsVertically(pixels, this.exporter.width, this.exporter.height, 4);
  }

  /**
   * Configure Deck for HDR export.
   */
  private _beginExport(): void {
    // Store current _framebuffer value (if any)
    this._originalFramebuffer = this.deck.props._framebuffer;

    // Set HDR framebuffer
    this.deck.setProps({
      _framebuffer: this.exporter.framebuffer
    } as Partial<DeckProps>);
  }

  /**
   * Restore Deck to normal rendering.
   */
  private _endExport(): void {
    this.deck.setProps({
      _framebuffer: this._originalFramebuffer
    } as Partial<DeckProps>);
    this._originalFramebuffer = null;
  }

  /**
   * Render a frame to the HDR framebuffer and read pixels asynchronously.
   * Works on both WebGPU and WebGL.
   */
  private async _renderToHDR(): Promise<Float32Array> {
    return new Promise<Float32Array>((resolve, reject) => {
      // Store current callback
      const originalOnAfterRender = this.deck.props.onAfterRender;

      // Set up one-time callback
      this.deck.setProps({
        _framebuffer: this.exporter.framebuffer,
        onAfterRender: async () => {
          try {
            // Read pixels asynchronously (works on both WebGPU and WebGL)
            const pixels = await this.exporter.readPixelsAsync();

            // Restore original callback
            this.deck.setProps({
              onAfterRender: originalOnAfterRender
            } as Partial<DeckProps>);

            resolve(pixels);
          } catch (error) {
            reject(error);
          }
        }
      } as Partial<DeckProps>);

      // Force a redraw
      this.deck.redraw('HDR export');
    });
  }
}
