/**
 * Thread formatter — produces Apollo-ready HTML from the Outlook compose body.
 *
 * Goal: the email pushed into Apollo should look as close as possible to what
 * the recipient would see if Nick had hit Send in Outlook directly.
 *
 * Approach: minimal cleanup using browser DOMParser. We trust Outlook's HTML
 * because it is authentic by definition — the recipient receives Outlook HTML
 * every day. We only strip things that are genuinely not part of the
 * conversation (security wrappers, ATP banners) or that the user explicitly
 * asked us to remove (inline images that render as broken placeholders).
 *
 * Specifically we KEEP:
 *   - Empty <p>/<div> blocks → these are the user's intended blank lines
 *   - safelinks.protection.outlook.com URL wrapping → authentic Outlook tell
 *   - "Mso*" / "WordSection*" / "elementToProof" CSS classes → invisible to recipient
 *   - mso-* inline style declarations → ignored by non-Outlook clients anyway
 *   - Mixed fonts across nested quoted messages → that's how multi-sender threads look
 *
 * We strip:
 *   - <script>, <style>, MSO conditional comments → security / non-rendering
 *   - <img>, <video>, <object>, <embed> → user preference (broken placeholders)
 *   - "EXTERNAL" orange banner spans (Defender ATP injection) → not part of conversation
 *   - Office namespace elements like <o:p> → don't render in non-Outlook clients
 *
 * Then we wrap the result in Nick's preferred Storm Search default font block:
 *   font-family: Calibri, Tahoma, sans-serif; font-size: 12pt;
 *
 * (Nested children retain their own explicit fonts, so quoted messages still
 * render in their original fonts.)
 */

(function (global) {
  "use strict";

  const STORM_FONT_STYLE =
    "font-family: Calibri, Tahoma, sans-serif; font-size: 12pt; color: rgb(0, 0, 0);";

  /**
   * Heuristic: is this element an Outlook ATP "EXTERNAL" warning banner?
   * Microsoft Defender for Office 365 injects spans / paragraphs with an
   * orange background color (#FF6600 family) and the text "EXTERNAL" or
   * "[EXTERNAL]" before the body of any incoming external email.
   */
  function isExternalAtpBanner(el) {
    if (!el) return false;
    const text = (el.textContent || "").trim();
    if (!/^\[?\s*EXTERNAL\s*\]?$/i.test(text)) return false;
    const style = (el.getAttribute && el.getAttribute("style")) || "";
    if (/background\s*:\s*#FF6600/i.test(style)) return true;
    // Sometimes the orange is in a child span; accept the shorter trim+text match
    // alone if the element is small (no other content beyond "EXTERNAL").
    return el.children.length === 0 || el.children.length === 1;
  }

  /**
   * Walk the DOM tree and remove ATP banners, scripts, styles, images, and
   * Office namespace elements. Returns nothing — modifies tree in place.
   */
  function cleanupDom(root, opts) {
    const stripImages = opts.stripImages !== false;

    // Pass 1: remove security/non-rendering elements globally.
    root.querySelectorAll("script, style, noscript").forEach((el) => el.remove());

    // Pass 2: images and embedded media (per project decision).
    if (stripImages) {
      root.querySelectorAll("img, video, object, embed").forEach((el) => el.remove());
    }

    // Pass 3: Office namespace elements that don't render outside Outlook
    // (<o:p>, <v:imagedata>, etc.). Match by tag name prefix.
    Array.from(root.getElementsByTagName("*")).forEach((el) => {
      const tag = el.tagName.toLowerCase();
      // namespaced tags look like "o:p" — DOM lowercases them
      if (
        tag.startsWith("o:") ||
        tag.startsWith("v:") ||
        tag.startsWith("w:") ||
        tag.startsWith("m:") ||
        tag.startsWith("st1:")
      ) {
        // Replace the element with its text content so we don't lose data,
        // but drop the unsupported wrapper tag. For <o:p> these are usually
        // empty anyway.
        const text = el.textContent;
        if (text && text.trim()) {
          el.replaceWith(document.createTextNode(text));
        } else {
          el.remove();
        }
      }
    });

    // Pass 4: ATP "EXTERNAL" banners.
    root.querySelectorAll("span, p, div").forEach((el) => {
      if (isExternalAtpBanner(el)) {
        el.remove();
      }
    });

    // Pass 5: convert every <p> to <div>. This is the BIG visual fix.
    //
    // Outlook authors quoted threads using `<p class="MsoNormal">` and expects
    // its own stylesheet (margin: 0 on MsoNormal) to render them tight. In
    // Apollo's editor — and in any HTML renderer that doesn't ship Outlook's
    // CSS — `<p>` tags pick up the browser default ~16px top + bottom margin.
    // Empty `<p>&nbsp;</p>` separators (Outlook's blank lines) then compound,
    // producing huge visible gaps that don't appear in actual Outlook.
    //
    // `<div>` has no default vertical margin in any browser, so swapping every
    // `<p>` for an equivalent `<div>` reproduces the tight spacing Outlook
    // shows natively. All attributes (id, class, style) and children migrate
    // unchanged so inline styling, signatures, fonts etc. stay authentic.
    //
    // This also aligns with Nick's preferred Storm Search outbound HTML style,
    // which is exclusively `<div>`-based.
    const ownerDoc = root.ownerDocument;
    root.querySelectorAll("p").forEach((p) => {
      const div = ownerDoc.createElement("div");
      for (let i = 0; i < p.attributes.length; i++) {
        const attr = p.attributes[i];
        div.setAttribute(attr.name, attr.value);
      }
      while (p.firstChild) {
        div.appendChild(p.firstChild);
      }
      p.parentNode.replaceChild(div, p);
    });
  }

  /**
   * Strip MSO conditional comments before/after parsing — DOMParser treats
   * comments differently and removeChild on comment nodes is awkward, so we
   * pre-strip via regex on the raw HTML string.
   */
  function preStripMsoConditionals(html) {
    return String(html || "").replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "");
  }

  /**
   * Main entry: take the Outlook compose body HTML, return Apollo-ready HTML.
   *
   * @param {string} bodyHtml - HTML from Office.context.mailbox.item.body.getAsync()
   * @param {object} opts
   * @param {boolean} opts.stripImages - default true; drop <img> tags
   * @returns {string} Apollo-ready HTML wrapped in Storm Search default font block
   */
  function format(bodyHtml, opts) {
    opts = opts || {};

    // 1. Pre-strip MSO conditional comments (in HTML comments — easier with regex).
    let html = preStripMsoConditionals(bodyHtml);

    // 2. Parse via the browser's native DOMParser. This produces a real DOM tree
    //    we can walk reliably, regardless of how nested or malformed the source.
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head></head><body>${html}</body></html>`,
      "text/html"
    );

    // 3. Apply cleanup passes in place.
    cleanupDom(doc.body, opts);

    // 4. Serialize back. innerHTML preserves the cleaned tree.
    const cleanedInner = doc.body.innerHTML.trim();

    // 5. Wrap in Nick's Storm Search default font block. Nested children that
    //    explicitly set their own font (Outlook quoted messages, sender
    //    signatures) will still render in those fonts because inline styles
    //    win over the wrapper.
    return `<div style="${STORM_FONT_STYLE}">${cleanedInner}</div>`;
  }

  global.ThreadFormatter = { format };
})(window);
