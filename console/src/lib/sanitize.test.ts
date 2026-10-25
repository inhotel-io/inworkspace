import { describe, expect, it } from "vitest";
import { decodeEntities, emailHtmlDocument, htmlToText, sanitizeEmailHtml } from "./sanitize";

describe("sanitizeEmailHtml", () => {
  it("removes scripts, handlers, frames and forms", () => {
    const html = sanitizeEmailHtml(
      `<p onclick="steal()">Hello</p><script>alert(1)</script><iframe src="https://evil.example"></iframe><form action="https://evil.example"><input name="x"></form>`,
    );
    expect(html).toBe("<p>Hello</p>");
  });

  it("drops remote image sources but keeps inline images", () => {
    expect(sanitizeEmailHtml(`<img src="https://tracker.example/p.gif" alt="t">`)).toBe('<img alt="t" />');
    expect(sanitizeEmailHtml(`<img src="data:image/png;base64,AAAA">`)).toBe('<img src="data:image/png;base64,AAAA" />');
  });

  it("keeps safe links and opens them in a new context", () => {
    expect(sanitizeEmailHtml(`<a href="https://example.com/x">x</a>`)).toBe(
      '<a href="https://example.com/x" rel="noopener noreferrer nofollow" target="_blank">x</a>',
    );
    expect(sanitizeEmailHtml(`<a href="javascript:alert(1)">x</a>`)).toBe(
      '<a rel="noopener noreferrer nofollow" target="_blank">x</a>',
    );
  });

  it("keeps inline styles and table layout", () => {
    expect(sanitizeEmailHtml(`<table width="100%"><tr><td style="color:red">a</td></tr></table>`)).toBe(
      '<table width="100%"><tr><td style="color:red">a</td></tr></table>',
    );
  });
});

describe("htmlToText", () => {
  it("keeps line breaks and decodes entities", () => {
    expect(htmlToText("<p>Hi&nbsp;Jane,</p><p>Fish &amp; chips<br>at 8&#58;00</p><script>x()</script>")).toBe("Hi Jane,\nFish & chips\nat 8:00");
  });

  it("decodes named, decimal and hex entities and leaves unknown ones", () => {
    expect(decodeEntities("&lt;a&gt; &quot;b&quot; &#39;c&#39; &#x263A; &bogus;")).toBe(`<a> "b" 'c' ☺ &bogus;`);
  });
});

describe("emailHtmlDocument", () => {
  it("wraps the body in a document that blocks every remote resource", () => {
    const document = emailHtmlDocument("<p>Hi</p>");
    expect(document).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:"`);
    expect(document).toContain("<body><p>Hi</p></body>");
  });
});
