/**
 * JSON.parse, except that integers too large for a double — the server's 64-bit queue and
 * span ids — come back as their exact decimal strings instead of rounded numbers.
 */
export function parseJsonExact(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) => {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      context?.source !== undefined
    ) {
      return context.source;
    }
    return value;
  });
}
