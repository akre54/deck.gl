// deck.gl
// SPDX-License-Identifier: MIT
// Copyright (c) vis.gl contributors

import type {ShaderModule} from '@luma.gl/shadertools';
import type {LayerProps} from '../../types/layer-props';

const uniformBlockGLSL = `\
uniform layerUniforms {
  uniform float opacity;
  uniform bool linearColorSpace;
} layer;
`;

const uniformBlockWGSL = /* wgsl */ `\
struct LayerUniforms {
  opacity: f32,
  linearColorSpace: i32,
};

@group(0) @binding(1)
var<uniform> layer: LayerUniforms;
`;

export type LayerUniforms = {
  opacity?: number;
  linearColorSpace?: boolean;
};

/**
 * Extended layer props with linear color space support.
 * When linearColorSpace is true, opacity is not gamma-corrected
 * and colors should be in linear space for proper HDR rendering.
 */
export type LinearColorProps = LayerProps & {
  /** Enable linear color space rendering (for HDR export) */
  _linearColorSpace?: boolean;
};

export const layerUniforms = {
  name: 'layer',
  vs: uniformBlockGLSL,
  fs: uniformBlockGLSL,
  source: uniformBlockWGSL,
  getUniforms: (props: Partial<LinearColorProps>) => {
    const linearColorSpace = props._linearColorSpace ?? false;
    return {
      // In linear color space mode, use raw opacity
      // In sRGB mode (default), apply gamma to make it visually "linear"
      // TODO - v10: use raw opacity by default?
      opacity: linearColorSpace ? props.opacity! : Math.pow(props.opacity!, 1 / 2.2),
      linearColorSpace
    };
  },
  uniformTypes: {
    opacity: 'f32',
    linearColorSpace: 'i32'
  }
} as const satisfies ShaderModule<LinearColorProps, LayerUniforms>;
