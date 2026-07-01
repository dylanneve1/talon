import 'package:flutter/material.dart';

/// The Talon visual language: a deep, near-black canvas with restrained, mostly
/// monochrome surfaces and a single vivid accent used sparingly. The old build
/// leaned on gradients + colored glows on nearly every control, which read as
/// "consumer / flashy"; the design now favours calm, flat surfaces and lets
/// motion (see [TalonMotion] + flutter_animate) carry the delight instead.
class TalonColors {
  TalonColors._();

  // Base canvas
  static const Color void0 = Color(0xFF07070C); // deepest background
  static const Color void1 = Color(0xFF0C0D16); // panels base
  static const Color surface = Color(0xFF13141F); // raised surface
  static const Color surfaceHi = Color(0xFF1B1D2B); // hover / selected

  // Glass strokes & fills (used with opacity over the gradient backdrop)
  static const Color glassFill = Color(0x14FFFFFF);
  static const Color glassStroke = Color(0x1FFFFFFF);

  // Accent — electric indigo with a cyan partner reserved for the gradient
  // brand mark and the rare hero moment (never every button).
  static const Color accent = Color(0xFF7C8CFF);
  static const Color accent2 = Color(0xFF54E6FF);
  static const Color accentDeep = Color(0xFF5B6BF0);

  // Text
  static const Color text = Color(0xFFEDEEF7);
  static const Color textDim = Color(0xFFA6A9C2);
  static const Color textFaint = Color(0xFF6F7392);

  // Status
  static const Color ok = Color(0xFF49E2A0);
  static const Color warn = Color(0xFFFFC56B);
  static const Color bad = Color(0xFFFF6B81);

  // Bubbles
  static const Color userBubbleA = Color(0xFF6B79F5);
  static const Color userBubbleB = Color(0xFF7C8CFF);
  static const Color assistantBubble = Color(0xFF161826);

  /// Backdrop gradient painted behind everything.
  static const LinearGradient backdrop = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF0A0B13), Color(0xFF07070C), Color(0xFF0B0A12)],
  );

  static const LinearGradient accentGradient = LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [accent, accent2],
  );
}

/// Spacing scale — an 8pt grid (with a 2/4 half-step for tight insets). Snap
/// every padding/gap to one of these so the layout reads as a system rather
/// than a pile of hand-tuned magic numbers.
class TalonSpace {
  TalonSpace._();

  static const double xxs = 2;
  static const double xs = 4;
  static const double sm = 8;
  static const double md = 12;
  static const double lg = 16;
  static const double xl = 24;
  static const double xxl = 32;
}

/// Corner-radius tokens. Three steps + a full pill; everything rounds to one of
/// these so panels, cards, and controls feel related.
class TalonRadius {
  TalonRadius._();

  static const double sm = 8; // chips, small controls
  static const double md = 14; // cards, inputs, buttons
  static const double lg = 22; // panels, sheets
  static const double pill = 999;

  static const BorderRadius rSm = BorderRadius.all(Radius.circular(sm));
  static const BorderRadius rMd = BorderRadius.all(Radius.circular(md));
  static const BorderRadius rLg = BorderRadius.all(Radius.circular(lg));
  static const BorderRadius rPill = BorderRadius.all(Radius.circular(pill));
}

/// Type scale. Named, deliberate sizes replace the scattered 15.5/14.5/13.5/…
/// literals so the whole app can be re-tuned in one place and stays consistent.
class TalonType {
  TalonType._();

  static const TextStyle display = TextStyle(
    fontSize: 22,
    height: 1.2,
    fontWeight: FontWeight.w700,
    color: TalonColors.text,
  );

  static const TextStyle title = TextStyle(
    fontSize: 16,
    height: 1.3,
    fontWeight: FontWeight.w700,
    color: TalonColors.text,
  );

  static const TextStyle subtitle = TextStyle(
    fontSize: 14,
    height: 1.3,
    fontWeight: FontWeight.w600,
    color: TalonColors.text,
  );

  static const TextStyle body = TextStyle(
    fontSize: 14,
    height: 1.5,
    color: TalonColors.text,
  );

  static const TextStyle label = TextStyle(
    fontSize: 13,
    height: 1.3,
    color: TalonColors.textDim,
  );

