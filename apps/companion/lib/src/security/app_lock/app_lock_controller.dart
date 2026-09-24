import 'dart:async';
import 'dart:io' show Platform;
import 'dart:typed_data';

import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart' show AppLifecycleState;

import '../../services/log.dart';
import '../../services/prefs.dart';
import 'biometrics.dart';
import 'envelope.dart';
import 'lock_record.dart';
import 'passcode_kdf.dart';
import 'secret_store.dart';
import 'snapshot_cipher.dart';

enum AppLockStatus {
  /// No app lock configured.
  disabled,

  /// Configured and the UI is covered by the lock screen.
  locked,

  /// Configured and the user is in.
  unlocked,
}

enum UnlockOutcome {
  success,
  wrongPasscode,

  /// Too soon after a failure — see [UnlockResult.retryAfter].
  throttled,

  /// That failure crossed the "erase after N attempts" threshold: the lock,
  /// the cached chats and the connection are gone.
  wiped,

  /// Another attempt is still being checked.
  busy,

  /// The lock isn't loaded (or can't be read) — nothing to check against.
  unavailable,
}

class UnlockResult {
  final UnlockOutcome outcome;
  final Duration retryAfter;

  /// Attempts left before the connection is erased, when that is enabled.
  final int? attemptsLeft;

  const UnlockResult(
    this.outcome, {
    this.retryAfter = Duration.zero,
    this.attemptsLeft,
  });

  bool get ok => outcome == UnlockOutcome.success;
}

/// A mesh command waiting for the person holding the device to approve it.
class PendingApproval {
  PendingApproval._(this.command, this.requestedAt);

  final String command;
  final DateTime requestedAt;
  final Completer<bool> _done = Completer<bool>();

  Future<bool> get result => _done.future;
}

/// The app lock (#1051): an optional passcode (+ biometrics) in front of the
/// UI and the cached chat snapshot.
///
/// What it guards, and what it deliberately doesn't:
///   * The **UI**: locked on cold start and after [timeout] in the background
///     or idle. Only the widgets wait — the bridge connection, the SSE stream
///     and the Android background mesh keep running while locked.
///   * The **chat snapshot at rest**: while the lock is on, the offline
///     snapshot is sealed (AES-256-GCM) with a random data key, which is
///     stored only wrapped under a passcode-derived key (Argon2id) and, if
///     enabled, behind the platform's biometric gate. The key is released on
///     unlock and then kept in memory for the life of the process, so saves
///     keep working while the UI is re-locked in the background.
///   * **Not** the mesh credential: the background service must keep a usable
///     credential while locked, or locking the app would take the device off
///     the mesh.
///   * Optionally, **device-control commands** from the mesh: with
///     [requireUnlockForElevated], each burst needs an on-device approval
///     (passcode or biometrics) — see [approveCommand].
///
/// Checks run on cold start and on lifecycle changes only; the per-input cost
/// is one integer store in [noteActivity].
class AppLockController extends ChangeNotifier {
  AppLockController({
    required this.prefs,
    required SecretStore store,
    required SealedSnapshotStore sealedSnapshots,
    BiometricUnlocker biometrics = const NoBiometrics(),
    PasscodeDeriver deriver = const Argon2PasscodeDeriver(),
    SnapshotCipher cipher = const SnapshotCipher(),
    KdfParams kdfParams = KdfParams.standard,
    DateTime Function()? clock,
  })  : _store = store,
        _sealed = sealedSnapshots,
        _biometrics = biometrics,
        _deriver = deriver,
        _cipher = cipher,
        _kdfParams = kdfParams,
        _clock = clock ?? DateTime.now,
        // The prefs mirror is readable synchronously, so the very first frame
        // already knows to cover the UI; the record itself loads async.
        _status = prefs.appLockEnabled
            ? AppLockStatus.locked
            : AppLockStatus.disabled {
    _lastActivity = _clock();
    Prefs.sealedSnapshotSink = _onSnapshotSave;
  }

