"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Pulse } from "./Icons";
import ThemeToggle from "./ThemeToggle";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/traces", label: "Traces" },
  { href: "/evals", label: "Evals" },
  { href: "/drift", label: "Drift" },
  { href: "/alerts", label: "Alerts" },
  { href: "/reliability", label: "Reliability" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <header className="topbar">
      <div className="inner">
        <Link href="/" className="brand">
          <span className="brand-mark"><Pulse size={15} /></span>
          LLM Observability
        </Link>
        <nav className="main" aria-label="Main">
          {LINKS.map((link) => {
            const active = link.href === "/" ? path === "/" : path.startsWith(link.href);
            return (
              <Link key={link.href} href={link.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined}>
                {link.label}
              </Link>
            );
          })}
        </nav>
        <ThemeToggle />
      </div>
    </header>
  );
}