  static const TextStyle caption = TextStyle(
    fontSize: 12,
    height: 1.4,
    color: TalonColors.textFaint,
  );

  /// All-caps section eyebrow (sidebar groups, settings section headers).
  static const TextStyle eyebrow = TextStyle(
    fontSize: 11,
    height: 1.2,
    fontWeight: FontWeight.w700,
    letterSpacing: 1.1,
    color: TalonColors.textFaint,
  );

  /// Monospace for tool names, code, tabular readouts.
  static const TextStyle mono = TextStyle(
    fontFamily: 'monospace',
    fontSize: 13,
    height: 1.4,
    color: TalonColors.text,
  );
}

/// Shared motion vocabulary so every surface animates with the same rhythm.
/// Durations climb in a consistent scale; curves favour a soft, "emphasized"
/// deceleration (fast out, gentle settle) that reads as calm rather than
/// bouncy. Keep transitions here so the whole app can be retuned in one place.
class TalonMotion {
  TalonMotion._();

  /// Taps, toggles, small state flips.
  static const Duration fast = Duration(milliseconds: 140);

  /// The default for most transitions (pane swaps, entrances).
  static const Duration base = Duration(milliseconds: 240);

  /// Larger, more deliberate moves (expanding panels, first paint).
  static const Duration slow = Duration(milliseconds: 360);

  /// Per-item offset for staggered list entrances (sidebar, model list).
  static const Duration stagger = Duration(milliseconds: 45);

  /// Standard deceleration — fast to start, easing gently into place.
  static const Curve emphasized = Curves.easeOutCubic;

  /// Symmetric ease for reversible states (selected ⇄ idle).
  static const Curve standard = Curves.easeInOutCubic;
}

ThemeData buildTalonTheme() {
  final base = ThemeData.dark(useMaterial3: true);
  const accent = TalonColors.accent;

  return base.copyWith(
    scaffoldBackgroundColor: TalonColors.void0,
    colorScheme: base.colorScheme.copyWith(
      brightness: Brightness.dark,
      primary: accent,
      secondary: TalonColors.accent2,
      surface: TalonColors.surface,
      onSurface: TalonColors.text,
      error: TalonColors.bad,
    ),
    textTheme: base.textTheme
        .apply(
          bodyColor: TalonColors.text,
          displayColor: TalonColors.text,
          fontFamily: _fontFamily,
        )
        .copyWith(
          bodyMedium: TalonType.body,
          titleMedium: const TextStyle(fontWeight: FontWeight.w600),
        ),
    splashFactory: InkSparkle.splashFactory,
    dividerColor: TalonColors.glassStroke,
    iconTheme: const IconThemeData(color: TalonColors.textDim, size: 20),
    tooltipTheme: const TooltipThemeData(
      decoration: BoxDecoration(
        color: TalonColors.surfaceHi,
        borderRadius: TalonRadius.rSm,
      ),
      textStyle: TextStyle(color: TalonColors.text, fontSize: 12),
    ),
    scrollbarTheme: ScrollbarThemeData(
      thumbColor: WidgetStatePropertyAll(Colors.white.withValues(alpha: 0.12)),
      thickness: const WidgetStatePropertyAll(6),
      radius: const Radius.circular(8),
    ),
    // Material 3's default selected-track has no outline and a thumb that
    // can end up the same color as the track (see settings_screen.dart's
    // _switchRow), reading as a solid undifferentiated pill against this
    // theme's dark glass surfaces. Give both states an explicit border and
    // a thumb that always contrasts against its track.
    switchTheme: SwitchThemeData(
      trackColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.selected)
              ? TalonColors.accent
              : TalonColors.surfaceHi),
      trackOutlineColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.selected)
              ? TalonColors.accentDeep
              : TalonColors.glassStroke),
      trackOutlineWidth: const WidgetStatePropertyAll(1.4),
      thumbColor: WidgetStateProperty.resolveWith((states) =>
          states.contains(WidgetState.selected)
              ? Colors.white
              : TalonColors.textDim),
    ),
  );
}

/// Prefer a clean system UI font; Flutter falls back per-platform when absent.
const String? _fontFamily = null;
