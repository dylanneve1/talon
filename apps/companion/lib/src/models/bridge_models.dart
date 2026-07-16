/// Dart mirror of the Talon Client Bridge Protocol (v1).
///
/// These types match `src/frontend/desktop/protocol.ts` on the daemon side.
/// Keep them in sync; the bridge advertises its protocol version in `/health`
/// and the `hello` event so a mismatch can be detected.
library;

const int kBridgeProtocolVersion = 1;

enum Role { user, assistant, system }

Role _roleFrom(String? s) {
  switch (s) {
    case 'assistant':
      return Role.assistant;
    case 'system':
      return Role.system;
    default:
      return Role.user;
  }
}

String _string(Object? value, [String fallback = '']) =>
    value is String ? value : value?.toString() ?? fallback;

int _int(Object? value, [int fallback = 0]) {
  if (value is int) return value;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? fallback;
  return fallback;
}

bool _bool(Object? value, [bool fallback = false]) =>
    value is bool ? value : fallback;

List<dynamic> _list(Object? value) => value is List ? value : const <dynamic>[];

Map<String, dynamic> _map(Object? value) =>
    value is Map ? value.cast<String, dynamic>() : const {};

class ClientButton {
  final String text;
  final String? url;
  final String? data;
  const ClientButton({required this.text, this.url, this.data});

  factory ClientButton.fromJson(Map<String, dynamic> j) => ClientButton(
        text: _string(j['text']),
        url: j['url'] is String ? j['url'] as String : null,
        data: j['data'] is String ? j['data'] as String : null,
      );
}

class ClientMessage {
  final String id;
  final String chatId;
  final Role role;
  String text;
  final int ts;
  final List<List<ClientButton>> buttons;
  final List<String> reactions;

  /// Relative bridge path to an attached image (e.g. `/media?id=…`), resolved
  /// against the connection's base URL + token by the UI. Null for text rows.
  final String? imagePath;

  /// Tools that ran during this assistant turn (client-only — snapshot from
  /// the live turn when the canonical message arrives, so the history pane
  /// can show what the model did).
  final List<ToolActivity> tools;

  /// True while assistant text is still streaming into this bubble (client-only).
  bool streaming;

  /// Turn metadata attached when the turn ends (client-only): wall-clock
  /// duration and token usage, surfaced as a quiet footer under the reply.
  /// Null until the matching `turn_end` lands (and always null for user rows).
  int? durationMs;
  int? tokensIn;
  int? tokensOut;

  ClientMessage({
    required this.id,
    required this.chatId,
    required this.role,
    required this.text,
    required this.ts,
    this.buttons = const [],
    List<String>? reactions,
    this.imagePath,
    List<ToolActivity>? tools,
    this.streaming = false,
    this.durationMs,
    this.tokensIn,
    this.tokensOut,
  })  : reactions = reactions ?? <String>[],
        tools = tools ?? <ToolActivity>[];

  /// Whether this row has any turn stats worth showing.
  bool get hasStats =>
      (durationMs != null && durationMs! > 0) ||
      (tokensIn != null && tokensIn! > 0) ||
      (tokensOut != null && tokensOut! > 0);

  factory ClientMessage.fromJson(Map<String, dynamic> j) {
    final rawButtons = _list(j['buttons']);
    // Turn meta hydrated by the daemon (protocol-additive): the tool timeline
    // and stats footer for this assistant turn, surviving reload/restart.
    final tools = _list(j['tools'])
        .map((t) => ToolActivity.fromHistoryJson(_map(t)))
        .toList();
    final durationMs = _int(j['durationMs']);
    final tokensIn = _int(j['tokensIn']);
    final tokensOut = _int(j['tokensOut']);
    return ClientMessage(
      id: _string(j['id']),
      chatId: _string(j['chatId']),
      role: _roleFrom(j['role'] is String ? j['role'] as String : null),
      text: _string(j['text']),
      ts: _int(j['ts']),
      buttons: rawButtons
          .map<List<ClientButton>>(
            (row) =>
                _list(row).map((c) => ClientButton.fromJson(_map(c))).toList(),
          )
          .toList(),
      reactions: _list(j['reactions']).map((e) => e.toString()).toList(),
      imagePath: j['imagePath'] is String ? j['imagePath'] as String : null,
      tools: tools.isEmpty ? null : tools,
      durationMs: durationMs > 0 ? durationMs : null,
      tokensIn: tokensIn > 0 ? tokensIn : null,
      tokensOut: tokensOut > 0 ? tokensOut : null,
    );
  }

