import 'dart:async';

import 'package:flutter/foundation.dart';

import '../models/bridge_models.dart';
import '../models/connection.dart';
import '../services/bridge_client.dart';
import '../services/daemon_supervisor.dart';
import '../services/local_discovery.dart';
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

  /// True when the model delivered a message mid-turn but hasn't ended the
  /// turn — i.e. it's still working and more is likely coming. Set on a short
  /// grace delay after a delivered assistant message (so a normal single-reply
  /// turn, where `turn_end` lands right after, never flashes it), cleared the
  /// moment fresh content streams or the turn actually ends. Drives the quiet
  /// "still working" indicator under the delivered bubble.
  bool continuing = false;

  void reset() {
    draft = '';
    reasoning.clear();
    tools.clear();
    active = true;
    typing = true;
    continuing = false;
  }
}

/// Single source of truth for the UI. Owns the bridge client, the daemon
/// supervisor (desktop), the chat/message stores, and reconnection.
class AppState extends ChangeNotifier {
  final Prefs prefs;
  ConnectionConfig config;

  AppState(this.prefs) : config = prefs.connection {
    _hydrateFromSnapshot();
  }

  BridgeClient? _client;
  DaemonSupervisor? _supervisor;
  StreamSubscription<Map<String, dynamic>>? _sub;
  Timer? _reconnect;
  int _backoffMs = 800;
  bool _disposed = false;

  /// Per-chat grace timers that promote a delivered-but-not-ended turn into the
  /// "still working" state. Keyed by chatId; cancelled on `turn_end`, fresh
  /// content, or a newer delivery.
  final Map<String, Timer> _continuingTimers = {};

  /// How long after a mid-turn assistant message we wait before showing the
  /// "still working" indicator. Long enough that a normal single-reply turn
  /// (whose `turn_end` lands right behind the message) never flashes it.
  static const Duration _continuingGrace = Duration(milliseconds: 600);

  /// Monotonic connection-attempt counter. Each [start] bumps it; awaited
  /// continuations from an older attempt compare against it and bail instead
  /// of disposing the newer attempt's client or stomping its state (e.g. the
  /// user taps Reconnect while a backoff-timer attempt is mid-flight).
  int _epoch = 0;

  /// The connection actually in use. In local auto-discover mode this carries
  /// the discovered port/token, which the saved [config] doesn't — anything
  /// that builds URLs (media, diagnostics) must use this, not [config].
  ConnectionConfig? _activeConfig;
  ConnectionConfig get activeConfig => _activeConfig ?? config;

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

  // History pagination: chats whose scrollback is fully loaded, and chats
  // with an older-page fetch in flight.
  static const int _historyPageSize = 100;
  static const int _historyInitialSize = 200;
  final Set<String> _historyExhausted = {};
  final Set<String> _loadingOlder = {};
  final Set<String> _loadingHistory = {};

  // Offline snapshot: debounce handle for persisted cold-start state.
  Timer? _snapshotTimer;

  bool isLoadingOlder(String chatId) => _loadingOlder.contains(chatId);
  bool hasMoreHistory(String chatId) => !_historyExhausted.contains(chatId);

  /// True while a chat's first history page is being fetched (skeleton UI).
  bool isHistoryLoading(String chatId) => _loadingHistory.contains(chatId);

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

  /// Connect using the current [config]: local desktop mode discovers Talon's
  /// bridge file first; legacy managed mode can still supervise a daemon when
  /// explicitly configured; everywhere, open the event stream and load chats.
  Future<void> start() async {
    _reconnect?.cancel();
    final epoch = ++_epoch;
    AppLog.info('app_state', 'connect attempt ${config.host}:${config.port}');
    _setConn(ConnState.connecting, null);

    if (config.canAutoDiscoverLocal) {
      daemon = const DaemonState(DaemonPhase.unknown);
      final bridge = await readLocalBridge();
      if (epoch != _epoch) return; // superseded by a newer attempt
      if (bridge == null) {
        _setConn(
          ConnState.error,
          "Talon isn't running on this computer — start Talon and it'll connect automatically.",
        );
        _scheduleReconnect();
        return;
      }
      final effective = config.copyWith(
        host: '127.0.0.1',
        port: bridge.port,
        token: bridge.token,
        clearToken: bridge.token == null,
        tls: bridge.scheme == 'https',
        manageLocalDaemon: false,
      );
      AppLog.info(
        'app_state',
        'local discovery ${effective.host}:${effective.port}',
      );
      await _openStream(effective, epoch);
    } else if (config.canManageDaemon) {
      _supervisor = DaemonSupervisor(config);
      final ok = await _supervisor!.ensureRunning((d) {
        if (epoch != _epoch) return;
        daemon = d;
        notifyListeners();
      });
      if (epoch != _epoch) return;
      if (!ok) {
        _setConn(
          ConnState.error,
          daemon.detail ?? 'Could not reach or start Talon',
        );
        AppLog.warn('app_state', 'daemon unavailable');
        _scheduleReconnect();
        return;
      }
      await _openStream(null, epoch);
    } else {
      daemon = const DaemonState(DaemonPhase.unknown);
      await _openStream(null, epoch);
    }
  }

