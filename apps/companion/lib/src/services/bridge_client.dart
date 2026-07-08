import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/bridge_models.dart';
import '../models/connection.dart';
import 'log.dart';

/// Client for the Talon Client Bridge Protocol (v1).
///
/// REST for commands, a long-lived Server-Sent Events stream for everything the
/// daemon pushes. Transport-only: it parses frames and exposes typed futures +
/// a broadcast [events] stream. Reconnection/backoff lives in the caller
/// (AppState) so UI can reflect connection state.
class BridgeClient {
  ConnectionConfig config;
  final http.Client _http = http.Client();

  final _events = StreamController<Map<String, dynamic>>.broadcast();
  StreamSubscription<String>? _sseSub;
  http.Client? _sseClient;
  bool _closed = false;

  BridgeClient(this.config);

  /// Decoded SSE payloads (`{kind: ...}` objects).
  Stream<Map<String, dynamic>> get events => _events.stream;

  Uri _u(String path, [Map<String, String>? q]) =>
      Uri.parse('${config.baseUrl}$path').replace(queryParameters: q);

  // ── Health / discovery ─────────────────────────────────────────────────────

  /// Probe `/health`. Returns the parsed body if it's a Talon bridge, else null.
  Future<Map<String, dynamic>?> health({Duration? timeout}) async {
    try {
      AppLog.debug('bridge', 'health probe ${config.baseUrl}');
      final res = await _http
          .get(_u('/health'))
          .timeout(timeout ?? const Duration(seconds: 4));
      AppLog.debug('bridge', 'health result ${res.statusCode}');
      if (res.statusCode != 200) return null;
      final body = _decodeObject(res.body);
      return body['app'] == 'talon-bridge' ? body : null;
    } catch (e) {
      AppLog.warn('bridge', 'health probe failed', e);
      return null;
    }
  }

  // ── SSE stream ──────────────────────────────────────────────────────────────

  /// Open the event stream. Completes once the response headers arrive (i.e.
  /// the connection is live); individual events flow through [events].
  Future<void> connect({Duration timeout = const Duration(seconds: 10)}) async {
    await _sseSub?.cancel();
    _sseClient?.close();
    final client = http.Client();
    _sseClient = client;

    final req = http.Request('GET', Uri.parse(config.eventsUrl()))
      ..headers['Accept'] = 'text/event-stream'
      ..headers.addAll(config.authHeaders());

    AppLog.info('bridge', 'opening event stream ${config.host}:${config.port}');
    late http.StreamedResponse res;
    try {
      res = await client.send(req).timeout(timeout);
    } on TimeoutException catch (e) {
      client.close();
      if (identical(_sseClient, client)) _sseClient = null;
      AppLog.warn('bridge', 'event stream connect timed out', e);
      throw BridgeException(
        'Timed out connecting to event stream after ${timeout.inSeconds}s',
      );
    } catch (e) {
      client.close();
      if (identical(_sseClient, client)) _sseClient = null;
      AppLog.warn('bridge', 'event stream connect failed', e);
      throw BridgeException('Could not connect to event stream: $e');
    }
    if (res.statusCode != 200) {
      client.close();
      if (identical(_sseClient, client)) _sseClient = null;
      AppLog.warn('bridge', 'event stream rejected ${res.statusCode}');
      if (res.statusCode == 401) {
        throw BridgeException.unauthorized();
      }
      throw BridgeException('Event stream rejected (${res.statusCode})');
    }

    AppLog.info('bridge', 'event stream open');
    final buffer = StringBuffer();
    _sseSub = res.stream
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(
      (line) {
        if (line.startsWith(':')) return; // keep-alive comment
        if (line.isEmpty) {
          _flush(buffer);
          return;
        }
        if (line.startsWith('data:')) {
          buffer.writeln(line.substring(5).trimLeft());
        }
      },
      onError: (Object e) {
        AppLog.warn('bridge', 'event stream error', e);
        // dispose() closes the controller before the socket subscription is
        // fully torn down — a late transport error must not throw into it.
        if (!_closed) _events.addError(e);
      },
      onDone: () {
        if (!_closed) {
          AppLog.warn('bridge', 'event stream closed');
          _events.addError(BridgeException('Stream closed'));
        }
      },
      cancelOnError: true,
    );
  }

