#version 460 core

// Progressive frost for the chat header, used as a backdrop ImageFilter
// (ui.ImageFilter.shader, Impeller only). The blur radius is a continuous
// per-pixel function of height: full strength through the control zone,
// then one smoothstep ease to exactly zero at the bottom edge — so the
// frost dissolves with no bands, steps, or terminating line anywhere.
//
// Engine contract (see ImageFilter.shader docs): the first uniform must be
// a vec2 that the engine sets to the input texture size, and the first
// sampler2D is bound to the filter input (the backdrop region).

#include <flutter/runtime_effect.glsl>

uniform vec2 u_size;   // set by the engine: input texture size in pixels
uniform float u_radius; // max blur radius in texture pixels
uniform float u_solid;  // fraction of height that stays fully frosted
uniform sampler2D u_input;

out vec4 frag_color;

const float TAU = 6.28318530718;
// Golden-angle spiral: TAPS samples distributed uniformly over a disk.
const float GOLDEN = 2.39996322973;
const int TAPS = 36;

void main() {
  vec2 xy = FlutterFragCoord().xy;
  vec2 uv = xy / u_size;
#ifdef IMPELLER_TARGET_OPENGLES
  uv.y = 1.0 - uv.y;
#endif

  // C1-continuous strength ramp: 1 in the solid zone, easing to 0 at the
  // bottom edge, where the shader returns the backdrop untouched and hands
  // off seamlessly to the unfiltered canvas below.
  float k = 1.0 - smoothstep(u_solid, 1.0, uv.y);
  float radius = u_radius * k;

  if (radius < 0.5) {
    frag_color = texture(u_input, uv);
    return;
  }

  // Interleaved gradient noise rotates the spiral per pixel, trading any
  // residual ring/band structure for imperceptible high-frequency noise.
  float ign =
      fract(52.9829189 * fract(dot(xy, vec2(0.06711056, 0.00583715))));
  float a0 = ign * TAU;

  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < TAPS; i++) {
    float t = (float(i) + 0.5) / float(TAPS);
    float r = radius * sqrt(t);
    float a = a0 + float(i) * GOLDEN;
    vec2 offset = vec2(cos(a), sin(a)) * r;
    vec2 suv = clamp(uv + offset / u_size, vec2(0.0), vec2(1.0));
    // Gaussian-ish falloff over the disk so the result reads as frost
    // rather than flat bokeh.
    float w = exp(-2.0 * t);
    acc += texture(u_input, suv) * w;
    wsum += w;
  }
  frag_color = acc / wsum;
}
