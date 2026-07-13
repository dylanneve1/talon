import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_animate/flutter_animate.dart';

import '../models/bridge_models.dart';
import '../state/app_state.dart';
import '../theme.dart';
import 'activity_card.dart';
import 'brand.dart';
import 'chat_actions.dart';
import 'composer.dart';
import 'message_bubble.dart';
import 'model_sheet.dart';

const double _columnMax = 768;

/// Top inset for the scrollback so the newest-at-top content clears the
/// floating header when the list is scrolled all the way up. The scrollback
/// itself still runs (and fades) beneath the header while scrolling.
const double _headerClearance = 82;

class ChatView extends StatefulWidget {
  final AppState state;
  final bool showBack;
  final VoidCallback? onBack;

  const ChatView({
    super.key,
    required this.state,
    required this.showBack,
    this.onBack,
  });

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  final _scroll = ScrollController();

  /// Ids we've already shown, so the entrance animation plays once per message
  /// and never re-fires when a row is recycled back into view on scroll.
  final Set<String> _seen = <String>{};

  /// Which chat the list is currently anchored to, and whether we still owe it
  /// a jump-to-newest. When you open a chat it should land on the most recent
  /// message (like any chat app), not the top of the scrollback.
  String? _anchoredChatId;
  bool _pendingJumpToBottom = false;

  /// Whether the user has scrolled up into history far enough that a
  /// jump-to-latest affordance is useful.
  bool _awayFromBottom = false;

