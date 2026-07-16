import 'dart:async';

import 'package:flutter/foundation.dart' show defaultTargetPlatform;
import 'package:flutter/material.dart';

import '../models/bridge_models.dart';
import '../services/haptics.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'brand.dart';
import 'chat_actions.dart';
import 'glass.dart';
import 'markdown.dart';
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

  /// Daemon-side full-text hits for [_query] — the same `GET /search` the
  /// desktop quick switcher uses, so message search isn't keyboard-only.
  List<SearchHit> _hits = const [];
  bool _searching = false;
  Timer? _debounce;

  @override
  void dispose() {
    _debounce?.cancel();
    super.dispose();
  }

  bool get _isTouch =>
      defaultTargetPlatform == TargetPlatform.android ||
      defaultTargetPlatform == TargetPlatform.iOS;

  void _onQuery(String v) {
    setState(() => _query = v);
    _debounce?.cancel();
    final q = v.trim();
    if (q.length < 2) {
      setState(() {
        _hits = const [];
        _searching = false;
      });
      return;
    }
    setState(() => _searching = true);
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      final hits = await widget.state.searchMessages(q);
      // A slower response for an older query must not clobber the newer one.
      if (mounted && q == _query.trim()) {
        setState(() {
          _hits = hits;
          _searching = false;
        });
      }
    });
  }

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
                  const SizedBox(width: TalonSpace.sm + 2),
                  Expanded(
                    // The wordmark wears the brand gradient — one deliberate
                    // hero moment, matching the falcon tile beside it.
                    child: ShaderMask(
                      shaderCallback: (bounds) =>
                          TalonColors.accentGradient.createShader(bounds),
                      blendMode: BlendMode.srcIn,
                      child: Text(
                        widget.state.status.botName,
                        style: TalonType.title.copyWith(
                          fontSize: 17,
                          fontWeight: FontWeight.w700,
                          color: Colors.white,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: TalonSpace.md),
              _NewChatButton(onTap: widget.state.newChat),
              const SizedBox(height: TalonSpace.sm),
              _SearchBox(onChanged: _onQuery),
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
                    icon: Icon(Icons.settings_outlined,
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

    final searchingMessages = _query.trim().length >= 2;
    if (chats.isEmpty &&
        !(searchingMessages && (_searching || _hits.isNotEmpty))) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(TalonSpace.lg),
          child: Text(
            widget.state.conn == ConnState.connected
                ? (_query.isEmpty ? 'No chats yet.' : 'No matches.')
                : 'Connecting…',
            textAlign: TextAlign.center,
            style: TextStyle(color: TalonColors.textFaint, height: 1.5),
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

    final list = ListView(
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
              Widget tile = _ChatTile(
                chat: chat,
                selected: chat.id == widget.state.selectedChatId,
                unread: widget.state.hasUnread(chat),
                onTap: () =>
                    (widget.onSelect ?? widget.state.selectChat)(chat.id),
                // Touch path to every chat action (rename/pulse/export/
                // reset/delete) — the hover-only delete affordance doesn't
                // exist on a phone.
                onLongPress: () =>
                    showChatActionsSheet(context, widget.state, chat),
                onDelete: () => confirmDeleteChat(context, widget.state, chat),
              );
              // Mobile: swipe a tile left to delete (with the usual confirm).
              // confirmDismiss always resolves false — deletion happens via
              // AppState and the rebuild removes the tile, which sidesteps
              // Dismissible's "must be gone once dismissed" contract when a
              // slow round-trip would otherwise leave it in the tree.
              if (_isTouch) {
                tile = Dismissible(
                  key: ValueKey('swipe-${chat.id}'),
                  direction: DismissDirection.endToStart,
                  confirmDismiss: (_) async {
                    Haptics.medium();
                    await confirmDeleteChat(context, widget.state, chat);
                    return false;
                  },
                  background: Container(
                    alignment: Alignment.centerRight,
                    padding: const EdgeInsets.only(right: TalonSpace.lg),
                    decoration: BoxDecoration(
                      borderRadius: TalonRadius.rSm,
                      color: TalonColors.bad.withValues(alpha: 0.18),
                    ),
                    child: Icon(Icons.delete_outline,
                        size: 18, color: TalonColors.bad),
                  ),
                  child: tile,
                );
              }
              return EntranceFx(
                key: ValueKey('tile-${chat.id}'),
                enabled: isFresh && !reduceMotion,
                from: const Offset(-0.12, 0),
                delay: delay,
                child: tile,
              );
            }),
        ],
        // Full-text hits from the daemon, below the title matches — brings
        // the desktop quick switcher's message search to every layout.
        if (searchingMessages) ...[
          Padding(
            padding: const EdgeInsets.fromLTRB(
                TalonSpace.sm, TalonSpace.md, TalonSpace.sm, 6),
            child: Row(
              children: [
                Text('MESSAGES', style: TalonType.eyebrow),
                const SizedBox(width: TalonSpace.sm),
                if (_searching)
                  const SizedBox(
                    width: 10,
                    height: 10,
                    child: CircularProgressIndicator(strokeWidth: 1.6),
                  ),
              ],
            ),
          ),
          if (!_searching && _hits.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(
                  horizontal: TalonSpace.sm, vertical: TalonSpace.xs),
              child: Text('No message matches.', style: TalonType.caption),
            ),
          for (final hit in _hits.take(12))
            _HitTile(
              hit: hit,
              onTap: () =>
                  (widget.onSelect ?? widget.state.selectChat)(hit.chatId),
            ),
        ],
      ],
    );

    // Pull-to-refresh: re-sync chats/models (or retry the connection when
    // it's down). Mostly a touch gesture; harmless on desktop.
    return RefreshIndicator(
      onRefresh: widget.state.refresh,
      color: TalonColors.accent,
      backgroundColor: TalonColors.surfaceHi,
      child: list,
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
}

class _Group {
  final String label;
  final List<ClientChat> chats;
  _Group(this.label, this.chats);
}

/// Per-chat identity gradient, derived from the title so every conversation
/// gets a stable, distinct hue pair (WhatsApp/Telegram avatar pattern).
/// Saturation/lightness are pinned per brightness so any hue stays readable
/// under white text.
LinearGradient chatIdentityGradient(String seedText) {
  final h =
      seedText.codeUnits.fold<int>(0, (a, c) => (a * 31 + c) & 0x7fffffff);
  final hue = (h % 360).toDouble();
  final dark = TalonTheme.isDark;
  final c1 = HSLColor.fromAHSL(1, hue, 0.55, dark ? 0.60 : 0.50).toColor();
  final c2 = HSLColor.fromAHSL(1, (hue + 42) % 360, 0.60, dark ? 0.46 : 0.38)
      .toColor();
  return LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [c1, c2],
  );
}

