import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/bridge_models.dart';
import '../models/connection.dart';
import '../services/bridge_client.dart';
import '../services/daemon_supervisor.dart';
import '../services/prefs.dart';

enum ConnState { idle, connecting, connected, error }

/// Transient per-turn state: the streaming draft, the model's reasoning, and
/// any live tool calls. Cleared when the turn ends.
class TurnState {
  String draft = '';
  final List<String> reasoning = [];
  final List<ToolActivity> tools = [];
  bool active = false;
  bool typing = false;

  void reset() {
    draft = '';
    reasoning.clear();
    tools.clear();
    active = true;
    typing = true;
  }
}

/// Single source of truth for the UI. Owns the bridge client, the daemon
/// supervisor (desktop), the chat/message stores, and reconnection.
class AppState extends ChangeNotifier {
  final Prefs prefs;
  ConnectionConfig config;

  AppState(this.prefs) : config = prefs.connection;

  BridgeClient? _client;
  DaemonSupervisor? _supervisor;
  StreamSubscription<Map<String, dynamic>>? _sub;
  Timer? _reconnect;
  int _backoffMs = 800;
  bool _disposed = false;

  // Connection
  ConnState conn = ConnState.idle;
  String? connError;
  DaemonState daemon = const DaemonState(DaemonPhase.unknown);
  BridgeStatus status = BridgeStatus.empty;

  // Data
  final List<ClientChat> chats = [];
  String? selectedChatId;
  final Map<String, List<ClientMessage>> _messages = {};
  final Map<String, TurnState> _turns = {};
  final Set<String> _loadedHistory = {};

  // Models
  List<ModelOption> models = [];

  // Daemon settings (synced from the bridge)
  ConfigSnapshot? appConfig;

