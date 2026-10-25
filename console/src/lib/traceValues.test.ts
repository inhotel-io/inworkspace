import { describe, expect, it } from "vitest";
import { parseJsonExact } from "./json";
import { toTraceEvent } from "./traceValues";

describe("toTraceEvent", () => {
  it("types each value the way the server's trace objects do", () => {
    const data = parseJsonExact(
      `{"spanId":336901507366519296,"accountId":1,"elapsed":12,"remoteIp":"192.168.65.1","localPort":25,"nextRetry":"2026-10-25T11:19:51Z",
        "from":"jane@example.com","to":["a@agents.example.test","b@agents.example.test"],"tls":true,"score":-1.5,"delta":-3,"x":null,
        "causedBy":{"type":"store.data-corruption","text":"Data corruption","data":{"details":"bad"}},"map":{"a":1}}`,
    ) as Record<string, unknown>;
    expect(toTraceEvent("smtp.mail-from", new Date("2026-10-25T11:19:51Z"), data)).toEqual({
      event: "smtp.mail-from",
      timestamp: "2026-10-25T11:19:51.000Z",
      keyValues: [
        { key: "spanId", value: { "@type": "UnsignedInt", value: "336901507366519296" } },
        { key: "accountId", value: { "@type": "UnsignedInt", value: 1 } },
        { key: "elapsed", value: { "@type": "Duration", value: 12 } },
        { key: "remoteIp", value: { "@type": "IpAddr", value: "192.168.65.1" } },
        { key: "localPort", value: { "@type": "UnsignedInt", value: 25 } },
        { key: "nextRetry", value: { "@type": "UTCDateTime", value: "2026-10-25T11:19:51Z" } },
        { key: "from", value: { "@type": "String", value: "jane@example.com" } },
        {
          key: "to",
          value: {
            "@type": "List",
            value: [
              { "@type": "String", value: "a@agents.example.test" },
              { "@type": "String", value: "b@agents.example.test" },
            ],
          },
        },
        { key: "tls", value: { "@type": "Boolean", value: true } },
        { key: "score", value: { "@type": "Float", value: -1.5 } },
        { key: "delta", value: { "@type": "Integer", value: -3 } },
        { key: "x", value: { "@type": "Null" } },
        {
          key: "causedBy",
          value: { "@type": "Event", event: "store.data-corruption", value: [{ key: "details", value: { "@type": "String", value: "bad" } }] },
        },
        { key: "map", value: { "@type": "String", value: '{"a":1}' } },
      ],
    });
  });

  it("keeps a string that only looks like an address or id as text", () => {
    const { keyValues } = toTraceEvent("x.y", new Date(0), { remoteIp: "unknown", details: "1234567890123456789" });
    expect(keyValues.map((pair) => pair.value["@type"])).toEqual(["String", "String"]);
  });
});
