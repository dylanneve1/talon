# Continuous glass chat concept

The conversation becomes part of the app backdrop instead of an opaque,
rounded panel sitting on top of it.

## Direction

- Remove the chat pane's fill, clipping, outer radius, and phone inset.
- Let the ambient background run continuously behind the message history.
- No header bar at all: the title, chips and menu float directly on the
  canvas, and the scrollback slides underneath them, dissolving into a soft
  scrim instead of hitting a frosted strip with an edge.
- Keep separation local: the floating frosted composer pill provides contrast
  where the one control that needs it lives.
- Preserve the existing message hierarchy, accent bubbles, typography, and
  desktop column width so this is a surface refinement, not a navigation
  redesign.
- Apply the same language in light and dark themes. On desktop, the sidebar
  remains the strong glass panel while the conversation becomes the open
  canvas beside it.

## Rendered app screenshots

- `phone-light.png`
- `phone-dark.png`
- `desktop-dark.png`

These screenshots are rendered from the real Flutter widgets by
`test/screenshots/gallery_test.dart`, not image mockups.
