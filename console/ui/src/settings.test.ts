import { describe, expect, it } from "vitest";
import { basePathFrom, readSettings } from "./settings";

function pageWith(meta: Record<string, string>, baseURI: string): Document {
  return {
    baseURI,
    querySelector: (selector: string) => {
      const name = /meta\[name="([^"]+)"\]/.exec(selector)?.[1];
      return name && name in meta ? { getAttribute: () => meta[name] } : null;
    },
  } as unknown as Document;
}

describe("basePathFrom", () => {
  it("takes the prefix the server wrote into <base href>", () => {
    expect(basePathFrom("https://mail.example.com/console/")).toBe("/console");
    expect(basePathFrom("http://localhost:5173/")).toBe("");
  });
});

describe("readSettings", () => {
  it("reads the settings the console service wrote into the page", () => {
    const settings = readSettings(
      pageWith(
        {
          "inworkspace-console-api": "https://console-api.example.com/",
          "inworkspace-console-client-id": "inworkspace-console",
          "inworkspace-console-time-zone": "Europe/Zurich",
        },
        "https://mail.example.com/console/",
      ),
    );
    expect(settings).toEqual({
      apiUrl: "https://console-api.example.com",
      clientId: "inworkspace-console",
      timeZone: "Europe/Zurich",
      basePath: "/console",
    });
  });

  it("falls back to the browser's time zone", () => {
    const settings = readSettings(pageWith({ "inworkspace-console-time-zone": "" }, "https://mail.example.com/console/"));
    expect(settings.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
