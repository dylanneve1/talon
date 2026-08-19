import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/connect_screen.dart';
import 'package:talon_companion/src/ui/status_pill.dart';

/// Tier-3 semantics: widgets whose *name* lives in a neighbouring node rather
/// than in the widget itself. Visually the association is obvious; to a screen
/// reader it does not exist unless the two nodes are merged or relabelled.
void main() {
  Future<AppState> newState() async {
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    return AppState(prefs, narrowLayout: false);
  }

  Widget host(Widget child) => MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, c) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: c!,
        ),
        home: Scaffold(body: Center(child: child)),
      );

  testWidgets('status pill names what is online', (tester) async {
    final handle = tester.ensureSemantics();
    final state = await newState();
    addTearDown(state.dispose);

    await tester.pumpWidget(host(StatusPill(state: state)));
    await tester.pump();

    final node = tester.getSemantics(find.byType(StatusPill));
    expect(node.label, contains('Talon connection'),
        reason: '"Idle"/"Online" alone is ambiguous read aloud — it must say '
            'what is idle or online');

    await tester.pump(const Duration(seconds: 3));
    handle.dispose();
  });

  testWidgets('connect fields carry their caption as a name', (tester) async {
    await tester.binding.setSurfaceSize(const Size(500, 1000));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final handle = tester.ensureSemantics();
    final state = await newState();
    addTearDown(state.dispose);

    await tester.pumpWidget(host(ConnectScreen(state: state, firstRun: true)));
    await tester.pump();

    // The host/port/token fields live behind the remote-bridge mode.
    await tester.tap(find.text('Remote bridge'));
    await tester.pump();

    final node = tester.getSemantics(find.byType(TextField).first);
    expect(node.label, contains('Host or IP'),
        reason: 'the caption above the box is the field name; without a merge '
            'the field announces as a bare edit box');

    await tester.pump(const Duration(seconds: 3));
    handle.dispose();
  });
}