  /// The platform-backed controller the app uses.
  factory AppLockController.platform(Prefs prefs) {
    final linux = !kIsWeb && Platform.isLinux;
    return AppLockController(
      prefs: prefs,
      store: linux
          ? FallbackSecretStore(PlatformSecretStore(), FileSecretStore())
          : PlatformSecretStore(),
      sealedSnapshots: FileSealedSnapshotStore(),
      biometrics: linux ? const NoBiometrics() : PlatformBiometrics(),
    );
  }

  static const String recordKey = 'record.v1';
  static const String _dataKeyAad = 'talon.applock.datakey.v1';

  /// How long one on-device approval covers further device-control commands
  /// (a teleport session is dozens of them).
  static const Duration approvalWindow = Duration(minutes: 5);

  /// How long a command waits for someone to answer the approval prompt.
  static const Duration approvalTimeout = Duration(seconds: 60);

  static const String deniedInBackground =
      'Denied on the device: it requires local approval for device-control '
      'commands and the Talon app is not open. Open Talon on the device and '
      'try again.';
  static const String deniedByUser =
      'Denied on the device: local approval was declined or timed out.';

  /// Lock-timeout choices offered in Settings, in seconds (0 = immediately).
  static const List<int> timeoutChoices = [0, 60, 300, 900, 3600];

  /// "Erase connection after N failed attempts" threshold, when enabled.
  static const int wipeThreshold = 10;

  final Prefs prefs;
  final SecretStore _store;
  final SealedSnapshotStore _sealed;
  final BiometricUnlocker _biometrics;
  final PasscodeDeriver _deriver;
  final SnapshotCipher _cipher;
  final KdfParams _kdfParams;
  final DateTime Function() _clock;

  /// Receives the decrypted snapshot the first time the app is unlocked in
  /// this process (AppState.restoreSnapshot).
  void Function(Map<String, dynamic> snapshot)? onSnapshotUnsealed;

  /// Drops the connection (AppState.forgetConnection) — run by a reset.
  Future<void> Function()? onWipe;

  AppLockStatus _status;
  AppLockRecord? _record;
  Uint8List? _dataKey;
  bool _ready = false;
  bool _storeError = false;
  bool _verifying = false;
  bool _biometricsAvailable = false;
  bool _hydrated = false;
  bool _disposed = false;
  Future<void>? _loading;

  bool _foreground = true;
  DateTime? _backgroundedAt;
  late DateTime _lastActivity;
  Timer? _idleTimer;

  Map<String, dynamic>? _deferredSnapshot;
  Future<void> _writes = Future<void>.value();

  final List<Completer<void>> _unlockWaiters = [];

  PendingApproval? _pending;
  DateTime? _approvedUntil;

  // ── State ────────────────────────────────────────────────────────────────

  AppLockStatus get status => _status;
  bool get enabled => _status != AppLockStatus.disabled;
  bool get locked => _status == AppLockStatus.locked;

  /// The stored lock has been read (or found absent).
  bool get ready => _ready;

  /// The lock is on but its record couldn't be read — only a reset helps.
  bool get storeError => _storeError;

  /// A passcode is being checked (the KDF takes a moment).
  bool get verifying => _verifying;

  bool get numericPasscode => _record?.numeric ?? false;
  bool get biometricsEnabled => _record?.biometrics ?? false;
  bool get biometricsAvailable => _biometricsAvailable;
  String get biometricsLabel => _biometrics.label;
  Duration get timeout =>
      Duration(seconds: _record?.timeoutSeconds ?? AppLockRecord.defaultTimeoutSeconds);
  int? get wipeAfter => _record?.wipeAfter;
  bool get requireUnlockForElevated =>
      _record?.requireUnlockForElevated ?? false;
  int get failedAttempts => _record?.failedAttempts ?? 0;
  PendingApproval? get pendingApproval => _pending;