/// Rounded-square avatar with the chat's identity gradient and initial.
class _ChatAvatar extends StatelessWidget {
  final String title;
  const _ChatAvatar({required this.title});

  @override
  Widget build(BuildContext context) {
    final t = title.trim();
    final initial = t.isEmpty ? '·' : String.fromCharCode(t.runes.first);
    return Container(
      width: 34,
      height: 34,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        gradient: chatIdentityGradient(title),
        borderRadius: BorderRadius.circular(11),
      ),
      child: Text(
        initial.toUpperCase(),
        style: const TextStyle(
          color: Colors.white,
          fontSize: 14,
          fontWeight: FontWeight.w700,
          height: 1,
        ),
      ),
    );
  }
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
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return '${t.day} ${months[t.month - 1]}';
}

class _ChatTile extends StatefulWidget {
  final ClientChat chat;
  final bool selected;
  final bool unread;
  final VoidCallback onTap;
  final VoidCallback onLongPress;
  final VoidCallback onDelete;

  const _ChatTile({
    required this.chat,
    required this.selected,
    required this.unread,
    required this.onTap,
    required this.onLongPress,
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
        onLongPress: () {
          Haptics.medium();
          widget.onLongPress();
        },
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
            margin: const EdgeInsets.symmetric(vertical: 2),
            padding: const EdgeInsets.symmetric(
                horizontal: TalonSpace.sm, vertical: 8),
            decoration: BoxDecoration(
              borderRadius: TalonRadius.rMd,
              color: selected
                  ? TalonColors.accent.withValues(alpha: 0.14)
                  : (_hover ? TalonColors.surface : Colors.transparent),
              border: Border.all(
                color: selected
                    ? TalonColors.accent.withValues(alpha: 0.35)
                    : Colors.transparent,
              ),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.center,
              children: [
                _ChatAvatar(title: widget.chat.title),
                const SizedBox(width: 10),
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
                            Padding(
                              padding: const EdgeInsets.only(left: 4),
                              child: Icon(Icons.notifications_active_outlined,
                                  size: 11, color: TalonColors.textFaint),
                            ),
                          const SizedBox(width: 6),
                          Text(
                            _relTime(widget.chat.lastActiveTime),
                            style: TextStyle(
                                fontSize: 10.5, color: TalonColors.textFaint),
                          ),
                          // Unread: activity newer than the user's last look.
                          if (widget.unread)
                            Container(
                              width: 7,
                              height: 7,
                              margin: const EdgeInsets.only(left: 6),
                              decoration: BoxDecoration(
                                shape: BoxShape.circle,
                                gradient: TalonColors.accentGradient,
                              ),
                            ),
                        ],
                      ),
                      if (widget.chat.preview.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 1),
                          child: InlineMarkdownText(
                            key: ValueKey('chat-preview-${widget.chat.id}'),
                            data: widget.chat.preview,
                            style: TextStyle(
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
                      child: Padding(
                        padding: const EdgeInsets.all(2),
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
        // The one primary CTA in the sidebar: full accent gradient with a
        // matching glow that deepens on hover.
        child: AnimatedContainer(
          duration: TalonMotion.fast,
          curve: TalonMotion.standard,
          padding: const EdgeInsets.symmetric(
              vertical: 12, horizontal: TalonSpace.md),
          decoration: BoxDecoration(
            borderRadius: TalonRadius.rMd,
            gradient: LinearGradient(
              begin: Alignment.topLeft,
              end: Alignment.bottomRight,
              colors: _hover
                  ? [TalonColors.accent, TalonColors.accent]
                  : [TalonColors.accent, TalonColors.accentDeep],
            ),
            boxShadow: [
              BoxShadow(
                color:
                    TalonColors.accent.withValues(alpha: _hover ? 0.45 : 0.28),
                blurRadius: _hover ? 22 : 14,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: const Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(Icons.add_rounded, color: Colors.white, size: 19),
              SizedBox(width: TalonSpace.sm),
              Text(
                'New chat',
                style: TextStyle(
                    color: Colors.white,
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

/// A full-text search hit: chat title + a one-line snippet of the matching
/// message. Tapping opens the chat.
class _HitTile extends StatelessWidget {
  final SearchHit hit;
  final VoidCallback onTap;
  const _HitTile({required this.hit, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: TalonRadius.rSm,
      child: Padding(
        padding:
            const EdgeInsets.symmetric(horizontal: TalonSpace.sm, vertical: 7),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Icon(Icons.manage_search,
                  size: 15, color: TalonColors.textFaint),
            ),
            const SizedBox(width: TalonSpace.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    hit.chatTitle,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 12.5,
                      fontWeight: FontWeight.w600,
                      color: TalonColors.textDim,
                    ),
                  ),
                  InlineMarkdownText(
                    data: hit.message.text,
                    maxLines: 2,
                    style: TextStyle(
                      fontSize: 12,
                      height: 1.35,
                      color: TalonColors.textFaint,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SearchBox extends StatefulWidget {
  final ValueChanged<String> onChanged;
  const _SearchBox({required this.onChanged});

  @override
  State<_SearchBox> createState() => _SearchBoxState();
}

class _SearchBoxState extends State<_SearchBox> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _clear() {
    _controller.clear();
    widget.onChanged('');
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    return TextField(
      controller: _controller,
      onChanged: (v) {
        widget.onChanged(v);
        setState(() {}); // keep the clear affordance in sync
      },
      style: const TextStyle(fontSize: 13.5),
      decoration: InputDecoration(
        isDense: true,
        prefixIcon: const Icon(Icons.search, size: 17),
        prefixIconConstraints:
            const BoxConstraints(minWidth: 36, minHeight: 36),
        suffixIcon: _controller.text.isEmpty
            ? null
            : IconButton(
                onPressed: _clear,
                icon: const Icon(Icons.close, size: 15),
                tooltip: 'Clear',
              ),
        suffixIconConstraints:
            const BoxConstraints(minWidth: 36, minHeight: 36),
        hintText: 'Search chats & messages',
        hintStyle: TextStyle(color: TalonColors.textFaint, fontSize: 13),
        filled: true,
        fillColor: TalonColors.void0.withValues(alpha: 0.5),
        contentPadding: const EdgeInsets.symmetric(vertical: TalonSpace.sm),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: BorderSide(color: TalonColors.glassStroke),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: BorderSide(color: TalonColors.glassStroke),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(11),
          borderSide: BorderSide(color: TalonColors.accent),
        ),
      ),
    );
  }
}