  List<ClientMessage> messagesFor(String chatId) =>
      _messages[chatId] ?? const [];
  TurnState turnFor(String chatId) => _turns.putIfAbsent(chatId, TurnState.new);
  ClientChat? get selectedChat {
    for (final c in chats) {
      if (c.id == selectedChatId) return c;
    }
    return null;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /// Connect using the current [config]: on desktop, ensure a daemon is up
  /// first; everywhere, open the event stream and load chats.
  Future<void> start() async {
    _reconnect?.cancel();
    _setConn(ConnState.connecting, null);

    if (config.canManageDaemon) {
      _supervisor = DaemonSupervisor(config);
      final ok = await _supervisor!.ensureRunning((d) {
        daemon = d;
        notifyListeners();
      });
      if (!ok) {
        _setConn(ConnState.error,
            daemon.detail ?? 'Could not reach or start Talon');
        _scheduleReconnect();
        return;
      }
    } else {
      daemon = const DaemonState(DaemonPhase.unknown);
    }

    await _openStream();
  }

  Future<void> _openStream() async {
    await _sub?.cancel();
    _client?.dispose();
    final client = BridgeClient(config);
    _client = client;

    try {
      // Verify identity before committing to the stream — gives a crisp error
      // when the host/token is wrong rather than a silent dead stream.
      final h = await client.health();
      if (h == null) throw BridgeException('No Talon bridge at ${config.host}:${config.port}');

      _sub = client.events.listen(_onEvent, onError: (Object e) {
        _setConn(ConnState.error, e.toString());
        _scheduleReconnect();
      });
      await client.connect();

      _setConn(ConnState.connected, null);
      _backoffMs = 800;
      await _refreshChats();
      unawaited(_refreshModels());
    } catch (e) {
      _setConn(ConnState.error, e.toString());
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnect?.cancel();
    _reconnect = Timer(Duration(milliseconds: _backoffMs), () {
      _backoffMs = (_backoffMs * 1.7).clamp(800, 15000).toInt();
      start();
    });
  }

  /// Apply a new connection profile and reconnect from scratch.
  Future<void> applyConfig(ConnectionConfig next) async {
    config = next;
    await prefs.setConnection(next);
    chats.clear();
    _messages.clear();
    _turns.clear();
    _loadedHistory.clear();
    selectedChatId = null;
    await start();
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  Future<void> selectChat(String chatId) async {
    selectedChatId = chatId;
    notifyListeners();
    if (!_loadedHistory.contains(chatId)) await _loadHistory(chatId);
  }

  /// Narrow layout: return to the chat list.
  void clearSelection() {
    selectedChatId = null;
    notifyListeners();
  }

  Future<void> newChat() async {
    final c = await _client?.createChat();
    if (c == null) return;
    // chat_created event will also arrive; select eagerly for snappiness.
    _upsertChat(c);
    selectedChatId = c.id;
    _loadedHistory.add(c.id);
    notifyListeners();
  }

  Future<void> renameChat(String chatId, String title) =>
      _client?.renameChat(chatId, title) ?? Future.value();

  Future<void> deleteChat(String chatId) async {
    await _client?.deleteChat(chatId);
    // chat_deleted event reconciles state.
  }

  Future<void> sendMessage(String text) async {
    final chatId = selectedChatId;
    final client = _client;
    if (chatId == null || client == null || text.trim().isEmpty) return;
    try {
      await client.send(chatId, text.trim());
    } catch (e) {
      _appendSystem(chatId, 'Failed to send: $e');
    }
  }

  Future<void> setModel(String chatId, String model) async {
    await _client?.setModel(chatId, model);
  }

  Future<void> setEffort(String chatId, String effort) async {
    await _client?.setEffort(chatId, effort);
  }

  Future<(String, List<String>)> effortLevels(String chatId) async =>
      await _client?.effortLevels(chatId) ?? ('adaptive', const <String>[]);

  Future<void> resetChat(String chatId) async {
    await _client?.resetChat(chatId);
  }

  Future<void> setPulse(String chatId, bool on) async {
    await _client?.setPulse(chatId, on);
  }

  Future<ConfigSnapshot?> loadConfig() async {
    final c = await _client?.getConfig();
    if (c != null) {
      appConfig = c;
      notifyListeners();
    }
    return c;
  }

  Future<ConfigSnapshot?> updateConfig(Map<String, dynamic> update) async {
    final c = await _client?.setConfig(update);
    if (c != null) {
      appConfig = c;
      notifyListeners();
    }
    return c;
  }

  /// Desktop only: restart the managed daemon, then reconnect.
  Future<({bool ok, String? detail})> restartDaemon() async {
    if (!config.canManageDaemon) {
      return (ok: false, detail: 'Restart needs a local managed daemon');
    }
    _setConn(ConnState.connecting, null);
    final result = await DaemonSupervisor(config).restart();
    if (result.ok) {
      // Give the old process a moment to release the port before reattaching.
      await Future<void>.delayed(const Duration(seconds: 2));
      await start();
    } else {
      _setConn(ConnState.error, result.detail);
    }
    return result;
  }

  // ── Event handling ───────────────────────────────────────────────────────--

  void _onEvent(Map<String, dynamic> e) {
    switch (e['kind'] as String?) {
      case 'hello':
        status = BridgeStatus.fromJson((e['status'] as Map).cast());
        _setChats((e['chats'] as List?) ?? const []);
        break;
      case 'status':
        status = BridgeStatus.fromJson((e['status'] as Map).cast());
        break;
      case 'chat_created':
      case 'chat_updated':
        _upsertChat(ClientChat.fromJson((e['chat'] as Map).cast()));
        break;
      case 'chat_deleted':
        _removeChat(e['chatId'] as String);
        break;
      case 'message':
        _onMessage(e['chatId'] as String,
            ClientMessage.fromJson((e['message'] as Map).cast()));
        break;
      case 'message_edited':
        _editMessage(e['chatId'] as String, e['messageId'].toString(),
            (e['text'] ?? '') as String);
        break;
      case 'message_deleted':
        _deleteMessage(e['chatId'] as String, e['messageId'].toString());
        break;
      case 'reaction':
        _addReaction(e['chatId'] as String, e['messageId'].toString(),
            (e['emoji'] ?? '') as String);
        break;
      case 'turn_start':
        turnFor(e['chatId'] as String).reset();
        break;
      case 'reasoning':
        final t = turnFor(e['chatId'] as String);
        t.reasoning.add((e['text'] ?? '') as String);
        break;
      case 'delta':
        turnFor(e['chatId'] as String).draft += (e['text'] ?? '') as String;
        break;
      case 'tool':
        _onTool(e);
        break;
      case 'typing':
        turnFor(e['chatId'] as String).typing = (e['on'] ?? false) as bool;
        break;
      case 'turn_end':
        final t = turnFor(e['chatId'] as String);
        t.active = false;
        t.typing = false;
        t.draft = '';
        t.reasoning.clear();
        t.tools.clear();
        break;
      case 'error':
        final chatId = e['chatId'] as String?;
        if (chatId != null) _appendSystem(chatId, (e['message'] ?? '') as String);
        break;
    }
    notifyListeners();
  }

  void _onMessage(String chatId, ClientMessage m) {
    final list = _messages.putIfAbsent(chatId, () => []);
    if (list.any((x) => x.id == m.id)) return; // dedupe re-delivery
    list.add(m);
    // Canonical reply supersedes the live turn. End it now so we don't flash
    // typing dots / orphan tool chips while waiting for the trailing turn_end.
    if (m.role == Role.assistant) {
      final t = turnFor(chatId);
      // Hand the live tools to the message so the bubble can show a history.
      m.tools.addAll(t.tools);
      t.active = false;
      t.typing = false;
      t.draft = '';
      t.reasoning.clear();
      t.tools.clear();
    }
  }

  void _onTool(Map<String, dynamic> e) {
    final name = (e['name'] ?? 'tool') as String;
    // `end_turn` is the canonical delivery tool — its "result" is the assistant
    // message that arrives separately, so no tool_result event ever lands for
    // it. Showing it as a chip means an eternally-spinning row of noise.
    if (_isInternalTool(name)) return;

    final t = turnFor(e['chatId'] as String);
    final id = e['id'].toString();
    final phase = e['phase'] as String?;
    final existing = t.tools.where((x) => x.id == id);
    if (phase == 'result') {
      if (existing.isNotEmpty) {
        existing.first.done = true;
        existing.first.finishedAt = DateTime.now();
        existing.first.error = e['error'] as String?;
      }
      return;
    }
    if (existing.isEmpty) {
      t.tools.add(ToolActivity(
        id: id,
        name: name,
        input: ((e['input'] as Map?) ?? const {}).cast<String, dynamic>(),
      ));
    }
  }

  static bool _isInternalTool(String name) => name == 'end_turn';

  // ── Store helpers ────────────────────────────────────────────────────────--

  Future<void> _refreshChats() async {
    final list = await _client?.listChats() ?? const [];
    chats
      ..clear()
      ..addAll(list);
    _sortChats();
    selectedChatId ??= chats.isNotEmpty ? chats.first.id : null;
    if (selectedChatId != null && !_loadedHistory.contains(selectedChatId)) {
      await _loadHistory(selectedChatId!);
    }
    notifyListeners();
  }

  Future<void> _refreshModels() async {
    final r = await _client?.models();
    if (r != null) {
      models = r.$2;
      notifyListeners();
    }
  }

  Future<void> _loadHistory(String chatId) async {
    try {
      final msgs = await _client?.history(chatId) ?? const [];
      _messages[chatId] = msgs;
      _loadedHistory.add(chatId);
      notifyListeners();
    } catch (_) {
      /* leave empty; stream will fill in */
    }
  }

  void _setChats(List<dynamic> raw) {
    chats
      ..clear()
      ..addAll(raw.map((c) => ClientChat.fromJson((c as Map).cast())));
    _sortChats();
    selectedChatId ??= chats.isNotEmpty ? chats.first.id : null;
  }

  void _upsertChat(ClientChat c) {
    final i = chats.indexWhere((x) => x.id == c.id);
    if (i >= 0) {
      chats[i] = c;
    } else {
      chats.add(c);
    }
    _sortChats();
  }

  void _removeChat(String chatId) {
    chats.removeWhere((c) => c.id == chatId);
    _messages.remove(chatId);
    _turns.remove(chatId);
    _loadedHistory.remove(chatId);
    if (selectedChatId == chatId) {
      selectedChatId = chats.isNotEmpty ? chats.first.id : null;
    }
  }

  void _sortChats() => chats.sort((a, b) => b.lastActive.compareTo(a.lastActive));

  void _editMessage(String chatId, String messageId, String text) {
    for (final m in _messages[chatId] ?? const <ClientMessage>[]) {
      if (m.id == messageId) m.text = text;
    }
  }

  void _deleteMessage(String chatId, String messageId) {
    _messages[chatId]?.removeWhere((m) => m.id == messageId);
  }

  void _addReaction(String chatId, String messageId, String emoji) {
    for (final m in _messages[chatId] ?? const <ClientMessage>[]) {
      if (m.id == messageId && !m.reactions.contains(emoji)) {
        m.reactions.add(emoji);
      }
    }
  }

  void _appendSystem(String chatId, String text) {
    _messages.putIfAbsent(chatId, () => []).add(ClientMessage(
          id: 'sys-${DateTime.now().microsecondsSinceEpoch}',
          chatId: chatId,
          role: Role.system,
          text: text,
          ts: DateTime.now().millisecondsSinceEpoch,
        ));
  }

  void _setConn(ConnState s, String? err) {
    conn = s;
    connError = err;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _reconnect?.cancel();
    _sub?.cancel();
    _client?.dispose();
    super.dispose();
  }
}