  void _flush(StringBuffer buffer) {
    final raw = buffer.toString().trim();
    buffer.clear();
    if (raw.isEmpty || _closed) return;
    try {
      final obj = _decodeObject(raw);
      _events.add(obj);
    } catch (e) {
      AppLog.debug('bridge', 'ignored malformed event frame', e);
      /* ignore malformed frame */
    }
  }

  // ── REST commands ──────────────────────────────────────────────────────────

  Future<List<ClientChat>> listChats() async {
    final j = await _getJson('/chats');
    return _list(j['chats']).map((c) => ClientChat.fromJson(_map(c))).toList();
  }

  Future<ClientChat> createChat([String? title]) async {
    final j = await _postJson('/chats', {if (title != null) 'title': title});
    return ClientChat.fromJson(_map(j['chat']));
  }

  Future<void> renameChat(String chatId, String title) =>
      _postJson('/chats/rename', {'chatId': chatId, 'title': title});

  Future<void> deleteChat(String chatId) =>
      _postJson('/chats/delete', {'chatId': chatId});

  Future<void> resetChat(String chatId) =>
      _postJson('/chats/reset', {'chatId': chatId});

  /// Best-effort interrupt of the chat's in-flight turn. Returns whether the
  /// daemon found a running turn to signal.
  Future<bool> interruptTurn(String chatId) async {
    final j = await _postJson('/chats/interrupt', {'chatId': chatId});
    return j['ok'] == true;
  }

  Future<void> setPulse(String chatId, bool on) =>
      _postJson('/chats/pulse', {'chatId': chatId, 'on': on});

  /// Set/replace/clear the chat's queued follow-up (empty text clears). The
  /// daemon broadcasts the change to every client via chat_updated.
  Future<void> queue(String chatId, String text) =>
      _postJson('/queue', {'chatId': chatId, 'text': text});

  Future<ConfigSnapshot> getConfig() async =>
      ConfigSnapshot.fromJson(await _getJson('/config'));

  Future<ConfigSnapshot> setConfig(Map<String, dynamic> update) async =>
      ConfigSnapshot.fromJson(await _postJson('/config', update));

  /// Newest daemon log entries (oldest first). [level] is a minimum severity
  /// (e.g. "warn" returns warn+error+fatal); [component] an exact subsystem tag.
  Future<List<DaemonLogEntry>> logs({
    int lines = 300,
    String? level,
    String? component,
  }) async {
    final j = await _getJson('/logs', {
      'lines': '$lines',
      if (level != null) 'level': level,
      if (component != null) 'component': component,
    });
    return _list(j['entries'])
        .map((e) => DaemonLogEntry.fromJson(_map(e)))
        .toList();
  }

  /// Fire a daemon-level control action ("restart", "dream"). Returns the
  /// daemon's ok/message result (never throws on an application-level failure —
  /// the server answers 200 with `ok:false`).
  Future<({bool ok, String message})> control(String action) async {
    final j = await _postJson('/control', {'action': action});
    return (
      ok: j['ok'] == true,
      message: j['message'] is String ? j['message'] as String : '',
    );
  }

  /// A page of history: the newest window by default, or — when [before] is
  /// given — the window of messages strictly older than that message id.
  Future<List<ClientMessage>> history(
    String chatId, {
    int? before,
    int? limit,
  }) async {
    final j = await _getJson('/history', {
      'chatId': chatId,
      if (before != null) 'before': '$before',
      if (limit != null) 'limit': '$limit',
    });
    return _list(
      j['messages'],
    ).map((m) => ClientMessage.fromJson(_map(m))).toList();
  }

  /// Full-text search across chats (or one chat when [chatId] is given).
  Future<List<SearchHit>> search(String query, {String? chatId}) async {
    final j = await _getJson('/search', {
      'q': query,
      if (chatId != null) 'chatId': chatId,
    });
    return _list(j['results']).map((r) => SearchHit.fromJson(_map(r))).toList();
  }

  Future<void> send(
    String chatId,
    String text, {
    String? imagePath,
    String? attachmentPath,
  }) =>
      _postJson('/send', {
        'chatId': chatId,
        'text': text,
        if (imagePath != null) 'imagePath': imagePath,
        if (attachmentPath != null) 'attachmentPath': attachmentPath,
      });