  DateTime get time => DateTime.fromMillisecondsSinceEpoch(ts);

  /// Minimal wire-shape encoding for the local offline snapshot (buttons,
  /// reactions and tool traces are re-fetched from the daemon on connect).
  Map<String, dynamic> toSnapshotJson() => {
        'id': id,
        'chatId': chatId,
        'role': role.name,
        'text': text,
        'ts': ts,
        if (imagePath != null) 'imagePath': imagePath,
        if (durationMs != null) 'durationMs': durationMs,
        if (tokensIn != null) 'tokensIn': tokensIn,
        if (tokensOut != null) 'tokensOut': tokensOut,
      };
}

/// Live context-window fill for a chat's session — mirrors the daemon's
/// `ContextInfo`. [known] is false when the backend doesn't report a
/// current-window figure, in which case the UI hides the readout.
class ContextInfo {
  final bool known;
  final int used;
  final int max;
  final int pct;
  final bool warn;

  const ContextInfo({
    required this.known,
    required this.used,
    required this.max,
    required this.pct,
    required this.warn,
  });

  factory ContextInfo.fromJson(Map<String, dynamic> j) => ContextInfo(
        known: _bool(j['known']),
        used: _int(j['used']),
        max: _int(j['max']),
        pct: _int(j['pct']),
        warn: _bool(j['warn']),
      );

  Map<String, dynamic> toJson() => {
        'known': known,
        'used': used,
        'max': max,
        'pct': pct,
        'warn': warn,
      };
}

/// A follow-up parked while a turn runs — mirrors the daemon's `QueuedMessage`.
/// Held server-side and synced to every client, so it appears (and can be
/// edited/cancelled) on any device.
class QueuedMessage {
  final String text;
  final bool hasAttachment;

  const QueuedMessage({required this.text, this.hasAttachment = false});

  factory QueuedMessage.fromJson(Map<String, dynamic> j) => QueuedMessage(
        text: _string(j['text']),
        hasAttachment: _bool(j['hasAttachment']),
      );

  Map<String, dynamic> toJson() => {
        'text': text,
        'hasAttachment': hasAttachment,
      };
}

class DeviceInfo {
  final String id;
  final String name;
  final String platform;
  final String appVersion;
  final bool online;
  final int lastSeen;
  final int? battery;
  final bool? charging;

  /// Command names the device advertised at registration (e.g. "ring").
  final List<String> capabilities;

  const DeviceInfo({
    required this.id,
    required this.name,
    required this.platform,
    required this.appVersion,
    required this.online,
    required this.lastSeen,
    this.battery,
    this.charging,
    this.capabilities = const [],
  });

  factory DeviceInfo.fromJson(Map<String, dynamic> j) => DeviceInfo(
        id: _string(j['id']),
        name: _string(j['name']),
        platform: _string(j['platform']),
        appVersion: _string(j['appVersion']),
        online: _bool(j['online']),
        lastSeen: _int(j['lastSeen']),
        battery: j['battery'] is num ? (j['battery'] as num).round() : null,
        charging: j['charging'] is bool ? j['charging'] as bool : null,
        capabilities: j['capabilities'] is List
            ? (j['capabilities'] as List)
                .whereType<String>()
                .toList(growable: false)
            : const [],
      );
}

