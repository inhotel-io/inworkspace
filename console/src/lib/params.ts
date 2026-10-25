const MAX_POSITION = 100_000;

export function firstValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function decodeAddressParam(raw: string): string {
  try {
    return decodeURIComponent(raw).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

export function parsePosition(value: string | string[] | undefined): number {
  const parsed = Number.parseInt(firstValue(value) ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, MAX_POSITION);
}

export function isThreadId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(value);
}
