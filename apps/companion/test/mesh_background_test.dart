import 'package:flutter_test/flutter_test.dart';
import 'package:talon_companion/src/services/mesh_background.dart';

void main() {
  group('evaluateMeshForegroundHealth', () {
    test('does not bounce during the fresh-start grace window', () {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: true,
        nowMs: 20 * 1000,
        aliveAtMs: null,
        startedAtMs: 10 * 1000,
      );

      expect(health.kind, MeshForegroundHealthKind.starting);
      expect(health.shouldBounce, isFalse);
    });

    test('bounces a running service with no alive stamp after grace', () {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: true,
        nowMs: 45 * 1000,
        aliveAtMs: null,
        startedAtMs: 10 * 1000,
      );

      expect(health.kind, MeshForegroundHealthKind.stale);
      expect(health.shouldBounce, isTrue);
    });

    test('keeps a recently alive running service', () {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: true,
        nowMs: 100 * 1000,
        aliveAtMs: 30 * 1000,
        startedAtMs: 0,
      );

      expect(health.kind, MeshForegroundHealthKind.healthy);
      expect(health.shouldBounce, isFalse);
    });

    test('bounces a running service with a stale alive stamp', () {
      final health = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: true,
        nowMs: 200 * 1000,
        aliveAtMs: 30 * 1000,
        startedAtMs: 0,
      );

      expect(health.kind, MeshForegroundHealthKind.stale);
      expect(health.shouldBounce, isTrue);
    });

    test('does not bounce when sharing is disabled or service is stopped', () {
      final disabled = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: false,
        serviceRunning: true,
        nowMs: 200 * 1000,
        aliveAtMs: null,
        startedAtMs: 0,
      );
      final stopped = evaluateMeshForegroundHealth(
        supported: true,
        sharingEnabled: true,
        serviceRunning: false,
        nowMs: 200 * 1000,
        aliveAtMs: null,
        startedAtMs: 0,
      );

      expect(disabled.shouldBounce, isFalse);
      expect(stopped.shouldBounce, isFalse);
    });
  });
}