  Future<void> _openStream(ConnectionConfig? effectiveConfig, int epoch) async {
    await _sub?.cancel();
    if (epoch != _epoch) return;
    _client?.dispose();
    final cfg = effectiveConfig ?? config;
    final client = BridgeClient(cfg);
    _client = client;
    _activeConfig = cfg;

    try {
      // Verify identity before committing to the stream — gives a crisp error
      // when the host/token is wrong rather than a silent dead stream.
      final h = await client.health();
      if (epoch != _epoch) {
        _disposeStale(client);
        return;
      }
      AppLog.info('app_state', 'health ${h == null ? 'failed' : 'ok'}');
      if (h == null) {
        throw BridgeException(
          'No Talon bridge at ${cfg.host}:${cfg.port}',
        );
      }

      _sub = client.events.listen(
        _onEvent,
        onError: (Object e) {
          if (!identical(_client, client)) return; // stale stream
          if (_isUnauthorized(e)) {
            _stopUnauthorized();
            return;
          }
          _setConn(ConnState.error, e.toString());
          _scheduleReconnect();
        },
      );
      await client.connect();
      if (epoch != _epoch) {
        _disposeStale(client);
        return;
      }

      AppLog.info('app_state', 'connected');
      _setConn(ConnState.connected, null);
      _backoffMs = 800;
      await _refreshChats();
      unawaited(_refreshModels());
    } catch (e) {
      if (epoch != _epoch) {
        _disposeStale(client);
        return;
      }
      if (_isUnauthorized(e)) {
        _stopUnauthorized();
        return;
      }
      _setConn(ConnState.error, e.toString());
      _scheduleReconnect();
    }
  }

  /// Tear down a client from a superseded connection attempt without touching
  /// the current one (a newer attempt may already own [_client]).
  void _disposeStale(BridgeClient client) {
    if (!identical(_client, client)) client.dispose();
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
    _activeConfig = null;
    await prefs.setConnection(next);
    chats.clear();
    _messages.clear();
    _turns.clear();
    _loadedHistory.clear();
    models = [];
    selectedChatId = null;
    AppLog.info('app_state', 'connection config applied; stores reset');
    await start();
  }

  // ── Commands ────────────────────────────────────────────────────────────────

  Future<void> selectChat(String chatId) async {
    selectedChatId = chatId;
    markRead(chatId);
    notifyListeners();
    if (!_loadedHistory.contains(chatId)) await _loadHistory(chatId);
  }

  // ── Unread tracking ────────────────────────────────────────────────────────

  /// A chat is unread when it saw activity newer than the user's last look
  /// and it isn't the one currently on screen.
  bool hasUnread(ClientChat chat) =>
      chat.id != selectedChatId &&
      chat.lastActive > prefs.lastReadOf(chat.id);

  void markRead(String chatId) {
    final chat = _chatById(chatId);
    final ts = chat?.lastActive ?? DateTime.now().millisecondsSinceEpoch;
    unawaited(prefs.setLastRead(chatId, ts));
  }

  // ── History pagination + search ───────────────────────────────────────────

