import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/chat_view.dart';

/// Tier-2 semantics: controls that DO carry text still need the button *role*,
/// otherwise a screen reader reads them as static prose with no hint that they
/// can be activated. These assert the role, not the label — the label comes
/// from the child text and is the part that already worked.
void main() {
  Future<AppState> seededState(List<ClientMessage> messages) async {
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: false);
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
      messages: {'c1': messages},
      select: 'c1',
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
        home: Scaffold(body: ChatView(state: state, showBack: false)),
      );

  testWidgets('conversation identity header announces as a button',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(900, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final handle = tester.ensureSemantics();

    await tester.pumpWidget(host(await seededState(const [])));
    await tester.pump();

    final node = tester.getSemantics(find.byKey(
      const Key('conversation-identity'),
    ));
    expect(node.flagsCollection.isButton, isTrue,
        reason: 'tapping the title opens chat actions; it must not read as '
            'plain text');

    // Drain AppState's debounced snapshot-save timer.
    await tester.pump(const Duration(seconds: 3));
    handle.dispose();
  });

  testWidgets('conversation starters announce as buttons', (tester) async {
    await tester.binding.setSurfaceSize(const Size(900, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final handle = tester.ensureSemantics();

    // Empty conversation → the starter chips are on screen.
    await tester.pumpWidget(host(await seededState(const [])));
    await tester.pump();

    final chip = tester.getSemantics(find.text('Summarize my day'));
    expect(chip.flagsCollection.isButton, isTrue,
        reason: 'a starter chip sends a prompt; it is an action, not a label');
    expect(chip.label, contains('Summarize my day'));

    // Drain AppState's debounced snapshot-save timer.
    await tester.pump(const Duration(seconds: 3));
    handle.dispose();
  });
}
