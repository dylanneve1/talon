import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// The Talon visual language: a calm canvas with restrained, mostly
/// monochrome surfaces and a single vivid accent used sparingly. Ships in two
/// palettes — the original near-black dark theme and a soft paper-white light
/// theme — selected by [TalonTheme] (auto / light / dark).
class TalonPalette {
  final Brightness brightness;

  // Base canvas
  final Color void0; // deepest background
  final Color void1; // panels base
  final Color surface; // raised surface
  final Color surfaceHi; // hover / selected

  // Glass strokes & fills (used with opacity over the gradient backdrop)
  final Color glassFill;
  final Color glassStroke;

  // Accent — electric indigo with a cyan partner reserved for the gradient
  // brand mark and the rare hero moment (never every button).
  final Color accent;
  final Color accent2;
  final Color accentDeep;

  // Text
  final Color text;
  final Color textDim;
  final Color textFaint;

  // Status
  final Color ok;
  final Color warn;
  final Color bad;

  /// Backdrop gradient painted behind everything.
  final LinearGradient backdrop;

  const TalonPalette({
    required this.brightness,
    required this.void0,
    required this.void1,
    required this.surface,
    required this.surfaceHi,
    required this.glassFill,
    required this.glassStroke,
    required this.accent,
    required this.accent2,
    required this.accentDeep,
    required this.text,
    required this.textDim,
    required this.textFaint,
    required this.ok,
    required this.warn,
    required this.bad,
    required this.backdrop,
  });

  LinearGradient get accentGradient => LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [accent, accent2],
      );
}

const TalonPalette kTalonDark = TalonPalette(
  brightness: Brightness.dark,
  void0: Color(0xFF07070C),
  void1: Color(0xFF0C0D16),
  surface: Color(0xFF13141F),
  surfaceHi: Color(0xFF1B1D2B),
  glassFill: Color(0x14FFFFFF),
  glassStroke: Color(0x1FFFFFFF),
  accent: Color(0xFF7C8CFF),
  accent2: Color(0xFF54E6FF),
  accentDeep: Color(0xFF5B6BF0),
  text: Color(0xFFEDEEF7),
  textDim: Color(0xFFA6A9C2),
  textFaint: Color(0xFF6F7392),
  ok: Color(0xFF49E2A0),
  warn: Color(0xFFFFC56B),
  bad: Color(0xFFFF6B81),
  backdrop: LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFF0A0B13), Color(0xFF07070C), Color(0xFF0B0A12)],
  ),
);

/// Paper-white counterpart: same hues, deepened for contrast on light
/// surfaces (the dark theme's pastel accent and faint grays wash out on
/// white). Glass becomes ink-tinted instead of white-tinted.
const TalonPalette kTalonLight = TalonPalette(
  brightness: Brightness.light,
  void0: Color(0xFFF2F3F9),
  void1: Color(0xFFF9FAFD),
  surface: Color(0xFFFFFFFF),
  surfaceHi: Color(0xFFE9EBF6),
  glassFill: Color(0x0A10123B),
  glassStroke: Color(0x2210123B),
  accent: Color(0xFF5B6BF0),
  accent2: Color(0xFF0E9CC7),
  accentDeep: Color(0xFF4553D6),
  text: Color(0xFF191B2A),
  textDim: Color(0xFF4C5069),
  textFaint: Color(0xFF83879F),
  ok: Color(0xFF178F62),
  warn: Color(0xFFA9720A),
  bad: Color(0xFFDB3B52),
  backdrop: LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [Color(0xFFF0F1F8), Color(0xFFF7F8FC), Color(0xFFEDEFF7)],
  ),
);

/// Global theme selection: a persisted [mode] (auto/light/dark) resolved
/// against the platform brightness into the active [palette]. [revision]
/// bumps whenever the palette actually changes, so pushed routes (Settings,
/// Connect) can subscribe and repaint in place — the root app rebuilds via
/// its own listener in main.dart.
class TalonTheme {
  TalonTheme._();

  static final ValueNotifier<ThemeMode> mode = ValueNotifier(ThemeMode.system);
  static final ValueNotifier<int> revision = ValueNotifier(0);

  static TalonPalette _palette = kTalonDark;
  static TalonPalette get palette => _palette;
  static bool get isDark => _palette.brightness == Brightness.dark;

  /// Resolve [mode] against the platform brightness and swap the palette.
  static void apply(Brightness platformBrightness) {
    final dark = switch (mode.value) {
      ThemeMode.dark => true,
      ThemeMode.light => false,
      ThemeMode.system => platformBrightness == Brightness.dark,
    };
    final next = dark ? kTalonDark : kTalonLight;
    if (!identical(next, _palette)) {
      _palette = next;
      revision.value++;
    }
  }

  /// Restyle the OS chrome (Android status/navigation bars, iOS status bar)
  /// to match the active palette. Without this the bars keep their launch
  /// style, so switching themes visibly changes nothing outside the Flutter
  /// viewport — in light mode that means invisible white status icons.
  /// Separate from [apply] (and called from main.dart after it) because it
  /// needs a live binding, which pure palette resolution — and its tests —
  /// shouldn't require.
  static void syncSystemChrome() {
    final dark = isDark;
    SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
      statusBarColor: Colors.transparent,
      statusBarBrightness: _palette.brightness, // iOS
      statusBarIconBrightness:
          dark ? Brightness.light : Brightness.dark, // Android
      systemNavigationBarColor: _palette.void0,
      systemNavigationBarDividerColor: Colors.transparent,
      systemNavigationBarIconBrightness:
          dark ? Brightness.light : Brightness.dark,
    ));
  }
}

