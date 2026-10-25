import { describe, expect, it } from "vitest";
import { emailHtmlDocument } from "./emailDocument";

describe("emailHtmlDocument", () => {
  it("wraps the body in a document that blocks every remote resource", () => {
    const document = emailHtmlDocument("<p>Hi</p>");
    expect(document).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"`);
    expect(document).toContain("<body><p>Hi</p></body>");
  });
});
