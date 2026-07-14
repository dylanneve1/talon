#version 460 core

// Continuous mask for a full-pane progressive backdrop frost (Impeller).
// Dart composes one native Gaussian blur inside this shader. We only fade the
// blurred image's premultiplied alpha, so BackdropFilter's srcOver blend
// continuously mixes it with the untouched backdrop already on screen.
// There are no snapshots, blur bands, per-pixel convolution loops, or clipped
// blur boundary.
//
// Engine contract (ImageFilter.shader docs): first uniform is a vec2 the
// engine sets to the input texture size; the first sampler2D is bound to
// the filter input.

#include <flutter/runtime_effect.glsl>

uniform vec2 u_size;    // engine-set: input texture size in pixels
uniform float u_solid;  // fraction of pane height fully frosted
uniform float u_end;    // fraction of pane height where frost is transparent
uniform sampler2D u_input;

out vec4 frag_color;

// C2-continuous smootherstep: zero slope at both ends, so the dissolve has
// no perceptible start or stop (no Mach band).
float easeS(float t) {
  float x = clamp(t, 0.0, 1.0);
  return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
}

void main() {
  vec2 xy = FlutterFragCoord().xy;
  vec2 uv = xy / u_size;
  // Position is in Flutter-local coordinates; only the engine-provided input
  // texture is flipped on the OpenGLES Impeller backend.
  float y = uv.y;
#ifdef IMPELLER_TARGET_OPENGLES
  uv.y = 1.0 - uv.y;
#endif

  float t = (y - u_solid) / max(u_end - u_solid, 1e-4);
  float opacity = 1.0 - easeS(t);
  // Image-filter output must be premultiplied. Multiplying all four channels
  // lets srcOver reveal the original backdrop as opacity approaches zero.
  frag_color = texture(u_input, uv) * opacity;
}
