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

vec4 tap(vec2 uv, vec2 direction, float radius) {
  return texture(u_input, uv + direction * radius / u_size);
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

  // A symmetric 17-tap two-ring kernel. Bilinear texture sampling fills the
  // gaps between taps; the weighted inner ring keeps text/card edges from
  // turning into a boxy bokeh pattern while staying cheap enough for 60 fps.
  vec4 color = texture(u_input, uv) * 4.0;

  const float d = 0.70710678;
  float inner = radius * 0.42;
  color += tap(uv, vec2( 1.0,  0.0), inner) * 2.0;
  color += tap(uv, vec2(-1.0,  0.0), inner) * 2.0;
  color += tap(uv, vec2( 0.0,  1.0), inner) * 2.0;
  color += tap(uv, vec2( 0.0, -1.0), inner) * 2.0;
  color += tap(uv, vec2( d,  d), inner) * 2.0;
  color += tap(uv, vec2(-d,  d), inner) * 2.0;
  color += tap(uv, vec2( d, -d), inner) * 2.0;
  color += tap(uv, vec2(-d, -d), inner) * 2.0;

  color += tap(uv, vec2( 1.0,  0.0), radius);
  color += tap(uv, vec2(-1.0,  0.0), radius);
  color += tap(uv, vec2( 0.0,  1.0), radius);
  color += tap(uv, vec2( 0.0, -1.0), radius);
  color += tap(uv, vec2( d,  d), radius);
  color += tap(uv, vec2(-d,  d), radius);
  color += tap(uv, vec2( d, -d), radius);
  color += tap(uv, vec2(-d, -d), radius);

  frag_color = color / 28.0;
}
