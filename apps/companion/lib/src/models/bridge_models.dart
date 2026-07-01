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
    );
  }

  DateTime get time => DateTime.fromMillisecondsSinceEpoch(ts);
}

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
      );

  DateTime get lastActiveTime =>
      DateTime.fromMillisecondsSinceEpoch(lastActive);
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

  const BridgeStatus({
    required this.protocol,
    required this.botName,
    required this.backend,
    required this.model,
    required this.activeChats,
    required this.startedAt,
  });

  factory BridgeStatus.fromJson(Map<String, dynamic> j) => BridgeStatus(
        protocol: _int(j['protocol'], 1),
        botName: _string(j['botName'], 'Talon'),
        backend: _string(j['backend']),
        model: _string(j['model']),
        activeChats: _int(j['activeChats']),
        startedAt: _string(j['startedAt']),
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
  final DateTime startedAt;
  DateTime? finishedAt;

  ToolActivity({
    required this.id,
    required this.name,
    this.done = false,
    this.error,
    Map<String, dynamic>? input,
    DateTime? startedAt,
    this.finishedAt,
  })  : input = input ?? <String, dynamic>{},
        startedAt = startedAt ?? DateTime.now();

  Duration get elapsed => (finishedAt ?? DateTime.now()).difference(startedAt);
}