  /// Fetch the page of messages older than the oldest one currently loaded.
  /// Returns how many new messages were prepended (0 when exhausted/offline).
  Future<int> loadOlderMessages(String chatId) async {
    if (_loadingOlder.contains(chatId) ||
        _historyExhausted.contains(chatId) ||
        conn != ConnState.connected) {
      return 0;
    }
    final msgs = _messages[chatId];
    if (msgs == null || msgs.isEmpty) return 0;
    // Oldest server-assigned id (local system notes have non-numeric ids).
    int? oldest;
    for (final m in msgs) {
      final n = int.tryParse(m.id);
      if (n != null) {
        oldest = n;
        break;
      }
    }
    if (oldest == null) return 0;

    _loadingOlder.add(chatId);
    notifyListeners();
    try {
      final page = await _client?.history(
            chatId,
            before: oldest,
            limit: _historyPageSize,
          ) ??
          const <ClientMessage>[];
      if (page.length < _historyPageSize) _historyExhausted.add(chatId);
      final existing = msgs.map((m) => m.id).toSet();
      final fresh = page.where((m) => !existing.contains(m.id)).toList();
      msgs.insertAll(0, fresh);
      return fresh.length;
    } catch (e) {
      AppLog.warn('app_state', 'older-history fetch failed', e);
      return 0;
    } finally {
      _loadingOlder.remove(chatId);
      notifyListeners();
    }
  }

