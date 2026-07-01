import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/theme.dart';

void main() {
  tearDown(() {
    // Restore the default so other suites see the dark palette.
    TalonTheme.mode.value = ThemeMode.system;
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

  test('light palette keeps status colors distinguishable from text', () {
    // Guard against a light palette regression where faint text or status
    // colors collapse into the background.
    expect(kTalonLight.text.computeLuminance(),
        lessThan(kTalonLight.void0.computeLuminance()));
    expect(kTalonLight.ok, isNot(kTalonLight.text));
    expect(kTalonLight.bad, isNot(kTalonLight.warn));
  });
}
