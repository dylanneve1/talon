import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:progressive_blur/progressive_blur.dart';
import 'package:talon_companion/src/ui/glass.dart';

void main() {
  Widget host(TopEdgeFrost frost) => MaterialApp(
        home: Center(
          child: SizedBox(width: 240, height: 180, child: frost),
        ),
      );

  testWidgets('frost is one variable-radius blur driven by a strength ramp',
      (tester) async {
    await tester.pumpWidget(
      host(
        const TopEdgeFrost(
          extent: 100,
          solidUntil: 40,
          child: ColoredBox(color: Colors.red),
        ),
      ),
    );

    // Regression guards for approaches that render wrong: an outer
    // ShaderMask silently kills a backdrop blur (the mask's saveLayer
    // becomes the filter's empty backdrop), and stepped backdrop bands
    // seam. The frost must be a single progressive blur of the scrollback.
    expect(find.byType(ShaderMask), findsNothing);
    expect(find.byType(BackdropFilter), findsNothing);

    final blur = tester.widget<ProgressiveBlurWidget>(
      find.byType(ProgressiveBlurWidget),
    );
    expect(blur.sigma, TopEdgeFrost.sigma);

    // Full strength from the top through solidUntil, melting to zero at
    // extent — as fractions of the 180-high child.
    final ramp = blur.linearGradientBlur!;
    expect(ramp.values, [1, 1, 0]);
    expect(ramp.stops[0], 0);
    expect(ramp.stops[1], moreOrLessEquals(40 / 180));
    expect(ramp.stops[2], moreOrLessEquals(100 / 180));
    expect(ramp.start, Alignment.topCenter);
    expect(ramp.end, Alignment.bottomCenter);
  });

  testWidgets('zero extent renders the child without a blur surface',
      (tester) async {
    await tester.pumpWidget(
      host(
        const TopEdgeFrost(
          extent: 0,
          solidUntil: 0,
          child: ColoredBox(color: Colors.red),
        ),
      ),
    );
    expect(find.byType(ProgressiveBlurWidget), findsNothing);
    expect(
      find.byWidgetPredicate(
        (w) => w is ColoredBox && w.color == Colors.red,
      ),
      findsOneWidget,
    );
  });

  testWidgets('degenerate geometry clamps instead of throwing',
      (tester) async {
    await tester.pumpWidget(
      host(
        const TopEdgeFrost(
          // solidUntil beyond extent, extent beyond the child.
          extent: 500,
          solidUntil: 900,
          child: ColoredBox(color: Colors.red),
        ),
      ),
    );
    final blur = tester.widget<ProgressiveBlurWidget>(
      find.byType(ProgressiveBlurWidget),
    );
    final ramp = blur.linearGradientBlur!;
    expect(ramp.stops[1], moreOrLessEquals(1));
    expect(ramp.stops[2], moreOrLessEquals(1));
  });
}