  /// Daemon-side full-text search across all chats. Empty on failure so the
  /// quick switcher can fall back to local title matches silently.
  Future<List<SearchHit>> searchMessages(String query) async {
    if (conn != ConnState.connected || query.trim().isEmpty) return const [];
    try {
      return await _client?.search(query.trim()) ?? const [];
    } catch (e) {
      AppLog.warn('app_state', 'search failed', e);
      return const [];
    }
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

  ClientChat? _chatById(String chatId) {
    for (final c in chats) {
      if (c.id == chatId) return c;
    }
    return null;
  }

  /// Run a chat-scoped daemon command, surfacing failure as a system note in
  /// that chat instead of an unhandled async exception in a UI callback.
  Future<void> _command(String chatId, String what, Future<void> future) async {
    try {
      await future;
    } catch (e) {
      AppLog.warn('app_state', '$what failed', e);
      _appendSystem(chatId, '$what failed: $e');
    }
  }

  Future<void> renameChat(String chatId, String title) async {
    // Optimistic: reflect immediately; the chat_updated event reconciles.
    final chat = _chatById(chatId);
    if (chat != null && chat.title != title) {
      chat.title = title;
      notifyListeners();
    }
    final client = _client;
    if (client == null) return;
    await _command(chatId, 'Rename', client.renameChat(chatId, title));
  }

  Future<void> deleteChat(String chatId) async {
    final client = _client;
    if (client == null) return;
    // chat_deleted event reconciles state.
    await _command(chatId, 'Delete', client.deleteChat(chatId));
  }

  Future<void> sendMessage(
    String text, {
    String? imagePath,
    String? attachmentPath,
  }) async {
    final chatId = selectedChatId;
    final client = _client;
    if (chatId == null || client == null) return;
    // Text may be empty when an image is attached.
    if (text.trim().isEmpty && attachmentPath == null) return;
    // Always hand it to the daemon: if a turn is already running for this chat
    // the daemon parks it as the queued follow-up (synced to every client) and
    // auto-sends it at turn end, rather than interrupting. So the app doesn't
    // need to decide — it just sends.
    try {
      await client.send(
        chatId,
        text.trim(),
        imagePath: imagePath,
        attachmentPath: attachmentPath,
      );
    } catch (e) {
      _appendSystem(chatId, 'Failed to send: $e');
    }
  }

  // ── Queued follow-up (server-authoritative, one slot per chat) ────────────--

  /// The queued follow-up for a chat, or null when nothing is queued. Sourced
  /// from the chat's synced state so it's identical on every device.
  QueuedMessage? queuedFor(String chatId) => _chatById(chatId)?.queued;

  /// Set / replace / clear (empty text) the chat's queued follow-up. The daemon
  /// broadcasts the change back, so every client — including this one — updates
  /// from the authoritative chat_updated rather than a local guess.
  Future<void> editQueued(String chatId, String text) async {
    try {
      await _client?.queue(chatId, text);
    } catch (e) {
      AppLog.warn('app_state', 'queue edit failed', e);
    }
  }

  /// Upload image bytes and return the render + on-disk paths, or null on
  /// failure (a system note is appended so the user sees what happened).
  Future<({String imagePath, String path})?> uploadImage(
    List<int> bytes,
    String filename,
    String contentType,
  ) async {
    final client = _client;
    if (client == null) return null;
    try {
      return await client.uploadImage(bytes, filename, contentType);
    } catch (e) {
      final chatId = selectedChatId;
      if (chatId != null) _appendSystem(chatId, 'Upload failed: $e');
      return null;
    }
  }

  Future<void> setModel(String chatId, String model) async {
    // Optimistic: the header chip and sheet update instantly instead of
    // waiting a round-trip for chat_updated.
    final chat = _chatById(chatId);
    if (chat != null && chat.model != model) {
      chat.model = model;
      notifyListeners();
    }
    final client = _client;
    if (client == null) return;
    await _command(chatId, 'Model change', client.setModel(chatId, model));
  }

  /// Backends selectable for a chat + the chat's active backend id. Returns
  /// empty on any failure (e.g. an older daemon without the endpoint) so the
  /// sheet simply hides the backend row.
  Future<(String, List<BackendOption>)> backends(String chatId) async {
    try {
      return await _client?.backends(chatId) ?? ('', const <BackendOption>[]);
    } catch (e) {
      AppLog.warn('app_state', 'backends fetch failed', e);
      return ('', const <BackendOption>[]);
    }
  }

  /// Switch a chat's backend. Returns the daemon result so the UI can toast a
  /// failure (e.g. "Backend not available") instead of silently no-op'ing.
  Future<({bool ok, String? error})> setBackend(
    String chatId,
    String backend,
  ) async {
    try {
      final r = await _client?.setBackend(chatId, backend);
      if (r?.ok == true) {
        final chat = _chatById(chatId);
        if (chat != null && chat.backend != backend) {
          chat.backend = backend;
          notifyListeners();
        }
        // The new backend exposes a different model catalog, so re-pull the
        // models for this chat from the gateway. Without this the picker keeps
        // showing the previous backend's models until the next manual refresh.
        await _refreshModels(chatId);
      }
      return r ?? (ok: false, error: 'Not connected');
    } catch (e) {
      AppLog.warn('app_state', 'backend switch failed', e);
      return (ok: false, error: e.toString());
    }
  }

  Future<void> setEffort(String chatId, String effort) async {
    final chat = _chatById(chatId);
    if (chat != null && chat.effort != effort) {
      chat.effort = effort;
      notifyListeners();
    }
    final client = _client;
    if (client == null) return;
    await _command(chatId, 'Effort change', client.setEffort(chatId, effort));
  }

  /// Effort levels for a chat; empty on failure so the row hides.
  Future<(String, List<String>)> effortLevels(String chatId) async {
    try {
      return await _client?.effortLevels(chatId) ??
          ('adaptive', const <String>[]);
    } catch (e) {
      AppLog.warn('app_state', 'effort fetch failed', e);
      return ('adaptive', const <String>[]);
    }
  }

  Future<void> resetChat(String chatId) async {
    final client = _client;
    if (client == null) return;
    await _command(chatId, 'Reset', client.resetChat(chatId));
  }

  /// Whether a turn is currently running for [chatId] — drives the composer's
  /// send↔stop affordance.
  bool isTurnRunning(String chatId) => turnFor(chatId).active;

  /// Ask the daemon to interrupt the chat's in-flight turn. Best-effort: does
  /// nothing when the backend can't interrupt or no turn is running.
  Future<void> interruptTurn(String chatId) async {
    final client = _client;
    if (client == null) return;
    try {
      await client.interruptTurn(chatId);
    } catch (e) {
      AppLog.warn('app_state', 'interrupt failed', e);
    }
  }

  Future<void> setPulse(String chatId, bool on) async {
    final chat = _chatById(chatId);
    if (chat != null && chat.pulse != on) {
      chat.pulse = on;
      notifyListeners();
    }
    final client = _client;
    if (client == null) return;
    await _command(chatId, 'Pulse toggle', client.setPulse(chatId, on));
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
    try {
      final c = await _client?.setConfig(update);
      if (c != null) {
        appConfig = c;
        notifyListeners();
      }
      return c;
    } catch (e) {
      AppLog.warn('app_state', 'config update failed', e);
      return null;
    }
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

  /// Fire a daemon-level control action over the bridge ("restart", "dream").
  /// Unlike [restartDaemon] (which drives a locally-managed process), this asks
  /// the *running* daemon to act on itself, so it works over a remote bridge
  /// too — the app can restart a Talon running on another machine.
  Future<({bool ok, String message})> daemonControl(String action) async {
    final client = _client;
    if (client == null) return (ok: false, message: 'Not connected');
    try {
      return await client.control(action);
    } catch (e) {
      AppLog.warn('app_state', 'control "$action" failed', e);
      return (ok: false, message: '$e');
    }
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
        _continuingTimers.remove(chatId)?.cancel();
        turnFor(chatId).reset();
        return true;
      case 'reasoning':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        final t = turnFor(chatId);
        _clearContinuing(t, chatId);
        t.reasoning.add(_string(e['text']) ?? '');
        return true;
      case 'delta':
        final chatId = _string(e['chatId']);
        if (chatId == null) return false;
        final t = turnFor(chatId);
        _clearContinuing(t, chatId);
        t.draft += _string(e['text']) ?? '';
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
        // the definitive point where the turn is finished. Also attach the
        // turn's stats (duration + token usage) to that message so the bubble
        // can show a quiet footer.
        final usage = _map(e['usage']);
        final durationMs = e['durationMs'];
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
              if (durationMs is num) msg.durationMs = durationMs.toInt();
              if (usage != null) {
                final inTok = usage['input'];
                final outTok = usage['output'];
                if (inTok is num) msg.tokensIn = inTok.toInt();
                if (outTok is num) msg.tokensOut = outTok.toInt();
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
        _clearContinuing(t, chatId);
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
    // The visible chat is by definition read up to now.
    if (chatId == selectedChatId) markRead(chatId);
    // A delivered assistant message supersedes the live streaming state, but
    // NOT necessarily the turn: the model may have called send_message and
    // kept working (no end_turn yet). So fold the streamed draft/tools into
    // this bubble and clear the transient state, but leave the turn `active`
    // and let the definitive `turn_end` end it. To avoid flashing a "working"
    // indicator on a normal single-reply turn (where turn_end lands right
    // behind the message), arm a short grace timer: only if the turn is still
    // active when it fires do we promote to the `continuing` state.
    if (m.role == Role.assistant) {
      final t = turnFor(chatId);
      // Hand the live tools to the message so the bubble can show a history.
      m.tools.addAll(t.tools);
      t.typing = false;
      t.draft = '';
      t.reasoning.clear();
      t.tools.clear();
      t.continuing = false;
      _continuingTimers.remove(chatId)?.cancel();
      if (t.active) {
        _continuingTimers[chatId] = Timer(_continuingGrace, () {
          _continuingTimers.remove(chatId);
          final cur = turnFor(chatId);
          // Still mid-turn with nothing newer streaming → show "still working".
          if (cur.active && cur.draft.isEmpty && cur.tools.isEmpty) {
            cur.continuing = true;
            notifyListeners();
          }
        });
      }
    }
  }

  /// Drop any pending "still working" promotion for a chat and clear the flag.
  /// Called whenever fresh content streams or the turn ends.
  void _clearContinuing(TurnState t, String chatId) {
    _continuingTimers.remove(chatId)?.cancel();
    t.continuing = false;
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
    final output = _string(e['output']);
    final existing = t.tools.where((x) => x.id == id);
    if (phase == 'result') {
      if (existing.isNotEmpty) {
        existing.first.done = true;
        existing.first.finishedAt = DateTime.now();
        existing.first.error = _string(e['error']);
        if (output != null) existing.first.output = output;
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
              if (output != null) tool.output = output;
            }
          }
        }
      }
      return true;
    }
    if (existing.isEmpty) {
      _clearContinuing(t, chatId);
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
    _reconcileSelection();
    // This runs on every (re)connect. History may have advanced while we were
    // disconnected (a heartbeat/cron reply, another client, a network blip or
    // laptop sleep), so drop the "already loaded" marks — otherwise a chat we'd
    // viewed before would keep its stale message list forever. Re-fetch the
    // visible chat now; the rest reload lazily when next opened.
    _loadedHistory.clear();
    _historyExhausted.clear();
    if (selectedChatId != null) {
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
        // The gateway also reports the chat's active model — sync it so the
        // header chip is right immediately after a backend switch, even if
        // the daemon's chat_updated event is late or missing.
        if (chatId != null && r.$1.isNotEmpty) {
          final chat = _chatById(chatId);
          if (chat != null) chat.model = r.$1;
        }
        notifyListeners();
      }
    } catch (e) {
      AppLog.warn('app_state', 'model refresh failed', e);
    }
  }

