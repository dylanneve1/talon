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

/// C2-continuous ease (smootherstep). Linear alpha ramps end with a kink
/// (C0) that the eye reads as a line — Mach banding. This curve has zero
/// first and second derivatives at both ends, so frost and scrim dissolve
/// with no perceptible start or stop.
double _ease(double t) {
  final x = t.clamp(0.0, 1.0);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/// The app-wide progressive frost: a single native Gaussian backdrop blur,
/// confined to the header strip, whose composited result is dissolved with a
/// continuous alpha mask. This stays on Impeller's fast separable-blur path;
/// there are no scene snapshots, synchronous GPU readbacks, or brute-force
/// fragment-shader taps.
class TopEdgeFrost extends StatelessWidget {
  final Widget child;

  /// Total frost depth from the top, in logical pixels (usually includes
  /// the status-bar inset).
  final double extent;

  /// How many of those pixels stay fully frosted before the dissolve.
  final double solidUntil;

  const TopEdgeFrost({
    super.key,
    required this.child,
    required this.extent,
    required this.solidUntil,
  });

  /// Strong enough to dissolve text and card edges under the controls. The
  /// native blur is separable, so this is dramatically cheaper than sampling
  /// a two-dimensional kernel in a runtime shader.
  static const double sigma = 32;

  @override
  Widget build(BuildContext context) {
    return Stack(
      fit: StackFit.expand,
      children: [
        child,
        Positioned.fill(
          child: IgnorePointer(
            child: LayoutBuilder(
              builder: (context, constraints) {
                if (!constraints.maxHeight.isFinite ||
                    constraints.maxHeight <= 0) {
                  return const SizedBox.shrink();
                }
                final clearAt = extent.clamp(0.0, constraints.maxHeight);
                final solid = solidUntil.clamp(0.0, clearAt);
                return Align(
                  alignment: Alignment.topCenter,
                  child: SizedBox(
                    width: double.infinity,
                    height: clearAt,
                    child: ClipRect(
                      child: BackdropFilter(
                        // Bounded blur samples only real backdrop pixels in
                        // this strip and renormalizes the kernel at its edge.
                        // An unbounded clamp blur repeats the final source row,
                        // stretching colorful content into a horizontal bar.
                        filterConfig: const ImageFilterConfig.blur(
                          sigmaX: sigma,
                          sigmaY: sigma,
                          tileMode: TileMode.decal,
                          bounded: true,
                        ),
                        child: CustomPaint(
                          painter: _BottomFadeMaskPainter(solid: solid),
                          size: Size.infinite,
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
      ],
    );
  }
}

/// Masks the backdrop-filter layer itself. Painting this as a child of the
/// [BackdropFilter] is important: [BlendMode.dstIn] then feathers the filtered
/// backdrop rather than adding a translucent veil over the sharp scene.
class _BottomFadeMaskPainter extends CustomPainter {
  const _BottomFadeMaskPainter({required this.solid});

  final double solid;

  @override
  void paint(Canvas canvas, Size size) {
    if (size.isEmpty) return;
    final fadeHeight = size.height - solid;
    if (fadeHeight <= 0) return;

    // Blur a hard alpha edge whose centre sits halfway through the dissolve.
    // Eight sigmas span the dissolve. At either boundary the Gaussian tail is
    // below 1/30,000 alpha: visually solid at [solid] and visually zero at the
    // clip, without extending the backdrop layer or introducing gradient
    // segments that shimmer while scrolling.
    final sigma = fadeHeight / 8;
    final edge = solid + fadeHeight / 2;
    canvas.drawRect(
      Rect.fromLTRB(0, -fadeHeight, size.width, edge),
      Paint()
        ..blendMode = BlendMode.dstIn
        ..color = Colors.white
        ..imageFilter = ImageFilter.blur(
          sigmaX: 0,
          sigmaY: sigma,
          tileMode: TileMode.decal,
        ),
    );
  }

  @override
  bool shouldRepaint(_BottomFadeMaskPainter oldDelegate) =>
      oldDelegate.solid != solid;
}

/// The gradient wash painted behind floating header controls: a translucent
/// veil through the control zone that dissolves along the same eased curve
/// as the frost. Kept deliberately light — the frost carries the glass
/// look; the scrim only tops up text contrast. Runs edge-to-edge (behind
/// the status bar) — callers pad their controls below the inset.
class HeaderScrim extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  const HeaderScrim({super.key, required this.child, required this.padding});

  /// Peak scrim opacity (dark canvas hides a veil better than paper-white,
  /// which was reading as a white wash instead of blur).
  static double get _peak => TalonTheme.isDark ? 0.62 : 0.42;

  @override
  Widget build(BuildContext context) {
    final base = TalonTheme.isDark ? TalonColors.void1 : Colors.white;
    const plateau = 0.45; // fraction of height at full veil
    const steps = 12;
    final stops = <double>[0.0];
    final colors = <Color>[base.withValues(alpha: _peak)];
    for (var i = 0; i <= steps; i++) {
      final t = i / steps;
      stops.add(plateau + t * (1 - plateau));
      colors.add(base.withValues(alpha: _peak * (1 - _ease(t))));
    }
    return Container(
      decoration: BoxDecoration(
        gradient: LinearGradient(
          begin: Alignment.topCenter,
          end: Alignment.bottomCenter,
          colors: colors,
          stops: stops,
        ),
      ),
      padding: padding,
      child: child,
    );
  }
}

/// A pushed-route scaffold in the frosted-canvas language: the body runs
/// edge-to-edge (behind the status bar) and slides under a floating header
/// — auto back button, title, actions — instead of a distinct AppBar strip.
/// Scrollables in [body] should top-pad by [topClearance] so resting
/// content sits below the header.
class FrostedScreen extends StatelessWidget {
  final String title;
  final List<Widget> actions;
  final Widget body;
  const FrostedScreen({
    super.key,
    required this.title,
    this.actions = const [],
    required this.body,
  });

  /// Vertical room the floating header needs: status-bar inset + controls.
  static double topClearance(BuildContext context) =>
      MediaQuery.of(context).padding.top + 64;

  @override
  Widget build(BuildContext context) {
    final inset = MediaQuery.of(context).padding.top;
    final canPop = Navigator.of(context).canPop();
    return Scaffold(
      backgroundColor: Colors.transparent,
      body: Stack(
        children: [
          Positioned.fill(
            child: TopEdgeFrost(
              extent: inset + 94,
              solidUntil: inset + 48,
              child: body,
            ),
          ),
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: HeaderScrim(
              padding: EdgeInsets.fromLTRB(4, 4 + inset, 8, 16),
              child: Row(
                children: [
                  if (canPop)
                    IconButton(
                      onPressed: () => Navigator.of(context).maybePop(),
                      tooltip: 'Back',
                      icon: Icon(Icons.adaptive.arrow_back, size: 20),
                    ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        fontSize: 16.5,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  ...actions,
                ],
              ),
            ),
          ),
        ],
      ),
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
