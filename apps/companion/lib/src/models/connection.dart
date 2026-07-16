import 'dart:io' show Platform;

/// How the companion reaches a Talon daemon.
///
/// - On desktop the default is zero-config local discovery: Talon writes
///   `~/.talon/native-bridge.json`, and the app reads host/port/token from it.
/// - On mobile (or when pointing at another machine) it's a *remote* bridge:
///   a host/IP + port and, for anything off-loopback, a shared token.
class ConnectionConfig {
  final String host;
  final int port;
  final String? token;

  /// Use TLS (https) for the bridge — either the bridge's own certificate
  /// (`native.tls`, the default whenever the daemon binds off-loopback) or a
  /// reverse proxy (Caddy/nginx/Tailscale Serve) that terminates HTTPS.
  final bool tls;

  /// Pinned bridge certificate: SHA-256 of the certificate DER, lowercase
  /// hex without separators. Captured on first connect (or from local
  /// discovery) and required to match on every reconnect; null means no pin
  /// yet — the next TLS connect adopts whatever certificate it sees.
  /// Irrelevant for proxy setups whose certificates chain to a real CA (the
  /// platform trust store accepts those before the pin is consulted).
  final String? fingerprint;

  /// Desktop only: try to spawn/attach a local daemon instead of assuming one.
  final bool manageLocalDaemon;

  /// Desktop local mode: discover the running bridge from Talon's data dir
  /// instead of launching a daemon or requiring host/port/token entry.
  final bool localAutoDiscover;

  /// Command used to launch the daemon when [manageLocalDaemon] is on.
  /// Defaults to the globally-installed `talon` CLI on PATH.
  final String launchCommand;
  final List<String> launchArgs;

  const ConnectionConfig({
    this.host = '127.0.0.1',
    this.port = 19880,
    this.token,
    this.tls = false,
    this.fingerprint,
    this.manageLocalDaemon = true,
    this.localAutoDiscover = true,
    this.launchCommand = 'talon',
    this.launchArgs = const ['start'],
  });

  /// Canonical fingerprint form: lowercase hex, no colons/spaces. Returns
  /// null for anything that isn't plausibly a SHA-256 hex digest.
  static String? normalizeFingerprint(String? raw) {
    if (raw == null) return null;
    final s = raw.replaceAll(RegExp(r'[\s:]'), '').toLowerCase();
    return RegExp(r'^[0-9a-f]{64}$').hasMatch(s) ? s : null;
  }

  bool get isLoopback =>
      host == '127.0.0.1' || host == 'localhost' || host == '::1';

  /// We only ever supervise a daemon for a local, loopback connection.
  bool get canManageDaemon =>
      manageLocalDaemon && !localAutoDiscover && isLoopback && _desktopPlatform;

  /// Zero-config discovery is only meaningful for same-machine desktop mode.
  bool get canAutoDiscoverLocal =>
      localAutoDiscover && isLoopback && _desktopPlatform;

  String get scheme => tls ? 'https' : 'http';

  String get baseUrl => '$scheme://$host:$port';

  /// Resolve a relative bridge media path (e.g. `/media?id=…`) to a full URL,
  /// appending the auth token as a query param (Image.network can't set an
  /// Authorization header), mirroring how [eventsUrl] authorises the SSE GET.
  String mediaUrl(String path) {
    final t = token;
    if (t == null || t.isEmpty) return '$baseUrl$path';
    final sep = path.contains('?') ? '&' : '?';
    return '$baseUrl$path${sep}token=${Uri.encodeQueryComponent(t)}';
  }

  String eventsUrl() {
    final t = token;
    return t == null || t.isEmpty
        ? '$baseUrl/events'
        : '$baseUrl/events?token=${Uri.encodeQueryComponent(t)}';
  }

  Map<String, String> authHeaders([Map<String, String>? extra]) {
    final h = <String, String>{...?extra};
    final t = token;
    if (t != null && t.isNotEmpty) h['Authorization'] = 'Bearer $t';
    return h;
  }

