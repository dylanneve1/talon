import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/ui/glass.dart';

void main() {
  testWidgets('glass bar is a solid translucent surface with a hairline edge',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: GlassBar(
            padding: EdgeInsets.all(8),
            child: Text('Title'),
          ),
        ),
      ),
    );

    // No live backdrop blur: the bar is an opaque-enough tinted fill, so it
    // costs nothing to composite and cannot band or shimmer.
    expect(find.byType(BackdropFilter), findsNothing);

    // The bar owns a tinted fill and a bottom hairline so the surface ends
    // honestly.
    final container = tester.widget<Container>(
      find.ancestor(of: find.text('Title'), matching: find.byType(Container)),
    );
    final decoration = container.decoration! as BoxDecoration;
    expect(decoration.color, isNotNull);
    expect(decoration.border!.bottom.width, greaterThan(0));
  });

  testWidgets('pushed-route scaffold puts the bar above the body',
      (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: GlassBarScreen(
          title: 'Settings',
          body: SizedBox.expand(),
        ),
      ),
    );
    expect(find.text('Settings'), findsOneWidget);
    expect(find.byType(GlassBar), findsOneWidget);
  });
}
