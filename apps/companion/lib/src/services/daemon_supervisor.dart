import 'dart:async';
import 'dart:io';

import '../models/connection.dart';
import 'bridge_client.dart';

enum DaemonPhase { unknown, probing, launching, attached, failed }

class DaemonState {
  final DaemonPhase phase;
  final String? detail;
  const DaemonState(this.phase, [this.detail]);
}

/// Desktop-only supervisor that realises the "auto-start if not running, else
/// attach" behaviour. On mobile this is never used — the app connects to a
/// remote bridge instead.
///
/// It launches the daemon with `TALON_FRONTEND_OVERRIDE=desktop` so a user who
/// normally runs Telegram/Discord still gets a desktop bridge for the app,
/// without their saved config being rewritten.
class DaemonSupervisor {
  final ConnectionConfig config;
  Process? _process;

  DaemonSupervisor(this.config);

  /// Returns true if a desktop bridge is reachable, launching one if needed.
  /// Emits progress through [onPhase].
  Future<bool> ensureRunning(void Function(DaemonState) onPhase) async {
    final probe = BridgeClient(config);
    try {
      onPhase(const DaemonState(DaemonPhase.probing, 'Looking for Talon…'));
      if (await probe.health() != null) {
        onPhase(const DaemonState(DaemonPhase.attached, 'Attached'));
        return true;
      }

      if (!config.canManageDaemon) {
        onPhase(const DaemonState(
            DaemonPhase.failed, 'No daemon and not managing one here'));
        return false;
      }

      onPhase(const DaemonState(DaemonPhase.launching, 'Starting Talon…'));
      final launched = await _launch();
      if (!launched.ok) {
        onPhase(DaemonState(DaemonPhase.failed, launched.detail));
        return false;
      }

      // Poll for the bridge to come up (plugins/backends can take a while).
      final deadline = DateTime.now().add(const Duration(seconds: 35));
      while (DateTime.now().isBefore(deadline)) {
        if (await probe.health() != null) {
          onPhase(const DaemonState(DaemonPhase.attached, 'Started'));
          return true;
        }
        await Future<void>.delayed(const Duration(milliseconds: 600));
      }
      onPhase(const DaemonState(
          DaemonPhase.failed, 'Talon did not come up in time'));
      return false;
    } finally {
      probe.dispose();
    }
  }

  Future<({bool ok, String? detail})> _launch() async {
    try {
      _process = await Process.start(
        config.launchCommand,
        config.launchArgs,
        environment: {'TALON_FRONTEND_OVERRIDE': 'desktop'},
        mode: ProcessStartMode.detachedWithStdio,
        runInShell: true,
      );
      return (ok: true, detail: null);
    } on ProcessException catch (e) {
      return (
        ok: false,
        detail: 'Could not run "${config.launchCommand}": ${e.message}. '
            'Install the Talon CLI or set a launch command in Settings.'
      );
    } catch (e) {
      return (ok: false, detail: e.toString());
    }
  }

  /// Restart the daemon via the CLI (`talon restart`), preserving the desktop
  /// frontend override. Used by the Settings "Restart Talon" action so config
  /// changes that need a fresh boot take effect.
  Future<({bool ok, String? detail})> restart() async {
    if (!config.canManageDaemon) {
      return (ok: false, detail: 'Restart is only available for a local daemon');
    }
    try {
      await Process.start(
        config.launchCommand,
        const ['restart'],
        environment: {'TALON_FRONTEND_OVERRIDE': 'desktop'},
        mode: ProcessStartMode.detachedWithStdio,
        runInShell: true,
      );
      return (ok: true, detail: null);
    } catch (e) {
      return (ok: false, detail: e.toString());
    }
  }

  /// Best-effort: lets go of any child we spawned (we don't own an attached
  /// daemon's lifecycle).
  void detach() {
    _process = null;
  }
}