  /// Time left before another passcode attempt is accepted.
  Duration get retryAfter {
    final record = _record;
    final at = record?.lastFailureAtMs;
    if (record == null || at == null) return Duration.zero;
    final delay = unlockDelayAfter(record.failedAttempts);
    final elapsed = _clock().millisecondsSinceEpoch - at;
    if (elapsed < 0) return delay; // clock went backwards: full wait
    final left = delay.inMilliseconds - elapsed;
    return left <= 0 ? Duration.zero : Duration(milliseconds: left);
  }

  /// Completes once the UI is unlocked (immediately when it isn't locked).
  Future<void> whenUnlocked() {
    if (_status != AppLockStatus.locked) return Future<void>.value();
    final c = Completer<void>();
    _unlockWaiters.add(c);
    return c.future;
  }

  // ── Loading ──────────────────────────────────────────────────────────────

  Future<void> load() => _loading ??= _load();

  Future<void> _load() async {
    AppLockRecord? record;
    var readFailed = false;
    try {
      final raw = await _store.read(recordKey);
      if (raw != null) record = AppLockRecord.decode(raw);
    } catch (e) {
      readFailed = true;
      AppLog.warn('app_lock', 'lock record unreadable', e);
    }
    if (record == null) {
      if (readFailed && prefs.appLockEnabled) {
        // On, but unreadable: stay locked. The lock screen offers the reset.
        _storeError = true;
        _status = AppLockStatus.locked;
      } else {
        if (prefs.appLockEnabled) {
          // The record is gone (reinstall, keystore reset). Without it the
          // sealed snapshot can never be opened again — clean up.
          AppLog.warn('app_lock', 'lock record missing; turning the lock off');
          await _dropLocalState();
        }
        _setStatus(AppLockStatus.disabled);
      }
    } else {
      _record = record;
      if (!prefs.appLockEnabled) {
        // Interrupted while turning the lock on: finish the job. Anything left
        // in the plaintext cache can't be sealed without the key — drop it.
        await prefs.setAppLockEnabled(true);
        await prefs.clearPlainSnapshot();
      }
      await prefs.setAppLockElevatedGate(record.requireUnlockForElevated);
      if (_status == AppLockStatus.disabled) _status = AppLockStatus.locked;
    }
    _biometricsAvailable = await _biometrics.isAvailable();
    _ready = true;
    _notify();
  }

  // ── Lifecycle / idle ─────────────────────────────────────────────────────

  /// Fed from the app's lifecycle observer. Locks on return when the app was
  /// away for [timeout] or longer ("immediately" locks as it leaves, so the
  /// app-switcher snapshot is the lock screen too).
  void onLifecycle(AppLifecycleState state) {
    final now = _clock();
    switch (state) {
      case AppLifecycleState.resumed:
        _foreground = true;
        final away = _backgroundedAt;
        _backgroundedAt = null;
        if (_status == AppLockStatus.unlocked &&
            away != null &&
            now.difference(away) >= timeout) {
          lockNow();
        } else {
          _lastActivity = now;
          _armIdleTimer();
        }
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
        _foreground = false;
        _backgroundedAt ??= now;
        _idleTimer?.cancel();
        // Nobody can answer an approval prompt from the background.
        _resolvePending(false);
        if (_status == AppLockStatus.unlocked && timeout == Duration.zero) {
          lockNow();
        }
      case AppLifecycleState.inactive:
      case AppLifecycleState.detached:
        break;
    }
  }

  /// Any user input. Deliberately trivial — it runs per pointer/key event.
  void noteActivity() => _lastActivity = _clock();

  void _armIdleTimer() {
    _idleTimer?.cancel();
    _idleTimer = null;
    if (_status != AppLockStatus.unlocked || !_foreground) return;
    final t = timeout;
    if (t == Duration.zero) return; // "immediately" means on leaving
    _idleTimer = Timer(t, _onIdleCheck);
  }

