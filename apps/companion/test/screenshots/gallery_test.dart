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
import 'package:talon_companion/src/state/voice_session.dart';
import 'package:talon_companion/src/theme.dart';
import 'package:talon_companion/src/ui/connect_screen.dart';
import 'package:talon_companion/src/ui/extensions_screen.dart';
import 'package:talon_companion/src/ui/glass.dart';
import 'package:talon_companion/src/ui/root_view.dart';
import 'package:talon_companion/src/ui/settings_screen.dart';
import 'package:talon_companion/src/ui/voice_mode_screen.dart';

import '../fake_voice_engine.dart';

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

  // The app's bundled faces (pubspec fonts don't auto-load in widget tests):
  // load them from the repo assets so screenshots show real typography.
  Future<ByteData> asset(String file) async {
    final bytes = await File('assets/fonts/$file').readAsBytes();
    return ByteData.view(bytes.buffer);
  }

  final inter = FontLoader('Inter')
    ..addFont(asset('Inter-Regular.ttf'))
    ..addFont(asset('Inter-Medium.ttf'))
    ..addFont(asset('Inter-SemiBold.ttf'))
    ..addFont(asset('Inter-Bold.ttf'));
  await inter.load();
  final mono = FontLoader('JetBrains Mono')
    ..addFont(asset('JetBrainsMono-Regular.ttf'))
    ..addFont(asset('JetBrainsMono-Medium.ttf'))
    ..addFont(asset('JetBrainsMono-Bold.ttf'));
  await mono.load();

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
      context: id == 'c1'
          ? const ContextInfo(
              known: true, used: 91000, max: 200000, pct: 45, warn: false)
          : null,
    );

List<ClientChat> _demoChats() => [
      _chat('c1', 'Trip to Kerry', '**Sounds good** — booked for Saturday.', 4,
          model: 'opus'),
      _chat('c2', 'VPS disk cleanup', 'Freed 3.1G by pruning old builds.', 38),
      _chat('c3', 'Flutter back gesture', 'PopScope handles predictive back.',
          60 * 5),
      _chat(
          'c4', 'Dinner ideas', 'A ragù wants 3 hours, start early.', 60 * 26),
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
          text: "Here's a tight plan:\n\n"
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
      'c2': [
        ClientMessage(
          id: 'n1',
          chatId: 'c2',
          role: Role.user,
          text: 'Disk is at 94% — what can we prune safely?',
          ts: _ts(52),
        ),
        ClientMessage(
          id: 'n2',
          chatId: 'c2',
          role: Role.assistant,
          text: 'Old build artifacts are the bulk of it. Preview first:\n\n'
              '```bash\n'
              'du -sh ~/.talon/workspace/builds/* | sort -rh | head -n 5\n'
              'find ~/.talon/workspace/builds -mtime +30 -name "*.apk"\n'
              '```\n\n'
              'Then prune anything older than 30 days with `-delete`. '
              'Current usage:\n\n'
              '```\n'
              'Filesystem      Size  Used Avail Use%\n'
              '/dev/sda1        75G   70G  4.9G  94%\n'
              '```\n\n'
              'Want me to run the cleanup?',
          ts: _ts(50),
          durationMs: 6200,
          tokensIn: 1400,
          tokensOut: 310,
        ),
        ClientMessage(
          id: 'n3',
          chatId: 'c2',
          role: Role.user,
          text: 'Yes, prune it.',
          ts: _ts(40),
        ),
        ClientMessage(
          id: 'n4',
          chatId: 'c2',
          role: Role.assistant,
          text: 'Freed 3.1G by pruning old builds.',
          ts: _ts(38),
          reactions: ['🔥'],
          durationMs: 12800,
          tokensIn: 2100,
          tokensOut: 90,
        ),
      ],
    };

List<PluginInfo> _demoPlugins() => const [
      PluginInfo(
          name: 'github',
          kind: 'builtin',
          enabled: true,
          source: 'config.github'),
      PluginInfo(
          name: 'mempalace',
          kind: 'builtin',
          enabled: true,
          source: 'config.mempalace'),
      PluginInfo(
          name: 'playwright',
          kind: 'builtin',
          enabled: false,
          source: 'config.playwright'),
      PluginInfo(
          name: 'weather-tools',
          kind: 'module',
          enabled: true,
          source: '~/.talon/plugins/node_modules/weather-tools'),
      PluginInfo(
          name: 'fetch',
          kind: 'mcp',
          enabled: false,
          source: 'npx -y @modelcontextprotocol/server-fetch'),
    ];

