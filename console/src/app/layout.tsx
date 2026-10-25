import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { OperatorBadge } from "@/components/OperatorBadge";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "inWorkspace Console", template: "%s · inWorkspace Console" },
  description: "Oversight of AI agents working through inWorkspace mailboxes.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b border-border bg-surface">
          <div className="mx-auto flex max-w-7xl items-center gap-8 px-6 py-3">
            <Link href="/" className="text-sm font-semibold tracking-tight text-text">
              inWorkspace <span className="text-brand">Console</span>
            </Link>
            <nav aria-label="Main" className="flex gap-5 text-sm">
              <Link href="/" className="text-text-muted hover:text-text">
                Overview
              </Link>
              <Link href="/events" className="text-text-muted hover:text-text">
                Events
              </Link>
            </nav>
            <div className="ml-auto text-xs text-text-muted">
              <Suspense fallback={null}>
                <OperatorBadge />
              </Suspense>
            </div>
          </div>
        </header>
        <div className="mx-auto max-w-7xl px-6 py-8">{children}</div>
      </body>
    </html>
  );
}
