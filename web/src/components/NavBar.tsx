"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/chat", label: "Chat" },
  { href: "/cohort", label: "Cohort Builder" },
  { href: "/auditor", label: "SQL + Schema Auditor" },
  { href: "/evaluation", label: "Evaluation" },
];

/**
 * Shared route nav. Each tab is a real App Router route (not client-state
 * tab-switching) specifically so the Chat/Cohort track and the
 * Auditor/Evaluation track can each own their own route folder with zero
 * file overlap between them.
 */
export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="tab-bar" role="tablist" aria-label="PharmaSentinel sections">
      {TABS.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          role="tab"
          aria-selected={pathname === tab.href}
          className={
            pathname === tab.href ? "tab-button tab-button--active" : "tab-button"
          }
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
