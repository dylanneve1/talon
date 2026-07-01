import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/bridge_models.dart';
import '../models/connection.dart';
import '../services/bridge_client.dart';
import '../services/daemon_supervisor.dart';
import '../services/log.dart';
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
    AppLog.info('app_state', 'connect attempt ${config.host}:${config.port}');
    _setConn(ConnState.connecting, null);

    if (config.canManageDaemon) {
      _supervisor = DaemonSupervisor(config);
      final ok = await _supervisor!.ensureRunning((d) {
        daemon = d;
        notifyListeners();
      });
      if (!ok) {
        _setConn(
          ConnState.error,
          daemon.detail ?? 'Could not reach or start Talon',
        );
        AppLog.warn('app_state', 'daemon unavailable');
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
      AppLog.info('app_state', 'health ${h == null ? 'failed' : 'ok'}');
      if (h == null) {
        throw BridgeException(
          'No Talon bridge at ${config.host}:${config.port}',
        );
      }

      _sub = client.events.listen(
        _onEvent,
        onError: (Object e) {
          if (_isUnauthorized(e)) {
            _stopUnauthorized();
            return;
          }
          _setConn(ConnState.error, e.toString());
          _scheduleReconnect();
        },
      );
      await client.connect();

      AppLog.info('app_state', 'connected');
      _setConn(ConnState.connected, null);
      _backoffMs = 800;
      await _refreshChats();
      unawaited(_refreshModels());
    } catch (e) {
      if (_isUnauthorized(e)) {
        _stopUnauthorized();
        return;
      }
      _setConn(ConnState.error, e.toString());
      _scheduleReconnect();
    }
  }

  void _scheduleReconnect() {
    if (_disposed) return;
    _reconnect?.cancel();
    AppLog.info('app_state', 'reconnect in ${_backoffMs}ms');
    _reconnect = Timer(Duration(milliseconds: _backoffMs), () {
      _backoffMs = (_backoffMs * 1.7).clamp(800, 15000).toInt();
      start();
    });
  }

  void _stopUnauthorized() {
    AppLog.warn('app_state', 'auth-fatal stop');
    _reconnect?.cancel();
    _setConn(ConnState.error, 'Unauthorized — check your token');
  }

  static bool _isUnauthorized(Object e) =>
      e is BridgeException && e.unauthorized ||
      e.toString().contains('Unauthorized') ||
      e.toString().contains('(401)');

  /// Apply a new connection profile and reconnect from scratch.
  Future<void> applyConfig(ConnectionConfig next) async {
    config = next;
    await prefs.setConnection(next);
    chats.clear();
    _messages.clear();
    _turns.clear();
    _loadedHistory.clear();
    selectedChatId = null;
    AppLog.info('app_state', 'connection config applied; stores reset');
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

  /// Backends selectable for a chat + the chat's active backend id.
  Future<(String, List<BackendOption>)> backends(String chatId) async =>
      await _client?.backends(chatId) ?? ('', const <BackendOption>[]);

  /// Switch a chat's backend. Returns the daemon result so the UI can toast a
  /// failure (e.g. "Backend not available") instead of silently no-op'ing.
  Future<({bool ok, String? error})> setBackend(
    String chatId,
    String backend,
  ) async {
    final r = await _client?.setBackend(chatId, backend);
    return r ?? (ok: false, error: 'Not connected');
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
    try {
      if (_applyEvent(e)) notifyListeners();
    } catch (err) {
      AppLog.warn('app_state', 'ignored malformed event', err);
    }
  }

  bool _applyEvent(Map<String, dynamic> e) {
    switch (e['kind'] as String?) {
      case 'hello':
        final rawStatus = _map(e['status']);
        if (rawStatus == null) return false;
        status = BridgeStatus.fromJson(rawStatus);
        _setChats(_list(e['chats']));
        return true;
      case 'status':
        final rawStatus = _map(e['status']);
        if (rawStatus == null) return false;
        status = BridgeStatus.fromJson(rawStatus);
        return true;
      case 'chat_created':
      case 'chat_updated':
        final rawChat = _map(e['chat']);
        if (rawChat == null) return false;
        _upsertChat(ClientChat.fromJson(rawChat));
        return true;
      case 'chat_deleted':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        _removeChat(chatId);
        return true;
      case 'message':
        final chatId = _string(e['chatId']);
        final rawMessage = _map(e['message']);
        if (chatId == null || rawMessage == null) return false;
        _onMessage(chatId, ClientMessage.fromJson(rawMessage));
        return true;
      case 'message_edited':
        final chatId = _string(e['chatId']);
        final messageId = _string(e['messageId']);
        if (chatId == null || messageId == null) return false;
        _editMessage(chatId, messageId, _string(e['text']) ?? '');
        return true;
      case 'message_deleted':
        final chatId = _string(e['chatId']);
        final messageId = _string(e['messageId']);
        if (chatId == null || messageId == null) return false;
        _deleteMessage(chatId, messageId);
        return true;
      case 'reaction':
        final chatId = _string(e['chatId']);
        final messageId = _string(e['messageId']);
        final emoji = _string(e['emoji']);
        if (chatId == null || messageId == null || emoji == null) {
          return false;
        }
        _addReaction(chatId, messageId, emoji);
        return true;
      case 'turn_start':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        turnFor(chatId).reset();
        return true;
      case 'reasoning':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        turnFor(chatId).reasoning.add(_string(e['text']) ?? '');
        return true;
      case 'delta':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        turnFor(chatId).draft += _string(e['text']) ?? '';
        return true;
      case 'tool':
        return _onTool(e);
      case 'typing':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        turnFor(chatId).typing = e['on'] == true;
        return true;
      case 'turn_end':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        final t = turnFor(chatId);
        // Guarantee all tools in the most recent assistant message are done.
        // Tool result events can race against the message snapshot — this is
        // the definitive point where the turn is finished.
        final msgs = _messages[chatId];
        if (msgs != null) {
          for (final msg in msgs.reversed) {
            if (msg.role == Role.assistant) {
              for (final tool in msg.tools) {
                if (!tool.done) {
                  tool.done = true;
                  tool.finishedAt ??= DateTime.now();
                }
              }
              break;
            }
          }
        }
        t.active = false;
        t.typing = false;
        t.draft = '';
        t.reasoning.clear();
        t.tools.clear();
        return true;
      case 'error':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        _appendSystem(chatId, _string(e['message']) ?? '');
        return true;
    }
    return false;
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

  bool _onTool(Map<String, dynamic> e) {
    final chatId = _string(e['chatId']);
    final id = _string(e['id']);
    if (chatId == null || id == null) return false;
    final name = _string(e['name']) ?? 'tool';
    // `end_turn` is the canonical delivery tool — its "result" is the assistant
    // message that arrives separately, so no tool_result event ever lands for
    // it. Showing it as a chip means an eternally-spinning row of noise.
    if (_isInternalTool(name)) return true;

    final t = turnFor(chatId);
    final phase = _string(e['phase']);
    final existing = t.tools.where((x) => x.id == id);
    if (phase == 'result') {
      if (existing.isNotEmpty) {
        existing.first.done = true;
        existing.first.finishedAt = DateTime.now();
        existing.first.error = _string(e['error']);
      } else {
        // The assistant message already arrived and tools were snapshotted into
        // it before this result event landed — update the historical copy too so
        // the chip doesn't spin forever in the message history.
        for (final msg in _messages[chatId] ?? <ClientMessage>[]) {
          for (final tool in msg.tools) {
            if (tool.id == id) {
              tool.done = true;
              tool.finishedAt ??= DateTime.now();
              tool.error = _string(e['error']);
            }
          }
        }
      }
      return true;
    }
    if (existing.isEmpty) {
      t.tools.add(
        ToolActivity(id: id, name: name, input: _map(e['input']) ?? const {}),
      );
    }
    return true;
  }

  static bool _isInternalTool(String name) =>
      name.contains('desktop-tools') ||
      name == 'end_turn' ||
      name.endsWith('__end_turn');

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

  /// Public: re-fetch the model catalog (optionally for a specific chat, so the
  /// active-model hint reflects that chat's backend). Used after a backend
  /// switch, where the newly-selected backend exposes a different model set.
  Future<void> refreshModels([String? chatId]) => _refreshModels(chatId);

  Future<void> _refreshModels([String? chatId]) async {
    try {
      final r = await _client?.models(chatId);
      if (r != null && !_disposed) {
        models = r.$2;
        notifyListeners();
      }
    } catch (e) {
      AppLog.warn('app_state', 'model refresh failed', e);
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
      ..addAll(
        raw
            .map(_map)
            .whereType<Map<String, dynamic>>()
            .map(ClientChat.fromJson),
      );
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

  void _sortChats() =>
      chats.sort((a, b) => b.lastActive.compareTo(a.lastActive));

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
    _messages.putIfAbsent(chatId, () => []).add(
          ClientMessage(
            id: 'sys-${DateTime.now().microsecondsSinceEpoch}',
            chatId: chatId,
            role: Role.system,
            text: text,
            ts: DateTime.now().millisecondsSinceEpoch,
          ),
        );
  }

  void _setConn(ConnState s, String? err) {
    conn = s;
    connError = err;
    notifyListeners();
  }

  static String? _string(Object? value) {
    if (value == null) return null;
    if (value is String) return value;
    return value.toString();
  }

  static Map<String, dynamic>? _map(Object? value) =>
      value is Map ? value.cast<String, dynamic>() : null;

  static List<dynamic> _list(Object? value) =>
      value is List ? value : const <dynamic>[];

  @override
  void dispose() {
    _disposed = true;
    _reconnect?.cancel();
    _sub?.cancel();
    _client?.dispose();
    super.dispose();
  }
}
