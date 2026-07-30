import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/ui/empty_state.dart';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('renders title only when that is all it is given',
      (tester) async {
    await tester.pumpWidget(_host(const TalonEmptyState(title: 'No chats')));
    expect(find.text('No chats'), findsOneWidget);
    expect(find.byType(Icon), findsNothing);
    expect(find.byType(OutlinedButton), findsNothing);
  });

  testWidgets('renders icon, message and action when supplied', (tester) async {
    var tapped = 0;
    await tester.pumpWidget(_host(TalonEmptyState(
      icon: Icons.filter_alt_off_outlined,
      title: 'No matching log lines',
      message: 'Nothing matches this filter.',
      action: OutlinedButton(
        onPressed: () => tapped++,
        child: const Text('Clear filters'),
      ),
    )));

    expect(find.byIcon(Icons.filter_alt_off_outlined), findsOneWidget);
    expect(find.text('Nothing matches this filter.'), findsOneWidget);
    await tester.tap(find.text('Clear filters'));
    expect(tapped, 1);
  });

  testWidgets('announces as a single node with title and message',
      (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_host(const TalonEmptyState(
      icon: Icons.search_off_outlined,
      title: 'No matches',
      message: 'Try a shorter query.',
    )));

    // One combined label, not three loose fragments — and the decorative icon
    // contributes nothing.
    expect(
      find.bySemanticsLabel('No matches. Try a shorter query.'),
      findsOneWidget,
    );
    expect(find.bySemanticsLabel('No matches'), findsNothing);
    handle.dispose();
  });

  testWidgets('compact variant tightens its padding', (tester) async {
    await tester.pumpWidget(_host(const TalonEmptyState(
      title: 'Nothing here',
      compact: true,
    )));
    final compact = tester.widget<Padding>(
      find.descendant(of: find.byType(Center), matching: find.byType(Padding)),
    );

    await tester.pumpWidget(_host(const TalonEmptyState(title: 'Nothing here')));
    final full = tester.widget<Padding>(
      find.descendant(of: find.byType(Center), matching: find.byType(Padding)),
    );

    expect(
      (compact.padding as EdgeInsets).top,
      lessThan((full.padding as EdgeInsets).top),
    );
  });
}