  /// Upload image bytes to the bridge. Returns the relative render path
  /// (`/media?id=…`) and the absolute on-disk path handed to the model.
  Future<({String imagePath, String path})> uploadImage(
    List<int> bytes,
    String filename,
    String contentType,
  ) async {
    final res = await _http
        .post(
          _u('/upload', {'filename': filename}),
          headers: config.authHeaders({'Content-Type': contentType}),
          body: bytes,
        )
        .timeout(const Duration(seconds: 30));
    final j = _decode(res);
    return (
      imagePath: j['imagePath']?.toString() ?? '',
      path: j['path']?.toString() ?? '',
    );
  }

  Future<(String active, List<ModelOption> models)> models([
    String? chatId,
  ]) async {
    final j = await _getJson('/models', {
      if (chatId != null) 'chatId': chatId,
    });
    final list = _list(
      j['models'],
    ).map((m) => ModelOption.fromJson(_map(m))).toList();
    return (j['active']?.toString() ?? '', list);
  }

  Future<void> setModel(String chatId, String model) =>
      _postJson('/model', {'chatId': chatId, 'model': model});

  Future<(String active, List<BackendOption> backends)> backends(
    String chatId,
  ) async {
    final j = await _getJson('/backends', {'chatId': chatId});
    final list = _list(
      j['backends'],
    ).map((b) => BackendOption.fromJson(_map(b))).toList();
    return (j['active']?.toString() ?? '', list);
  }

  /// Switch a chat's backend. Returns the daemon's application result so the
  /// caller can surface an error (e.g. "Backend not available") without the
  /// request throwing.
  Future<({bool ok, String? error})> setBackend(
    String chatId,
    String backend,
  ) async {
    final j = await _postJson('/backend', {
      'chatId': chatId,
      'backend': backend,
    });
    return (ok: j['ok'] == true, error: j['error']?.toString());
  }

  Future<void> setEffort(String chatId, String effort) =>
      _postJson('/effort', {'chatId': chatId, 'effort': effort});

  Future<(String active, List<String> levels)> effortLevels(
    String chatId,
  ) async {
    final j = await _getJson('/effort', {'chatId': chatId});
    return (
      j['active']?.toString() ?? 'adaptive',
      _list(j['levels']).map((e) => e.toString()).toList(),
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> _getJson(
    String path, [
    Map<String, String>? q,
  ]) async {
    try {
      final res = await _http
          .get(_u(path, q), headers: config.authHeaders())
          .timeout(const Duration(seconds: 12));
      return _decode(res);
    } catch (e) {
      AppLog.warn('bridge', 'GET $path failed', e);
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _postJson(
    String path,
    Map<String, dynamic> body,
  ) async {
    try {
      final res = await _http
          .post(
            _u(path),
            headers: config.authHeaders({'Content-Type': 'application/json'}),
            body: jsonEncode(body),
          )
          .timeout(const Duration(seconds: 12));
      return _decode(res);
    } catch (e) {
      AppLog.warn('bridge', 'POST $path failed', e);
      rethrow;
    }
  }

  Map<String, dynamic> _decode(http.Response res) {
    if (res.statusCode == 401) throw BridgeException.unauthorized();
    if (res.statusCode >= 400) {
      throw BridgeException('Request failed (${res.statusCode})');
    }
    if (res.body.isEmpty) return const {};
    return _decodeObject(res.body);
  }

  static Map<String, dynamic> _decodeObject(String raw) {
    final decoded = jsonDecode(raw);
    if (decoded is! Map) throw const FormatException('Expected JSON object');
    return decoded.cast<String, dynamic>();
  }

  static Map<String, dynamic> _map(Object? value) =>
      value is Map ? value.cast<String, dynamic>() : const {};

  static List<dynamic> _list(Object? value) =>
      value is List ? value : const <dynamic>[];

  void dispose() {
    _closed = true;
    AppLog.info('bridge', 'disconnect');
    _sseSub?.cancel();
    _sseClient?.close();
    _http.close();
    _events.close();
  }
}

class BridgeException implements Exception {
  final String message;
  final bool unauthorized;
  BridgeException(this.message) : unauthorized = false;
  BridgeException.unauthorized()
      : message = 'Unauthorized — check your token',
        unauthorized = true;
  @override
  String toString() => message;
}
