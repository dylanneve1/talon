import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_foreground_task/flutter_foreground_task.dart';

import 'src/services/bridge_trust.dart';
import 'src/services/haptics.dart';
import 'src/services/mesh_background.dart';
import 'src/services/prefs.dart';
import 'src/services/voice.dart';
import 'src/services/windows_tray.dart';
import 'src/state/app_state.dart';
import 'src/theme.dart';
import 'src/ui/root_view.dart';
import 'src/ui/voice_mode_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Certificate pinning for every implicitly-created HttpClient
  // (Image.network) — BridgeClient carries its own pinned client.
  BridgeTrust.install();
  // UI ↔ foreground-service isolate messaging (mesh reconfigure pokes).
  if (MeshForegroundController.isSupported) {
    FlutterForegroundTask.initCommunicationPort();
  }
  // Windows: tray residency — close hides to the system tray, mesh keeps
  // running (macOS gets the same from native code in macos/Runner).
  await WindowsTray.instance.init();
  final prefs = await Prefs.load();
  TalonTheme.mode.value = switch (prefs.themeMode) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    _ => ThemeMode.system,
  };
  final seed = prefs.accentSeed;
  TalonTheme.accentSeed.value = seed == null ? null : Color(seed);
  TalonTheme.textScale.value = prefs.textScale;
  Haptics.enabled = prefs.haptics;
  TalonTheme.apply(
    WidgetsBinding.instance.platformDispatcher.platformBrightness,
  );
  TalonTheme.syncSystemChrome();
  final state = AppState(prefs);
  runApp(TalonApp(state: state));
}

class TalonApp extends StatefulWidget {
  final AppState state;
  const TalonApp({super.key, required this.state});

  @override
  State<TalonApp> createState() => _TalonAppState();
}

class _TalonAppState extends State<TalonApp> with WidgetsBindingObserver {
  /// Root navigator — the assist-gesture handler pushes voice mode through
  /// it without needing a BuildContext below the MaterialApp.
  final _navigatorKey = GlobalKey<NavigatorState>();
  StreamSubscription<void>? _assistSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Theme-mode / accent changes (Settings) re-resolve the palette and
    // rebuild; text-scale changes rebuild to re-apply the root TextScaler.
    TalonTheme.mode.addListener(_onThemeChanged);
    TalonTheme.accentSeed.addListener(_onThemeChanged);
    TalonTheme.textScale.addListener(_onThemeChanged);
    // Connect on launch using the saved profile (or platform default).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (widget.state.prefs.onboarded) widget.state.start();
    });
    if (VoiceService.supported) {
      // Warm assist launches (gesture while the app runs) arrive as events;
      // a cold start straight from the gesture leaves a flag to consume once
      // the first frame is up.
      _assistSub =
          VoiceService.instance.onAssistLaunch.listen((_) => _openVoiceMode());
      WidgetsBinding.instance.addPostFrameCallback((_) async {
        if (await VoiceService.instance.consumeAssistLaunch()) {
          _openVoiceMode();
        }
      });
    }
  }

  /// Jump into full-screen voice mode (assist gesture). Ensures a chat is
  /// selected first so AppShell settles its conversation route BENEATH the
  /// voice screen, then pushes the orb on top.
  Future<void> _openVoiceMode() async {
    final state = widget.state;
    if (!state.prefs.onboarded) return;
    if (VoiceModeScreen.open.value) return; // already in a session
    // Clear the native pending flag so this launch is handled exactly once.
    await VoiceService.instance.consumeAssistLaunch();
    if (state.selectedChatId == null && state.chats.isNotEmpty) {
      await state.selectChat(state.chats.first.id);
      // Let AppShell's post-frame route sync push the conversation first.
      await Future<void>.delayed(const Duration(milliseconds: 80));
    }
    if (!mounted || VoiceModeScreen.open.value) return;
    _navigatorKey.currentState?.push(VoiceModeScreen.route(state));
  }

  /// The OS flipped light/dark — matters in auto mode.
  @override
  void didChangePlatformBrightness() => _onThemeChanged();

  void _onThemeChanged() {
    setState(() {
      TalonTheme.apply(
        WidgetsBinding.instance.platformDispatcher.platformBrightness,
      );
    });
    TalonTheme.syncSystemChrome();
  }

  @override
  void dispose() {
    _assistSub?.cancel();
    TalonTheme.mode.removeListener(_onThemeChanged);
    TalonTheme.accentSeed.removeListener(_onThemeChanged);
    TalonTheme.textScale.removeListener(_onThemeChanged);
    WidgetsBinding.instance.removeObserver(this);
    widget.state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Talon',
      navigatorKey: _navigatorKey,
      debugShowCheckedModeBanner: false,
      theme: buildTalonTheme(),
      // Apply the user's text-size preference on top of whatever scaling the
      // OS already requests, for every route in one place.
      builder: (context, child) {
        final mq = MediaQuery.of(context);
        final osFactor = mq.textScaler.scale(1.0);
        return MediaQuery(
          data: mq.copyWith(
            textScaler:
                TextScaler.linear(osFactor * TalonTheme.textScale.value),
          ),
          child: child ?? const SizedBox.shrink(),
        );
      },
      home: RootView(state: widget.state),
    );
  }
}
