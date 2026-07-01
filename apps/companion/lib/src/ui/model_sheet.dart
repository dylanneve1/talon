import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';

Future<void> openModelSheet(
  BuildContext context,
  AppState state,
  ClientChat chat,
) {
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    isScrollControlled: true,
    builder: (_) => _ModelSheet(state: state, chat: chat),
  );
}

class _ModelSheet extends StatefulWidget {
  final AppState state;
  final ClientChat chat;
  const _ModelSheet({required this.state, required this.chat});

  @override
  State<_ModelSheet> createState() => _ModelSheetState();
}

class _ModelSheetState extends State<_ModelSheet> {
  String _query = '';
  List<String> _effortLevels = const [];
  String _activeEffort = 'adaptive';
  List<BackendOption> _backends = const [];
  String _activeBackend = '';
  bool _switchingBackend = false;

  /// The live chat from AppState, so `chat_updated` events (model, effort or
  /// backend changed here or from another client) are reflected while the
  /// sheet is open. [widget.chat] is only a fallback if the chat vanished.
  ClientChat get _chat {
    for (final c in widget.state.chats) {
      if (c.id == widget.chat.id) return c;
    }
    return widget.chat;
  }

  @override
  void initState() {
    super.initState();
    _loadEffort();
    _loadBackends();
  }

  Future<void> _loadEffort() async {
    final (active, levels) = await widget.state.effortLevels(widget.chat.id);
    if (mounted) {
      setState(() {
        // 'adaptive' is rendered as a fixed first chip; some daemons also
        // include it in the level list, which would draw it twice.
        _effortLevels = levels.where((l) => l != 'adaptive').toList();
        _activeEffort = _chat.effort ?? active;
      });
    }
  }

  Future<void> _loadBackends() async {
    final (active, backends) = await widget.state.backends(widget.chat.id);
    if (mounted) {
      setState(() {
        _backends = backends;
        _activeBackend = _chat.backend ?? active;
      });
    }
  }