class DeviceLocation {
  final String deviceId;
  final double lat;
  final double lon;
  final double? accuracyM;
  final double? altitudeM;
  final double? speedMps;
  final double? headingDeg;
  final int ts;
  final String? provider;
  final int? batteryPct;

  const DeviceLocation({
    required this.deviceId,
    required this.lat,
    required this.lon,
    required this.ts,
    this.accuracyM,
    this.altitudeM,
    this.speedMps,
    this.headingDeg,
    this.provider,
    this.batteryPct,
  });

  factory DeviceLocation.fromJson(Map<String, dynamic> j) => DeviceLocation(
        deviceId: _string(j['deviceId']),
        lat: _double(j['lat']),
        lon: _double(j['lon']),
        accuracyM: _nullableDouble(j['accuracyM']),
        altitudeM: _nullableDouble(j['altitudeM']),
        speedMps: _nullableDouble(j['speedMps']),
        headingDeg: _nullableDouble(j['headingDeg']),
        ts: _int(j['ts']),
        provider: j['provider'] is String ? j['provider'] as String : null,
        batteryPct:
            j['batteryPct'] is num ? (j['batteryPct'] as num).round() : null,
      );
}

double _double(Object? value, [double fallback = 0]) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value) ?? fallback;
  return fallback;
}

double? _nullableDouble(Object? value) =>
    value is num ? value.toDouble() : null;

class ClientChat {
  final String id;
  String title;
  final int createdAt;
  int lastActive;
  String preview;
  String? model;
  String? backend;
  String? effort;
  bool? pulse;
  ContextInfo? context;
  QueuedMessage? queued;

  ClientChat({
    required this.id,
    required this.title,
    required this.createdAt,
    required this.lastActive,
    required this.preview,
    this.model,
    this.backend,
    this.effort,
    this.pulse,
    this.context,
    this.queued,
  });

  factory ClientChat.fromJson(Map<String, dynamic> j) => ClientChat(
        id: _string(j['id']),
        title: _string(j['title'], 'New chat'),
        createdAt: _int(j['createdAt']),
        lastActive: _int(j['lastActive']),
        preview: _string(j['preview']),
        model: j['model'] is String ? j['model'] as String : null,
        backend: j['backend'] is String ? j['backend'] as String : null,
        effort: j['effort'] is String ? j['effort'] as String : null,
        pulse: j['pulse'] is bool ? j['pulse'] as bool : null,
        context: j['context'] is Map
            ? ContextInfo.fromJson(
                (j['context'] as Map).cast<String, dynamic>())
            : null,
        queued: j['queued'] is Map
            ? QueuedMessage.fromJson(
                (j['queued'] as Map).cast<String, dynamic>())
            : null,
      );

  DateTime get lastActiveTime =>
      DateTime.fromMillisecondsSinceEpoch(lastActive);

  Map<String, dynamic> toSnapshotJson() => {
        'id': id,
        'title': title,
        'createdAt': createdAt,
        'lastActive': lastActive,
        'preview': preview,
        if (model != null) 'model': model,
        if (backend != null) 'backend': backend,
        if (effort != null) 'effort': effort,
        if (pulse != null) 'pulse': pulse,
        if (context != null) 'context': context!.toJson(),
      };
}

/// Snapshot of the daemon's own (editable) settings + health — the payload of
/// `GET /config`.
class ConfigSnapshot {
  final String backend;
  final String frontend;
  final String model;
  final String modelDisplay;
  final String botDisplayName;
  final String timezone;
  final bool pulse;
  final int pulseIntervalMs;
  final bool heartbeat;
  final int heartbeatIntervalMinutes;
  final bool dream;
  final List<String> editable;
  final bool healthy;
  final int uptimeMs;
  final int sessions;
  final int messages;
  final int memoryMb;