List<SkillInfo> _demoSkills() => const [
      SkillInfo(
          name: 'review-pr',
          description: 'Checklist-driven pull request review with repo context',
          enabled: true),
      SkillInfo(
          name: 'trip-planner',
          description:
              'Plan multi-day trips: routes, bookings, weather windows',
          enabled: true),
      SkillInfo(
          name: 'meeting-notes',
          description: 'Summarise a transcript into decisions and actions',
          enabled: false),
    ];

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
      'capabilities': ['mesh', 'mesh-commands', 'plugins-skills'],
    }),
    plugins: _demoPlugins(),
    skills: _demoSkills(),
  );
  return state;
}

class _FakePrefsBacking {
  static late final SharedPreferences instance;
}

/// A daemon snapshot for the settings screens — without one the status card
/// has no stat tiles to draw and every daemon-owned section stays unlisted,
/// since there is no live daemon behind the gallery.
const ConfigSnapshot _demoConfig = ConfigSnapshot(
  backend: 'claude',
  frontend: 'telegram',
  model: 'opus',
  modelDisplay: 'Opus 4.8',
  botDisplayName: 'Claudius',
  timezone: '',
  pulse: false,
  pulseIntervalMs: 300000,
  heartbeat: true,
  heartbeatIntervalMinutes: 60,
  dream: false,
  editable: [
    'model',
    'botDisplayName',
    'timezone',
    'pulse',
    'heartbeat',
    'dream',
    'pulseIntervalMs',
    'heartbeatIntervalMinutes',
  ],
  healthy: true,
  uptimeMs: 176400000,
  sessions: 63,
  messages: 43,
  memoryMb: 168,
);

