import 'package:flutter/foundation.dart'
    show debugDefaultTargetPlatformOverride;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/markdown.dart';
import 'package:talon_companion/src/ui/sidebar.dart';

/// Sidebar search + swipe actions: the search box filters chat titles
/// locally, surfaces a full-text MESSAGES section for daemon hits, and chat
/// tiles support swipe-to-delete (with confirm) on touch platforms.
void main() {
  Future<AppState> seededState() async {
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: true);
    state.debugSeed(
      chats: [
        ClientChat(
          id: 'c1',
          title: 'General',
          createdAt: 1,
          lastActive: 2,
          preview: 'hi there',
        ),
        ClientChat(
          id: 'c2',
          title: 'Trip planning',
          createdAt: 1,
          lastActive: 2,
          preview: 'Kerry on Saturday',
        ),
      ],
      messages: const {},
      connState: ConnState.connected,
      bridgeStatus: BridgeStatus.fromJson(const {
        'protocol': 1,
        'botName': 'Talon',
        'backend': 'claude',
        'model': 'opus',
        'activeChats': 2,
        'startedAt': '',
      }),
    );
    return state;
  }

  Widget host(AppState state) => MediaQuery(
        data: const MediaQueryData(disableAnimations: true),
        child: MaterialApp(
          theme: buildTalonTheme(),
          home: Scaffold(
            body: Sidebar(state: state, onSelect: (_) {}),
          ),
        ),
      );

  testWidgets('search filters chat titles locally', (tester) async {
    final state = await seededState();
    addTearDown(state.dispose);
    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    expect(find.text('General'), findsOneWidget);
    expect(find.text('Trip planning'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'trip');
    await tester.pumpAndSettle();

    expect(find.text('General'), findsNothing);
    expect(find.text('Trip planning'), findsOneWidget);

    // Flush AppState's debounced snapshot timer before teardown.
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('chat previews render inline Markdown without delimiters',
      (tester) async {
    final state = await seededState();
    addTearDown(state.dispose);
    state.chats.first.preview =
        '**July 15** with _details_, `code`, and [a link](https://talon.test)';

    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    final preview = find.byKey(const ValueKey('chat-preview-c1'));
    expect(preview, findsOneWidget);
    expect(find.byType(InlineMarkdownText), findsNWidgets(2));

    final rich = tester.widget<RichText>(find.descendant(
      of: preview,
      matching: find.byType(RichText),
    ));
    final span = rich.text as TextSpan;
    expect(span.toPlainText(), 'July 15 with details, code, and a link');
    expect(span.toPlainText(), isNot(contains('**')));
    expect(rich.maxLines, 1);
    expect(rich.overflow, TextOverflow.ellipsis);

    TextSpan? withText(InlineSpan current, String text) {
      if (current is! TextSpan) return null;
      if (current.text == text) return current;
      for (final child in current.children ?? const <InlineSpan>[]) {
        final found = withText(child, text);
        if (found != null) return found;
      }
      return null;
    }

    expect(withText(span, 'July 15')?.style?.fontWeight, FontWeight.w700);
    expect(withText(span, 'details')?.style?.fontStyle, FontStyle.italic);
    expect(withText(span, 'code')?.style?.fontFamily, 'JetBrains Mono');
    expect(
        withText(span, 'a link')?.style?.decoration, TextDecoration.underline);

    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('a 2+ char query surfaces the full-text MESSAGES section',
      (tester) async {
    final state = await seededState();
    addTearDown(state.dispose);
    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'kerry');
    await tester.pump(); // debounce armed, spinner up
    expect(find.text('MESSAGES'), findsOneWidget);

    // Let the 300ms debounce fire; with no live client the search resolves
    // to zero hits, which must render the quiet empty note (not a crash).
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    expect(find.text('No message matches.'), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('clearing the query removes the MESSAGES section',
      (tester) async {
    final state = await seededState();
    addTearDown(state.dispose);
    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'kerry');
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    expect(find.text('MESSAGES'), findsOneWidget);

    // The clear (×) affordance appears with text and resets everything.
    await tester.tap(find.descendant(
      of: find.byType(TextField),
      matching: find.byIcon(Icons.close),
    ));
    await tester.pumpAndSettle();
    expect(find.text('MESSAGES'), findsNothing);
    expect(find.text('General'), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('swiping a chat tile left asks for delete confirmation',
      (tester) async {
    debugDefaultTargetPlatformOverride = TargetPlatform.android;

    final state = await seededState();
    addTearDown(state.dispose);
    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    await tester.drag(find.text('General'), const Offset(-500, 0));
    await tester.pumpAndSettle();

    expect(find.text('Delete chat?'), findsOneWidget);
    await tester.tap(find.text('Cancel'));
    await tester.pumpAndSettle();

    // Cancelled: the tile is still there.
    expect(find.text('General'), findsOneWidget);
    expect(find.text('Delete chat?'), findsNothing);

    await tester.pump(const Duration(seconds: 3));
    // Reset before the binding's invariant check (addTearDown is too late).
    debugDefaultTargetPlatformOverride = null;
  });
}
