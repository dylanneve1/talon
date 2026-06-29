import 'package:flutter/material.dart';

import '../state/app_state.dart';
import '../theme.dart';

/// Compact "Talon running / connecting / offline" indicator with a live dot.
class StatusPill extends StatelessWidget {
  final AppState state;
  const StatusPill({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    final (color, label) = switch (state.conn) {
      ConnState.connected => (TalonColors.ok, 'Talon online'),
      ConnState.connecting => (TalonColors.warn, _connectingLabel()),
      ConnState.error => (TalonColors.bad, 'Offline'),
      ConnState.idle => (TalonColors.textFaint, 'Idle'),
    };

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: color.withValues(alpha: 0.32)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          _Dot(color: color, pulse: state.conn == ConnState.connecting),
          const SizedBox(width: 7),
          Text(
            label,
            style: TextStyle(
              color: color,
              fontSize: 12,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.2,
            ),
          ),
        ],
      ),
    );
  }

  String _connectingLabel() {
    final d = state.daemon;
    return d.detail ?? 'Connecting…';
  }
}

class _Dot extends StatefulWidget {
  final Color color;
  final bool pulse;
  const _Dot({required this.color, required this.pulse});

  @override
  State<_Dot> createState() => _DotState();
}

class _DotState extends State<_Dot> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))
        ..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final t = widget.pulse ? _c.value : 1.0;
        return Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: widget.color,
            boxShadow: [
              BoxShadow(
                color: widget.color.withValues(alpha: 0.55 * t),
                blurRadius: 8 * t,
                spreadRadius: 1.5 * t,
              ),
            ],
          ),
        );
      },
    );
  }
}
