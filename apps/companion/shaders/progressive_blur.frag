#version 460 core

// Single-pass progressive backdrop blur for Impeller. The radius follows a
// C2-continuous curve to exactly zero at the bottom edge, so the filtered and
// untouched scenes meet on identical pixels. No alpha-mask edge or readback.

#include <flutter/runtime_effect.glsl>

uniform vec2 u_size;      // engine-set input texture size
uniform float u_radius;   // outer sample radius in logical pixels
uniform float u_solid;    // fraction of height at full blur
uniform sampler2D u_input;

out vec4 frag_color;

float smoother(float t) {
  float x = clamp(t, 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

float binomial_weight(int index) {
  if (index == 0 || index == 6) {
    return 1.0;
  }
  if (index == 1 || index == 5) {
    return 6.0;
  }
  if (index == 2 || index == 4) {
    return 15.0;
  }
  return 20.0;
}

void main() {
  vec2 xy = FlutterFragCoord().xy;
  vec2 uv = xy / u_size;
  float y = uv.y;
#ifdef IMPELLER_TARGET_OPENGLES
  uv.y = 1.0 - uv.y;
#endif

  float fade = 1.0 - smoother((y - u_solid) / max(1.0 - u_solid, 1e-4));
  float radius = u_radius * fade;

  // Dense 7x7 separable-binomial weights evaluated in one pass. The former
  // sparse rings were cheap but rendered high-contrast text as discrete
  // ghosts. These 49 regularly spaced taps approximate a true Gaussian while
  // remaining confined to the small header strip.
  vec4 color = vec4(0.0);
  float step_size = radius / 3.0;
  for (int iy = 0; iy < 7; iy++) {
    for (int ix = 0; ix < 7; ix++) {
      vec2 offset = vec2(float(ix - 3), float(iy - 3)) * step_size;
      float weight = binomial_weight(ix) * binomial_weight(iy);
      color += texture(u_input, uv + offset / u_size) * weight;
    }
  }

  frag_color = color / 4096.0;
}
