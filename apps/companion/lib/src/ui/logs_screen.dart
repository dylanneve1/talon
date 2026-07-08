import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../models/bridge_models.dart';
import '../services/log.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'glass.dart';

/// Daemon log viewer — a nicely rendered tail of the daemon's log file
/// (served by `GET /logs`), with severity/component/text filtering, live
/// follow, and per-row expansion for error details and stack traces.
class LogsScreen extends StatefulWidget {
  final AppState state;
  const LogsScreen({super.key, required this.state});

  @override
  State<LogsScreen> createState() => _LogsScreenState();
}

class _LogsScreenState extends State<LogsScreen> {
  List<DaemonLogEntry> _entries = const [];
  bool _loading = true;
  String? _error;

  /// Minimum severity to request (null = everything).
  String? _minLevel;

  /// Exact component filter (null = all components).
  String? _component;

  /// Components seen across loads, so the filter menu stays stable even
  /// when the current filter hides some of them.
  final Set<String> _knownComponents = {};

  /// Live follow: refresh every few seconds and stick to the bottom.
  bool _follow = true;
  Timer? _followTimer;

  final _search = TextEditingController();
  final _scroll = ScrollController();

  /// Row index → expanded, for entries with error/stack detail.
  final Set<int> _expanded = {};

  @override
  void initState() {
    super.initState();
    _load();
    _armFollow();
    _search.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _followTimer?.cancel();
    _search.dispose();
    _scroll.dispose();
    super.dispose();
  }

  void _armFollow() {
    _followTimer?.cancel();
    if (!_follow) return;
    _followTimer = Timer.periodic(
      const Duration(seconds: 3),
      (_) => _load(quiet: true),
    );
  }

