import 'package:flutter/material.dart';

import '../models/bridge_models.dart';
import '../services/haptics.dart';
import '../services/log.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'glass.dart';

/// Plugins sub-menu: every installed plugin (built-ins, module plugins,
/// MCP servers) with a live enable/disable switch. Toggles persist to the
/// daemon's config and hot-reload, so a change is real on the next turn.
class PluginsScreen extends StatelessWidget {
  final AppState state;
  const PluginsScreen({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    return _ExtensionListScreen<PluginInfo>(
      title: 'Plugins',
      emptyText: 'No plugins installed — add one with `talon plugin install`.',
      load: state.listPlugins,
      toggle: state.togglePlugin,
      nameOf: (p) => p.name,
      enabledOf: (p) => p.enabled,
      iconOf: (p) => switch (p.kind) {
        'builtin' => Icons.inventory_2_outlined,
        'mcp' => Icons.cable_outlined,
        _ => Icons.extension_outlined,
      },
      subtitleOf: (p) => p.kind == 'builtin' ? 'built-in' : p.source,
    );
  }
}

/// Skills sub-menu: every installed SKILL.md bundle with a live switch. A
/// disabled skill drops out of the model's prompt index but stays
/// installed, so re-enabling is instant.
class SkillsScreen extends StatelessWidget {
  final AppState state;
  const SkillsScreen({super.key, required this.state});

  @override
  Widget build(BuildContext context) {
    return _ExtensionListScreen<SkillInfo>(
      title: 'Skills',
      emptyText:
          'No skills installed — add one with `talon skill install`, or ask '
          'Talon to save one.',
      load: state.listSkills,
      toggle: state.toggleSkill,
      nameOf: (s) => s.name,
      enabledOf: (s) => s.enabled,
      iconOf: (_) => Icons.menu_book_outlined,
      subtitleOf: (s) => s.description,
    );
  }
}

/// The shared list-and-toggle screen behind both sub-menus: load → glass
/// list with switches, optimistic toggling with revert + toast on failure,
/// pull-to-refresh, and the standard skeleton/error states.
class _ExtensionListScreen<T> extends StatefulWidget {
  final String title;
  final String emptyText;
  final Future<List<T>> Function() load;
  final Future<({bool ok, String? error})> Function(String name, bool enabled)
      toggle;
  final String Function(T) nameOf;
  final bool Function(T) enabledOf;
  final IconData Function(T) iconOf;
  final String Function(T) subtitleOf;

  const _ExtensionListScreen({
    super.key,
    required this.title,
    required this.emptyText,
    required this.load,
    required this.toggle,
    required this.nameOf,
    required this.enabledOf,
    required this.iconOf,
    required this.subtitleOf,
  });

  @override
  State<_ExtensionListScreen<T>> createState() =>
      _ExtensionListScreenState<T>();
}

class _ExtensionListScreenState<T> extends State<_ExtensionListScreen<T>> {
  List<T> _items = const [];
  bool _loading = true;
  String? _error;

  /// Optimistic overrides for in-flight toggles, keyed by item name. The
  /// switch flips the moment it's tapped; the entry is dropped when the
  /// daemon confirms (reload replaces it) or reverted with a toast when
  /// the round-trip fails.
  final Map<String, bool> _pending = {};

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final items = await widget.load();
      if (!mounted) return;
      setState(() {
        _items = items;
        _loading = false;
      });
    } catch (e) {
      AppLog.warn('extensions', '${widget.title} fetch failed', e);
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = e.toString();
      });
    }
  }

  Future<void> _toggle(T item, bool enabled) async {
    final name = widget.nameOf(item);
    Haptics.selection();
    setState(() => _pending[name] = enabled);
    final result = await widget.toggle(name, enabled);
    if (!mounted) return;
    if (result.ok) {
      await _load();
      if (!mounted) return;
      setState(() => _pending.remove(name));
      return;
    }
    setState(() => _pending.remove(name));
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          result.error ?? 'Could not ${enabled ? 'enable' : 'disable'} $name',
        ),
      ),
    );
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
            title: Text(widget.title),
            actions: [
              IconButton(
                onPressed: _load,
                icon: const Icon(Icons.refresh),
                tooltip: 'Refresh',
              ),
            ],
          ),
          body: RefreshIndicator(
            onRefresh: _load,
            child: SingleChildScrollView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.all(20),
              child: Align(
                alignment: Alignment.topCenter,
                child: ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 560),
                  child: _body(),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _body() {
    if (_loading) return const _ListSkeleton();
    if (_error != null) {
      return Glass(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              'Could not load ${widget.title.toLowerCase()}',
              style: const TextStyle(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 6),
            Text(
              _error!,
              style: TextStyle(fontSize: 12.5, color: TalonColors.textFaint),
            ),
            const SizedBox(height: 10),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                onPressed: _load,
                icon: const Icon(Icons.refresh, size: 16),
                label: const Text('Retry'),
              ),
            ),
          ],
        ),
      );
    }
    if (_items.isEmpty) {
      return Glass(
        padding: const EdgeInsets.all(20),
        child: Text(
          widget.emptyText,
          style: TextStyle(color: TalonColors.textFaint),
        ),
      );
    }
    return Glass(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        children: [
          for (var i = 0; i < _items.length; i++) ...[
            if (i > 0)
              Divider(
                height: 1,
                indent: 52,
                color: TalonColors.glassStroke,
              ),
            _row(_items[i]),
          ],
        ],
      ),
    );
  }

  Widget _row(T item) {
    final name = widget.nameOf(item);
    final enabled = _pending[name] ?? widget.enabledOf(item);
    final subtitle = widget.subtitleOf(item);
    final busy = _pending.containsKey(name);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      child: Row(
        children: [
          Icon(
            widget.iconOf(item),
            size: 20,
            color: enabled ? TalonColors.accent : TalonColors.textFaint,
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  name,
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    fontSize: 14,
                    color: enabled ? null : TalonColors.textDim,
                  ),
                ),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 2),
                  Text(
                    subtitle,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12,
                      color: TalonColors.textFaint,
                    ),
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(width: 12),
          Switch(
            value: enabled,
            onChanged: busy ? null : (v) => _toggle(item, v),
          ),
        ],
      ),
    );
  }
}

/// Placeholder rows while the first fetch is in flight.
class _ListSkeleton extends StatelessWidget {
  const _ListSkeleton();

  @override
  Widget build(BuildContext context) {
    return Glass(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        children: [
          for (var i = 0; i < 4; i++)
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: 14,
                vertical: 14,
              ),
              child: Row(
                children: [
                  Container(
                    width: 20,
                    height: 20,
                    decoration: BoxDecoration(
                      color: TalonColors.glassStroke,
                      borderRadius: BorderRadius.circular(6),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Container(
                      height: 12,
                      decoration: BoxDecoration(
                        color: TalonColors.glassStroke,
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                  ),
                  const SizedBox(width: 48),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
