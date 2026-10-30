import { parseHTML } from "linkedom";
import { config } from "./config.js";

/** Keep stored previews portable; scope only local asset URLs at the API boundary. */
export function publicPreview(html: string, basePath = config.basePath) {
  if (!basePath) return html;
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const img of document.querySelectorAll("img[src]")) {
    const src = img.getAttribute("src")!;
    if (/^\/api\/v1\/assets\/[a-f\d-]+(?:\?.*)?$/i.test(src))
      img.setAttribute("src", `${basePath}${src}`);
  }
  return document.body.innerHTML;
}
