import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../theme.dart';

/// A frosted-glass panel: blurred translucent fill, hairline stroke, soft
/// rounding. The building block of the whole UI.
class Glass extends StatelessWidget {
  final Widget child;
  final double radius;
  final EdgeInsetsGeometry? padding;
  final double blur;
  final Color? fill;
  final Color? stroke;
  final Gradient? glow;

  /// Optional drop shadows painted outside the blur clip (e.g.
  /// [TalonShadows.soft]) so a panel can float off the backdrop.
  final List<BoxShadow>? shadows;

  const Glass({
    super.key,
    required this.child,
    this.radius = 18,
    this.padding,
    this.blur = 18,
    this.fill,
    this.stroke,
    this.glow,
    this.shadows,
  });

  @override
  Widget build(BuildContext context) {
    final r = BorderRadius.circular(radius);
    final panel = ClipRRect(
      borderRadius: r,
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
        child: Container(
          padding: padding,
          decoration: BoxDecoration(
            gradient: glow,
            color: glow == null ? (fill ?? TalonColors.glassFill) : null,
            borderRadius: r,
            border: Border.all(
              color: stroke ?? TalonColors.glassStroke,
              width: 1,
            ),
          ),
          child: child,
        ),
      ),
    );
    if (shadows == null) return panel;
    return DecoratedBox(
      decoration: BoxDecoration(borderRadius: r, boxShadow: shadows),
      child: panel,
    );
  }
}

/// The themed canvas behind every screen: the palette's backdrop gradient with
/// the ambient glow on top. RootView paints it once for the main shell; pushed
/// routes (Settings, Connect) are opaque and render outside that tree, so they
/// must wrap their transparent Scaffolds in this too — otherwise nothing
/// paints behind them and the route shows as pitch black in light mode.
class TalonBackdrop extends StatelessWidget {
  final Widget child;
  const TalonBackdrop({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    return DecoratedBox(
      decoration: BoxDecoration(gradient: TalonColors.backdrop),
      child: Stack(
        children: [
          const Positioned.fill(child: AmbientGlow()),
          Positioned.fill(child: child),
        ],
      ),
    );
  }
}

/// A whisper of radial colour behind the backdrop, giving the near-black canvas
/// depth without tinting the whole surface. The two blobs drift on a slow,
/// offset loop so the background feels alive rather than static — the effect is
/// deliberately barely-perceptible, and it holds still under reduce-motion.
class AmbientGlow extends StatelessWidget {
  const AmbientGlow({super.key});

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    // The light canvas takes a slightly stronger wash than the near-black one
    // (colour reads quieter on white).
    final boost = TalonTheme.isDark ? 1.0 : 1.25;
    return IgnorePointer(
      child: Stack(
        children: [
          Positioned(
            top: -180,
            left: -140,
            child: _drift(
              _blob(TalonColors.accent.withValues(alpha: 0.14 * boost), 460),
              reduceMotion,
              const Offset(24, 18),
              18000,
            ),
          ),
          Positioned(
            top: -120,
            right: -180,
            child: _drift(
              _blob(TalonColors.accent2.withValues(alpha: 0.08 * boost), 400),
              reduceMotion,
              const Offset(-26, 20),
              21000,
            ),
          ),
          Positioned(
            bottom: -200,
            right: -140,
            child: _drift(
              _blob(TalonColors.accent2.withValues(alpha: 0.10 * boost), 500),
              reduceMotion,
              const Offset(-20, -22),
              24000,
            ),
          ),
          Positioned(
            bottom: -160,
            left: -200,
            child: _drift(
              _blob(
                  TalonColors.accentDeep.withValues(alpha: 0.09 * boost), 420),
              reduceMotion,
              const Offset(28, -16),
              27000,
            ),
          ),
        ],
      ),
    );
  }

  Widget _drift(Widget child, bool reduceMotion, Offset to, int ms) {
    if (reduceMotion) return child;
    return child.animate(onPlay: (c) => c.repeat(reverse: true)).move(
          begin: Offset.zero,
          end: to,
          duration: ms.ms,
          curve: Curves.easeInOut,
        );
  }

  Widget _blob(Color color, double size) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(colors: [color, color.withValues(alpha: 0)]),
        ),
      );
}
