import 'dart:io' show Platform;

/// How the companion reaches a Talon daemon.
///
/// - On desktop the default is a *managed local* daemon: connect to
///   `127.0.0.1`, and if nothing answers, launch one ourselves.
/// - On mobile (or when pointing at another machine) it's a *remote* bridge:
///   a host/IP + port and, for anything off-loopback, a shared token.
class ConnectionConfig {
  final String host;
  final int port;
  final String? token;

  /// Use TLS (https) for the bridge. Needed when the daemon sits behind a
  /// reverse proxy (Caddy/nginx/Tailscale Serve) that terminates HTTPS. The
  /// bridge itself is plaintext, so this is off for direct connections.
  final bool tls;

  /// Desktop only: try to spawn/attach a local daemon instead of assuming one.
  final bool manageLocalDaemon;

  /// Command used to launch the daemon when [manageLocalDaemon] is on.
  /// Defaults to the globally-installed `talon` CLI on PATH.
  final String launchCommand;
  final List<String> launchArgs;

  const ConnectionConfig({
    this.host = '127.0.0.1',
    this.port = 19880,
    this.token,
    this.tls = false,
    this.manageLocalDaemon = true,
    this.launchCommand = 'talon',
    this.launchArgs = const ['start'],
  });

  bool get isLoopback => host == '127.0.0.1' || host == 'localhost' || host == '::1';

  /// We only ever supervise a daemon for a local, loopback connection.
  bool get canManageDaemon =>
      manageLocalDaemon && isLoopback && _desktopPlatform;

  String get scheme => tls ? 'https' : 'http';

  String get baseUrl => '$scheme://$host:$port';

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
    bool? manageLocalDaemon,
    String? launchCommand,
    List<String>? launchArgs,
  }) =>
      ConnectionConfig(
        host: host ?? this.host,
        port: port ?? this.port,
        token: clearToken ? null : (token ?? this.token),
        tls: tls ?? this.tls,
        manageLocalDaemon: manageLocalDaemon ?? this.manageLocalDaemon,
        launchCommand: launchCommand ?? this.launchCommand,
        launchArgs: launchArgs ?? this.launchArgs,
      );

  Map<String, dynamic> toJson() => {
        'host': host,
        'port': port,
        'token': token,
        'tls': tls,
        'manageLocalDaemon': manageLocalDaemon,
        'launchCommand': launchCommand,
        'launchArgs': launchArgs,
      };

  factory ConnectionConfig.fromJson(Map<String, dynamic> j) => ConnectionConfig(
        host: (j['host'] ?? '127.0.0.1') as String,
        port: (j['port'] ?? 19880) as int,
        token: j['token'] as String?,
        tls: (j['tls'] ?? false) as bool,
        manageLocalDaemon: (j['manageLocalDaemon'] ?? true) as bool,
        launchCommand: (j['launchCommand'] ?? 'talon') as String,
        launchArgs:
            ((j['launchArgs'] as List?) ?? const ['start']).map((e) => e.toString()).toList(),
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

  /// First-run default tuned to the platform: desktop manages a local daemon;
  /// mobile starts in remote mode (the user supplies a host + token).
  factory ConnectionConfig.defaults() => ConnectionConfig(
        manageLocalDaemon: _desktopPlatform,
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
