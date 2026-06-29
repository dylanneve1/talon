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
    this.manageLocalDaemon = true,
    this.launchCommand = 'talon',
    this.launchArgs = const ['start'],
  });

  bool get isLoopback => host == '127.0.0.1' || host == 'localhost' || host == '::1';

  /// We only ever supervise a daemon for a local, loopback connection.
  bool get canManageDaemon =>
      manageLocalDaemon && isLoopback && _desktopPlatform;

  String get baseUrl => 'http://$host:$port';

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
    bool? manageLocalDaemon,
    String? launchCommand,
    List<String>? launchArgs,
  }) =>
      ConnectionConfig(
        host: host ?? this.host,
        port: port ?? this.port,
        token: clearToken ? null : (token ?? this.token),
        manageLocalDaemon: manageLocalDaemon ?? this.manageLocalDaemon,
        launchCommand: launchCommand ?? this.launchCommand,
        launchArgs: launchArgs ?? this.launchArgs,
      );

  Map<String, dynamic> toJson() => {
        'host': host,
        'port': port,
        'token': token,
        'manageLocalDaemon': manageLocalDaemon,
        'launchCommand': launchCommand,
        'launchArgs': launchArgs,
      };

  factory ConnectionConfig.fromJson(Map<String, dynamic> j) => ConnectionConfig(
        host: (j['host'] ?? '127.0.0.1') as String,
        port: (j['port'] ?? 19880) as int,
        token: j['token'] as String?,
        manageLocalDaemon: (j['manageLocalDaemon'] ?? true) as bool,
        launchCommand: (j['launchCommand'] ?? 'talon') as String,
        launchArgs:
            ((j['launchArgs'] as List?) ?? const ['start']).map((e) => e.toString()).toList(),
      );

  /// First-run default tuned to the platform: desktop manages a local daemon;
  /// mobile starts in remote mode (the user supplies a host + token).
  factory ConnectionConfig.defaults() => ConnectionConfig(
        manageLocalDaemon: _desktopPlatform,
      );
}

bool get _desktopPlatform {
  try {
    return Platform.isWindows || Platform.isMacOS || Platform.isLinux;
  } catch (_) {
    return false; // web — treat as non-desktop
  }
}