  const ConfigSnapshot({
    required this.backend,
    required this.frontend,
    required this.model,
    required this.modelDisplay,
    required this.botDisplayName,
    required this.timezone,
    required this.pulse,
    required this.pulseIntervalMs,
    required this.heartbeat,
    required this.heartbeatIntervalMinutes,
    required this.dream,
    required this.editable,
    required this.healthy,
    required this.uptimeMs,
    required this.sessions,
    required this.messages,
    required this.memoryMb,
  });

  factory ConfigSnapshot.fromJson(Map<String, dynamic> j) {
    final health = _map(j['health']);
    return ConfigSnapshot(
      backend: _string(j['backend']),
      frontend: _string(j['frontend']),
      model: _string(j['model']),
      modelDisplay: _string(j['modelDisplay']),
      botDisplayName: _string(j['botDisplayName'], 'Talon'),
      timezone: _string(j['timezone']),
      pulse: _bool(j['pulse']),
      pulseIntervalMs: _int(j['pulseIntervalMs'], 300000),
      heartbeat: _bool(j['heartbeat']),
      heartbeatIntervalMinutes: _int(j['heartbeatIntervalMinutes'], 60),
      dream: _bool(j['dream']),
      editable: _list(j['editable']).map((e) => e.toString()).toList(),
      healthy: _bool(health['healthy']),
      uptimeMs: _int(health['uptimeMs']),
      sessions: _int(health['sessions']),
      messages: _int(health['messages']),
      memoryMb: _int(health['memoryMb']),
    );
  }
}

class BridgeStatus {
  final int protocol;
  final String botName;
  final String backend;
  final String model;
  final int activeChats;
  final String startedAt;

  /// Additive bridge features this daemon supports (e.g. "plugins-skills").
  /// The app gates optional surfaces on these instead of protocol bumps.
  final List<String> capabilities;

  const BridgeStatus({
    required this.protocol,
    required this.botName,
    required this.backend,
    required this.model,
    required this.activeChats,
    required this.startedAt,
    this.capabilities = const [],
  });

  bool hasCapability(String name) => capabilities.contains(name);

  factory BridgeStatus.fromJson(Map<String, dynamic> j) => BridgeStatus(
        protocol: _int(j['protocol'], 1),
        botName: _string(j['botName'], 'Talon'),
        backend: _string(j['backend']),
        model: _string(j['model']),
        activeChats: _int(j['activeChats']),
        startedAt: _string(j['startedAt']),
        capabilities: j['capabilities'] is List
            ? (j['capabilities'] as List)
                .whereType<String>()
                .toList(growable: false)
            : const [],
      );

  static const empty = BridgeStatus(
    protocol: kBridgeProtocolVersion,
    botName: 'Talon',
    backend: '',
    model: '',
    activeChats: 0,
    startedAt: '',
  );
}

class ModelOption {
  final String id;
  final String displayName;
  final String provider;
  final bool reasoning;

  const ModelOption({
    required this.id,
    required this.displayName,
    required this.provider,
    required this.reasoning,
  });

  factory ModelOption.fromJson(Map<String, dynamic> j) => ModelOption(
        id: _string(j['id']),
        displayName: _string(j['displayName']),
        provider: _string(j['provider']),
        reasoning: _bool(j['reasoning']),
      );
}

/// A selectable backend (e.g. Claude SDK, Codex) — the payload of
/// `GET /backends`.
class BackendOption {
  final String id;
  final String label;

  const BackendOption({required this.id, required this.label});

  factory BackendOption.fromJson(Map<String, dynamic> j) => BackendOption(
        id: _string(j['id']),
        label: _string(j['label']),
      );
}

/// A live tool invocation surfaced under the streaming reply.
class ToolActivity {
  final String id;
  final String name;
  bool done;
  String? error;
  Map<String, dynamic> input;

  /// Truncated string form of the tool's result, shown in the expanded view.
  /// Arrives on the `result` phase (or re-hydrated from history).
  String? output;
  final DateTime startedAt;
  DateTime? finishedAt;