  void _onIdleCheck() {
    _idleTimer = null;
    if (_status != AppLockStatus.unlocked || !_foreground) return;
    final idle = _clock().difference(_lastActivity);
    final t = timeout;
    if (idle >= t) {
      lockNow();
    } else {
      _idleTimer = Timer(t - idle, _onIdleCheck);
    }
  }

  void lockNow() {
    if (_status != AppLockStatus.unlocked) return;
    _idleTimer?.cancel();
    _idleTimer = null;
    _setStatus(AppLockStatus.locked);
  }

  // ── Unlocking ────────────────────────────────────────────────────────────

  Future<UnlockResult> unlockWithPasscode(String passcode) async {
    final (result, key) = await _verify(passcode);
    if (key != null) await _onUnlocked(key);
    return result;
  }

  Future<bool> unlockWithBiometrics() async {
    final key = await _biometricKey('Unlock Talon');
    if (key == null) return false;
    await _onUnlocked(key);
    return true;
  }

  /// Check [passcode]; on success hand back the data key. Counts failures,
  /// enforces the backoff, and erases everything at the wipe threshold.
  Future<(UnlockResult, Uint8List?)> _verify(String passcode) async {
    final record = _record;
    if (!_ready || record == null) {
      return (const UnlockResult(UnlockOutcome.unavailable), null);
    }
    final wait = retryAfter;
    if (wait > Duration.zero) {
      return (UnlockResult(UnlockOutcome.throttled, retryAfter: wait), null);
    }
    if (_verifying) return (const UnlockResult(UnlockOutcome.busy), null);
    _verifying = true;
    _notify();
    try {
      final keys = await _deriver.derive(passcode, record.salt, record.kdf);
      if (!constantTimeEquals(keys.verifier, record.verifier)) {
        return (await _registerFailure(record), null);
      }
      final key = await _unwrapOrRotate(record, keys.kek);
      return (const UnlockResult(UnlockOutcome.success), key);
    } finally {
      _verifying = false;
      _notify();
    }
  }

  Future<UnlockResult> _registerFailure(AppLockRecord record) async {
    final failures = record.failedAttempts + 1;
    final wipeAt = record.wipeAfter;
    if (wipeAt != null && failures >= wipeAt) {
      AppLog.warn('app_lock', '$failures failed attempts: erasing');
      await reset(wipeConnection: true);
      return const UnlockResult(UnlockOutcome.wiped);
    }
    await _save(record.copyWith(
      failedAttempts: failures,
      lastFailureAtMs: _clock().millisecondsSinceEpoch,
    ));
    return UnlockResult(
      UnlockOutcome.wrongPasscode,
      retryAfter: unlockDelayAfter(failures),
      attemptsLeft: wipeAt == null ? null : wipeAt - failures,
    );
  }

  /// Open the wrapped data key. If the passcode verified but the key won't
  /// open, the record was damaged: start a fresh key (the old snapshot is
  /// unreadable either way) rather than locking the user out.
  Future<Uint8List> _unwrapOrRotate(AppLockRecord record, Uint8List kek) async {
    try {
      final key = Envelope.open(kek, record.wrappedDataKey, aad: _dataKeyAad);
      if (constantTimeEquals(keyCheckOf(key), record.keyCheck)) return key;
    } on EnvelopeException catch (e) {
      AppLog.warn('app_lock', 'data key did not open', e);
    }
    final fresh = Envelope.randomBytes(Envelope.keyLength);
    await _biometrics.clear();
    await _sealed.delete();
    await _save(record.copyWith(
      wrappedDataKey: Envelope.seal(kek, fresh, aad: _dataKeyAad),
      keyCheck: keyCheckOf(fresh),
      biometrics: false,
    ));
    return fresh;
  }

