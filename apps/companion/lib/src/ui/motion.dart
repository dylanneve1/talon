import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../theme.dart';

/// True when the platform asks us to minimise motion.
bool reduceMotion(BuildContext context) =>
    MediaQuery.of(context).disableAnimations;

/// A one-shot entrance (fade + slide) that plays exactly once and then holds —
/// crucially, it survives parent rebuilds that flip [enabled] back to false.
///
/// This matters because the chat list and sidebar rebuild on every streaming
/// token (AppState is a ChangeNotifier). The freshness gates that decide
/// whether a row is "new" (`_seen` sets) return true on first sight and false
/// forever after — so a naive `enabled ? child.animate() : child` swaps the
/// Animate widget for a plain one on the very next rebuild, tearing the
/// entrance down a few frames in and making the row visibly snap into place.
///
/// [EntranceFx] captures the decision in [initState] and always returns the
/// same subtree shape afterwards, so flutter_animate reuses the element and
/// plays the entrance through to completion regardless of later rebuilds.
class EntranceFx extends StatefulWidget {
  /// Whether to animate. Read once, at mount; later changes are ignored.
  final bool enabled;

  /// Fractional (relative to the child's size) offset the child slides from.
  final Offset from;
  final Duration delay;
  final Duration duration;
  final Widget child;

  const EntranceFx({
    super.key,
    required this.enabled,
    required this.child,
    this.from = const Offset(0, 0.12),
    this.delay = Duration.zero,
    this.duration = TalonMotion.base,
  });

  @override
  State<EntranceFx> createState() => _EntranceFxState();
}

class _EntranceFxState extends State<EntranceFx> {
  // Fixed at mount so a rebuild that flips widget.enabled can't restart or
  // cancel the entrance mid-flight.
  late final bool _play = widget.enabled;

  @override
  Widget build(BuildContext context) {
    if (!_play) return widget.child;
    return widget.child
        .animate()
        .fadeIn(delay: widget.delay, duration: widget.duration)
        .slide(
          begin: widget.from,
          end: Offset.zero,
          delay: widget.delay,
          duration: widget.duration,
          curve: TalonMotion.emphasized,
        );
  }
}