  Future<void> _load({bool quiet = false}) async {
    if (!quiet) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final entries = await widget.state.daemonLogs(
        lines: 400,
        level: _minLevel,
        component: _component,
      );
      if (!mounted) return;
      setState(() {
        _entries = entries;
        _knownComponents.addAll(
          entries.map((e) => e.component).where((c) => c.isNotEmpty),
        );
        _loading = false;
        _error = null;
        _expanded.clear();
      });
      if (_follow) _jumpToBottom();
    } catch (e) {
      AppLog.warn('logs', 'daemon log fetch failed', e);
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  void _jumpToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scroll.hasClients) {
        _scroll.jumpTo(_scroll.position.maxScrollExtent);
      }
    });
  }

  List<DaemonLogEntry> get _visible {
    final q = _search.text.trim().toLowerCase();
    if (q.isEmpty) return _entries;
    return _entries
        .where(
          (e) =>
              e.msg.toLowerCase().contains(q) ||
              e.component.toLowerCase().contains(q) ||
              (e.err?.toLowerCase().contains(q) ?? false),
        )
        .toList();
  }

  Future<void> _copyVisible() async {
    final buf = StringBuffer();
    for (final e in _visible) {
      buf.writeln(
        '${_fmtTime(e.time)} ${e.level.toUpperCase().padRight(5)} '
        '${e.component.isEmpty ? '' : '[${e.component}] '}${e.msg}'
        '${e.err != null ? ' — ${e.err}' : ''}',
      );
    }
    await Clipboard.setData(ClipboardData(text: buf.toString()));
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('${_visible.length} log lines copied')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return ValueListenableBuilder<int>(
      valueListenable: TalonTheme.revision,
      builder: (context, _, __) => TalonBackdrop(
        child: Scaffold(
          backgroundColor: Colors.transparent,
          appBar: AppBar(
            backgroundColor: Colors.transparent,
            title: const Text('Daemon logs'),
            actions: [
              IconButton(
                tooltip: _follow ? 'Pause live follow' : 'Follow live',
                onPressed: () {
                  setState(() => _follow = !_follow);
                  _armFollow();
                  if (_follow) _load(quiet: true);
                },
                icon: Icon(
                  _follow ? Icons.pause_circle_outline : Icons.play_circle_outline,
                  color: _follow ? TalonColors.accent : null,
                ),
              ),
              IconButton(
                tooltip: 'Refresh',
                onPressed: _load,
                icon: const Icon(Icons.refresh),
              ),
              IconButton(
                tooltip: 'Copy visible lines',
                onPressed: _visible.isEmpty ? null : _copyVisible,
                icon: const Icon(Icons.copy_all_outlined),
              ),
            ],
          ),
          body: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 10),
                child: _filterBar(),
              ),
              Expanded(child: _body()),
            ],
          ),
        ),
      ),
    );
  }

  Widget _filterBar() {
    const levels = [
      (null, 'All'),
      ('info', 'Info+'),
      ('warn', 'Warn+'),
      ('error', 'Errors'),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    for (final (value, label) in levels)
                      Padding(
                        padding: const EdgeInsets.only(right: 8),
                        child: ChoiceChip(
                          label: Text(label),
                          selected: _minLevel == value,
                          showCheckmark: false,
                          backgroundColor: TalonColors.surface,
                          selectedColor:
                              TalonColors.accent.withValues(alpha: 0.22),
                          side: BorderSide(
                            color: _minLevel == value
                                ? TalonColors.accent
                                : TalonColors.glassStroke,
                          ),
                          labelStyle: TextStyle(
                            fontSize: 12.5,
                            color: _minLevel == value
                                ? TalonColors.text
                                : TalonColors.textDim,
                          ),
                          onSelected: (_) {
                            setState(() => _minLevel = value);
                            _load();
                          },
                        ),
                      ),
                    _componentChip(),
                  ],
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 8),
        TextField(
          controller: _search,
          style: const TextStyle(fontSize: 13.5),
          decoration: InputDecoration(
            isDense: true,
            hintText: 'Filter log lines…',
            prefixIcon: const Icon(Icons.search, size: 18),
            suffixIcon: _search.text.isEmpty
                ? null
                : IconButton(
                    icon: const Icon(Icons.clear, size: 16),
                    onPressed: _search.clear,
                  ),
            border: OutlineInputBorder(
              borderRadius: TalonRadius.rMd,
              borderSide: BorderSide(color: TalonColors.glassStroke),
            ),
          ),
        ),
      ],
    );
  }

  Widget _componentChip() {
    final label = _component ?? 'Component';
    return ActionChip(
      avatar: Icon(
        Icons.filter_alt_outlined,
        size: 14,
        color: _component != null ? TalonColors.accent : TalonColors.textFaint,
      ),
      label: Text(label),
      backgroundColor: TalonColors.surface,
      side: BorderSide(
        color:
            _component != null ? TalonColors.accent : TalonColors.glassStroke,
      ),
      labelStyle: TextStyle(
        fontSize: 12.5,
        color: _component != null ? TalonColors.text : TalonColors.textDim,
      ),
      onPressed: _pickComponent,
    );
  }

  Future<void> _pickComponent() async {
    final components = _knownComponents.toList()..sort();
    final picked = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: TalonColors.void1,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(12),
          children: [
            ListTile(
              title: const Text('All components'),
              trailing: _component == null
                  ? Icon(Icons.check, color: TalonColors.accent)
                  : null,
              onTap: () => Navigator.pop(ctx, ''),
            ),
            for (final c in components)
              ListTile(
                title: Text(c, style: TalonType.mono),
                trailing: c == _component
                    ? Icon(Icons.check, color: TalonColors.accent)
                    : null,
                onTap: () => Navigator.pop(ctx, c),
              ),
          ],
        ),
      ),
    );
    if (picked == null || !mounted) return;
    setState(() => _component = picked.isEmpty ? null : picked);
    await _load();
  }

  Widget _body() {
    if (_loading && _entries.isEmpty) {
      return const Center(child: CircularProgressIndicator(strokeWidth: 2));
    }
    if (_error != null && _entries.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(Icons.cloud_off_outlined,
                  size: 34, color: TalonColors.textFaint),
              const SizedBox(height: 10),
              Text(
                'Could not load logs',
                style: TextStyle(
                    fontWeight: FontWeight.w600, color: TalonColors.text),
              ),
              const SizedBox(height: 6),
              Text(
                _error!,
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 12.5, color: TalonColors.textDim),
              ),
              const SizedBox(height: 12),
              OutlinedButton(onPressed: _load, child: const Text('Retry')),
            ],
          ),
        ),
      );
    }
    final rows = _visible;
    if (rows.isEmpty) {
      return Center(
        child: Text(
          'No matching log lines',
          style: TextStyle(color: TalonColors.textFaint),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: Scrollbar(
        controller: _scroll,
        child: ListView.builder(
          controller: _scroll,
          padding: const EdgeInsets.fromLTRB(12, 0, 12, 16),
          physics: const AlwaysScrollableScrollPhysics(),
          itemCount: rows.length,
          itemBuilder: (context, i) => _row(rows[i], i),
        ),
      ),
    );
  }

  Widget _row(DaemonLogEntry e, int index) {
    final color = _levelColor(e.level);
    final hasDetail = e.err != null || e.stack != null;
    final expanded = _expanded.contains(index);
    return InkWell(
      onTap: hasDetail
          ? () => setState(() {
                if (expanded) {
                  _expanded.remove(index);
                } else {
                  _expanded.add(index);
                }
              })
          : null,
      borderRadius: TalonRadius.rSm,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 5, horizontal: 4),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 5),
                  child: Container(
                    width: 7,
                    height: 7,
                    decoration:
                        BoxDecoration(shape: BoxShape.circle, color: color),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  e.ts == 0 ? '—' : _fmtTime(e.time),
                  style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 11.5,
                    color: TalonColors.textFaint,
                  ),
                ),
                const SizedBox(width: 8),
                if (e.component.isNotEmpty) ...[
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
                    decoration: BoxDecoration(
                      color: TalonColors.surfaceHi,
                      borderRadius: TalonRadius.rPill,
                    ),
                    child: Text(
                      e.component,
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w600,
                        color: TalonColors.textDim,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                ],
                Expanded(
                  child: Text(
                    e.msg.isEmpty ? '—' : e.msg,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 12,
                      height: 1.45,
                      color: _isSevere(e.level) ? color : TalonColors.text,
                    ),
                  ),
                ),
                if (hasDetail)
                  Icon(
                    expanded ? Icons.expand_less : Icons.expand_more,
                    size: 15,
                    color: TalonColors.textFaint,
                  ),
              ],
            ),
            if (expanded && hasDetail)
              Container(
                margin: const EdgeInsets.only(left: 15, top: 6),
                padding: const EdgeInsets.all(10),
                width: double.infinity,
                decoration: BoxDecoration(
                  color: TalonColors.bad.withValues(alpha: 0.07),
                  borderRadius: TalonRadius.rSm,
                  border: Border.all(
                    color: TalonColors.bad.withValues(alpha: 0.25),
                  ),
                ),
                child: SelectableText(
                  [
                    if (e.err != null) e.err!,
                    if (e.stack != null) e.stack!,
                  ].join('\n\n'),
                  style: TextStyle(
                    fontFamily: 'monospace',
                    fontSize: 11.5,
                    height: 1.45,
                    color: TalonColors.textDim,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  bool _isSevere(String level) =>
      level == 'warn' || level == 'error' || level == 'fatal';

  Color _levelColor(String level) => switch (level) {
        'error' || 'fatal' => TalonColors.bad,
        'warn' => TalonColors.warn,
        'info' => TalonColors.ok,
        _ => TalonColors.textFaint, // trace / debug
      };

  String _fmtTime(DateTime t) {
    String two(int n) => n.toString().padLeft(2, '0');
    return '${two(t.hour)}:${two(t.minute)}:${two(t.second)}';
  }
}
