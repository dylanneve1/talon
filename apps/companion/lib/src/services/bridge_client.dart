import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/bridge_models.dart';
import '../models/connection.dart';

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
      final res = await _http
          .get(_u('/health'))
          .timeout(timeout ?? const Duration(milliseconds: 1200));
      if (res.statusCode != 200) return null;
      final body = (jsonDecode(res.body) as Map).cast<String, dynamic>();
      return body['app'] == 'talon-bridge' ? body : null;
    } catch (_) {
      return null;
    }
  }

  // ── SSE stream ──────────────────────────────────────────────────────────────

  /// Open the event stream. Completes once the response headers arrive (i.e.
  /// the connection is live); individual events flow through [events].
  Future<void> connect() async {
    await _sseSub?.cancel();
    _sseClient?.close();
    final client = http.Client();
    _sseClient = client;

    final req = http.Request('GET', Uri.parse(config.eventsUrl()))
      ..headers['Accept'] = 'text/event-stream'
      ..headers.addAll(config.authHeaders());

    final res = await client.send(req);
    if (res.statusCode != 200) {
      client.close();
      throw BridgeException('Event stream rejected (${res.statusCode})');
    }

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
      onError: (Object e) => _events.addError(e),
      onDone: () {
        if (!_closed) _events.addError(BridgeException('Stream closed'));
      },
      cancelOnError: true,
    );
  }

  void _flush(StringBuffer buffer) {
    final raw = buffer.toString().trim();
    buffer.clear();
    if (raw.isEmpty) return;
    try {
      final obj = (jsonDecode(raw) as Map).cast<String, dynamic>();
      _events.add(obj);
    } catch (_) {
      /* ignore malformed frame */
    }
  }

  // ── REST commands ──────────────────────────────────────────────────────────

  Future<List<ClientChat>> listChats() async {
    final j = await _getJson('/chats');
    return ((j['chats'] as List?) ?? const [])
        .map((c) => ClientChat.fromJson((c as Map).cast<String, dynamic>()))
        .toList();
  }

  Future<ClientChat> createChat([String? title]) async {
    final j = await _postJson('/chats', {if (title != null) 'title': title});
    return ClientChat.fromJson((j['chat'] as Map).cast<String, dynamic>());
  }

  Future<void> renameChat(String chatId, String title) =>
      _postJson('/chats/rename', {'chatId': chatId, 'title': title});

  Future<void> deleteChat(String chatId) =>
      _postJson('/chats/delete', {'chatId': chatId});

  Future<void> resetChat(String chatId) =>
      _postJson('/chats/reset', {'chatId': chatId});

  Future<void> setPulse(String chatId, bool on) =>
      _postJson('/chats/pulse', {'chatId': chatId, 'on': on});

  Future<ConfigSnapshot> getConfig() async =>
      ConfigSnapshot.fromJson(await _getJson('/config'));

  Future<ConfigSnapshot> setConfig(Map<String, dynamic> update) async =>
      ConfigSnapshot.fromJson(await _postJson('/config', update));

  Future<List<ClientMessage>> history(String chatId) async {
    final j = await _getJson('/history', {'chatId': chatId});
    return ((j['messages'] as List?) ?? const [])
        .map((m) => ClientMessage.fromJson((m as Map).cast<String, dynamic>()))
        .toList();
  }

  Future<void> send(String chatId, String text) =>
      _postJson('/send', {'chatId': chatId, 'text': text});

  Future<(String active, List<ModelOption> models)> models() async {
    final j = await _getJson('/models');
    final list = ((j['models'] as List?) ?? const [])
        .map((m) => ModelOption.fromJson((m as Map).cast<String, dynamic>()))
        .toList();
    return ((j['active'] ?? '') as String, list);
  }

  Future<void> setModel(String chatId, String model) =>
      _postJson('/model', {'chatId': chatId, 'model': model});

  Future<void> setEffort(String chatId, String effort) =>
      _postJson('/effort', {'chatId': chatId, 'effort': effort});

  Future<(String active, List<String> levels)> effortLevels(String chatId) async {
    final j = await _getJson('/effort', {'chatId': chatId});
    return (
      (j['active'] ?? 'adaptive') as String,
      ((j['levels'] as List?) ?? const []).map((e) => e.toString()).toList(),
    );
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  Future<Map<String, dynamic>> _getJson(String path,
      [Map<String, String>? q]) async {
    final res = await _http
        .get(_u(path, q), headers: config.authHeaders())
        .timeout(const Duration(seconds: 12));
    return _decode(res);
  }

  Future<Map<String, dynamic>> _postJson(
      String path, Map<String, dynamic> body) async {
    final res = await _http
        .post(_u(path),
            headers: config.authHeaders({'Content-Type': 'application/json'}),
            body: jsonEncode(body))
        .timeout(const Duration(seconds: 12));
    return _decode(res);
  }

  Map<String, dynamic> _decode(http.Response res) {
    if (res.statusCode == 401) throw BridgeException('Unauthorized — check token');
    if (res.statusCode >= 400) {
      throw BridgeException('Request failed (${res.statusCode})');
    }
    if (res.body.isEmpty) return const {};
    return (jsonDecode(res.body) as Map).cast<String, dynamic>();
  }

  void dispose() {
    _closed = true;
    _sseSub?.cancel();
    _sseClient?.close();
    _http.close();
    _events.close();
  }
}

class BridgeException implements Exception {
  final String message;
  BridgeException(this.message);
  @override
  String toString() => message;
}