/// Color tokens. Same call sites as the original constants, now resolving
/// through the active [TalonTheme.palette] — which is why these can no longer
/// appear in `const` expressions.
class TalonColors {
  TalonColors._();

  static Color get void0 => TalonTheme.palette.void0;
  static Color get void1 => TalonTheme.palette.void1;
  static Color get surface => TalonTheme.palette.surface;
  static Color get surfaceHi => TalonTheme.palette.surfaceHi;
  static Color get glassFill => TalonTheme.palette.glassFill;
  static Color get glassStroke => TalonTheme.palette.glassStroke;
  static Color get accent => TalonTheme.palette.accent;
  static Color get accent2 => TalonTheme.palette.accent2;
  static Color get accentDeep => TalonTheme.palette.accentDeep;
  static Color get text => TalonTheme.palette.text;
  static Color get textDim => TalonTheme.palette.textDim;
  static Color get textFaint => TalonTheme.palette.textFaint;
  static Color get ok => TalonTheme.palette.ok;
  static Color get warn => TalonTheme.palette.warn;
  static Color get bad => TalonTheme.palette.bad;
  static LinearGradient get backdrop => TalonTheme.palette.backdrop;
  static LinearGradient get accentGradient =>
      TalonTheme.palette.accentGradient;
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

/// Type scale. Named, deliberate sizes replace scattered literals so the whole
/// app can be re-tuned in one place. Getters, not consts: they carry the
/// active palette's text colors.
class TalonType {
  TalonType._();

  static TextStyle get display => TextStyle(
        fontSize: 22,
        height: 1.2,
        fontWeight: FontWeight.w700,
        color: TalonColors.text,
      );

  static TextStyle get title => TextStyle(
        fontSize: 16,
        height: 1.3,
        fontWeight: FontWeight.w700,
        color: TalonColors.text,
      );

  static TextStyle get subtitle => TextStyle(
        fontSize: 14,
        height: 1.3,
        fontWeight: FontWeight.w600,
        color: TalonColors.text,
      );

  static TextStyle get body => TextStyle(
        fontSize: 14,
        height: 1.5,
        color: TalonColors.text,
      );

  static TextStyle get label => TextStyle(
        fontSize: 13,
        height: 1.3,
        color: TalonColors.textDim,
      );

  static TextStyle get caption => TextStyle(
        fontSize: 12,
        height: 1.4,
        color: TalonColors.textFaint,
      );

  /// All-caps section eyebrow (sidebar groups, settings section headers).
  static TextStyle get eyebrow => TextStyle(
        fontSize: 11,
        height: 1.2,
        fontWeight: FontWeight.w700,
        letterSpacing: 1.1,
        color: TalonColors.textFaint,
      );

  /// Monospace for tool names, code, tabular readouts.
  static TextStyle get mono => TextStyle(
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
  final dark = TalonTheme.isDark;
  final base = dark
      ? ThemeData.dark(useMaterial3: true)
      : ThemeData.light(useMaterial3: true);
  final accent = TalonColors.accent;

  return base.copyWith(
    scaffoldBackgroundColor: TalonColors.void0,
    colorScheme: base.colorScheme.copyWith(
      brightness: dark ? Brightness.dark : Brightness.light,
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
    // Pushed routes (Settings, Connect) use transparent AppBars over the
    // backdrop gradient. M3's defaults tint them on scroll and let the bar
    // impose its own system-chrome style — pin both so the bars stay part of
    // the canvas and the status bar keeps the palette's icon brightness.
    appBarTheme: base.appBarTheme.copyWith(
      backgroundColor: Colors.transparent,
      foregroundColor: TalonColors.text,
      elevation: 0,
      scrolledUnderElevation: 0,
      surfaceTintColor: Colors.transparent,
      titleTextStyle: TalonType.title.copyWith(fontSize: 18),
      systemOverlayStyle: SystemUiOverlayStyle(
        statusBarColor: Colors.transparent,
        statusBarBrightness: dark ? Brightness.dark : Brightness.light,
        statusBarIconBrightness: dark ? Brightness.light : Brightness.dark,
        systemNavigationBarColor: TalonColors.void0,
        systemNavigationBarIconBrightness:
            dark ? Brightness.light : Brightness.dark,
      ),
    ),
    dividerColor: TalonColors.glassStroke,
    iconTheme: IconThemeData(color: TalonColors.textDim, size: 20),
    tooltipTheme: TooltipThemeData(
      decoration: BoxDecoration(
        color: TalonColors.surfaceHi,
        borderRadius: TalonRadius.rSm,
      ),
      textStyle: TextStyle(color: TalonColors.text, fontSize: 12),
    ),
    scrollbarTheme: ScrollbarThemeData(
      thumbColor:
          WidgetStatePropertyAll(TalonColors.text.withValues(alpha: 0.12)),
      thickness: const WidgetStatePropertyAll(6),
      radius: const Radius.circular(8),
    ),
    // Material 3's default selected-track has no outline and a thumb that
    // can end up the same color as the track (see settings_screen.dart's
    // _switchRow), reading as a solid undifferentiated pill against this
    // theme's glass surfaces. Give both states an explicit border and
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
