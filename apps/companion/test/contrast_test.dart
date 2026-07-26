// Pins WCAG 2.1 contrast for the palette's text tokens against every surface
// they are actually painted on.
//
// Why this exists: `textFaint` shipped at 2.55–2.98:1 on the light palette and
// 3.61–4.35:1 on the dark one, while carrying real body copy — composer and
// search hints, empty-state prose, connect-screen help text, model/extension
// descriptions at 11–12.5px. That is below even the 3:1 large-text floor, and
// nothing in the suite would have caught a regression back to it. Tokens are a
// single point of leverage for the whole app, so guard them at the token.
//
// Threshold is 4.5:1 (AA, normal text) because these tokens are used at small
// sizes; the large-text exemption does not apply to them.

import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/theme.dart';

/// Relative luminance per WCAG 2.1 §relative-luminance.
double _luminance(Color c) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

/// Contrast ratio per WCAG 2.1 §contrast-ratio. Both colors must be opaque.
double _contrast(Color fg, Color bg) {
  final a = _luminance(fg);
  final b = _luminance(bg);
  final lighter = math.max(a, b);
  final darker = math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

void main() {
  const aaNormal = 4.5;

  for (final entry in <String, TalonPalette>{
    'dark': kTalonDark,
    'light': kTalonLight,
  }.entries) {
    final name = entry.key;
    final p = entry.value;

    final surfaces = <String, Color>{
      'void0': p.void0,
      'void1': p.void1,
      'surface': p.surface,
      'surfaceHi': p.surfaceHi,
    };
    final foregrounds = <String, Color>{
      'text': p.text,
      'textDim': p.textDim,
      'textFaint': p.textFaint,
    };

    for (final fg in foregrounds.entries) {
      for (final bg in surfaces.entries) {
        test('$name: ${fg.key} on ${bg.key} meets AA normal text', () {
          final ratio = _contrast(fg.value, bg.value);
          expect(
            ratio,
            greaterThanOrEqualTo(aaNormal),
            reason: '$name ${fg.key} on ${bg.key} is '
                '${ratio.toStringAsFixed(2)}:1, below $aaNormal:1',
          );
        });
      }
    }

    test('$name: the three text tokens stay a visible hierarchy', () {
      // Guards the fix from being "solved" by collapsing textFaint into
      // textDim: each step down must still be a distinguishable step.
      double onSurface(Color c) => _contrast(c, p.surface);
      expect(onSurface(p.text), greaterThan(onSurface(p.textDim)));
      expect(onSurface(p.textDim), greaterThan(onSurface(p.textFaint)));
      expect(
        onSurface(p.textDim) - onSurface(p.textFaint),
        greaterThan(0.5),
        reason: 'textDim and textFaint are too close to read as a hierarchy',
      );
    });
  }
}
