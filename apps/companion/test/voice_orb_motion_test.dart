import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/state/voice_session.dart';
import 'package:talon_companion/src/ui/voice_mode_screen.dart';

void main() {
  group('voice orb ambient motion', () {
    test('every animated phase is identical at the loop boundary', () {
      for (final phase in [
        VoicePhase.arming,
        VoicePhase.recovering,
        VoicePhase.speaking,
        VoicePhase.thinking,
      ]) {
        final start = sampleOrbMotion(
          t: 0,
          phase: phase,
          level: 0,
          muted: false,
        );
        final end = sampleOrbMotion(
          t: 1,
          phase: phase,
          level: 0,
          muted: false,
        );

        expect(end.energy, closeTo(start.energy, 1e-12));
        for (var i = 0; i < 3; i++) {
          expect(
            (end.blobOffset(i) - start.blobOffset(i)).distance,
            lessThan(1e-12),
            reason: '${phase.name} blob $i must not teleport',
          );
          expect(
            end.blobRadiusFactor(i),
            closeTo(start.blobRadiusFactor(i), 1e-12),
          );
        }
        for (var i = 0; i < 2; i++) {
          expect(end.ringOpacity(i), start.ringOpacity(i));
        }
      }
    });

    test('approaches the loop seam continuously', () {
      final before = sampleOrbMotion(
        t: 1 - 1e-6,
        phase: VoicePhase.recovering,
        level: 0,
        muted: false,
      );
      final after = sampleOrbMotion(
        t: 0,
        phase: VoicePhase.recovering,
        level: 0,
        muted: false,
      );

      expect((before.energy - after.energy).abs(), lessThan(1e-5));
      for (var i = 0; i < 3; i++) {
        expect(
          (before.blobOffset(i) - after.blobOffset(i)).distance,
          lessThan(1e-4),
        );
        expect(
          (before.blobRadiusFactor(i) - after.blobRadiusFactor(i)).abs(),
          lessThan(1e-4),
        );
      }
      for (var i = 0; i < 2; i++) {
        expect(
          (before.ringOpacity(i) - after.ringOpacity(i)).abs(),
          lessThan(1e-6),
        );
      }
    });

    test('silence recovery and recognizer arming share one breath', () {
      for (final t in [0.0, 0.13, 0.37, 0.72, 0.99]) {
        final arming = sampleOrbMotion(
          t: t,
          phase: VoicePhase.arming,
          level: 0,
          muted: false,
        );
        final recovering = sampleOrbMotion(
          t: t,
          phase: VoicePhase.recovering,
          level: 0,
          muted: false,
        );

        expect(recovering.energy, arming.energy);
        for (var i = 0; i < 3; i++) {
          expect(recovering.blobOffset(i), arming.blobOffset(i));
          expect(
            recovering.blobRadiusFactor(i),
            arming.blobRadiusFactor(i),
          );
        }
      }
    });

    test('pulse rings fade out at every radius wrap', () {
      for (final (t, wrappingRing) in [
        (0.0, 0),
        (0.25, 1),
        (0.5, 0),
        (0.75, 1),
        (1.0, 0),
      ]) {
        final sample = sampleOrbMotion(
          t: t,
          phase: VoicePhase.recovering,
          level: 0,
          muted: false,
        );
        expect(sample.ringOpacity(wrappingRing), closeTo(0, 1e-12));
      }
    });
  });
}
