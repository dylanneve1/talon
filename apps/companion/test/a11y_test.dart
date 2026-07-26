import 'package:flutter/material.dart';
import 'dart:ui' show Tristate;
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/state/voice_session.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/code_block.dart';
import 'package:talon_companion/src/ui/composer.dart';
import 'package:talon_companion/src/ui/voice_mode_screen.dart';

import 'fake_voice_engine.dart';

/// Screen-reader contract for the app's icon-only and custom-painted controls.
///
/// These are the widgets a sighted user reads by shape — a bare arrow glyph, a
/// painted orb, a copy chip. To TalkBack/VoiceOver they were unlabelled,
/// role-less rectangles. This file pins the label *and* the state, because a
/// button that announces itself as tappable while disabled is its own bug.
void main() {
  Widget host(Widget child) => MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, c) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: c!,
        ),
        home: Scaffold(body: child),
      );

  testWidgets('the send button is a button, and is disabled while empty',
      (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(host(Composer(
      onSend: (_, {imagePath, attachmentPath}) async => true,
      onUpload: (_, __, ___) async => null,
      enabled: true,
    )));

    final send = find.bySemanticsLabel('Send message');
    expect(send, findsOneWidget);
    var node = tester.getSemantics(send);
    expect(node.flagsCollection.isButton, isTrue);
    // Nothing typed yet: announced, but explicitly not actionable.
    expect(node.flagsCollection.isEnabled, Tristate.isFalse);

    await tester.enterText(find.byType(TextField), 'hello');
    await tester.pump();
    node = tester.getSemantics(find.bySemanticsLabel('Send message'));
    expect(node.flagsCollection.isEnabled, Tristate.isTrue);

    handle.dispose();
  });

  testWidgets('the stop button announces itself while a turn runs',
      (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(host(Composer(
      onSend: (_, {imagePath, attachmentPath}) async => true,
      onUpload: (_, __, ___) async => null,
      enabled: true,
      running: true,
      onStop: () async {},
    )));
    await tester.pump(const Duration(milliseconds: 300));

    final stop = find.bySemanticsLabel('Stop generating');
    expect(stop, findsOneWidget);
    expect(tester.getSemantics(stop).flagsCollection.isButton, isTrue);
    handle.dispose();
  });

  testWidgets('the code copy chip is a labelled button', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(
      host(const CodeBlock(code: 'print(1)', language: 'dart')),
    );

    // The chip's own text is the label; what was missing is the role.
    final copy = find.bySemanticsLabel('Copy');
    expect(copy, findsOneWidget);
    expect(tester.getSemantics(copy).flagsCollection.isButton, isTrue);
    handle.dispose();
  });

  testWidgets('the voice orb carries its phase in its label', (tester) async {
    await tester.binding.setSurfaceSize(const Size(420, 900));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final handle = tester.ensureSemantics();
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: true);
    addTearDown(state.dispose);
    state.debugSeed(
      chats: [
        ClientChat(
            id: 'c1', title: 'Inbox', createdAt: 1, lastActive: 2, preview: ''),
      ],
      select: 'c1',
      connState: ConnState.connected,
    );
    final engine = SilentVoiceEngine();
    addTearDown(engine.close);
    final session = VoiceSession(state, handsFree: false, engine: engine);
    addTearDown(session.dispose);

    await tester.pumpWidget(host(
      VoiceModeScreen(state: state, session: session),
    ));
    await tester.pump(const Duration(milliseconds: 300));

    // The orb is a CustomPaint — without a label it is a blank rectangle.
    final idle = find.bySemanticsLabel('Start talking');
    expect(idle, findsOneWidget);
    expect(tester.getSemantics(idle).flagsCollection.isButton, isTrue);

    // Same control, different meaning: the label has to move with the phase.
    session.debugSetPhase(VoicePhase.speaking);
    await tester.pump(const Duration(milliseconds: 300));
    expect(
      find.bySemanticsLabel('Talon is speaking. Tap to interrupt'),
      findsOneWidget,
    );
    expect(find.bySemanticsLabel('Start talking'), findsNothing);

    // Let AppState's debounced snapshot timer fire before teardown.
    await tester.pump(const Duration(seconds: 3));
    handle.dispose();
  });
}
