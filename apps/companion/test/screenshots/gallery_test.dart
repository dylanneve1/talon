/// Screenshot gallery — renders the app's real screens to PNGs so UI changes
/// can be *seen* (and reviewed) without a device. Not a regression suite: it
/// only runs when explicitly asked for, and its output is gitignored.
///
///   TALON_SCREENSHOTS=1 flutter test --update-goldens test/screenshots
///
/// PNGs land in test/screenshots/goldens/. Real fonts (Roboto + Material
/// Icons from the Flutter SDK cache) are loaded so text renders legibly
/// instead of as the block test font.
library;

import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:talon_companion/src/models/bridge_models.dart';
import 'package:talon_companion/src/services/prefs.dart';
import 'package:talon_companion/src/state/app_state.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/connect_screen.dart';
import 'package:talon_companion/src/ui/glass.dart';
import 'package:talon_companion/src/ui/root_view.dart';
import 'package:talon_companion/src/ui/settings_screen.dart';

final bool _enabled = Platform.environment['TALON_SCREENSHOTS'] == '1';

Future<void> _loadRealFonts() async {
  final root = Platform.environment['FLUTTER_ROOT'];
  if (root == null) return;
  final dir = '$root/bin/cache/artifacts/material_fonts';
  Future<ByteData> font(String file) async {
    final bytes = await File('$dir/$file').readAsBytes();
    return ByteData.view(bytes.buffer);
  }

  final roboto = FontLoader('Roboto')
    ..addFont(font('Roboto-Regular.ttf'))
    ..addFont(font('Roboto-Medium.ttf'))
    ..addFont(font('Roboto-Bold.ttf'))
    ..addFont(font('Roboto-Italic.ttf'));
  await roboto.load();
  final icons = FontLoader('MaterialIcons')
    ..addFont(font('MaterialIcons-Regular.otf'));
  await icons.load();

  // Emoji (reaction chips, message text): the SDK font cache has no emoji
  // font, so anything like 👍 renders as tofu in screenshots — on-device the
  // platform supplies the fallback. Borrow the system's Noto Color Emoji
  // when present; skip quietly otherwise.
  for (final path in const [
    '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf', // Debian/Ubuntu
    '/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf', // Fedora
  ]) {
    final f = File(path);
    if (!f.existsSync()) continue;
    final bytes = await f.readAsBytes();
    final emoji = FontLoader('Noto Color Emoji')
      ..addFont(Future.value(ByteData.view(bytes.buffer)));
    await emoji.load();
    break;
  }
}

int _ts(int minutesAgo) => DateTime.now()
    .subtract(Duration(minutes: minutesAgo))
    .millisecondsSinceEpoch;

ClientChat _chat(
  String id,
  String title,
  String preview,
  int minutesAgo, {
  bool pulse = false,
  String? model,
}) =>
    ClientChat(
      id: id,
      title: title,
      createdAt: _ts(minutesAgo + 600),
      lastActive: _ts(minutesAgo),
      preview: preview,
      model: model,
      effort: 'adaptive',
      pulse: pulse,
      context: id == 'c1'
          ? const ContextInfo(
              known: true, used: 91000, max: 200000, pct: 45, warn: false)
          : null,
    );

List<ClientChat> _demoChats() => [
      _chat('c1', 'Trip to Kerry', 'Sounds good — booked for Saturday.', 4,
          model: 'opus'),
      _chat('c2', 'VPS disk cleanup', 'Freed 3.1G by pruning old builds.', 38,
          pulse: true),
      _chat('c3', 'Flutter back gesture', 'PopScope handles predictive back.',
          60 * 5),
      _chat('c4', 'Dinner ideas', 'A ragù wants 3 hours, start early.',
          60 * 26),
      _chat('c5', 'Polymarket research', 'Book is thin — sized down to \$2.',
          60 * 24 * 3),
      _chat('c6', 'Server hardening notes', 'fail2ban + keys only, done.',
          60 * 24 * 12),
    ];

Map<String, List<ClientMessage>> _demoMessages() => {
      'c1': [
        ClientMessage(
          id: 'm1',
          chatId: 'c1',
          role: Role.user,
          text: 'Plan a weekend in Kerry — hiking + one nice dinner.',
          ts: _ts(32),
        ),
        ClientMessage(
          id: 'm2',
          chatId: 'c1',
          role: Role.assistant,
          text:
              "Here's a tight plan:\n\n"
              '1. **Saturday am** — Torc Mountain from the Muckross side '
              '(2.5h, runnable ridge views).\n'
              '2. **Saturday pm** — Killarney town, dinner at *Mews* '
              '(book the 7:30 slot).\n'
              '3. **Sunday** — Gap of Dunloe loop, coffee in Kate '
              "Kearney's Cottage.\n\n"
              'Want me to check the weather window before you book?',
          ts: _ts(30),
          tools: [
            ToolActivity(
              id: 't1',
              name: 'web_search',
              done: true,
              input: const {'query': 'Torc Mountain trail conditions'},
              startedAt: DateTime.now(),
              finishedAt: DateTime.now().add(const Duration(seconds: 3)),
            ),
          ],
          durationMs: 9400,
          tokensIn: 2100,
          tokensOut: 460,
        ),
        ClientMessage(
          id: 'm3',
          chatId: 'c1',
          role: Role.user,
          text: 'Yes — and book Saturday if it looks dry.',
          ts: _ts(6),
        ),
        ClientMessage(
          id: 'm4',
          chatId: 'c1',
          role: Role.assistant,
          text: 'Sounds good — booked for Saturday. Forecast is dry until '
              '~18:00, light wind on the ridge. Confirmation is in your '
              'inbox.',
          ts: _ts(4),
          reactions: ['👍'],
          durationMs: 21000,
          tokensIn: 3400,
          tokensOut: 220,
        ),
      ],
    };

