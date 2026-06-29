import 'package:flutter/material.dart';

import 'src/services/prefs.dart';
import 'src/state/app_state.dart';
import 'src/theme.dart';
import 'src/ui/root_view.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await Prefs.load();
  final state = AppState(prefs);
  runApp(TalonApp(state: state));
}

class TalonApp extends StatefulWidget {
  final AppState state;
  const TalonApp({super.key, required this.state});

  @override
  State<TalonApp> createState() => _TalonAppState();
}

class _TalonAppState extends State<TalonApp> {
  @override
  void initState() {
    super.initState();
    // Connect on launch using the saved profile (or platform default).
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (widget.state.prefs.onboarded) widget.state.start();
    });
  }

  @override
  void dispose() {
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
