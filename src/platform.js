// SPDX-License-Identifier: GPL-3.0-or-later
export function installPlatformGuards(root) {
  const preventer = (event) => {
    event.preventDefault();
  };

  ["gesturestart", "gesturechange", "gestureend"].forEach((name) => {
    root.addEventListener(name, preventer, { passive: false });
  });

  const focusable = root;
  if (!focusable.hasAttribute("tabindex")) {
    focusable.setAttribute("tabindex", "0");
  }

  return {
    focusGame() {
      focusable.focus({ preventScroll: true });
    },
  };
}
