import 'package:flutter/material.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'brand.dart';
import 'glass.dart';
import 'motion.dart';
import 'settings_screen.dart';
import 'status_pill.dart';

/// ChatGPT-style left rail: new chat, search, time-grouped history, and a
/// footer with live status + settings.
class Sidebar extends StatefulWidget {
  final AppState state;

  /// When set (narrow layout) tapping a chat routes through this.
  final void Function(String chatId)? onSelect;

  const Sidebar({super.key, required this.state, required this.onSelect});

  @override
  State<Sidebar> createState() => _SidebarState();
}

class _SidebarState extends State<Sidebar> {
  String _query = '';

  /// Chat ids we've already shown, so the entrance cascade plays once per tile
  /// and never re-fires on the frequent rebuilds driven by live streaming.
  final Set<String> _seen = <String>{};

  @override
  Widget build(BuildContext context) {
    return Glass(
      radius: TalonRadius.lg,
      blur: 24,
      padding: const EdgeInsets.fromLTRB(
          TalonSpace.md, TalonSpace.lg, TalonSpace.md, TalonSpace.sm),
      child: ListenableBuilder(
        listenable: widget.state,
        builder: (context, _) {
          return Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const BrandMark(size: 30),
                  const SizedBox(width: TalonSpace.sm),
                  Expanded(
                    child: Text(
                      widget.state.status.botName,
                      style: TalonType.title,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: TalonSpace.md),
              _NewChatButton(onTap: widget.state.newChat),
              const SizedBox(height: TalonSpace.sm),
              _SearchBox(onChanged: (v) => setState(() => _query = v)),
              const SizedBox(height: TalonSpace.sm),
              Expanded(child: _groupedList(context)),
              const Divider(height: TalonSpace.md),
              Row(
                children: [
                  Expanded(child: StatusPill(state: widget.state)),
                  IconButton(
                    tooltip: 'Settings',
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) => SettingsScreen(state: widget.state),
                      ),
                    ),
                    icon: const Icon(Icons.settings_outlined,
                        size: 20, color: TalonColors.textDim),
                  ),
                ],
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _groupedList(BuildContext context) {
    final chats = widget.state.chats.where((c) {
      if (_query.isEmpty) return true;
      final q = _query.toLowerCase();
      return c.title.toLowerCase().contains(q) ||
          c.preview.toLowerCase().contains(q);
    }).toList();

    if (chats.isEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(TalonSpace.lg),
          child: Text(
            widget.state.conn == ConnState.connected
                ? (_query.isEmpty ? 'No chats yet.' : 'No matches.')
                : 'Connecting…',
            textAlign: TextAlign.center,
            style: const TextStyle(color: TalonColors.textFaint, height: 1.5),
          ),
        ),
      );
    }

    final groups = _groupByTime(chats);
    // Stagger only tiles the sidebar hasn't shown before, cascading by their
    // ordinal among the fresh ones so the first paint ripples in without
    // re-animating on every streaming-driven rebuild.
    var freshOrdinal = 0;
    final reduceMotion = MediaQuery.of(context).disableAnimations;

    return ListView(
      padding: EdgeInsets.zero,
      children: [
        for (final group in groups) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(
                TalonSpace.sm, TalonSpace.sm, TalonSpace.sm, 6),
            child: Text(group.label.toUpperCase(), style: TalonType.eyebrow),
          ),
          for (final chat in group.chats)
            Builder(builder: (context) {
              final isFresh = _seen.add(chat.id);
              // Stagger only the fresh tiles; the delay is fixed at the tile's
              // first appearance and latched inside EntranceFx, so later
              // streaming rebuilds never restart or truncate the cascade.
              final delay = isFresh
                  ? TalonMotion.stagger * (freshOrdinal++).clamp(0, 12)
                  : Duration.zero;
              return EntranceFx(
                key: ValueKey('tile-${chat.id}'),
                enabled: isFresh && !reduceMotion,
                from: const Offset(-0.12, 0),
                delay: delay,
                child: _ChatTile(
                  chat: chat,
                  selected: chat.id == widget.state.selectedChatId,
                  unread: widget.state.hasUnread(chat),
                  onTap: () =>
                      (widget.onSelect ?? widget.state.selectChat)(chat.id),
                  onDelete: () => _confirmDelete(context, chat),
                ),
              );
            }),
        ],
      ],
    );
  }

  List<_Group> _groupByTime(List<ClientChat> chats) {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final yesterday = today.subtract(const Duration(days: 1));
    final week = today.subtract(const Duration(days: 7));
    final month = today.subtract(const Duration(days: 30));

    final buckets = <String, List<ClientChat>>{
      'Today': [],
      'Yesterday': [],
      'Previous 7 days': [],
      'Previous 30 days': [],
      'Older': [],
    };
    for (final c in chats) {
      final d = c.lastActiveTime;
      if (!d.isBefore(today)) {
        buckets['Today']!.add(c);
      } else if (!d.isBefore(yesterday)) {
        buckets['Yesterday']!.add(c);
      } else if (!d.isBefore(week)) {
        buckets['Previous 7 days']!.add(c);
      } else if (!d.isBefore(month)) {
        buckets['Previous 30 days']!.add(c);
      } else {
        buckets['Older']!.add(c);
      }
    }
    return [
      for (final entry in buckets.entries)
        if (entry.value.isNotEmpty) _Group(entry.key, entry.value),
    ];
  }

  Future<void> _confirmDelete(BuildContext context, ClientChat chat) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        backgroundColor: TalonColors.surface,
        title: const Text('Delete chat?'),
        content: Text('"${chat.title}" and its history will be removed.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: TalonColors.bad),
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (ok == true) await widget.state.deleteChat(chat.id);
  }
}