  ToolActivity({
    required this.id,
    required this.name,
    this.done = false,
    this.error,
    Map<String, dynamic>? input,
    this.output,
    DateTime? startedAt,
    this.finishedAt,
  })  : input = input ?? <String, dynamic>{},
        startedAt = startedAt ?? DateTime.now();

  /// A finished call re-hydrated from persisted history: anchor the window at
  /// parse time so [elapsed] reproduces the recorded duration.
  factory ToolActivity.fromHistoryJson(Map<String, dynamic> j) {
    final started = DateTime.now();
    final duration = _int(j['durationMs']);
    return ToolActivity(
      id: _string(j['id']),
      name: _string(j['name'], 'tool'),
      done: true,
      error: j['error'] is String ? j['error'] as String : null,
      input: _map(j['input']),
      output: j['output'] is String ? j['output'] as String : null,
      startedAt: started,
      finishedAt: started.add(Duration(milliseconds: duration)),
    );
  }

  Duration get elapsed => (finishedAt ?? DateTime.now()).difference(startedAt);
}

/// One daemon log line from `GET /logs` — the log viewer's row model.
class DaemonLogEntry {
  /// Epoch milliseconds (0 when the line carried no timestamp).
  final int ts;

  /// pino level name: trace/debug/info/warn/error/fatal.
  final String level;

  /// Subsystem tag (e.g. "agent", "native"), empty when absent.
  final String component;
  final String msg;

  /// Concise error message, when the line logged one.
  final String? err;

  /// Full stack trace, when the line logged one.
  final String? stack;

  const DaemonLogEntry({
    required this.ts,
    required this.level,
    required this.component,
    required this.msg,
    this.err,
    this.stack,
  });

  factory DaemonLogEntry.fromJson(Map<String, dynamic> j) => DaemonLogEntry(
        ts: _int(j['ts']),
        level: _string(j['level'], 'info'),
        component: _string(j['component']),
        msg: _string(j['msg']),
        err: j['err'] is String ? j['err'] as String : null,
        stack: j['stack'] is String ? j['stack'] as String : null,
      );

  DateTime get time => DateTime.fromMillisecondsSinceEpoch(ts);
}

/// One full-text search hit from `GET /search`.
class SearchHit {
  final String chatId;
  final String chatTitle;
  final ClientMessage message;

  const SearchHit({
    required this.chatId,
    required this.chatTitle,
    required this.message,
  });

  factory SearchHit.fromJson(Map<String, dynamic> j) => SearchHit(
        chatId: _string(j['chatId']),
        chatTitle: _string(j['chatTitle']),
        message: ClientMessage.fromJson(_map(j['message'])),
      );
}

/// One installed plugin, as `GET /plugins` lists it (behind the
/// `plugins-skills` bridge capability).
class PluginInfo {
  final String name;

  /// "builtin" (config-section plugin), "module", or "mcp".
  final String kind;
  final bool enabled;

  /// Where it comes from: a config section, module path, or MCP command.
  final String source;

  const PluginInfo({
    required this.name,
    required this.kind,
    required this.enabled,
    required this.source,
  });

  factory PluginInfo.fromJson(Map<String, dynamic> j) => PluginInfo(
        name: _string(j['name']),
        kind: _string(j['kind']),
        enabled: _bool(j['enabled']),
        source: _string(j['source']),
      );
}

/// One installed skill, as `GET /skills` lists it. A disabled skill drops
/// out of the model's prompt index but stays installed.
class SkillInfo {
  final String name;
  final String description;
  final bool enabled;

  const SkillInfo({
    required this.name,
    required this.description,
    required this.enabled,
  });

  factory SkillInfo.fromJson(Map<String, dynamic> j) => SkillInfo(
        name: _string(j['name']),
        description: _string(j['description']),
        enabled: _bool(j['enabled']),
      );
}
