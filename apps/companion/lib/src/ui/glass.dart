import 'dart:ui';

import 'package:flutter/material.dart';

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

/// The app's navigation surface: one uniform native backdrop blur with a
/// translucent tint and a hairline bottom edge, running edge-to-edge behind
/// the status bar. Content slides beneath it and glows through the glass.
///
/// Uniform sigma is the design, not a shortcut. A progressive melt needs
/// either a variable-sigma fragment shader (hundreds of texture taps per
/// pixel across the strip — measured too slow on phones) or stacked
/// backdrop bands (visible sigma steps however they're arranged). One
/// honest surface on the engine's downsampled Gaussian costs the same as
/// the composer's pill and cannot band — there is no gradient to step.
class GlassBar extends StatelessWidget {
  final Widget child;
  final EdgeInsetsGeometry padding;
  const GlassBar({super.key, required this.child, required this.padding});

  static const double sigma = 24;

  @override
  Widget build(BuildContext context) {
    final fill = TalonTheme.isDark
        ? TalonColors.void1.withValues(alpha: 0.52)
        : Colors.white.withValues(alpha: 0.58);
    return ClipRect(
      child: BackdropFilter(
        filter: ImageFilter.blur(sigmaX: sigma, sigmaY: sigma),
        child: Container(
          padding: padding,
          decoration: BoxDecoration(
            color: fill,
            border: Border(
              bottom: BorderSide(color: TalonColors.glassStroke),
            ),
          ),
          child: child,
        ),
      ),
    );
  }
}

/// A pushed-route scaffold in the glass-bar language: the body runs
/// edge-to-edge (behind the status bar) and slides under the bar — auto
/// back button, title, actions. Scrollables in [body] should top-pad by
/// [topClearance] so resting content sits below the bar.
class GlassBarScreen extends StatelessWidget {
  final String title;
  final List<Widget> actions;
  final Widget body;
  const GlassBarScreen({
    super.key,
    required this.title,
    this.actions = const [],
    required this.body,
  });

  /// Vertical room the bar needs: status-bar inset + controls.
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
          Positioned.fill(child: body),
          Positioned(
            top: 0,
            left: 0,
            right: 0,
            child: GlassBar(
              padding: EdgeInsets.fromLTRB(4, 4 + inset, 8, 6),
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
/// depth without tinting the whole surface. Deliberately static: the blobs
/// used to drift on 18–27s loops, but any motion beneath a BackdropFilter
/// dirties the backdrop every frame and forces every glass surface (bar,
/// composer, sheets) to re-composite continuously — permanent idle GPU load
/// for a sub-perceptual effect.
class AmbientGlow extends StatelessWidget {
  const AmbientGlow({super.key});

  @override
  Widget build(BuildContext context) {
    // The light canvas takes a slightly stronger wash than the near-black one
    // (colour reads quieter on white).
    final boost = TalonTheme.isDark ? 1.0 : 1.25;
    return IgnorePointer(
      child: Stack(
        children: [
          Positioned(
            top: -180,
            left: -140,
            child:
                _blob(TalonColors.accent.withValues(alpha: 0.14 * boost), 460),
          ),
          Positioned(
            top: -120,
            right: -180,
            child:
                _blob(TalonColors.accent2.withValues(alpha: 0.08 * boost), 400),
          ),
          Positioned(
            bottom: -200,
            right: -140,
            child:
                _blob(TalonColors.accent2.withValues(alpha: 0.10 * boost), 500),
          ),
          Positioned(
            bottom: -160,
            left: -200,
            child: _blob(
                TalonColors.accentDeep.withValues(alpha: 0.09 * boost), 420),
          ),
        ],
      ),
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