  ConnectionConfig copyWith({
    String? host,
    int? port,
    String? token,
    bool clearToken = false,
    bool? tls,
    String? fingerprint,
    bool clearFingerprint = false,
    bool? manageLocalDaemon,
    bool? localAutoDiscover,
    String? launchCommand,
    List<String>? launchArgs,
  }) =>
      ConnectionConfig(
        host: host ?? this.host,
        port: port ?? this.port,
        token: clearToken ? null : (token ?? this.token),
        tls: tls ?? this.tls,
        fingerprint:
            clearFingerprint ? null : (fingerprint ?? this.fingerprint),
        manageLocalDaemon: manageLocalDaemon ?? this.manageLocalDaemon,
        localAutoDiscover: localAutoDiscover ?? this.localAutoDiscover,
        launchCommand: launchCommand ?? this.launchCommand,
        launchArgs: launchArgs ?? this.launchArgs,
      );

  Map<String, dynamic> toJson() => {
        'host': host,
        'port': port,
        'token': token,
        'tls': tls,
        'fingerprint': fingerprint,
        'manageLocalDaemon': manageLocalDaemon,
        'localAutoDiscover': localAutoDiscover,
        'launchCommand': launchCommand,
        'launchArgs': launchArgs,
      };

  factory ConnectionConfig.fromJson(Map<String, dynamic> j) => ConnectionConfig(
        host: (j['host'] ?? '127.0.0.1') as String,
        port: (j['port'] ?? 19880) as int,
        token: j['token'] as String?,
        tls: (j['tls'] ?? false) as bool,
        fingerprint: normalizeFingerprint(j['fingerprint'] as String?),
        manageLocalDaemon: (j['manageLocalDaemon'] ?? true) as bool,
        localAutoDiscover: (j['localAutoDiscover'] ?? true) as bool,
        launchCommand: (j['launchCommand'] ?? 'talon') as String,
        launchArgs: ((j['launchArgs'] as List?) ?? const ['start'])
            .map((e) => e.toString())
            .toList(),
      );

  /// Parsed result of a free-text "host" field.
  ///
  /// Users paste all sorts of things into a host box: a bare IP, `host:port`,
  /// a full `https://host:port/path` URL, or a value with stray whitespace or
  /// a trailing slash. Building `http://$host:$port` straight from that yields
  /// a malformed URL (e.g. `http://https://host:19880`) and the connection
  /// fails even though the endpoint is perfectly reachable — which reads as an
  /// app bug. [parseHostInput] normalizes any of those into a clean host, an
  /// optional embedded port, and a TLS hint from the scheme.
  static HostInput parseHostInput(String raw) {
    var s = raw.trim();
    if (s.isEmpty) return const HostInput(host: '');
    bool? tls;
    final schemeMatch = RegExp(r'^([a-zA-Z][a-zA-Z0-9+.-]*)://').firstMatch(s);
    if (schemeMatch != null) {
      final scheme = schemeMatch.group(1)!.toLowerCase();
      if (scheme == 'https' || scheme == 'wss') tls = true;
      if (scheme == 'http' || scheme == 'ws') tls = false;
      s = s.substring(schemeMatch.end);
    }
    // Drop any path/query/fragment — we only want authority.
    s = s.split('/').first.split('?').first.split('#').first.trim();
    int? port;
    // IPv6 in brackets: [::1]:1234
    final v6 = RegExp(r'^\[(.+)\](?::(\d+))?$').firstMatch(s);
    if (v6 != null) {
      s = v6.group(1)!;
      port = int.tryParse(v6.group(2) ?? '');
    } else {
      // host:port — but only when there's exactly one colon (not bare IPv6).
      final colon = s.indexOf(':');
      if (colon >= 0 && s.indexOf(':', colon + 1) == -1) {
        final maybePort = int.tryParse(s.substring(colon + 1));
        if (maybePort != null && maybePort >= 1 && maybePort <= 65535) {
          port = maybePort;
          s = s.substring(0, colon);
        }
      }
    }
    return HostInput(host: s.trim(), port: port, tls: tls);
  }

  /// First-run default tuned to the platform: desktop discovers local Talon;
  /// mobile starts in remote mode (the user supplies a host + token).
  factory ConnectionConfig.defaults() => ConnectionConfig(
        manageLocalDaemon: _desktopPlatform,
        localAutoDiscover: _desktopPlatform,
      );
}

/// Normalized pieces extracted from a free-text host field.
class HostInput {
  final String host;
  final int? port;
  final bool? tls;
  const HostInput({required this.host, this.port, this.tls});
}

bool get _desktopPlatform {
  try {
    return Platform.isWindows || Platform.isMacOS || Platform.isLinux;
  } catch (_) {
    return false; // web — treat as non-desktop
  }
}
