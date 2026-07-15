import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/ui/glass.dart';

void main() {
  testWidgets('glass bar is one uniform native blur with a hairline edge',
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

    // Exactly one backdrop blur — the bar's whole budget. A ShaderMask
    // around it would silently kill the blur (the mask's saveLayer becomes
    // the filter's empty backdrop), and stacked filters were the source of
    // the banding this design replaced.
    final filters = find.byType(BackdropFilter);
    expect(filters, findsOneWidget);
    expect(
      tester.element(filters).findAncestorWidgetOfExactType<ShaderMask>(),
      isNull,
    );

    // The bar owns a bottom hairline so the surface ends honestly.
    final container = tester.widget<Container>(
      find.ancestor(of: find.text('Title'), matching: find.byType(Container)),
    );
    final decoration = container.decoration! as BoxDecoration;
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
