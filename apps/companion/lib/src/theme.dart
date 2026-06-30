import 'package:flutter/material.dart';

/// The Talon visual language: a deep, near-black canvas under a soft indigo→cyan
/// glow, frosted glass panels, and a single vivid accent. Tuned for the "modern
/// dark, glassy" look — gradients, translucency, rounded geometry.
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

  // Accent — electric indigo with a cyan partner for gradients/glow
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
          bodyMedium: const TextStyle(fontSize: 14.5, height: 1.5),
          titleMedium: const TextStyle(fontWeight: FontWeight.w600),
        ),
    splashFactory: InkSparkle.splashFactory,
    dividerColor: TalonColors.glassStroke,
    iconTheme: const IconThemeData(color: TalonColors.textDim, size: 20),
    tooltipTheme: const TooltipThemeData(
      decoration: BoxDecoration(
        color: TalonColors.surfaceHi,
        borderRadius: BorderRadius.all(Radius.circular(8)),
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