AppState _demoState({required bool narrow, String? select}) {
  final prefs = Prefs(_FakePrefsBacking.instance);
  final state = AppState(prefs, narrowLayout: narrow);
  state.debugSeed(
    chats: _demoChats(),
    messages: _demoMessages(),
    select: select,
    connState: ConnState.connected,
    bridgeStatus: BridgeStatus.fromJson(const {
      'protocol': 1,
      'botName': 'Talon',
      'backend': 'claude',
      'model': 'opus',
      'activeChats': 6,
      'startedAt': '',
    }),
  );
  return state;
}

class _FakePrefsBacking {
  static late final SharedPreferences instance;
}

Widget _app(Widget home) {
  final base = buildTalonTheme();
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    // Pin every text style to the loaded Roboto: the app's own styles leave
    // fontFamily null (fine on-device — the platform default is used), but in
    // a test that resolves to the blocky FlutterTest font.
    theme: base.copyWith(
      textTheme: base.textTheme.apply(
        fontFamily: 'Roboto',
        fontFamilyFallback: const ['Noto Color Emoji'],
      ),
      appBarTheme: base.appBarTheme.copyWith(
        titleTextStyle:
            base.appBarTheme.titleTextStyle?.copyWith(fontFamily: 'Roboto'),
      ),
    ),
    // Freeze the ambient/looping animations so frames are deterministic.
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(disableAnimations: true),
      child: child!,
    ),
    home: home,
  );
}

Future<void> _shoot(WidgetTester tester, String name) async {
  await tester.pump(const Duration(milliseconds: 400));
  await tester.pump(const Duration(milliseconds: 400));
  await expectLater(
    find.byType(MaterialApp),
    matchesGoldenFile('goldens/$name.png'),
  );
  // Let AppState's debounced snapshot timer fire before the test ends —
  // the binding asserts on pending timers at teardown.
  await tester.pump(const Duration(seconds: 3));
}

void _phone(WidgetTester tester) {
  tester.view.physicalSize = const Size(1080, 2280);
  tester.view.devicePixelRatio = 2.75;
  addTearDown(tester.view.reset);
}

void _desktop(WidgetTester tester) {
  tester.view.physicalSize = const Size(1440, 900);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

void main() {
  if (!_enabled) {
    test('screenshot gallery skipped (set TALON_SCREENSHOTS=1)', () {});
    return;
  }

  setUpAll(() async {
    SharedPreferences.setMockInitialValues({'onboarded.v1': true});
    _FakePrefsBacking.instance = await SharedPreferences.getInstance();
    await _loadRealFonts();
  });

  setUp(() {
    TalonTheme.mode.value = ThemeMode.dark;
    TalonTheme.accentSeed.value = null;
    TalonTheme.apply(Brightness.dark);
  });

  testWidgets('phone · chat list', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true);
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await _shoot(tester, 'phone_chat_list');
  });

  testWidgets('phone · conversation', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true, select: 'c1');
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await _shoot(tester, 'phone_chat');
  });

  testWidgets('phone · chat actions sheet (long-press)', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true);
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.longPress(find.text('Trip to Kerry'));
    await _shoot(tester, 'phone_chat_actions');
  });

  testWidgets('phone · settings', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true);
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(SettingsScreen(state: state)));
    await _shoot(tester, 'phone_settings');
  });

  testWidgets('phone · conversation (emerald accent)', (tester) async {
    _phone(tester);
    TalonTheme.accentSeed.value = const Color(0xFF3ED598);
    TalonTheme.apply(Brightness.dark);
    final state = _demoState(narrow: true, select: 'c1');
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await _shoot(tester, 'phone_chat_accent');
  });

  testWidgets('phone · connect (first run)', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true);
    addTearDown(state.dispose);
    // Mirror RootView's wrapping (backdrop + transparent Material): the
    // first-run screen renders inside it in the real app.
    await tester.pumpWidget(_app(TalonBackdrop(
      child: Material(
        type: MaterialType.transparency,
        child: ConnectScreen(state: state, firstRun: true),
      ),
    )));
    await _shoot(tester, 'phone_connect');
  });

  testWidgets('phone · conversation (light)', (tester) async {
    _phone(tester);
    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);
    final state = _demoState(narrow: true, select: 'c1');
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await _shoot(tester, 'phone_chat_light');
  });

  testWidgets('desktop · two-pane', (tester) async {
    _desktop(tester);
    final state = _demoState(narrow: false, select: 'c1');
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await _shoot(tester, 'desktop_two_pane');
  });
}
