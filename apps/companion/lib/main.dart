import 'package:flutter/material.dart';

import 'src/services/prefs.dart';
import 'src/state/app_state.dart';
import 'src/theme.dart';
import 'src/ui/root_view.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await Prefs.load();
  TalonTheme.mode.value = switch (prefs.themeMode) {
    'light' => ThemeMode.light,
    'dark' => ThemeMode.dark,
    _ => ThemeMode.system,
  };
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
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Theme-mode changes (Settings) re-resolve the palette and rebuild.
    TalonTheme.mode.addListener(_onThemeChanged);
    // Connect on launch using the saved profile (or platform default).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (widget.state.prefs.onboarded) widget.state.start();
    });
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
    TalonTheme.mode.removeListener(_onThemeChanged);
    WidgetsBinding.instance.removeObserver(this);
    widget.state.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Talon',
      debugShowCheckedModeBanner: false,
      theme: buildTalonTheme(),
      home: RootView(state: widget.state),
    );
  }
}