Widget _app(Widget home) {
  final base = buildTalonTheme();
  return MaterialApp(
    debugShowCheckedModeBanner: false,
    // The app pins its own bundled Inter (loaded above); just add the emoji
    // fallback so reaction chips don't render as tofu.
    theme: base.copyWith(
      textTheme: base.textTheme.apply(
        fontFamilyFallback: const ['Noto Color Emoji'],
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
  // Real system insets (status bar + gesture navigation bar), in physical
  // pixels. Without them the gallery renders a phone that has neither, which
  // is exactly the case where "does the list run under the nav bar?" and
  // "does the FAB clear it?" can't be seen.
  tester.view.padding =
      const FakeViewPadding(top: 132, bottom: 66);
  tester.view.viewPadding =
      const FakeViewPadding(top: 132, bottom: 66);
  // Widget tests force TargetPlatform.android, so touch density is already
  // what this shot would get on a real phone — pin it anyway so the gallery
  // never depends on that default.
  TalonDensity.overrideTouch = true;
  addTearDown(tester.view.reset);
}

void _desktop(WidgetTester tester) {
  tester.view.physicalSize = const Size(1440, 900);
  tester.view.devicePixelRatio = 1.0;
  // ...and pin the pointer scale for the desktop shots, which would otherwise
  // render at phone density under that same forced platform.
  TalonDensity.overrideTouch = false;
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
    TalonDensity.overrideTouch = null;
    TalonTheme.mode.value = ThemeMode.dark;
    TalonTheme.accentSeed.value = null;
    TalonTheme.apply(Brightness.dark);
  });

  testWidgets('phone · chat list', (tester) async {
    _phone(tester);
    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);
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

  // Voice mode mid-tool-call: the case that used to render the raw MCP id
  // (`mcp__email-tools__search_emails`) into the status line.
  testWidgets('phone · voice mode (tool call)', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true, select: 'c1');
    addTearDown(state.dispose);
    final engine = SilentVoiceEngine();
    addTearDown(engine.close);
    final session = VoiceSession(state, handsFree: true, engine: engine);
    addTearDown(session.dispose);

    final turn = state.turnFor('c1');
    turn.active = true;
    turn.tools.add(ToolActivity(
      id: 'tool-1',
      name: 'mcp__email-tools__search_emails',
      input: const {'query': 'flight confirmation'},
      startedAt: DateTime.now().subtract(const Duration(milliseconds: 2400)),
    ));
    session.debugSetPhase(
      VoicePhase.thinking,
      userText: 'Did the flight confirmation land in my inbox?',
    );

    await tester.pumpWidget(
        _app(VoiceModeScreen(state: state, session: session)));
    await _shoot(tester, 'phone_voice_tool');
  });

  testWidgets('phone · voice mode (listening)', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true, select: 'c1');
    addTearDown(state.dispose);
    final engine = SilentVoiceEngine();
    addTearDown(engine.close);
    final session = VoiceSession(state, handsFree: true, engine: engine);
    addTearDown(session.dispose);
    session.debugSetPhase(
      VoicePhase.listening,
      partial: 'what does my afternoon look like',
    );

    await tester.pumpWidget(
        _app(VoiceModeScreen(state: state, session: session)));
    await _shoot(tester, 'phone_voice_listening');
  });

  testWidgets('phone · settings', (tester) async {
    _phone(tester);
    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);
    final state = _demoState(narrow: true);
    state.appConfig = _demoConfig;
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(SettingsScreen(state: state)));
    await _shoot(tester, 'phone_settings');
  });

  // The wide settings layout had no gallery case at all, which is exactly how
  // it went unnoticed that ten stacked cards were rendering into a 560px
  // ribbon on a 1440px window. Both brightnesses, since the rail's
  // selected-tile fill is one of the tints most likely to misread on white.
  testWidgets('desktop · settings (section rail)', (tester) async {
    _desktop(tester);
    final state = _demoState(narrow: false);
    state.appConfig = _demoConfig;
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(SettingsScreen(state: state)));
    await _shoot(tester, 'desktop_settings');
  });

  // Overview is the default chapter; Agent is the densest one, so it's the
  // case that actually proves the two-column pane carries real content rather
  // than one card and a lot of air.
  testWidgets('desktop · settings (agent chapter)', (tester) async {
    _desktop(tester);
    final state = _demoState(narrow: false);
    state.appConfig = _demoConfig;
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(SettingsScreen(state: state)));
    await tester.pump(const Duration(milliseconds: 300));
    await tester.tap(find.text('Agent'));
    await _shoot(tester, 'desktop_settings_agent');
  });

  testWidgets('desktop · settings (section rail, light)', (tester) async {
    _desktop(tester);
    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);
    final state = _demoState(narrow: false);
    state.appConfig = _demoConfig;
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(SettingsScreen(state: state)));
    await _shoot(tester, 'desktop_settings_light');
  });

  testWidgets('phone · plugins', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true);
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(PluginsScreen(state: state)));
    await _shoot(tester, 'phone_plugins');
  });

  testWidgets('phone · skills', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true);
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(SkillsScreen(state: state)));
    await _shoot(tester, 'phone_skills');
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

  testWidgets('phone · conversation (code blocks)', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true, select: 'c2');
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await _shoot(tester, 'phone_chat_code');
  });

  testWidgets('phone · conversation (code blocks, light)', (tester) async {
    _phone(tester);
    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.light);
    final state = _demoState(narrow: true, select: 'c2');
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await _shoot(tester, 'phone_chat_code_light');
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

  // Cmd+K is bound in AppShell, so driving it through the real key binding
  // (rather than calling openQuickSwitcher directly) also proves the binding
  // still reaches the palette. Ctrl is the chord on the test platform.
  testWidgets('desktop · command palette', (tester) async {
    _desktop(tester);
    final state = _demoState(narrow: false, select: 'c1');
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await tester.pump(const Duration(milliseconds: 300));
    // CallbackShortcuts only sees keys bubbling from a focused descendant, and
    // nothing in a freshly pumped tree holds focus — so the chord has to be
    // typed at something. The composer is the field a real user would already
    // be in, and it sits inside the same shortcuts scope.
    await tester.tap(find.byType(TextField).last);
    await tester.pump(const Duration(milliseconds: 200));
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
    await _shoot(tester, 'desktop_command_palette');
  });

  // The context pill used to be a tooltip-only dead end, so its figures were
  // unreachable on touch. `c1` is seeded at 45% (see _chat), which is the
  // healthy branch; the warn branch is a separate case so both palettes of the
  // badge get eyes on them.
  testWidgets('phone · context sheet', (tester) async {
    _phone(tester);
    final state = _demoState(narrow: true, select: 'c1');
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    // On the narrow layout the conversation is a pushed route, not a pane, so
    // the header (and its pill) only exist once that route has settled — a
    // single short pump lands mid-transition and finds nothing to tap.
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('45%'));
    await _shoot(tester, 'phone_context_sheet');
  });

  testWidgets('desktop · two-pane', (tester) async {
    _desktop(tester);
    final state = _demoState(narrow: false, select: 'c1');
    addTearDown(state.dispose);
    await tester.pumpWidget(_app(RootView(state: state)));
    await _shoot(tester, 'desktop_two_pane');
  });
}
