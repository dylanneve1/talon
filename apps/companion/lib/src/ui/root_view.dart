import 'package:flutter/material.dart';

import '../state/app_state.dart';
import 'app_shell.dart';
import 'connect_screen.dart';
import 'glass.dart';

/// Decides between the first-run connect screen and the main app shell, and
/// paints the global backdrop + ambient glow behind everything.
class RootView extends StatelessWidget {
  final AppState state;
  const RootView({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    return TalonBackdrop(
      child: Material(
        type: MaterialType.transparency,
        child: ListenableBuilder(
          listenable: state,
          builder: (context, _) {
            if (!state.prefs.onboarded) {
              return ConnectScreen(state: state, firstRun: true);
            }
            return AppShell(state: state);
          },
        ),
      ),
    );
  }
}
