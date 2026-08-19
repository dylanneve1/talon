import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/models/connection.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/connect_screen.dart';

/// The remote fields are the first thing a phone user touches, and a blank
/// host or a nonsense port used to surface only as an opaque socket failure
/// after the dial timed out. These tests pin the pre-flight check.
void main() {
  Future<_RecordingState> pumpConnect(WidgetTester tester) async {
    // Tall surface: the whole card must be on screen for Connect to hit-test.
    await tester.binding.setSurfaceSize(const Size(800, 1200));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    SharedPreferences.setMockInitialValues({});
    final prefs = await Prefs.load();
    final state = _RecordingState(prefs);
    addTearDown(state.dispose);

    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);

    await tester.pumpWidget(
      MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: child!,
        ),
        // firstRun mode returns a bare body — RootView supplies the Scaffold
        // in the real app, so the test has to as well.
        home: Scaffold(
          body: ConnectScreen(state: state, firstRun: true),
        ),
      ),
    );
    await tester.pump();

    // Force remote mode so the host/port/token fields are on screen.
    await tester.tap(find.text('Remote bridge'));
    await tester.pump();
    return state;
  }

  testWidgets('a blank host is reported inline and does not dial', (
    tester,
  ) async {
    final state = await pumpConnect(tester);

    await tester.tap(find.text('Connect'));
    await tester.pump();

    expect(find.text('Enter the host or IP of your Talon bridge.'),
        findsOneWidget);
    expect(state.applied, isEmpty);

    // Typing clears the error immediately — it must not outlive the mistake.
    await tester.enterText(find.byType(TextField).first, '192.168.1.20');
    await tester.pump();
    expect(find.text('Enter the host or IP of your Talon bridge.'), findsNothing);
  });

  testWidgets('an out-of-range port is reported inline and does not dial', (
    tester,
  ) async {
    final state = await pumpConnect(tester);

    final fields = find.byType(TextField);
    await tester.enterText(fields.first, '192.168.1.20');
    await tester.enterText(fields.at(1), '99999');
    await tester.pump();

    await tester.tap(find.text('Connect'));
    await tester.pump();

    expect(find.text('Port must be a number between 1 and 65535.'),
        findsOneWidget);
    expect(state.applied, isEmpty);
  });

  testWidgets('valid remote details dial through', (tester) async {
    final state = await pumpConnect(tester);

    final fields = find.byType(TextField);
    await tester.enterText(fields.first, '192.168.1.20');
    await tester.enterText(fields.at(1), '19880');
    await tester.pump();

    await tester.tap(find.text('Connect'));
    await tester.pumpAndSettle();

    expect(state.applied, hasLength(1));
    expect(state.applied.single.host, '192.168.1.20');
    expect(state.applied.single.port, 19880);
  });
}

class _RecordingState extends AppState {
  _RecordingState(super.prefs) : super(narrowLayout: true);

  final applied = <ConnectionConfig>[];

  @override
  Future<void> applyConfig(ConnectionConfig config) async {
    applied.add(config);
  }

  @override
  Future<ConfigSnapshot?> loadConfig() async => null;

  @override
  Future<void> refreshMeshDevices() async {}

  @override
  Future<void> refreshMeshBackgroundHealth() async {}
}
