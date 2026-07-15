import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../state/app_state.dart';
import 'chat_view.dart';
import 'glass.dart';
import 'quick_switcher.dart';
import 'sidebar.dart';

/// The main two-pane layout. Side-by-side on desktop/tablet; on a phone it
/// collapses to one pane (chat list ⇄ conversation) driven by selection.
class AppShell extends StatelessWidget {
  final AppState state;
  const AppShell({super.key, required this.state});

  static const double _wideBreakpoint = 820;

  @override
  Widget build(BuildContext context) {
    // A Scaffold (not present anywhere above this in the tree -- RootView
    // is a Stack/Material, not a Scaffold) is what makes
    // resizeToAvoidBottomInset happen: without it, nothing shrinks for the
    // keyboard, so the message list never collapses and the Composer (in
    // ChatView, at the bottom of this subtree) doesn't get pushed up --
    // the keyboard just overlaps it. backgroundColor is transparent so
    // RootView's gradient backdrop still shows through underneath.
    return Scaffold(
      backgroundColor: Colors.transparent,
      resizeToAvoidBottomInset: true,
      // Global keyboard shortcuts: Cmd/Ctrl+K quick switcher, Cmd/Ctrl+N new
      // chat, Esc back to the list on the narrow layout. CallbackShortcuts
      // sees keys bubbling from any focused descendant (composer included).
      body: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.keyK, meta: true): () =>
              openQuickSwitcher(context, state),
          const SingleActivator(LogicalKeyboardKey.keyK, control: true): () =>
              openQuickSwitcher(context, state),
          const SingleActivator(LogicalKeyboardKey.keyN, meta: true):
              state.newChat,
          const SingleActivator(LogicalKeyboardKey.keyN, control: true):
              state.newChat,
        },
        // top: false — the conversation owns the status-bar zone: ChatView's
        // header glass runs up behind it and pads its controls by the inset,
        // so the system bar sits on the same continuous canvas instead of on
        // a separate strip above it. Layouts that keep a panelled top edge
        // (the chat list, the wide two-pane shell) re-add their own SafeArea.
        child: SafeArea(
          top: false,
          child: LayoutBuilder(
            builder: (context, constraints) {
              final wide = constraints.maxWidth >= _wideBreakpoint;
              // Let selection logic know which layout it's driving: narrow
              // treats the chat list as its own screen (no auto-selection).
              state.setNarrowLayout(!wide);
              if (wide) {
                return SafeArea(
                  bottom: false,
                  child: Padding(
                    padding: const EdgeInsets.all(10),
                    child: Row(
                      children: [
                        SizedBox(
                          width: 308,
                          child: Sidebar(state: state, onSelect: null),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: ChatView(state: state, showBack: false),
                        ),
                      ],
                    ),
                  ),
                );
              }

              // Narrow: list until a chat is chosen, then the conversation.
              return ListenableBuilder(
                listenable: state,
                builder: (context, _) {
                  final showChat = state.selectedChatId != null;
                  // System back (button or predictive gesture) while a
                  // conversation is open returns to the chat list — it must
                  // never fall through and quit the app. From the list, back
                  // pops for real and the app backgrounds as expected.
                  return PopScope(
                    canPop: !showChat,
                    onPopInvokedWithResult: (didPop, _) {
                      if (!didPop) state.clearSelection();
                    },
                    child: CallbackShortcuts(
                      bindings: {
                        const SingleActivator(LogicalKeyboardKey.escape): () {
                          if (state.selectedChatId != null) {
                            state.clearSelection();
                          }
                        },
                      },
                      child: AnimatedSwitcher(
                        duration: const Duration(milliseconds: 240),
                        switchInCurve: Curves.easeOutCubic,
                        switchOutCurve: Curves.easeOutCubic,
                        // Push/pop, not crossfade: the conversation slides
                        // fully on/off screen over the list (which parallaxes
                        // beneath). No fades — a fade's saveLayer starves the
                        // glass BackdropFilters of their backdrop so the blur
                        // pops in at the end, and a non-faded outgoing screen
                        // shows through whatever fades in over it.
                        transitionBuilder: (child, anim) {
                          final chat = child.key == const ValueKey('chat');
                          return SlideTransition(
                            position: Tween(
                              begin: Offset(chat ? 1 : -0.15, 0),
                              end: Offset.zero,
                            ).animate(anim),
                            child: child,
                          );
                        },
                        // The conversation must cover the list in both
                        // directions; by default the switcher puts the
                        // incoming child on top, which is wrong on close.
                        layoutBuilder: (current, previous) => Stack(
                          alignment: Alignment.center,
                          children: showChat
                              ? [...previous, if (current != null) current]
                              : [if (current != null) current, ...previous],
                        ),
                        // The conversation carries its own canvas: ChatView
                        // is transparent (the shell paints the backdrop
                        // once), so without this the list shows through the
                        // card while it slides.
                        child: showChat
                            ? TalonBackdrop(
                                key: const ValueKey('chat'),
                                child: ChatView(
                                  state: state,
                                  showBack: true,
                                  onBack: state.clearSelection,
                                ),
                              )
                            : SafeArea(
                                key: const ValueKey('list'),
                                bottom: false,
                                child: Padding(
                                  padding: const EdgeInsets.all(8),
                                  child: Sidebar(
                                    state: state,
                                    onSelect: (id) => state.selectChat(id),
                                  ),
                                ),
                              ),
                      ),
                    ),
                  );
                },
              );
            },
          ),
        ),
      ),
    );
  }
}
