"use client";

import { useEffect, useRef, useState } from "react";
import type { StoredEvent } from "@/lib/eventStore";
import { EventRow } from "./EventRow";

const POLL_MS = 3000;
const KEEP = 500;

export function LiveEvents({ initialAfter, query, timeZone }: { initialAfter: number; query: string; timeZone: string }) {
  const [live, setLive] = useState(false);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const after = useRef(initialAfter);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/events?${query ? `${query}&` : ""}after=${after.current}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = (await response.json()) as { events: StoredEvent[] };
        if (cancelled) return;
        setError(null);
        if (body.events.length > 0) {
          after.current = Math.max(after.current, ...body.events.map((event) => event.id));
          setEvents((current) => [...body.events, ...current].slice(0, KEEP));
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [live, query]);

  return (
    <section aria-label="Live events" className="overflow-hidden rounded-lg border border-border bg-surface">
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <button
          type="button"
          onClick={() => setLive((value) => !value)}
          aria-pressed={live}
          className={`rounded-md px-3 py-1.5 text-xs font-medium ${live ? "bg-brand text-surface hover:bg-brand-strong" : "border border-border hover:bg-surface-muted"}`}
        >
          {live ? "Stop live updates" : "Start live updates"}
        </button>
        <span className="text-xs text-text-muted">
          {live ? (error ? `Paused: ${error}. Retrying…` : `Checking every ${POLL_MS / 1000} seconds.`) : "New events appear here while live updates are on."}
        </span>
        {events.length > 0 ? <span className="ml-auto text-xs font-medium">{events.length} new</span> : null}
      </div>
      {events.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full">
            <tbody>
              {events.map((event) => (
                <EventRow key={event.id} event={event} timeZone={timeZone} />
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