  Future<void> _selectBackend(String id) async {
    if (id == _activeBackend || _switchingBackend) return;
    setState(() => _switchingBackend = true);
    final result = await widget.state.setBackend(widget.chat.id, id);
    if (!mounted) return;
    if (result.ok) {
      // setBackend already re-pulled the new backend's model catalog; the
      // ListenableBuilder in build picks it up. Effort levels are per-backend
      // too, so re-fetch them for the new backend.
      setState(() {
        _activeBackend = id;
        _switchingBackend = false;
      });
      unawaited(_loadEffort());
    } else {
      setState(() => _switchingBackend = false);
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(result.error ?? 'Could not switch backend')),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    // Listen to AppState so the list repopulates when the catalog lands after
    // the sheet opened (first open, or the refresh after a backend switch).
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) => _sheet(context),
    );
  }

  Widget _sheet(BuildContext context) {
    final models = widget.state.models
        .where((m) =>
            _query.isEmpty ||
            m.displayName.toLowerCase().contains(_query.toLowerCase()) ||
            m.provider.toLowerCase().contains(_query.toLowerCase()))
        .toList();
    final activeModel = _chat.model ?? widget.state.status.model;

    return DraggableScrollableSheet(
      initialChildSize: 0.7,
      minChildSize: 0.4,
      maxChildSize: 0.92,
      builder: (context, scroll) {
        return Container(
          decoration: const BoxDecoration(
            color: TalonColors.void1,
            borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
            border: Border(top: BorderSide(color: TalonColors.glassStroke)),
          ),
          child: Column(
            children: [
              const SizedBox(height: 10),
              Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: TalonColors.textFaint,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                child: Row(
                  children: [
                    const Icon(Icons.tune, size: 18, color: TalonColors.accent),
                    const SizedBox(width: 8),
                    Text(
                      _chat.title,
                      style: const TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
              ),
              if (_backends.length > 1) _backendRow(),
              if (_effortLevels.isNotEmpty) _effortRow(),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                child: TextField(
                  onChanged: (v) => setState(() => _query = v),
                  decoration: InputDecoration(
                    prefixIcon: const Icon(Icons.search, size: 18),
                    hintText: 'Search models',
                    filled: true,
                    fillColor: TalonColors.surface,
                    contentPadding: const EdgeInsets.symmetric(vertical: 0),
                    border: OutlineInputBorder(
                      borderRadius: BorderRadius.circular(12),
                      borderSide: BorderSide.none,
                    ),
                  ),
                ),
              ),
              Expanded(
                child: models.isEmpty
                    ? const Center(
                        child: Text('No models reported',
                            style: TextStyle(color: TalonColors.textFaint)))
                    : ListView.builder(
                        controller: scroll,
                        padding: const EdgeInsets.fromLTRB(12, 0, 12, 20),
                        itemCount: models.length,
                        itemBuilder: (context, i) {
                          final m = models[i];
                          final selected = m.id == activeModel;
                          final row = _ModelRow(
                            model: m,
                            selected: selected,
                            onTap: () {
                              widget.state.setModel(widget.chat.id, m.id);
                              Navigator.pop(context);
                            },
                          );
                          if (MediaQuery.of(context).disableAnimations) {
                            return row;
                          }
                          // Cascade the first screenful in; later rows (revealed
                          // by scrolling) shouldn't wait on a growing delay.
                          final delay = (i.clamp(0, 8) * 35).ms;
                          return row
                              .animate()
                              .fadeIn(delay: delay, duration: TalonMotion.base)
                              .slideY(
                                  begin: 0.15,
                                  end: 0,
                                  delay: delay,
                                  curve: TalonMotion.emphasized);
                        },
                      ),
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _backendRow() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Text(
                'BACKEND',
                style: TextStyle(
                  color: TalonColors.textFaint,
                  fontSize: 11,
                  fontWeight: FontWeight.w700,
                  letterSpacing: 0.8,
                ),
              ),
              if (_switchingBackend) ...[
                const SizedBox(width: 8),
                const SizedBox(
                  width: 11,
                  height: 11,
                  child: CircularProgressIndicator(strokeWidth: 1.6),
                ),
              ],
            ],
          ),
          const SizedBox(height: 6),
          Wrap(
            spacing: 8,
            runSpacing: 4,
            children: [
              for (final b in _backends)
                ChoiceChip(
                  label: Text(b.label),
                  selected: _activeBackend == b.id,
                  showCheckmark: false,
                  backgroundColor: TalonColors.surface,
                  selectedColor: TalonColors.accent.withValues(alpha: 0.3),
                  side: BorderSide(
                    color: _activeBackend == b.id
                        ? TalonColors.accent
                        : TalonColors.glassStroke,
                  ),
                  labelStyle: TextStyle(
                    color: _activeBackend == b.id
                        ? TalonColors.text
                        : TalonColors.textDim,
                    fontSize: 12.5,
                  ),
                  onSelected:
                      _switchingBackend ? null : (_) => _selectBackend(b.id),
                ),
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            'Switching backend starts a fresh conversation.',
            style: TextStyle(color: TalonColors.textFaint, fontSize: 11),
          ),
        ],
      ),
    );
  }

  Widget _effortRow() {
    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 4, 16, 4),
      child: Align(
        alignment: Alignment.centerLeft,
        child: Wrap(
          spacing: 8,
          children: [
            for (final level in ['adaptive', ..._effortLevels])
              ChoiceChip(
                label: Text(level),
                selected: _activeEffort == level,
                showCheckmark: false,
                backgroundColor: TalonColors.surface,
                selectedColor: TalonColors.accent.withValues(alpha: 0.3),
                side: BorderSide(
                  color: _activeEffort == level
                      ? TalonColors.accent
                      : TalonColors.glassStroke,
                ),
                labelStyle: TextStyle(
                  color: _activeEffort == level
                      ? TalonColors.text
                      : TalonColors.textDim,
                  fontSize: 12.5,
                ),
                onSelected: (_) {
                  setState(() => _activeEffort = level);
                  widget.state.setEffort(
                      widget.chat.id, level == 'adaptive' ? 'adaptive' : level);
                },
              ),
          ],
        ),
      ),
    );
  }
}

class _ModelRow extends StatelessWidget {
  final ModelOption model;
  final bool selected;
  final VoidCallback onTap;
  const _ModelRow(
      {required this.model, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(12),
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 3),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(12),
          color: selected
              ? TalonColors.accent.withValues(alpha: 0.16)
              : TalonColors.surface,
          border: Border.all(
            color: selected ? TalonColors.accent : Colors.transparent,
          ),
        ),
        child: Row(
          children: [
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    model.displayName,
                    style: const TextStyle(
                        fontSize: 14, fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 2),
                  Text(
                    model.provider,
                    style: const TextStyle(
                        fontSize: 11.5, color: TalonColors.textFaint),
                  ),
                ],
              ),
            ),
            if (model.reasoning)
              const Padding(
                padding: EdgeInsets.only(right: 8),
                child: Icon(Icons.psychology_outlined,
                    size: 16, color: TalonColors.textFaint),
              ),
            if (selected)
              const Icon(Icons.check_circle,
                  color: TalonColors.accent, size: 18),
          ],
        ),
      ),
    );
  }
}
