const path = require("node:path");
const color = (variable, fallback) => ({ opacityValue }) => opacityValue
  ? `color-mix(in srgb, var(${variable}, ${fallback}) ${Number(opacityValue) * 100}%, transparent)`
  : `var(${variable}, ${fallback})`;
module.exports = {
  content: [path.join(__dirname, "react/**/*.{ts,tsx}")],
  important: ".chatticus-chat",
  corePlugins: { preflight: false },
  theme: { extend: { colors: {
    surface: color("--chatticus-chat-surface", "Canvas"),
    "surface-raised": color("--chatticus-chat-raised", "ButtonFace"),
    "surface-foreground": color("--chatticus-chat-foreground", "CanvasText"),
    cobalt: color("--chatticus-chat-accent", "Highlight"),
    clay: color("--chatticus-chat-error", "CanvasText"),
    signal: color("--chatticus-chat-action", "Highlight"),
    ink: color("--chatticus-chat-action-text", "HighlightText"),
  } } },
};