  @override
  void initState() {
    super.initState();
    _scroll.addListener(_onScrolled);
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  void _onScrolled() {
    if (!_scroll.hasClients) return;
    final pos = _scroll.position;
    final away = pos.maxScrollExtent - pos.pixels > 420;
    if (away != _awayFromBottom) setState(() => _awayFromBottom = away);
    // Nearing the top of loaded scrollback → pull the previous page in.
    if (pos.pixels < 240 && !_pendingJumpToBottom) _maybeLoadOlder();
  }

  /// Fetch the page above the current scrollback and keep the viewport
  /// anchored on the row the user was looking at (prepending grows
  /// maxScrollExtent; jump by the delta so nothing visibly shifts).
  Future<void> _maybeLoadOlder() async {
    final chatId = _anchoredChatId;
    if (chatId == null) return;
    final state = widget.state;
    if (state.isLoadingOlder(chatId) || !state.hasMoreHistory(chatId)) return;
    final extentBefore =
        _scroll.hasClients ? _scroll.position.maxScrollExtent : 0.0;
    final pixelsBefore = _scroll.hasClients ? _scroll.position.pixels : 0.0;
    final added = await state.loadOlderMessages(chatId);
    if (added > 0 && mounted) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (!_scroll.hasClients) return;
        final delta = _scroll.position.maxScrollExtent - extentBefore;
        if (delta > 0) _scroll.jumpTo(pixelsBefore + delta);
      });
    }
  }

  void _jumpToLatest() {
    if (!_scroll.hasClients) return;
    _scroll.animateTo(
      _scroll.position.maxScrollExtent,
      duration: const Duration(milliseconds: 260),
      curve: Curves.easeOutCubic,
    );
  }

  /// A row animates in only the first time we see it AND when it's genuinely
  /// fresh (sent/received seconds ago) — so opening a chat's history doesn't
  /// trigger a cascade of animations.
  bool _shouldAnimate(ClientMessage m) {
    final firstSight = _seen.add(m.id);
    if (!firstSight) return false;
    return DateTime.now().difference(m.time).inMilliseconds < 4000;
  }

  void _autoScroll(String chatId, int messageCount) {
    // Opening (or switching to) a chat should land on the newest message. The
    // history often loads a frame or two after the switch, so keep owing the
    // jump until the chat actually has content, then snap to the bottom.
    if (chatId != _anchoredChatId) {
      _anchoredChatId = chatId;
      _pendingJumpToBottom = true;
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scroll.hasClients) return;
      final pos = _scroll.position;
      if (_pendingJumpToBottom) {
        _scroll.jumpTo(pos.maxScrollExtent);
        // Only consider it settled once there's something to anchor to, so an
        // async history load right after the switch still snaps to newest.
        if (messageCount > 0) _pendingJumpToBottom = false;
        return;
      }
      // Otherwise follow live growth only when the user is already near the
      // bottom, so we never yank them up while they're reading scrollback.
      if (pos.maxScrollExtent - pos.pixels < 260) {
        _scroll.animateTo(
          pos.maxScrollExtent,
          duration: const Duration(milliseconds: 160),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    // The conversation is the canvas, not a card placed on top of it. Keeping
    // this layer transparent lets the global backdrop run continuously from
    // the system bars to the composer; glass is reserved for controls that
    // actually need separation (chips and input). The header is not a bar at
    // all: it floats over the scrollback, which slides underneath and melts
    // into a scrim, so nothing reads as a separate strip on the canvas.
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        final chat = widget.state.selectedChat;
        if (chat == null) return const _EmptyState();
        _autoScroll(chat.id, widget.state.messagesFor(chat.id).length);
        return Stack(
          children: [
            Positioned.fill(
              child: Column(
                children: [
                  Expanded(child: _messages(chat.id)),
                  Center(
                    child: ConstrainedBox(
                      constraints: const BoxConstraints(maxWidth: _columnMax),
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          _QueuedBar(state: widget.state, chatId: chat.id),
                          Composer(
                            onSend: widget.state.sendMessage,
                            onUpload: widget.state.uploadImage,
                            enabled: widget.state.conn == ConnState.connected,
                            running: widget.state.isTurnRunning(chat.id),
                            onStop: () => widget.state.interruptTurn(chat.id),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: Column(
                children: [
                  _Header(
                    state: widget.state,
                    chat: chat,
                    showBack: widget.showBack,
                    onBack: widget.onBack,
                  ),
                  if (widget.state.conn != ConnState.connected)
                    _ConnBanner(state: widget.state),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _messages(String chatId) {
    final msgs = widget.state.messagesFor(chatId);
    final turn = widget.state.turnFor(chatId);
    final showActivity = turn.active &&
        (turn.draft.isNotEmpty ||
            turn.reasoning.isNotEmpty ||
            turn.tools.isNotEmpty ||
            turn.typing ||
            turn.continuing);

    if (msgs.isEmpty && widget.state.isHistoryLoading(chatId)) {
      return const _HistorySkeleton();
    }

    if (msgs.isEmpty && !showActivity) {
      return _ConversationEmpty(
        onPrompt: widget.state.conn == ConnState.connected
            ? (p) => widget.state.sendMessage(p)
            : null,
      );
    }

    // Interleave day markers: a quiet centered "Today / Yesterday / 4 July"
    // pill wherever the calendar day changes, so scrollback has temporal
    // landmarks instead of one undifferentiated stream.
    final rows = <Object>[];
    DateTime? day;
    for (final m in msgs) {
      final t = m.time.toLocal();
      final d = DateTime(t.year, t.month, t.day);
      if (day == null || d != day) {
        rows.add(d);
        day = d;
      }
      rows.add(m);
    }

    final topLoader = widget.state.isLoadingOlder(chatId);
    final itemCount =
        (topLoader ? 1 : 0) + rows.length + (showActivity ? 1 : 0);
    return Stack(
      children: [
        Align(
          alignment: Alignment.topCenter,
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: _columnMax),
            child: ListView.builder(
              controller: _scroll,
              padding: EdgeInsets.fromLTRB(
                20,
                _headerClearance + MediaQuery.of(context).padding.top,
                20,
                10,
              ),
              itemCount: itemCount,
              itemBuilder: (context, i) {
                if (topLoader && i == 0) {
                  return const Padding(
                    padding: EdgeInsets.symmetric(vertical: 10),
                    child: Center(
                      child: SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  );
                }
                final mi = i - (topLoader ? 1 : 0);
                if (mi < rows.length) {
                  final row = rows[mi];
                  if (row is DateTime) return _DayDivider(day: row);
                  final m = row as ClientMessage;
                  return MessageBubble(
                    message: m,
                    botName: widget.state.status.botName,
                    animateIn: _shouldAnimate(m),
                    // activeConfig, not config: in local auto-discover mode the
                    // saved config lacks the bridge's real port/token, and media
                    // fetched through it 404s or gets rejected.
                    imageUrl: m.imagePath == null
                        ? null
                        : widget.state.activeConfig.mediaUrl(m.imagePath!),
                  );
                }
                return LiveTurn(
                    turn: turn, botName: widget.state.status.botName);
              },
            ),
          ),
        ),
        Positioned(
          right: 18,
          bottom: 12,
          child: AnimatedSlide(
            duration: TalonMotion.base,
            curve: TalonMotion.emphasized,
            offset: _awayFromBottom ? Offset.zero : const Offset(0, 0.4),
            child: AnimatedOpacity(
              duration: TalonMotion.fast,
              opacity: _awayFromBottom ? 1 : 0,
              child: IgnorePointer(
                ignoring: !_awayFromBottom,
                child: _JumpToLatest(onTap: _jumpToLatest),
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Round "back to the newest message" button shown once the user scrolls up
/// into history.
/// Centered day marker between messages from different calendar days.
class _DayDivider extends StatelessWidget {
  final DateTime day;
  const _DayDivider({required this.day});

  static const _months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];

  String get _label {
    final now = DateTime.now();
    final today = DateTime(now.year, now.month, now.day);
    final days = today.difference(day).inDays;
    if (days <= 0) return 'Today';
    if (days == 1) return 'Yesterday';
    final base = '${day.day} ${_months[day.month - 1]}';
    return day.year == now.year ? base : '$base ${day.year}';
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: TalonSpace.sm),
      child: Center(
        child: Container(
          padding: const EdgeInsets.symmetric(
            horizontal: TalonSpace.md,
            vertical: TalonSpace.xs,
          ),
          decoration: BoxDecoration(
            color: TalonColors.glassFill,
            borderRadius: TalonRadius.rPill,
            border: Border.all(color: TalonColors.glassStroke),
          ),
          child: Text(
            _label,
            style: TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.3,
              color: TalonColors.textDim,
            ),
          ),
        ),
      ),
    );
  }
}

class _JumpToLatest extends StatelessWidget {
  final VoidCallback onTap;
  const _JumpToLatest({required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: [TalonColors.accent, TalonColors.accentDeep],
        ),
        boxShadow: TalonShadows.glow,
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          onTap: onTap,
          customBorder: const CircleBorder(),
          child: const Padding(
            padding: EdgeInsets.all(10),
            child: Icon(Icons.arrow_downward_rounded,
                size: 18, color: Colors.white),
          ),
        ),
      ),
    );
  }
}

/// Slim status strip under the header while the app is reconnecting or the
/// bridge is unreachable, so a dead connection is visible from the chat
/// itself (not just the sidebar pill) and recoverable in place.
class _ConnBanner extends StatelessWidget {
  final AppState state;
  const _ConnBanner({required this.state});

  @override
  Widget build(BuildContext context) {
    final error = state.conn == ConnState.error;
    final color = error ? TalonColors.bad : TalonColors.warn;
    final text =
        error ? (state.connError ?? 'Connection lost') : 'Connecting to Talon…';
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
      color: color.withValues(alpha: 0.10),
      child: Row(
        children: [
          if (error)
            Icon(Icons.cloud_off_rounded, size: 15, color: color)
          else
            SizedBox(
              width: 13,
              height: 13,
              child: CircularProgressIndicator(
                strokeWidth: 1.8,
                valueColor: AlwaysStoppedAnimation(color),
              ),
            ),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              text,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(fontSize: 12.5, color: color),
            ),
          ),
          if (error)
            TextButton(
              onPressed: state.start,
              style: TextButton.styleFrom(
                foregroundColor: color,
                padding: const EdgeInsets.symmetric(horizontal: 10),
                minimumSize: const Size(0, 30),
                textStyle: const TextStyle(
                    fontSize: 12.5, fontWeight: FontWeight.w700),
              ),
              child: const Text('Retry'),
            ),
        ],
      ),
    );
  }
}

/// Approximates a progressive backdrop blur behind [child]: the area is
/// covered by stacked blur bands, full-height first and progressively
/// shorter ones on top, so the compounded blur is strongest behind the top
/// of the header and melts to nothing at its bottom edge. This keeps the
/// glass feel without the hard lower boundary a single BackdropFilter strip
/// would draw across the canvas.
class _ProgressiveGlass extends StatelessWidget {
  final Widget child;
  const _ProgressiveGlass({required this.child});

  /// (fraction of header height covered from the top, blur sigma).
  ///
  /// Every band spans the top 55% — that zone gets all sigmas compounded
  /// (σ_eff = √Σσ² ≈ 12), reading as one solid sheet of frost. Below it the
  /// band bottoms are staggered every ~6% of the height with geometrically
  /// increasing sigmas, and crucially the band reaching furthest down
  /// carries the smallest sigma: each visible step only sheds a σ≈1-2 pass
  /// from already-blurred content, so the frost dissolves as a smooth ramp
  /// instead of a staircase with a defined edge.
  static const _bands = [
    (1.00, 0.8),
    (0.94, 1.1),
    (0.88, 1.6),
    (0.82, 2.2),
    (0.76, 3.1),
    (0.70, 4.4),
    (0.63, 6.2),
    (0.55, 8.7),
  ];

  @override
  Widget build(BuildContext context) {
    return ClipRect(
      child: Stack(
        children: [
          Positioned.fill(
            child: LayoutBuilder(
              builder: (context, constraints) {
                final h = constraints.maxHeight;
                return Stack(
                  children: [
                    for (final (frac, sigma) in _bands)
                      Positioned(
                        top: 0,
                        left: 0,
                        right: 0,
                        height: h * frac,
                        child: ClipRect(
                          child: BackdropFilter(
                            filter: ImageFilter.blur(
                              sigmaX: sigma,
                              sigmaY: sigma,
                            ),
                            child: const SizedBox.expand(),
                          ),
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
          child,
        ],
      ),
    );
  }
}

class _Header extends StatelessWidget {
  final AppState state;
  final ClientChat chat;
  final bool showBack;
  final VoidCallback? onBack;

  const _Header({
    required this.state,
    required this.chat,
    required this.showBack,
    this.onBack,
  });

  @override
  Widget build(BuildContext context) {
    final model = chat.model ?? state.status.model;
    final effort = chat.effort ?? 'adaptive';
    // Not a bar: the controls float directly on the canvas over a progressive
    // glass gradient — heavy backdrop blur behind the title that melts to
    // nothing at the bottom — plus a soft scrim for legibility. Scrollback
    // dissolves as it slides underneath instead of hitting a frosted strip
    // with an edge.
    final base = TalonTheme.isDark ? TalonColors.void1 : Colors.white;
    // The shell doesn't consume the top inset for the conversation: the
    // frost and scrim run up behind the system status bar (same canvas, one
    // surface) and only the controls are padded down below it.
    final topInset = MediaQuery.of(context).padding.top;
    return _ProgressiveGlass(
      child: Container(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            // Matches the blur ramp: solid through the control zone, then a
            // single smooth falloff to nothing across the same border the
            // frost dissolves over.
            colors: [
              base.withValues(alpha: 0.80),
              base.withValues(alpha: 0.74),
              base.withValues(alpha: 0.0),
            ],
            stops: const [0.0, 0.55, 1.0],
          ),
        ),
        padding: EdgeInsets.fromLTRB(12, 8 + topInset, 8, 26),
        // Auto-detect available width instead of hard-coding a platform
        // check: a desktop window with the sidebar open gives the chat pane
        // less room than fullscreen, and the phone is always narrow.
        child: LayoutBuilder(
          builder: (context, constraints) {
            final compact = constraints.maxWidth < 560;
            final modelLabel = model.isEmpty ? 'model' : model;
            return Row(
              children: [
                if (showBack)
                  IconButton(
                    onPressed: onBack,
                    tooltip: 'Back to chats',
                    // Platform-adaptive: Material arrow on Android, iOS chevron
                    // on Apple platforms.
                    icon: Icon(Icons.adaptive.arrow_back, size: 20),
                  ),
                Expanded(
                  child: Text(
                    chat.title,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                        fontSize: 15.5, fontWeight: FontWeight.w700),
                  ),
                ),
                if (chat.context?.known == true) ...[
                  _ContextChip(context: chat.context!),
                  const SizedBox(width: 6),
                ],
                if (compact)
                  // One pill with just the model. Effort still lives a tap away
                  // in the model sheet; spelling it out here starved the chat
                  // title of width on phones ("Trip to…" next to
                  // "opus · adaptive").
                  _Chip(
                    icon: Icons.memory,
                    label: modelLabel,
                    onTap: () => openModelSheet(context, state, chat),
                  )
                else ...[
                  _Chip(
                    icon: Icons.memory,
                    label: modelLabel,
                    onTap: () => openModelSheet(context, state, chat),
                  ),
                  const SizedBox(width: 6),
                  _Chip(
                    icon: Icons.tune,
                    label: effort,
                    onTap: () => openModelSheet(context, state, chat),
                  ),
                ],
                _ChatMenu(state: state, chat: chat),
              ],
            );
          },
        ),
      ),
    );
  }
}

class _ChatMenu extends StatelessWidget {
  final AppState state;
  final ClientChat chat;
  const _ChatMenu({required this.state, required this.chat});

  @override
  Widget build(BuildContext context) {
    final pulseOn = chat.pulse ?? false;
    return PopupMenuButton<String>(
      icon: Icon(Icons.more_vert, size: 20, color: TalonColors.textDim),
      color: TalonColors.surfaceHi,
      onSelected: (v) async {
        switch (v) {
          case 'reset':
            await state.resetChat(chat.id);
            break;
          case 'pulse':
            await state.setPulse(chat.id, !pulseOn);
            break;
          case 'export':
            final messenger = ScaffoldMessenger.of(context);
            await Clipboard.setData(
              ClipboardData(text: state.exportMarkdown(chat.id)),
            );
            messenger.showSnackBar(
              const SnackBar(content: Text('Conversation copied as Markdown')),
            );
            break;
          case 'rename':
            await promptRenameChat(context, state, chat);
            break;
          case 'delete':
            await confirmDeleteChat(context, state, chat);
            break;
        }
      },
      itemBuilder: (_) => [
        const PopupMenuItem(
          value: 'reset',
          child: _MenuRow(icon: Icons.refresh, label: 'Reset session'),
        ),
        const PopupMenuItem(
          value: 'export',
          child: _MenuRow(
              icon: Icons.ios_share_outlined, label: 'Copy as Markdown'),
        ),
        PopupMenuItem(
          value: 'pulse',
          child: _MenuRow(
            icon:
                pulseOn ? Icons.notifications_active : Icons.notifications_off,
            label: pulseOn ? 'Disable pulse' : 'Enable pulse',
          ),
        ),
        const PopupMenuItem(
          value: 'rename',
          child: _MenuRow(icon: Icons.edit_outlined, label: 'Rename'),
        ),
        const PopupMenuItem(
          value: 'delete',
          child: _MenuRow(
              icon: Icons.delete_outline, label: 'Delete', danger: true),
        ),
      ],
    );
  }
}

class _MenuRow extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool danger;
  const _MenuRow(
      {required this.icon, required this.label, this.danger = false});

  @override
  Widget build(BuildContext context) {
    final color = danger ? TalonColors.bad : TalonColors.text;
    return Row(
      children: [
        Icon(icon, size: 17, color: color),
        const SizedBox(width: 10),
        Text(label, style: TextStyle(color: color, fontSize: 13.5)),
      ],
    );
  }
}

/// Compact context-window readout: a tiny fill ring + percentage. Turns the
/// warn color once the window is ≥80% full. Tooltip shows the raw token
/// figures. Purely informational — no tap action.
class _ContextChip extends StatelessWidget {
  final ContextInfo context;
  const _ContextChip({required this.context});

  static String _fmt(int n) {
    if (n >= 1000000) return '${(n / 1000000).toStringAsFixed(1)}M';
    if (n >= 1000) return '${(n / 1000).toStringAsFixed(n >= 10000 ? 0 : 1)}k';
    return '$n';
  }

  @override
  Widget build(BuildContext ctx) {
    final color = context.warn ? TalonColors.warn : TalonColors.textDim;
    final tip = context.max > 0
        ? 'Context: ${_fmt(context.used)} / ${_fmt(context.max)} tokens (${context.pct}%)'
        : 'Context: ${_fmt(context.used)} tokens';
    return Tooltip(
      message: tip,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: TalonColors.glassFill,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(
            color: context.warn ? TalonColors.warn : TalonColors.glassStroke,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            SizedBox(
              width: 13,
              height: 13,
              child: CircularProgressIndicator(
                value: (context.pct.clamp(0, 100)) / 100,
                strokeWidth: 2.4,
                backgroundColor: TalonColors.glassStroke,
                valueColor: AlwaysStoppedAnimation(color),
              ),
            ),
            const SizedBox(width: 6),
            Text(
              '${context.pct}%',
              style: TextStyle(fontSize: 12, color: color),
            ),
          ],
        ),
      ),
    );
  }
}

/// Sticky bar above the composer showing the single queued follow-up while a
/// turn is running. Editable inline (pencil), sendable now (arrow), or
/// discardable (x). It auto-sends when the running turn ends.
class _QueuedBar extends StatefulWidget {
  final AppState state;
  final String chatId;
  const _QueuedBar({required this.state, required this.chatId});

  @override
  State<_QueuedBar> createState() => _QueuedBarState();
}

class _QueuedBarState extends State<_QueuedBar> {
  bool _editing = false;
  final _controller = TextEditingController();
  final _focus = FocusNode();

  @override
  void dispose() {
    _controller.dispose();
    _focus.dispose();
    super.dispose();
  }

  void _startEdit(String current) {
    _controller.text = current;
    _controller.selection = TextSelection.collapsed(offset: current.length);
    setState(() => _editing = true);
    _focus.requestFocus();
  }

  void _saveEdit() {
    widget.state.editQueued(widget.chatId, _controller.text);
    setState(() => _editing = false);
  }

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: widget.state,
      builder: (context, _) {
        final queued = widget.state.queuedFor(widget.chatId);
        if (queued == null) {
          if (_editing) _editing = false;
          return const SizedBox.shrink();
        }
        final hasAttachment = queued.hasAttachment;
        return Container(
          margin: const EdgeInsets.fromLTRB(14, 0, 14, 6),
          padding: const EdgeInsets.fromLTRB(12, 8, 6, 8),
          decoration: BoxDecoration(
            color: TalonColors.accent.withValues(alpha: 0.10),
            borderRadius: BorderRadius.circular(14),
            border:
                Border.all(color: TalonColors.accent.withValues(alpha: 0.35)),
          ),
          child: Row(
            children: [
              Icon(Icons.schedule, size: 15, color: TalonColors.accent),
              const SizedBox(width: 8),
              Expanded(
                child: _editing
                    ? TextField(
                        controller: _controller,
                        focusNode: _focus,
                        autofocus: true,
                        minLines: 1,
                        maxLines: 4,
                        style: const TextStyle(fontSize: 13.5),
                        decoration: const InputDecoration(
                          isDense: true,
                          border: InputBorder.none,
                          hintText: 'Edit queued message…',
                        ),
                        onSubmitted: (_) => _saveEdit(),
                      )
                    : Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            'Queued · sends when the reply finishes',
                            style: TextStyle(
                              fontSize: 10.5,
                              fontWeight: FontWeight.w700,
                              letterSpacing: 0.3,
                              color: TalonColors.accent,
                            ),
                          ),
                          const SizedBox(height: 2),
                          Row(
                            children: [
                              if (hasAttachment) ...[
                                Icon(Icons.attach_file,
                                    size: 13, color: TalonColors.textDim),
                                const SizedBox(width: 4),
                              ],
                              Expanded(
                                child: Text(
                                  queued.text.isEmpty && hasAttachment
                                      ? '(attachment)'
                                      : queued.text,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontSize: 13.5),
                                ),
                              ),
                            ],
                          ),
                        ],
                      ),
              ),
              if (_editing)
                _QueuedAction(
                  icon: Icons.check,
                  tooltip: 'Save',
                  color: TalonColors.ok,
                  onTap: _saveEdit,
                )
              else
                _QueuedAction(
                  icon: Icons.edit_outlined,
                  tooltip: 'Edit',
                  onTap: () => _startEdit(queued.text),
                ),
              _QueuedAction(
                icon: Icons.close,
                tooltip: 'Discard',
                onTap: () {
                  setState(() => _editing = false);
                  widget.state.editQueued(widget.chatId, '');
                },
              ),
            ],
          ),
        );
      },
    );
  }
}

class _QueuedAction extends StatelessWidget {
  final IconData icon;
  final String tooltip;
  final Color? color;
  final VoidCallback onTap;
  const _QueuedAction({
    required this.icon,
    required this.tooltip,
    required this.onTap,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: Icon(icon, size: 18),
      tooltip: tooltip,
      visualDensity: VisualDensity.compact,
      color: color ?? TalonColors.textDim,
      onPressed: onTap,
    );
  }
}

class _Chip extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  const _Chip({required this.icon, required this.label, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(999),
      child: Container(
        constraints: const BoxConstraints(maxWidth: 170),
        padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 7),
        decoration: BoxDecoration(
          color: TalonColors.glassFill,
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: TalonColors.glassStroke),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: TalonColors.textDim),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontSize: 12, color: TalonColors.textDim),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Shimmering placeholder rows while a chat's first history page loads, in
/// the same silhouette as real messages so the swap doesn't jump.
class _HistorySkeleton extends StatelessWidget {
  const _HistorySkeleton();

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    Widget bar(double width, {bool right = false}) {
      final box = Align(
        alignment: right ? Alignment.centerRight : Alignment.centerLeft,
        child: Container(
          width: width,
          height: 40,
          margin: const EdgeInsets.symmetric(vertical: 8),
          decoration: BoxDecoration(
            color: TalonColors.surfaceHi.withValues(alpha: 0.55),
            borderRadius: BorderRadius.circular(14),
          ),
        ),
      );
      if (reduceMotion) return box;
      return box.animate(onPlay: (c) => c.repeat()).shimmer(
            duration: 1200.ms,
            color: Colors.white.withValues(alpha: 0.06),
          );
    }

    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: _columnMax),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 24, 20, 10),
          children: [
            bar(220, right: true),
            bar(320),
            bar(180, right: true),
            bar(380),
            bar(260),
          ],
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    const mark = BrandMark(size: 64);
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          reduceMotion
              ? mark
              : mark
                  .animate()
                  .fadeIn(duration: TalonMotion.slow)
                  .scaleXY(begin: 0.85, end: 1, curve: TalonMotion.emphasized),
          const SizedBox(height: TalonSpace.lg),
          Text('Talon', style: TalonType.display),
          const SizedBox(height: 6),
          Text('Select a chat, or start a new one.',
              style: TextStyle(color: TalonColors.textFaint)),
        ],
      ),
    );
  }
}

