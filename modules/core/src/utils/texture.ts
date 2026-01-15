// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {Device, Texture, SamplerProps, TextureFormat} from '@luma.gl/core';

const DEFAULT_TEXTURE_PARAMETERS: SamplerProps = {
  minFilter: 'linear',
  mipmapFilter: 'linear',
  magFilter: 'linear',
  addressModeU: 'clamp-to-edge',
  addressModeV: 'clamp-to-edge'
};

// Track the textures that are created by us. They need to be released when they are no longer used.
const internalTextures: Record<string, string> = {};

export type CreateTextureOptions = {
  /**
   * Use sRGB texture format for automatic linearization on sample.
   * When true, uses 'rgba8unorm-srgb' format instead of 'rgba8unorm'.
   * This is recommended for color textures in linear color space workflows.
   * Default: false (uses 'rgba8unorm')
   */
  srgb?: boolean;
};

/**
 *
 * @param owner
 * @param device
 * @param image could be one of:
 *   - Texture
 *   - Browser object: Image, ImageData, ImageData, HTMLCanvasElement, HTMLVideoElement, ImageBitmap
 *   - Plain object: {width: <number>, height: <number>, data: <Uint8Array>}
 * @param sampler
 * @param options Additional texture options
 * @returns
 */
export function createTexture(
  owner: string,
  device: Device,
  image: any,
  sampler: SamplerProps,
  options?: CreateTextureOptions
): Texture | null {
  if (image instanceof Texture) {
    return image;
  } else if (image.constructor && image.constructor.name !== 'Object') {
    // Browser object
    image = {data: image};
  }

  let samplerParameters: SamplerProps | null = null;
  if (image.compressed) {
    samplerParameters = {
      minFilter: 'linear',
      mipmapFilter: image.data.length > 1 ? 'nearest' : 'linear'
    };
  }

  // Determine format: use sRGB format if requested for automatic linearization
  let format: TextureFormat | undefined = image.format;
  if (options?.srgb && !format) {
    // Use sRGB format for automatic gamma-to-linear conversion on sample
    // This is the standard approach for color textures in linear rendering pipelines
    format = 'rgba8unorm-srgb';
  }

  const {width, height} = image.data;
  const texture = device.createTexture({
    ...image,
    ...(format && {format}),
    sampler: {
      ...DEFAULT_TEXTURE_PARAMETERS,
      ...samplerParameters,
      ...sampler
    },
    mipLevels: device.getMipLevelCount(width, height)
  });
  texture.generateMipmapsWebGL();

  // Track this texture
  internalTextures[texture.id] = owner;
  return texture;
}

export function destroyTexture(owner: string, texture: Texture) {
  if (!texture || !(texture instanceof Texture)) {
    return;
  }
  // Only delete the texture if requested by the same layer that created it
  if (internalTextures[texture.id] === owner) {
    texture.delete();
    delete internalTextures[texture.id];
  }
}
