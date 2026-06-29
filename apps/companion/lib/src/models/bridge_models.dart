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

class ClientButton {
  final String text;
  final String? url;
  final String? data;
  const ClientButton({required this.text, this.url, this.data});

  factory ClientButton.fromJson(Map<String, dynamic> j) => ClientButton(
        text: (j['text'] ?? '') as String,
        url: j['url'] as String?,
        data: j['data'] as String?,
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

  /// Tools that ran during this assistant turn (client-only — snapshot from
  /// the live turn when the canonical message arrives, so the history pane
  /// can show what the model did).
  final List<ToolActivity> tools;

  /// True while assistant text is still streaming into this bubble (client-only).
  bool streaming;

  ClientMessage({
    required this.id,
    required this.chatId,
    required this.role,
    required this.text,
    required this.ts,
    this.buttons = const [],
    List<String>? reactions,
    List<ToolActivity>? tools,
    this.streaming = false,
  })  : reactions = reactions ?? <String>[],
        tools = tools ?? <ToolActivity>[];

  factory ClientMessage.fromJson(Map<String, dynamic> j) {
    final rawButtons = (j['buttons'] as List?) ?? const [];
    return ClientMessage(
      id: j['id'].toString(),
      chatId: (j['chatId'] ?? '') as String,
      role: _roleFrom(j['role'] as String?),
      text: (j['text'] ?? '') as String,
      ts: (j['ts'] ?? 0) as int,
      buttons: rawButtons
          .map<List<ClientButton>>((row) => ((row as List?) ?? const [])
              .map((c) => ClientButton.fromJson((c as Map).cast<String, dynamic>()))
              .toList())
          .toList(),
      reactions:
          ((j['reactions'] as List?) ?? const []).map((e) => e.toString()).toList(),
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
  String? effort;
  bool? pulse;

  ClientChat({
    required this.id,
    required this.title,
    required this.createdAt,
    required this.lastActive,
    required this.preview,
    this.model,
    this.effort,
    this.pulse,
  });

  factory ClientChat.fromJson(Map<String, dynamic> j) => ClientChat(
        id: (j['id'] ?? '') as String,
        title: (j['title'] ?? 'New chat') as String,
        createdAt: (j['createdAt'] ?? 0) as int,
        lastActive: (j['lastActive'] ?? 0) as int,
        preview: (j['preview'] ?? '') as String,
        model: j['model'] as String?,
        effort: j['effort'] as String?,
        pulse: j['pulse'] as bool?,
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
    final health = ((j['health'] as Map?) ?? const {}).cast<String, dynamic>();
    return ConfigSnapshot(
      backend: (j['backend'] ?? '') as String,
      frontend: (j['frontend'] ?? '') as String,
      model: (j['model'] ?? '') as String,
      modelDisplay: (j['modelDisplay'] ?? '') as String,
      botDisplayName: (j['botDisplayName'] ?? 'Talon') as String,
      timezone: (j['timezone'] ?? '') as String,
      pulse: (j['pulse'] ?? false) as bool,
      pulseIntervalMs: (j['pulseIntervalMs'] ?? 300000) as int,
      heartbeat: (j['heartbeat'] ?? false) as bool,
      heartbeatIntervalMinutes: (j['heartbeatIntervalMinutes'] ?? 60) as int,
      dream: (j['dream'] ?? false) as bool,
      editable:
          ((j['editable'] as List?) ?? const []).map((e) => e.toString()).toList(),
      healthy: (health['healthy'] ?? false) as bool,
      uptimeMs: (health['uptimeMs'] ?? 0) as int,
      sessions: (health['sessions'] ?? 0) as int,
      messages: (health['messages'] ?? 0) as int,
      memoryMb: (health['memoryMb'] ?? 0) as int,
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
        protocol: (j['protocol'] ?? 1) as int,
        botName: (j['botName'] ?? 'Talon') as String,
        backend: (j['backend'] ?? '') as String,
        model: (j['model'] ?? '') as String,
        activeChats: (j['activeChats'] ?? 0) as int,
        startedAt: (j['startedAt'] ?? '') as String,
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
        id: (j['id'] ?? '') as String,
        displayName: (j['displayName'] ?? '') as String,
        provider: (j['provider'] ?? '') as String,
        reasoning: (j['reasoning'] ?? false) as bool,
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
