"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "./Icons";

// Light / dark switch. The choice is kept in localStorage (a convenience only: the page works without it)
// and written to <html data-theme>, which the CSS tokens in globals.css react to.
export default function ThemeToggle() {
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const set = document.documentElement.dataset.theme;
    setTheme(set === "dark" || set === "light" ? set : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  }, []);

  function flip() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch {
      // private window or blocked storage: the switch still works for this page view
    }
    setTheme(next);
  }

  return (
    <button className="icon-btn" onClick={flip} aria-label={theme === "dark" ? "Switch to the light theme" : "Switch to the dark theme"} title="Switch theme">
      {theme === "dark" ? <Sun /> : <Moon />}
    </button>
  );
}
