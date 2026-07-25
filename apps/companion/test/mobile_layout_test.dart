import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/app_shell.dart';
import 'package:talon_companion/src/ui/message_bubble.dart';

/// The phone presentation: a full-bleed list with its primary action in the
/// thumb zone, and an assistant reply that uses the whole column instead of a
/// card inside it. These are the two structural claims of the mobile layout,
/// so they get regression coverage rather than only a screenshot.
void main() {
  tearDown(() => TalonDensity.overrideTouch = null);

  Future<AppState> seededState({bool empty = false}) async {
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    final prefs = await Prefs.load();
    final state = AppState(prefs, narrowLayout: true);
    state.debugSeed(
      chats: empty
          ? []
          : [
              ClientChat(
                id: 'c1',
                title: 'General',
                createdAt: 1,
                lastActive: 2,
                preview: 'hi',
              ),
            ],
      messages: const {},
      connState: ConnState.connected,
    );
    return state;
  }

  Widget host(Widget child) => MaterialApp(
        theme: buildTalonTheme(),
        builder: (context, c) => MediaQuery(
          data: MediaQuery.of(context).copyWith(disableAnimations: true),
          child: c!,
        ),
        home: child,
      );

  testWidgets('phone home puts New chat in a floating button, not a top CTA',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final state = await seededState();
    addTearDown(state.dispose);

    await tester.pumpWidget(host(AppShell(state: state)));
    await tester.pumpAndSettle();

    final cta = find.text('New chat');
    expect(cta, findsOneWidget);
    // Bottom-right corner, not the top of the list: the reachable half of a
    // phone screen is what the FAB move was for.
    final rect = tester.getRect(cta);
    expect(rect.center.dy, greaterThan(400));
    expect(rect.center.dx, greaterThan(200));

    // And the list is full-bleed — the chat tile starts within a few points
    // of the screen edge, not inset behind a card frame.
    expect(tester.getRect(find.text('General')).left, lessThan(80));

    // Let AppState's debounced snapshot timer fire before teardown.
    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('the list runs under the navigation bar, the FAB clears it',
      (tester) async {
    // Android draws the navigation bar transparently over the app, so the
    // chat list should scroll *behind* it rather than stopping at a solid
    // band — while every target stays above it.
    tester.view.physicalSize = const Size(400, 800);
    tester.view.devicePixelRatio = 1.0;
    tester.view.padding = const FakeViewPadding(top: 24, bottom: 48);
    tester.view.viewPadding = const FakeViewPadding(top: 24, bottom: 48);
    addTearDown(tester.view.reset);

    final state = await seededState();
    addTearDown(state.dispose);
    await tester.pumpWidget(host(AppShell(state: state)));
    await tester.pumpAndSettle();

    // The scroll view itself reaches the bottom of the screen…
    final listRect = tester.getRect(find.byType(ListView));
    expect(listRect.bottom, 800);
    // …and pads its content clear of both the nav bar and the FAB.
    final list = tester.widget<ListView>(find.byType(ListView));
    expect(list.padding, isNotNull);
    expect((list.padding as EdgeInsets).bottom, greaterThanOrEqualTo(48 + 60));
    // The button is a target, so it sits above the bar, not under it.
    expect(tester.getRect(find.text('New chat')).bottom, lessThan(800 - 48));

    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('the settings button is pinned to the right edge',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final state = await seededState();
    addTearDown(state.dispose);
    await tester.pumpWidget(host(AppShell(state: state)));
    await tester.pumpAndSettle();

    // Regression: identity + status shared the row's slack with a Spacer,
    // which parked the gear well short of the edge.
    final gear = tester.getRect(find.byIcon(Icons.settings_outlined));
    expect(gear.right, greaterThan(400 - 20));

    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('empty phone home explains the floating button', (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final state = await seededState(empty: true);
    addTearDown(state.dispose);

    await tester.pumpWidget(host(AppShell(state: state)));
    await tester.pumpAndSettle();

    expect(find.text('No chats yet'), findsOneWidget);
    expect(find.textContaining('Tap New chat'), findsOneWidget);

    await tester.pump(const Duration(seconds: 3));
  });

  testWidgets('assistant reply drops its card on touch and keeps it on pointer',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final msg = ClientMessage(
      id: 'm1',
      chatId: 'c1',
      role: Role.assistant,
      text: 'A reply that wants the whole column.',
      ts: DateTime(2026, 7, 25, 12).millisecondsSinceEpoch,
    );
    final card = find.byKey(const Key('assistant-message-card'));

    TalonDensity.overrideTouch = true;
    await tester.pumpWidget(host(
      Scaffold(body: MessageBubble(message: msg, botName: 'Talon')),
    ));
    await tester.pumpAndSettle();
    final touchWidth = tester.getSize(card).width;

    TalonDensity.overrideTouch = false;
    await tester.pumpWidget(host(
      Scaffold(body: MessageBubble(message: msg, botName: 'Talon')),
    ));
    await tester.pumpAndSettle();
    final pointerWidth = tester.getSize(card).width;

    // No avatar gutter and no bubble padding on touch: the reply is wider,
    // and it runs the full width of the row.
    expect(touchWidth, greaterThan(pointerWidth));
    expect(touchWidth, equals(400.0));
  });

  test('touch density scales type up and pins a 48dp target', () {
    TalonDensity.overrideTouch = false;
    final pointerBody = TalonType.body.fontSize!;
    expect(TalonDensity.tap, lessThan(48));

    TalonDensity.overrideTouch = true;
    expect(TalonType.body.fontSize!, greaterThan(pointerBody));
    expect(TalonDensity.tap, 48);
  });
}