  Future<void> _loadHistory(String chatId) async {
    _loadingHistory.add(chatId);
    notifyListeners();
    try {
      final hist =
          await _client?.history(chatId, limit: _historyInitialSize) ??
              const <ClientMessage>[];
      if (hist.length < _historyInitialSize) {
        _historyExhausted.add(chatId);
      } else {
        _historyExhausted.remove(chatId);
      }
      // Merge rather than overwrite: a live `message` event can land while this
      // fetch is in flight, and a blind assignment would drop it (it isn't in
      // the server snapshot yet). History is authoritative for order; append
      // any newer live messages not already present, deduped by id.
      final histIds = hist.map((m) => m.id).toSet();
      final extras = (_messages[chatId] ?? const <ClientMessage>[])
          .where((m) => !histIds.contains(m.id));
      _messages[chatId] = [...hist, ...extras];
      _loadedHistory.add(chatId);
    } catch (_) {
      /* leave existing messages; stream will fill in */
    } finally {
      _loadingHistory.remove(chatId);
      notifyListeners();
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
    _reconcileSelection();
  }

  /// Keep the selection valid against the freshly-set chat list: a chat
  /// deleted while we were away must not stay selected (it would render an
  /// empty conversation and fetch history for a dead id), and with nothing
  /// selected we default to the most recent chat.
  void _reconcileSelection() {
    if (selectedChatId != null &&
        !chats.any((c) => c.id == selectedChatId)) {
      selectedChatId = null;
    }
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
    _historyExhausted.remove(chatId);
    unawaited(prefs.clearLastRead(chatId));
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
    // Callers outside the event loop (send/upload/command failures) rely on
    // this notify — without it the note only appears on the next repaint.
    notifyListeners();
  }

  void _setConn(ConnState s, String? err) {
    conn = s;
    connError = err;
    notifyListeners();
  }

  // ── Offline snapshot (instant cold-start) ─────────────────────────────────

  /// Restore last-known chats + recent messages so the app renders content
  /// immediately on launch, before (or without) a bridge connection. The
  /// live connect replaces everything with authoritative server state.
  void _hydrateFromSnapshot() {
    final snap = prefs.snapshot;
    if (snap == null) return;
    try {
      final rawChats = snap['chats'];
      if (rawChats is List) {
        chats.addAll(rawChats
            .map(_map)
            .whereType<Map<String, dynamic>>()
            .map(ClientChat.fromJson));
      }
      final rawMessages = snap['messages'];
      if (rawMessages is Map) {
        rawMessages.forEach((chatId, list) {
          if (list is List) {
            _messages['$chatId'] = list
                .map(_map)
                .whereType<Map<String, dynamic>>()
                .map(ClientMessage.fromJson)
                .toList();
          }
        });
      }
      _sortChats();
      _reconcileSelection();
      AppLog.info('app_state', 'hydrated ${chats.length} chats from snapshot');
    } catch (e) {
      AppLog.warn('app_state', 'snapshot hydration failed', e);
    }
  }

  /// Debounced persist of a bounded snapshot (all chats, last 30 messages
  /// each, system notes excluded — they're transient).
  void _scheduleSnapshotSave() {
    if (_disposed || _snapshotTimer != null) return;
    _snapshotTimer = Timer(const Duration(seconds: 2), () {
      _snapshotTimer = null;
      if (_disposed) return;
      final snapshot = <String, dynamic>{
        'chats': chats.map((c) => c.toSnapshotJson()).toList(),
        'messages': {
          for (final entry in _messages.entries)
            entry.key: entry.value
                .where((m) => m.role != Role.system)
                .toList()
                .reversed
                .take(30)
                .toList()
                .reversed
                .map((m) => m.toSnapshotJson())
                .toList(),
        },
      };
      unawaited(prefs.saveSnapshot(snapshot));
    });
  }

  @override
  void notifyListeners() {
    super.notifyListeners();
    // Every state change is a candidate for the offline snapshot; the
    // 2s debounce keeps this from thrashing during streaming.
    _scheduleSnapshotSave();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  /// Render a conversation as portable markdown (for copy/share).
  String exportMarkdown(String chatId) {
    final chat = _chatById(chatId);
    final buf = StringBuffer('# ${chat?.title ?? 'Talon chat'}\n\n');
    for (final m in messagesFor(chatId)) {
      if (m.role == Role.system) continue;
      final who = m.role == Role.user ? 'User' : status.botName;
      final when = m.time.toLocal().toString().split('.').first;
      buf
        ..writeln('**$who** — $when')
        ..writeln()
        ..writeln(m.text.trim())
        ..writeln();
    }
    return buf.toString();
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
    _snapshotTimer?.cancel();
    for (final t in _continuingTimers.values) {
      t.cancel();
    }
    _continuingTimers.clear();
    _sub?.cancel();
    _client?.dispose();
    super.dispose();
  }
}
