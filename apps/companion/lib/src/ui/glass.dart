import 'dart:ui';
import 'dart:ui' as ui;

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

/// The app-wide progressive frost: one Impeller backdrop shader samples the
/// already-painted scene and decreases its blur radius continuously to zero.
/// The final filtered row is identical to the untouched backdrop — no clip
/// edge, blur bands, snapshots, or synchronous GPU readbacks.
class TopEdgeFrost extends StatefulWidget {
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

  /// Radius of the shader's outer sample ring in logical pixels.
  static const double radius = 28;

  @override
  State<TopEdgeFrost> createState() => _TopEdgeFrostState();
}

class _TopEdgeFrostState extends State<TopEdgeFrost> {
  static ui.FragmentProgram? _program;
  static Future<void>? _loading;
  static bool _loadFailed = false;

  ui.FragmentShader? _shader;

  @override
  void initState() {
    super.initState();
    if (ui.ImageFilter.isShaderFilterSupported &&
        _program == null &&
        !_loadFailed) {
      (_loading ??= _loadProgram()).whenComplete(() {
        if (mounted) setState(() {});
      });
    }
  }

  static Future<void> _loadProgram() async {
    try {
      _program = await ui.FragmentProgram.fromAsset(
        'shaders/progressive_blur.frag',
      );
    } catch (error, stack) {
      _loadFailed = true;
      FlutterError.reportError(
        FlutterErrorDetails(
          exception: error,
          stack: stack,
          library: 'talon companion',
          context: ErrorDescription('loading the progressive frost shader'),
        ),
      );
    }
  }

  @override
  void dispose() {
    _shader?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dpr = MediaQuery.devicePixelRatioOf(context);
    return Stack(
      fit: StackFit.expand,
      children: [
        widget.child,
        if (ui.ImageFilter.isShaderFilterSupported && _program != null)
          Positioned.fill(
            child: IgnorePointer(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  if (!constraints.maxHeight.isFinite ||
                      constraints.maxHeight <= 0) {
                    return const SizedBox.shrink();
                  }
                  final height = widget.extent.clamp(
                    0.0,
                    constraints.maxHeight,
                  );
                  final solid = (widget.solidUntil / height).clamp(0.0, 0.95);
                  final shader = _shader ??= _program!.fragmentShader();
                  // Slots 0-1 are the engine-provided input texture size.
                  shader
                    ..setFloat(2, TopEdgeFrost.radius * dpr)
                    ..setFloat(3, solid);
                  return Align(
                    alignment: Alignment.topCenter,
                    child: SizedBox(
                      width: double.infinity,
                      height: height,
                      child: ClipRect(
                        child: BackdropFilter(
                          filter: ui.ImageFilter.shader(shader),
                          child: const SizedBox.expand(),
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
