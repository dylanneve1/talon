# Continuous glass chat concept

The conversation becomes part of the app backdrop instead of an opaque,
rounded panel sitting on top of it.

## Direction

- Remove the chat pane's fill, clipping, outer radius, and phone inset.
- Let the ambient background run continuously behind the message history.
- One honest glass bar for the header: a single uniform native backdrop
  blur with a translucent tint and a hairline bottom edge, running
  edge-to-edge behind the status bar. The scrollback slides underneath and
  glows through the glass.
- Keep separation local: the floating frosted composer pill provides
  contrast where the one control that needs it lives. Chrome is glass, used
  sparingly — bar on top, pill at the bottom, open canvas between.
- Preserve the existing message hierarchy, accent bubbles, typography, and
  desktop column width so this is a surface refinement, not a navigation
  redesign.
- Apply the same language in light and dark themes. On desktop, the sidebar
  remains the strong glass panel while the conversation becomes the open
  canvas beside it.

Progressive "melt" frosts were prototyped (masked blurs, banded backdrop
stacks, a variable-sigma shader) and rejected: they either render wrong on
some backends, band visibly, or cost too much GPU on phones. Uniform sigma
on the engine's own downsampled Gaussian is fast, artifact-free, and honest
— see the design review at dylanneve1/talon-design-review for the options
considered.

## Rendered app screenshots

- `phone-light.png`
- `phone-dark.png`
- `phone-dark-melt.png` — mid-scroll, the accent bubble straddling the bar
  (the stress case for the glass)
- `desktop-dark.png`

These screenshots are rendered from the real Flutter widgets by
`test/screenshots/gallery_test.dart`, not image mockups.
