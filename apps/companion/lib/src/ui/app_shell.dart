import 'package:flutter/material.dart';

import '../state/app_state.dart';
import 'chat_view.dart';
import 'sidebar.dart';

/// The main two-pane layout. Side-by-side on desktop/tablet; on a phone it
/// collapses to one pane (chat list ⇄ conversation) driven by selection.
class AppShell extends StatelessWidget {
  final AppState state;
  const AppShell({super.key, required this.state});

  static const double _wideBreakpoint = 820;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final wide = constraints.maxWidth >= _wideBreakpoint;
          if (wide) {
            return Padding(
              padding: const EdgeInsets.all(10),
              child: Row(
                children: [
                  SizedBox(
                    width: 308,
                    child: Sidebar(state: state, onSelect: null),
                  ),
                  const SizedBox(width: 10),
                  Expanded(child: ChatView(state: state, showBack: false)),
                ],
              ),
            );
          }

          // Narrow: list until a chat is chosen, then the conversation.
          return ListenableBuilder(
            listenable: state,
            builder: (context, _) {
              final showChat = state.selectedChatId != null;
              return AnimatedSwitcher(
                duration: const Duration(milliseconds: 220),
                switchInCurve: Curves.easeOutCubic,
                transitionBuilder: (child, anim) => FadeTransition(
                  opacity: anim,
                  child: SlideTransition(
                    position: Tween(
                      begin: const Offset(0.04, 0),
                      end: Offset.zero,
                    ).animate(anim),
                    child: child,
                  ),
                ),
                child: showChat
                    ? Padding(
                        key: const ValueKey('chat'),
                        padding: const EdgeInsets.all(8),
                        child: ChatView(
                          state: state,
                          showBack: true,
                          onBack: state.clearSelection,
                        ),
                      )
                    : Padding(
                        key: const ValueKey('list'),
                        padding: const EdgeInsets.all(8),
                        child: Sidebar(
                          state: state,
                          onSelect: (id) => state.selectChat(id),
                        ),
                      ),
              );
            },
          );
        },
      ),
    );
  }
}
