import { useEffect, useRef, useState } from "react";
import type { EventsResponse, StoredEvent } from "@/lib/apiTypes";
import { useConsole } from "../console";
import { EventRow } from "./EventRow";

const POLL_MS = 3000;
const KEEP = 500;

export function LiveEvents({ initialAfter, query, timeZone }: { initialAfter: number; query: string; timeZone: string }) {
  const { get } = useConsole();
  const [live, setLive] = useState(false);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const after = useRef(initialAfter);

  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Each poll starts after the previous one ends, so slow answers never overlap or repeat rows.
    const poll = async () => {
      try {
        const body = await get<EventsResponse>(`events?${query ? `${query}&` : ""}after=${after.current}`);
        if (cancelled) return;
        setError(null);
        if (body.events.length > 0) {
          after.current = Math.max(after.current, ...body.events.map((event) => event.id));
          setEvents((current) => [...body.events, ...current].slice(0, KEEP));
        }
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      }
      if (!cancelled) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [live, query, get]);

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
