import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/app_shell.dart';
import 'package:talon_companion/src/ui/sidebar.dart';

/// The Android back contract: from an open conversation, the system back
/// button/gesture returns to the chat list; from the list it pops for real
/// (backgrounding the app). Regression coverage for the bug where back always
/// killed the activity.
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
          preview: 'hi',
        ),
      ],
      messages: {
        'c1': [
          ClientMessage(
            id: 'm1',
            chatId: 'c1',
            role: Role.user,
            text: 'hello there',
            ts: 1,
          ),
        ],
      },
      connState: ConnState.connected,
    );
    return state;
  }

  Widget host(AppState state) => MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        home: AppShell(state: state),
      );

  testWidgets('narrow: system back closes the conversation, not the app',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final state = await seededState();
    addTearDown(state.dispose);
    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    // Chat list first — nothing auto-selected on a phone.
    expect(state.selectedChatId, isNull);
    expect(find.text('General'), findsOneWidget);

    // Open the conversation.
    await tester.tap(find.text('General'));
    await tester.pumpAndSettle();
    expect(state.selectedChatId, 'c1');
    expect(find.text('hello there'), findsOneWidget);

    // System back → back to the list, selection cleared, app still alive.
    final popped = await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(popped, isTrue, reason: 'back must be consumed, not exit the app');
    expect(state.selectedChatId, isNull);
    expect(find.text('General'), findsOneWidget);

    // From the list, back is NOT consumed — the app may background/exit.
    final poppedAgain = await tester.binding.handlePopRoute();
    expect(poppedAgain, isFalse);

    // Flush AppState's debounced snapshot timer before teardown.
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('re-expanding past the breakpoint restores the two panes',
      (tester) async {
    // Drive size through the view (not setSurfaceSize) so the resize fires
    // didChangeMetrics — the shell can't rely on its LayoutBuilder here,
    // which is exactly the regression: while the conversation route covers
    // it, the two-pane layout is offstage and never relays out.
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);

    final state = await seededState();
    addTearDown(state.dispose);
    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    // Wide start: sidebar + conversation, most recent chat adopted.
    expect(state.selectedChatId, 'c1');
    expect(find.byType(Sidebar), findsOneWidget);

    // Shrink with the chat open: the conversation becomes a pushed route
    // covering the list — no sidebar on screen.
    tester.view.physicalSize = const Size(400, 800);
    await tester.pumpAndSettle();
    expect(find.text('hello there'), findsOneWidget);
    expect(find.byType(Sidebar), findsNothing);

    // Re-expand: the route pops, the two panes return, and the chat is
    // still selected — no stranded full-screen conversation.
    tester.view.physicalSize = const Size(1200, 800);
    await tester.pumpAndSettle();
    expect(find.byType(Sidebar), findsOneWidget);
    expect(find.text('hello there'), findsOneWidget);
    expect(state.selectedChatId, 'c1');

    // Flush AppState's debounced snapshot timer before teardown.
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('wide: two panes, no back interception', (tester) async {
    await tester.binding.setSurfaceSize(const Size(1200, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));

    final state = await seededState();
    addTearDown(state.dispose);
    await tester.pumpWidget(host(state));
    await tester.pumpAndSettle();

    // Growing wide adopts the most recent chat (list + conversation).
    expect(state.selectedChatId, 'c1');
    expect(find.text('hello there'), findsOneWidget);

    // Desktop/tablet wide layout: back isn't intercepted.
    final popped = await tester.binding.handlePopRoute();
    expect(popped, isFalse);
    expect(state.selectedChatId, 'c1');

    // Flush AppState's debounced snapshot timer before teardown.
    await tester.pump(const Duration(seconds: 3));
  });
}