  Future<Uint8List?> _biometricKey(String reason) async {
    final record = _record;
    if (!_ready || record == null || !record.biometrics) return null;
    final key = await _biometrics.unlock(reason: reason);
    if (key == null) return null;
    if (!constantTimeEquals(keyCheckOf(key), record.keyCheck)) {
      // A copy from an older enrolment: useless now, and never trusted.
      await _biometrics.clear();
      await _save(record.copyWith(biometrics: false));
      _notify();
      return null;
    }
    return key;
  }

  Future<void> _onUnlocked(Uint8List dataKey) async {
    _dataKey = dataKey;
    final record = _record;
    if (record != null &&
        (record.failedAttempts != 0 || record.lastFailureAtMs != null)) {
      await _save(record.copyWith(failedAttempts: 0, clearLastFailure: true));
    }
    _lastActivity = _clock();
    if (_status == AppLockStatus.locked) _setStatus(AppLockStatus.unlocked);
    _armIdleTimer();
    await _afterFirstUnlock(dataKey);
  }

  /// The first unlock of the process releases the snapshot: hydrate the UI
  /// from it, unless the live connection already filled it in while locked —
  /// then the newer, deferred save wins instead.
  Future<void> _afterFirstUnlock(Uint8List dataKey) async {
    if (_hydrated) return;
    _hydrated = true;
    final deferred = _deferredSnapshot;
    _deferredSnapshot = null;
    if (deferred != null) {
      await _writeSealed(deferred);
      return;
    }
    try {
      final sealed = await _sealed.read();
      if (sealed == null) return;
      final snapshot = await _cipher.open(dataKey, sealed);
      onSnapshotUnsealed?.call(snapshot);
    } catch (e) {
      AppLog.warn('app_lock', 'sealed snapshot unreadable; discarding', e);
      await _sealed.delete();
    }
  }

  // ── Snapshot at rest ─────────────────────────────────────────────────────

  /// [Prefs.saveSnapshot] routes here while the lock is on. Before the first
  /// unlock there is no key: keep the newest snapshot in memory (the UI
  /// already holds the same data) and write it once unlocked.
  Future<void> _onSnapshotSave(Map<String, dynamic> snapshot) async {
    if (_dataKey == null) {
      _deferredSnapshot = snapshot;
      return;
    }
    await _writeSealed(snapshot);
  }

  Future<void> _writeSealed(Map<String, dynamic> snapshot) {
    final key = _dataKey;
    if (key == null) return Future<void>.value();
    // Serialised, so an older snapshot can never land after a newer one.
    return _writes = _writes.then((_) async {
      try {
        await _sealed.write(await _cipher.seal(key, snapshot));
      } catch (e) {
        AppLog.warn('app_lock', 'sealed snapshot write failed', e);
      }
    });
  }

  // ── Setup ────────────────────────────────────────────────────────────────

  /// Turn the lock on. Seals the existing plaintext snapshot and removes it.
  Future<void> enable(String passcode) async {
    final problem = validatePasscode(passcode);
    if (problem != null) throw ArgumentError(problem);
    if (enabled) throw StateError('app lock is already on');
    final salt = Envelope.randomBytes(16);
    final keys = await _deriver.derive(passcode, salt, _kdfParams);
    final dataKey = Envelope.randomBytes(Envelope.keyLength);
    final record = AppLockRecord(
      kdf: _kdfParams,
      salt: salt,
      verifier: keys.verifier,
      wrappedDataKey: Envelope.seal(keys.kek, dataKey, aad: _dataKeyAad),
      keyCheck: keyCheckOf(dataKey),
      numeric: isNumericPasscode(passcode),
    );
    await _save(record);
    _dataKey = dataKey;
    _hydrated = true; // the UI is already showing its data
    // Migrate: plaintext cache → sealed file. Read while the mirror is still
    // off (that is what makes Prefs.snapshot return it).
    final plain = prefs.snapshot;
    if (plain != null) {
      await _sealed.write(await _cipher.seal(dataKey, plain));
    }
    await prefs.setAppLockEnabled(true);
    await prefs.setAppLockElevatedGate(false);
    await prefs.clearPlainSnapshot();
    _ready = true;
    _storeError = false;
    _lastActivity = _clock();
    _setStatus(AppLockStatus.unlocked);
    _armIdleTimer();
  }

