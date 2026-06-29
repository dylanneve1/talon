import 'package:flutter/material.dart';

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

  @override
  void initState() {
    super.initState();
    _loadEffort();
  }

  Future<void> _loadEffort() async {
    final (active, levels) = await widget.state.effortLevels(widget.chat.id);
    if (mounted) {
      setState(() {
        _effortLevels = levels;
        _activeEffort = widget.chat.effort ?? active;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final models = widget.state.models
        .where((m) =>
            _query.isEmpty ||
            m.displayName.toLowerCase().contains(_query.toLowerCase()) ||
            m.provider.toLowerCase().contains(_query.toLowerCase()))
        .toList();
    final activeModel = widget.chat.model ?? widget.state.status.model;

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
                      widget.chat.title,
                      style: const TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w700),
                    ),
                  ],
                ),
              ),
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
                          return _ModelRow(
                            model: m,
                            selected: selected,
                            onTap: () {
                              widget.state.setModel(widget.chat.id, m.id);
                              Navigator.pop(context);
                            },
                          );
                        },
                      ),
              ),
            ],
          ),
        );
      },
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
              const Icon(Icons.check_circle, color: TalonColors.accent, size: 18),
          ],
        ),
      ),
    );
  }
}
