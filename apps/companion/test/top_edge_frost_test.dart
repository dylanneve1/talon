import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/ui/glass.dart';

/// Effective blur of a compounded Gaussian stack: sqrt of the summed
/// sigma squares of every layer covering a depth.
double _effectiveSigma(Iterable<FrostBand> covering) => math.sqrt(
      covering.fold<double>(0, (sum, b) => sum + b.sigma * b.sigma),
    );

void main() {
  group('planFrostBands', () {
    test('cumulative layers compound to maxSigma behind the controls', () {
      final bands = planFrostBands(extent: 148, solidUntil: 56);
      expect(bands, isNotEmpty);

      // Every layer clips from the top edge; heights strictly shrink so each
      // paints over (and re-blurs) the one beneath. Equal heights would mean
      // a wasted layer; growth would invert the compounding.
      expect(bands.first.height, 148);
      for (var i = 1; i < bands.length; i++) {
        expect(bands[i].height, lessThan(bands[i - 1].height));
      }
      expect(bands.last.height, 56);

      // The solid zone is covered by every layer and must land exactly on
      // the design sigma.
      expect(
        _effectiveSigma(bands),
        moreOrLessEquals(TopEdgeFrost.sigma, epsilon: 0.001),
      );

      // The lowest seam is the only one over sharp content, so its step —
      // the bottom layer's own sigma — must stay gentle.
      expect(bands.first.sigma, lessThan(TopEdgeFrost.sigma / 4));

      // Effective blur grows monotonically with depth toward the top.
      var prev = 0.0;
      for (var i = 0; i < bands.length; i++) {
        final eff = _effectiveSigma(bands.take(i + 1));
        expect(eff, greaterThan(prev));
        prev = eff;
      }
    });

    test('degenerate inputs produce no bands instead of throwing', () {
      expect(planFrostBands(extent: 0, solidUntil: 40), isEmpty);
      expect(planFrostBands(extent: -10, solidUntil: 0), isEmpty);
      expect(planFrostBands(extent: double.infinity, solidUntil: 0), isEmpty);
    });

    test('solidUntil beyond extent yields a single full-strength band', () {
      final bands = planFrostBands(extent: 80, solidUntil: 200);
      expect(bands, hasLength(1));
      expect(bands.single.height, 80);
      expect(bands.single.sigma, TopEdgeFrost.sigma);
    });
  });

  testWidgets('frost renders stacked backdrop layers, never a ShaderMask',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: SizedBox(
          width: 240,
          height: 180,
          child: TopEdgeFrost(
            extent: 100,
            solidUntil: 40,
            child: ColoredBox(color: Colors.red),
          ),
        ),
      ),
    );

    // Regression guard: a ShaderMask around a BackdropFilter silently kills
    // the blur — the mask's saveLayer becomes the filter's (empty) backdrop.
    expect(find.byType(ShaderMask), findsNothing);

    // The progressive frost is a cumulative stack of clipped blur layers.
    final plan = planFrostBands(extent: 100, solidUntil: 40);
    expect(find.byType(BackdropFilter), findsNWidgets(plan.length));
  });
}