  /// Turn the lock off (needs the passcode). The sealed snapshot is decrypted
  /// back into the ordinary cache.
  Future<UnlockResult> disable(String passcode) async {
    final (result, key) = await _verify(passcode);
    if (key == null) return result;
    Map<String, dynamic>? snapshot;
    try {
      final sealed = await _sealed.read();
      if (sealed != null) snapshot = await _cipher.open(key, sealed);
    } catch (e) {
      AppLog.warn('app_lock', 'sealed snapshot unreadable while disabling', e);
    }
    await prefs.setAppLockEnabled(false);
    await prefs.setAppLockElevatedGate(false);
    if (snapshot != null) await prefs.saveSnapshot(snapshot);
    await _sealed.delete();
    await _biometrics.clear();
    await _store.delete(recordKey);
    _record = null;
    _dataKey = null;
    _setStatus(AppLockStatus.disabled);
    return result;
  }

  Future<UnlockResult> changePasscode(String current, String next) async {
    final problem = validatePasscode(next);
    if (problem != null) throw ArgumentError(problem);
    final (result, key) = await _verify(current);
    final record = _record;
    if (key == null || record == null) return result;
    final salt = Envelope.randomBytes(16);
    final keys = await _deriver.derive(next, salt, _kdfParams);
    await _save(record.copyWith(
      kdf: _kdfParams,
      salt: salt,
      verifier: keys.verifier,
      wrappedDataKey: Envelope.seal(keys.kek, key, aad: _dataKeyAad),
      numeric: isNumericPasscode(next),
      failedAttempts: 0,
      clearLastFailure: true,
    ));
    _notify();
    return result;
  }

  /// Enrol or drop biometric unlock. Needs the app unlocked (the data key in
  /// memory). Returns the resulting state.
  Future<bool> setBiometrics(bool on) async {
    final record = _record;
    final key = _dataKey;
    if (record == null) return false;
    if (!on) {
      await _biometrics.clear();
      await _save(record.copyWith(biometrics: false));
      _notify();
      return false;
    }
    if (key == null || !_biometricsAvailable) return false;
    final ok = await _biometrics.enroll(
      key,
      reason: 'Use ${_biometrics.label} to unlock Talon',
    );
    await _save((_record ?? record).copyWith(biometrics: ok));
    _notify();
    return ok;
  }

  Future<void> setTimeoutSeconds(int seconds) async {
    final record = _record;
    if (record == null) return;
    await _save(record.copyWith(timeoutSeconds: seconds < 0 ? 0 : seconds));
    _lastActivity = _clock();
    _armIdleTimer();
    _notify();
  }

  Future<void> setWipeAfter(int? attempts) async {
    final record = _record;
    if (record == null) return;
    await _save(attempts == null
        ? record.copyWith(clearWipeAfter: true)
        : record.copyWith(wipeAfter: attempts));
    _notify();
  }

  Future<void> setRequireUnlockForElevated(bool on) async {
    final record = _record;
    if (record == null) return;
    await _save(record.copyWith(requireUnlockForElevated: on));
    // The Android background mesh reads the mirror (it can't reach the
    // secure store's record without the UI).
    await prefs.setAppLockElevatedGate(on);
    if (!on) _approvedUntil = null;
    _notify();
  }

  /// Forget the lock entirely — the "forgot passcode" path, and what the wipe
  /// threshold triggers. Removes the lock record, the biometric key and every
  /// cached chat. With [wipeConnection] (always, from the lock screen: a
  /// reset that kept the connection would be a lock bypass) the bridge
  /// credentials go too, so the device has to be paired again.
  Future<void> reset({required bool wipeConnection}) async {
    await _dropLocalState();
    _resolvePending(false);
    _setStatus(AppLockStatus.disabled);
    if (wipeConnection) {
      try {
        await onWipe?.call();
      } catch (e) {
        AppLog.warn('app_lock', 'connection wipe failed', e);
      }
    }
  }

