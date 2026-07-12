import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/theme.dart';

void main() {
  tearDown(() {
    // Restore the default so other suites see the dark palette.
    TalonTheme.mode.value = ThemeMode.system;
    TalonTheme.accentSeed.value = null;
    TalonTheme.apply(Brightness.dark);
  });

  test('explicit modes override the platform brightness', () {
    TalonTheme.mode.value = ThemeMode.dark;
    TalonTheme.apply(Brightness.light);
    expect(TalonTheme.isDark, isTrue);

    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.dark);
    expect(TalonTheme.isDark, isFalse);
    expect(TalonColors.text, kTalonLight.text);
  });

  test('auto follows the platform brightness', () {
    TalonTheme.mode.value = ThemeMode.system;
    TalonTheme.apply(Brightness.dark);
    expect(TalonTheme.isDark, isTrue);
    expect(TalonColors.void0, kTalonDark.void0);

    TalonTheme.apply(Brightness.light);
    expect(TalonTheme.isDark, isFalse);
    expect(TalonColors.void0, kTalonLight.void0);
  });

  test('revision bumps only on an actual palette change', () {
    TalonTheme.mode.value = ThemeMode.dark;
    TalonTheme.apply(Brightness.dark);
    final before = TalonTheme.revision.value;
    TalonTheme.apply(Brightness.light); // still dark — forced mode
    expect(TalonTheme.revision.value, before);
    TalonTheme.mode.value = ThemeMode.light;
    TalonTheme.apply(Brightness.dark);
    expect(TalonTheme.revision.value, before + 1);
  });

  test('custom accent re-tints the palette and bumps revision', () {
    TalonTheme.mode.value = ThemeMode.dark;
    TalonTheme.apply(Brightness.dark);
    final before = TalonTheme.revision.value;

    TalonTheme.accentSeed.value = const Color(0xFF3ED598); // emerald
    TalonTheme.apply(Brightness.dark);
    expect(TalonTheme.revision.value, before + 1);
    expect(TalonColors.accent, isNot(kTalonDark.accent));
    // Canvas + text are untouched — only the accent triple changes.
    expect(TalonColors.void0, kTalonDark.void0);
    expect(TalonColors.text, kTalonDark.text);

    // Re-applying the same seed is a no-op.
    TalonTheme.apply(Brightness.dark);
    expect(TalonTheme.revision.value, before + 1);

    // Clearing the seed restores the handcrafted accent.
    TalonTheme.accentSeed.value = null;
    TalonTheme.apply(Brightness.dark);
    expect(TalonColors.accent, kTalonDark.accent);
  });

  test('accent derivation keeps contrast on both canvases', () {
    for (final (_, seed) in TalonAccents.presets) {
      final dark = TalonAccents.derive(kTalonDark, seed);
      final light = TalonAccents.derive(kTalonLight, seed);
      final dl = HSLColor.fromColor(dark.accent).lightness;
      final ll = HSLColor.fromColor(light.accent).lightness;
      // Visible on near-black…
      expect(dl, greaterThanOrEqualTo(0.55), reason: 'dark accent $seed');
      // …and readable on paper-white.
      expect(ll, lessThanOrEqualTo(0.50), reason: 'light accent $seed');
      // accentDeep is always darker than accent.
      expect(
        dark.accentDeep.computeLuminance(),
        lessThan(dark.accent.computeLuminance()),
      );
    }
  });

  test('light palette keeps status colors distinguishable from text', () {
    // Guard against a light palette regression where faint text or status
    // colors collapse into the background.
    expect(kTalonLight.text.computeLuminance(),
        lessThan(kTalonLight.void0.computeLuminance()));
    expect(kTalonLight.ok, isNot(kTalonLight.text));
    expect(kTalonLight.bad, isNot(kTalonLight.warn));
  });
}
