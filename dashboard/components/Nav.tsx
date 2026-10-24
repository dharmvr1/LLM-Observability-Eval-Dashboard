"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/traces", label: "Traces" },
  { href: "/evals", label: "Evals" },
  { href: "/drift", label: "Drift" },
  { href: "/alerts", label: "Alerts" },
];

export default function Nav() {
  const path = usePathname();
  return (
    <nav>
      {LINKS.map((link) => {
        const active = link.href === "/" ? path === "/" : path.startsWith(link.href);
        return (
          <Link key={link.href} href={link.href} className={active ? "active" : ""}>
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
