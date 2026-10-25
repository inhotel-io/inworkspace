import sanitizeHtml from "sanitize-html";

const LAYOUT_ATTRIBUTES = [
  "style", "align", "valign", "width", "height", "bgcolor", "color", "dir", "lang",
  "colspan", "rowspan", "border", "cellpadding", "cellspacing",
];

const EMAIL_HTML: sanitizeHtml.IOptions = {
  allowedTags: [...sanitizeHtml.defaults.allowedTags, "img", "font", "center"],
  allowedAttributes: {
    "*": LAYOUT_ATTRIBUTES,
    a: ["href", "title", "rel", "target"],
    img: ["src", "alt", "width", "height"],
    font: ["face", "size", "color"],
  },
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["data"] },
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer nofollow", target: "_blank" }),
  },
};

/** Safe markup for display: no scripts, handlers, forms or frames, and no remote images. */
export function sanitizeEmailHtml(html: string): string {
  return sanitizeHtml(html, EMAIL_HTML);
}

const BLOCK_END = /<\/(?:p|div|tr|li|h[1-6]|blockquote|table)>|<br\s*\/?>/gi;
const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const code = entity[1]?.toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Plain text for an HTML-only message. */
export function htmlToText(html: string): string {
  const stripped = sanitizeHtml(html.replace(BLOCK_END, (tag) => `${tag}\n`), { allowedTags: [], allowedAttributes: {} });
  return decodeEntities(stripped)
    .replace(/ /g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
