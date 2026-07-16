import 'dart:io';

import 'package:crypto/crypto.dart';

/// Process-wide trust anchor for the bridge's self-signed certificate.
///
/// The daemon serves the bridge over TLS with a certificate it minted
/// itself, identified by the SHA-256 of its DER (the fingerprint the daemon
/// prints and `/health` advertises). The active pin lives here — set by
/// AppState whenever the connection profile changes — so every transport
/// that reaches the bridge honours it: BridgeClient's own IOClient, and the
/// HttpClient that Flutter's Image.network creates internally (reachable
/// only through [HttpOverrides]).
///
/// Semantics: an otherwise-untrusted certificate is accepted exactly when
/// its fingerprint matches the pin. Certificates that already chain to a
/// platform-trusted CA (reverse-proxy setups) never reach this code — the
/// bad-certificate callback fires only when normal validation failed.
class BridgeTrust extends HttpOverrides {
  static String? _pinnedFingerprint;

  /// Adopt [fingerprint] (lowercase hex, no separators) as the pin; null
  /// clears it, restoring default certificate validation everywhere.
  static void pin(String? fingerprint) => _pinnedFingerprint = fingerprint;

  static String? get pinned => _pinnedFingerprint;

  /// The pin-comparison form of a certificate: SHA-256 over its DER.
  static String fingerprintOf(X509Certificate cert) =>
      sha256.convert(cert.der).toString();

  static bool accepts(X509Certificate cert) =>
      _pinnedFingerprint != null && fingerprintOf(cert) == _pinnedFingerprint;

  /// Route every implicitly-created HttpClient through the pin. Called once
  /// at startup, before any widget can issue a request.
  static void install() {
    HttpOverrides.global = BridgeTrust();
  }

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      super.createHttpClient(context)
        ..badCertificateCallback = (cert, host, port) => accepts(cert);
}