  Future<void> _dropLocalState() async {
    Future<void> quietly(Future<void> Function() op) async {
      try {
        await op();
      } catch (e) {
        AppLog.debug('app_lock', 'cleanup step failed', e);
      }
    }

    await quietly(() => _store.delete(recordKey));
    await quietly(_biometrics.clear);
    await quietly(_sealed.delete);
    await prefs.setAppLockEnabled(false);
    await prefs.setAppLockElevatedGate(false);
    await prefs.clearPlainSnapshot();
    _record = null;
    _dataKey = null;
    _deferredSnapshot = null;
    _storeError = false;
    _hydrated = true; // nothing left to restore
  }

  // ── Device-control approvals ─────────────────────────────────────────────

  /// Gate for mesh device-control commands (exec, file access, installs; the
  /// root/Shizuku tier included). Returns null to allow, or the refusal to
  /// send back to the daemon.
  ///
  /// Only when the lock is on and [requireUnlockForElevated] is set. One
  /// approval (passcode or biometrics, on this device) covers the
  /// [approvalWindow]; concurrent commands share one prompt. With the app not
  /// in the foreground there is nobody to ask, so the command is refused.
  Future<String?> approveCommand(String command) async {
    final record = _record;
    if (!enabled || record == null || !record.requireUnlockForElevated) {
      return null;
    }
    final until = _approvedUntil;
    if (until != null && _clock().isBefore(until)) return null;
    if (!_foreground) return deniedInBackground;
    var pending = _pending;
    if (pending == null) {
      pending = _pending = PendingApproval._(command, _clock());
      _notify();
    }
    final ok = await pending.result.timeout(
      approvalTimeout,
      onTimeout: () {
        _resolvePending(false);
        return false;
      },
    );
    return ok ? null : deniedByUser;
  }

  Future<UnlockResult> approveWithPasscode(String passcode) async {
    final (result, key) = await _verify(passcode);
    if (key != null) {
      await _onUnlocked(key);
      _resolvePending(true);
    }
    return result;
  }

  Future<bool> approveWithBiometrics() async {
    final key = await _biometricKey('Approve a command from Talon');
    if (key == null) return false;
    await _onUnlocked(key);
    _resolvePending(true);
    return true;
  }

  void denyPending() => _resolvePending(false);

  void _resolvePending(bool ok) {
    final pending = _pending;
    if (pending == null) return;
    _pending = null;
    if (ok) _approvedUntil = _clock().add(approvalWindow);
    if (!pending._done.isCompleted) pending._done.complete(ok);
    _notify();
  }

  // ── Internals ────────────────────────────────────────────────────────────

  static Uint8List keyCheckOf(List<int> dataKey) =>
      Argon2PasscodeDeriver.labelledKey(dataKey, 'talon.applock.keycheck.v1');

  Future<void> _save(AppLockRecord record) async {
    _record = record;
    await _store.write(recordKey, record.encode());
  }

  void _setStatus(AppLockStatus next) {
    if (_status == next) {
      _notify();
      return;
    }
    _status = next;
    if (next != AppLockStatus.locked) {
      for (final w in _unlockWaiters) {
        if (!w.isCompleted) w.complete();
      }
      _unlockWaiters.clear();
    }
    if (next != AppLockStatus.unlocked) {
      _idleTimer?.cancel();
      _idleTimer = null;
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @visibleForTesting
  String? debugRecordJson() => _record?.encode();

  @visibleForTesting
  bool get debugHasDataKey => _dataKey != null;

  @override
  void dispose() {
    _disposed = true;
    _idleTimer?.cancel();
    if (Prefs.sealedSnapshotSink == _onSnapshotSave) {
      Prefs.sealedSnapshotSink = null;
    }
    _resolvePending(false);
    super.dispose();
  }
}