class _Group {
  final String label;
  final List<ClientChat> chats;
  _Group(this.label, this.chats);
}

/// Compact "how long ago" stamp for chat tiles: `now`, `12m`, `3h`, `2d`,
/// then a short date once it's over a week old.
String _relTime(DateTime t) {
  final diff = DateTime.now().difference(t);
  if (diff.inMinutes < 1) return 'now';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m';
  if (diff.inHours < 24) return '${diff.inHours}h';
  if (diff.inDays < 7) return '${diff.inDays}d';
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return '${t.day} ${months[t.month - 1]}';
}

class _ChatTile extends StatefulWidget {
  final ClientChat chat;
  final bool selected;
  final bool unread;
  final VoidCallback onTap;
  final VoidCallback onDelete;

  const _ChatTile({
    required this.chat,
    required this.selected,
    required this.unread,
    required this.onTap,
    required this.onDelete,
  });

  @override
  State<_ChatTile> createState() => _ChatTileState();
}

class _ChatTileState extends State<_ChatTile> {
  bool _hover = false;
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final selected = widget.selected;
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      child: GestureDetector(
        onTap: widget.onTap,
        onTapDown: (_) => setState(() => _pressed = true),
        onTapUp: (_) => setState(() => _pressed = false),
        onTapCancel: () => setState(() => _pressed = false),
        child: AnimatedScale(
          scale: _pressed ? 0.975 : 1.0,
          duration: TalonMotion.fast,
          curve: TalonMotion.emphasized,
          child: AnimatedContainer(
            duration: TalonMotion.fast,
            curve: TalonMotion.standard,
            padding: const EdgeInsets.symmetric(
                horizontal: TalonSpace.sm, vertical: 9),
            decoration: BoxDecoration(
              borderRadius: TalonRadius.rSm,
              color: selected
                  ? TalonColors.surfaceHi
                  : (_hover ? TalonColors.surface : Colors.transparent),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                // A slim accent bar slides in on the selected tile.
                AnimatedContainer(
                  duration: TalonMotion.base,
                  curve: TalonMotion.emphasized,
                  width: selected ? 3 : 0,
                  height: 28,
                  margin: EdgeInsets.only(right: selected ? 9 : 0),
                  decoration: const BoxDecoration(
                    gradient: TalonColors.accentGradient,
                    borderRadius: BorderRadius.all(Radius.circular(2)),
                  ),
                ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Text(
                              widget.chat.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                fontSize: 13.5,
                                fontWeight: selected || widget.unread
                                    ? FontWeight.w600
                                    : FontWeight.w500,
                                color: selected || widget.unread
                                    ? TalonColors.text
                                    : TalonColors.textDim,
                              ),
                            ),
                          ),
                          if (widget.chat.pulse == true)
                            const Padding(
                              padding: EdgeInsets.only(left: 4),
                              child: Icon(Icons.notifications_active_outlined,
                                  size: 11, color: TalonColors.textFaint),
                            ),
                          const SizedBox(width: 6),
                          Text(
                            _relTime(widget.chat.lastActiveTime),
                            style: const TextStyle(
                                fontSize: 10.5, color: TalonColors.textFaint),
                          ),
                          // Unread: activity newer than the user's last look.
                          if (widget.unread)
                            Container(
                              width: 7,
                              height: 7,
                              margin: const EdgeInsets.only(left: 6),
                              decoration: const BoxDecoration(
                                shape: BoxShape.circle,
                                gradient: TalonColors.accentGradient,
                              ),
                            ),
                        ],
                      ),
                      if (widget.chat.preview.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 1),
                          child: Text(
                            widget.chat.preview.replaceAll('\n', ' '),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                                fontSize: 11.5,
                                color: TalonColors.textFaint,
                                height: 1.3),
                          ),
                        ),
                    ],
                  ),
                ),
                AnimatedOpacity(
                  duration: TalonMotion.fast,
                  opacity: (_hover || selected) ? 1 : 0,
                  child: IgnorePointer(
                    ignoring: !(_hover || selected),
                    child: InkWell(
                      onTap: widget.onDelete,
                      borderRadius: BorderRadius.circular(6),
                      child: const Padding(
                        padding: EdgeInsets.all(2),
                        child: Icon(Icons.close,
                            size: 15, color: TalonColors.textFaint),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _NewChatButton extends StatefulWidget {
  final VoidCallback onTap;
  const _NewChatButton({required this.onTap});

  @override
  State<_NewChatButton> createState() => _NewChatButtonState();
}

class _NewChatButtonState extends State<_NewChatButton> {
  bool _hover = false;

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      onEnter: (_) => setState(() => _hover = true),
      onExit: (_) => setState(() => _hover = false),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: TalonMotion.fast,
          curve: TalonMotion.standard,
          padding: const EdgeInsets.symmetric(
              vertical: 11, horizontal: TalonSpace.md),
          decoration: BoxDecoration(
            borderRadius: TalonRadius.rMd,
            color: _hover
                ? TalonColors.accent.withValues(alpha: 0.18)
                : TalonColors.glassFill,
            border: Border.all(
              color: _hover
                  ? TalonColors.accent.withValues(alpha: 0.6)
                  : TalonColors.glassStroke,
            ),
          ),
          child: const Row(
            children: [
              Icon(Icons.add_rounded, color: TalonColors.text, size: 19),
              SizedBox(width: TalonSpace.sm),
              Text(
                'New chat',
                style: TextStyle(
                    color: TalonColors.text,
                    fontWeight: FontWeight.w600,
                    fontSize: 13.5),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _SearchBox extends StatelessWidget {
  final ValueChanged<String> onChanged;
  const _SearchBox({required this.onChanged});

  @override
  Widget build(BuildContext context) {
    return TextField(
      onChanged: onChanged,
      style: const TextStyle(fontSize: 13.5),
      decoration: InputDecoration(
        isDense: true,
        prefixIcon: const Icon(Icons.search, size: 17),
        prefixIconConstraints:
            const BoxConstraints(minWidth: 36, minHeight: 36),
        hintText: 'Search chats',
        hintStyle: const TextStyle(color: TalonColors.textFaint, fontSize: 13),
        filled: true,
        fillColor: TalonColors.void0.withValues(alpha: 0.5),
        contentPadding: const EdgeInsets.symmetric(vertical: TalonSpace.sm),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: const BorderSide(color: TalonColors.glassStroke),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: const BorderSide(color: TalonColors.glassStroke),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: const BorderSide(color: TalonColors.accent),
        ),
      ),
    );
  }
}