/// Suggested prompts shown in a fresh conversation, à la ChatGPT/Claude — a few
/// tappable starters so an empty chat feels intentional rather than blank.
const List<({IconData icon, String label, String prompt})> _starters = [
  (
    icon: Icons.summarize_outlined,
    label: 'Summarize my day',
    prompt: 'Summarize what happened today and what needs my attention.',
  ),
  (
    icon: Icons.checklist_rounded,
    label: 'Plan a task',
    prompt: 'Help me break down a task into clear, actionable steps.',
  ),
  (
    icon: Icons.lightbulb_outline,
    label: 'Brainstorm ideas',
    prompt: 'Brainstorm a few creative ideas with me.',
  ),
];

class _ConversationEmpty extends StatelessWidget {
  /// Sends a suggested prompt; null while disconnected (chips disabled).
  final void Function(String prompt)? onPrompt;
  const _ConversationEmpty({required this.onPrompt});

  @override
  Widget build(BuildContext context) {
    final reduceMotion = MediaQuery.of(context).disableAnimations;
    final header = Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        const BrandMark(size: 56),
        const SizedBox(height: TalonSpace.lg),
        // Gradient greeting — the fresh-conversation hero moment.
        ShaderMask(
          shaderCallback: (bounds) =>
              TalonColors.accentGradient.createShader(bounds),
          blendMode: BlendMode.srcIn,
          child: Text(
            'How can I help?',
            style: TalonType.display.copyWith(
              fontSize: 24,
              color: Colors.white,
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text('Send a message to begin.',
            style: TextStyle(color: TalonColors.textFaint)),
      ],
    );

    return Center(
      child: Padding(
        padding: const EdgeInsets.all(TalonSpace.xl),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            reduceMotion
                ? header
                : header
                    .animate()
                    .fadeIn(duration: TalonMotion.slow)
                    .slideY(begin: 0.1, end: 0, curve: TalonMotion.emphasized),
            const SizedBox(height: TalonSpace.xl),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: TalonSpace.sm,
              runSpacing: TalonSpace.sm,
              children: [
                for (var i = 0; i < _starters.length; i++)
                  _StarterChip(
                    starter: _starters[i],
                    index: i,
                    reduceMotion: reduceMotion,
                    onTap: onPrompt == null
                        ? null
                        : () => onPrompt!(_starters[i].prompt),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _StarterChip extends StatelessWidget {
  final ({IconData icon, String label, String prompt}) starter;
  final int index;
  final bool reduceMotion;
  final VoidCallback? onTap;

  const _StarterChip({
    required this.starter,
    required this.index,
    required this.reduceMotion,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final chip = Material(
      color: Colors.transparent,
      child: InkWell(
        onTap: onTap,
        borderRadius: TalonRadius.rMd,
        child: Container(
          padding: const EdgeInsets.fromLTRB(
              TalonSpace.sm, TalonSpace.sm, TalonSpace.md, TalonSpace.sm),
          decoration: BoxDecoration(
            color: TalonColors.glassFill,
            borderRadius: TalonRadius.rMd,
            border: Border.all(color: TalonColors.glassStroke),
            boxShadow: TalonShadows.soft,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              // Accent-tinted icon well, so the starters read as actions.
              Container(
                width: 28,
                height: 28,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: TalonColors.accent.withValues(alpha: 0.14),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: Icon(starter.icon, size: 15, color: TalonColors.accent),
              ),
              const SizedBox(width: TalonSpace.sm),
              Text(starter.label,
                  style: TalonType.label.copyWith(color: TalonColors.text)),
            ],
          ),
        ),
      ),
    );
    if (reduceMotion) return chip;
    final delay = (120 + index * 70).ms;
    return chip
        .animate()
        .fadeIn(delay: delay, duration: TalonMotion.base)
        .slideY(
            begin: 0.3, end: 0, delay: delay, curve: TalonMotion.emphasized);
  }
}
