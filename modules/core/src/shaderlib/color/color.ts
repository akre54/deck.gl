// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import {ShaderModule} from '@luma.gl/shadertools';
import {LayerProps} from '../../types/layer-props';

const colorWGSL = /* WGSL */ `

struct ColorUniforms {
  opacity: f32,
};

var<private> color: ColorUniforms = ColorUniforms(1.0);
// TODO (kaapp) avoiding binding index collisions to handle layer opacity
// requires some thought.
// @group(0) @binding(0) var<uniform> color: ColorUniforms;

@must_use
fn deckgl_premultiplied_alpha(fragColor: vec4<f32>) -> vec4<f32> {
    return vec4(fragColor.rgb * fragColor.a, fragColor.a);
};

// sRGB to linear color space conversion (WGSL)
@must_use
fn sRGBToLinear(srgb: vec3<f32>) -> vec3<f32> {
    let cutoff = step(vec3<f32>(0.04045), srgb);
    let low = srgb / 12.92;
    let high = pow((srgb + 0.055) / 1.055, vec3<f32>(2.4));
    return mix(low, high, cutoff);
}

@must_use
fn sRGBToLinear4(srgba: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(sRGBToLinear(srgba.rgb), srgba.a);
}

// Linear to sRGB color space conversion (WGSL)
@must_use
fn linearToSRGB(linear: vec3<f32>) -> vec3<f32> {
    let cutoff = step(vec3<f32>(0.0031308), linear);
    let low = linear * 12.92;
    let high = 1.055 * pow(linear, vec3<f32>(1.0 / 2.4)) - 0.055;
    return mix(low, high, cutoff);
}

@must_use
fn linearToSRGB4(linear: vec4<f32>) -> vec4<f32> {
    return vec4<f32>(linearToSRGB(linear.rgb), linear.a);
}
`;

// GLSL shader code for linear color space conversion
const colorGLSL = /* glsl */ `
// sRGB to linear color space conversion
// Uses the official sRGB transfer function (IEC 61966-2-1)
vec3 sRGBToLinear(vec3 srgb) {
  return mix(
    srgb / 12.92,
    pow((srgb + 0.055) / 1.055, vec3(2.4)),
    step(0.04045, srgb)
  );
}

vec4 sRGBToLinear(vec4 srgba) {
  return vec4(sRGBToLinear(srgba.rgb), srgba.a);
}

// Linear to sRGB color space conversion
vec3 linearToSRGB(vec3 linear) {
  return mix(
    linear * 12.92,
    1.055 * pow(linear, vec3(1.0 / 2.4)) - 0.055,
    step(0.0031308, linear)
  );
}

vec4 linearToSRGB(vec4 linear) {
  return vec4(linearToSRGB(linear.rgb), linear.a);
}
`;

export type ColorProps = {
  /**
   * Opacity of the layer, between 0 and 1. Default 1.
   */
  opacity?: number;
};

export type ColorUniforms = {
  opacity?: number;
};

export default {
  name: 'color',
  dependencies: [],
  source: colorWGSL,
  vs: colorGLSL,
  fs: colorGLSL,
  getUniforms: (_props: Partial<ColorProps>) => {
    // TODO (kaapp) Handle layer opacity
    // apply gamma to opacity to make it visually "linear"
    // TODO - v10: use raw opacity?
    // opacity: Math.pow(props.opacity!, 1 / 2.2)
    return {};
  },
  uniformTypes: {
    opacity: 'f32'
  }
  // @ts-ignore TODO v9.1
} as const satisfies ShaderModule<LayerProps, ColorUniforms, {}>;

// Re-export GLSL code for direct use
export {colorGLSL};
