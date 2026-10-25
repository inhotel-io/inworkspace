/** A document for `<iframe sandbox srcdoc>`: its own policy blocks every remote resource. */
export function emailHtmlDocument(sanitizedHtml: string): string {
  return [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:\">",
    "<style>body{font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;color:#292929;margin:12px;overflow-wrap:anywhere}</style>",
    `</head><body>${sanitizedHtml}</body></html>`,
  ].join("");
}
