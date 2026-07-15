import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/ui/glass.dart';

void main() {
  testWidgets('frost mask wraps the composited backdrop filter',
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

    expect(find.byType(ShaderMask), findsOneWidget);
    expect(find.byType(BackdropFilter), findsOneWidget);

    // This relationship is the Android regression guard. An inner dstIn
    // painter only masks BackdropFilter's child; the filtered backdrop keeps
    // its rectangular edge. The mask must own the complete filtered layer.
    final backdrop = tester.element(find.byType(BackdropFilter));
    expect(
      backdrop.findAncestorWidgetOfExactType<ShaderMask>(),
      isNotNull,
    );
  });
}
