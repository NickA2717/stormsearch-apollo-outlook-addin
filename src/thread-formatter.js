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
 *   - non-renderable images (cid:/attachment-service) + <video>/<object>/<embed>;
 *     hosted http(s) and data: images are KEPT (signature logos, Nick 2026-07-08)
 *   - security banners: "EXTERNAL (EMAIL)", "CAUTION: …outside the organization…",
 *     "You don't often get email from…" → not part of conversation
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

  // Version stamp — confirm in console which formatter the iframe loaded.
  console.log("[formatter] thread-formatter.js v=20260708d loaded");

  const STORM_FONT_STYLE =
    "font-family: Calibri, Tahoma, sans-serif; font-size: 12pt; color: rgb(0, 0, 0);";

  /**
   * Walk the DOM tree and remove ATP banners, scripts, styles, images, and
   * Office namespace elements. Returns nothing — modifies tree in place.
   */
  function cleanupDom(root, opts) {
    const stripImages = opts.stripImages !== false;

    // Pass 1: remove security/non-rendering elements globally.
    root.querySelectorAll("script, style, noscript").forEach((el) => el.remove());

    // Pass 2: images and embedded media.
    // (2026-07-08, Nick) Signature logos must survive — but ONLY images that can
    // actually render for the recipient. Outlook inline attachments (cid:) and
    // Outlook's authenticated attachment-service URLs render as broken icons
    // outside the mailbox, so those still get stripped; publicly hosted
    // http(s) images and inline data: images are kept.
    if (stripImages) {
      root.querySelectorAll("video, object, embed").forEach((el) => el.remove());
      // Keep ONLY images we can vouch for (tightened per Codex finding 13 —
      // arbitrary remote images include other senders' tracking pixels, which
      // would fire false opens and leak recipient info when Apollo sends):
      //   - our own image host (signature logos rewritten by inline-images.js)
      //   - inline data: images (self-contained, no callback)
      let imgKept = 0, imgStripped = 0;
      root.querySelectorAll("img").forEach((el) => {
        const src = (el.getAttribute("src") || "").trim();
        const renderable =
          /^data:image\//i.test(src) ||
          /^https:\/\/apollo-addin-images\.jyurk\.workers\.dev\/img\//i.test(src);
        if (renderable) { imgKept++; } else { el.remove(); imgStripped++; }
      });
      console.log(`[formatter] images: kept ${imgKept} trusted, stripped ${imgStripped}`);

      // Strip image-only wrappers left behind. Outlook signatures often have
      // `<p class="MsoNormal"><span><img src="..."></span></p>` blocks. After
      // removing the <img>, the wrapper paragraph and span are still here
      // taking ~1 line of vertical space each. We remove paragraphs/divs that
      // have no real content left, BUT we preserve intentional blank lines:
      //   - `<p>&nbsp;</p>` → keep (NBSP is content)
      //   - `<p><br></p>` → keep (BR is a deliberate line break)
      //   - `<div><a name="anchor"></a></div>` → keep (named anchors are
      //     meaningful even when empty)
      //   - `<p><span></span></p>` after image strip → remove (no content)
      const isFunctionallyEmpty = (el) => {
        // "img" here protects the wrappers of images we KEPT in Pass 2.
        if (el.querySelector("br, hr, a[name], input, img")) return false;
        const text = el.textContent;
        if (text.length === 0) return true;
        // ASCII whitespace only counts as empty; NBSP (U+00A0) counts as content.
        return /^[\u0020\u0009\u000A\u000D]*$/.test(text);
      };
      let changed = true;
      let safety = 0;
      let totalRemoved = 0;
      while (changed && safety < 12) {
        changed = false;
        safety++;
        root.querySelectorAll("p, div").forEach((el) => {
          if (isFunctionallyEmpty(el)) {
            el.remove();
            changed = true;
            totalRemoved++;
          }
        });
      }
      console.log(`[formatter] empty-paragraph cleanup removed ${totalRemoved} element(s) over ${safety} pass(es)`);
    }

    // Pass 3: collapse runs of consecutive blank-line paragraphs to a single
    // one. A "blank line" is a <p>/<div> containing only whitespace + NBSPs
    // (or a <br>) and no real content. These stack up where an image-spacer
    // pattern lost its image during stripping — vendor logo signatures wrap
    // the logo with NBSP paragraphs, and removing the image leaves the
    // spacers visible as dead vertical space. Singletons are kept
    // (intentional spacing); only runs of 2+ collapse.
    const isBlankLine = (el) => {
      if (el.querySelector("img, video, object, embed, hr, a[name], input, table")) return false;
      return /^\s*$/.test(el.textContent);
    };
    let collapsedCount = 0;
    root.querySelectorAll("p, div").forEach((el) => {
      if (!isBlankLine(el)) return;
      let prev = el.previousSibling;
      while (prev && prev.nodeType === 3 && /^\s*$/.test(prev.textContent)) {
        prev = prev.previousSibling;
      }
      if (
        prev &&
        prev.nodeType === 1 &&
        (prev.tagName === "P" || prev.tagName === "DIV") &&
        isBlankLine(prev)
      ) {
        el.remove();
        collapsedCount++;
      }
    });
    console.log(`[formatter] collapsed ${collapsedCount} consecutive blank-line element(s)`);

    // Pass 4: Office namespace elements that don't render outside Outlook
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

    // Pass 5: security banners injected by mail defense — not part of the
    // conversation (Nick, 2026-07-08: strip ALL the yellow warning lines).
    // Three families, matched only when they are an element's ENTIRE text so a
    // legit sentence that merely mentions these words is never touched:
    //   1. "EXTERNAL" / "[EXTERNAL]" / "EXTERNAL EMAIL" (Defender ATP)
    //   2. "CAUTION: This email originated from outside the organization…"
    //      (gateway-appended, often stacked several deep at the thread bottom)
    //   3. "You don't often get email from x. Learn why this is important"
    //      (Outlook first-contact safety tip)
    // Tightened per Codex finding 14: each pattern must carry the banner's
    // distinctive phrase, not just its opening word, so a real sentence that
    // happens to start the same way survives.
    const BANNER_PATTERNS = [
      /^\[?\s*EXTERNAL(\s+EMAIL)?\s*\]?[.!]?$/i,
      /^CAUTION[:\s][\s\S]{0,80}originated from outside (of )?the organization[\s\S]{0,400}$/i,
      /^You don['’]t often get email from[\s\S]{0,120}Learn why this is important\.?$/i,
    ];
    const isSecurityBanner = (el) => {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 600) return false;
      return BANNER_PATTERNS.some((re) => re.test(text));
    };
    let bannersRemoved = 0;
    root.querySelectorAll("table, p, div, span").forEach((el) => {
      if (!el.isConnected || !isSecurityBanner(el)) return;
      // Climb to the outermost wrapper whose entire text is still just the
      // banner (banners usually sit in a table/div shell with bg color).
      let target = el;
      while (
        target.parentElement &&
        target.parentElement !== root &&
        isSecurityBanner(target.parentElement)
      ) {
        target = target.parentElement;
      }
      target.remove();
      bannersRemoved++;
    });
    console.log(`[formatter] removed ${bannersRemoved} security banner(s)`);

    // Pass 6: force inline `margin: 0` on every <p> and <div>. THIS is the
    // visual fix that actually works.
    //
    // Why: Outlook authors quoted threads with `<p class="MsoNormal">` and
    // assumes Outlook's stylesheet sets margin:0 on MsoNormal. Apollo's
    // editor (TinyMCE-based) doesn't ship that CSS, so `<p>` picks up the
    // browser default ~16px top+bottom margin. Empty `<p>&nbsp;</p>` spacers
    // then compound, producing huge gaps.
    //
    // We tried converting `<p>` → `<div>` but Apollo's editor has
    // `forced_root_block: 'p'` and converts our divs BACK to paragraphs on
    // load, undoing the fix. Inline styles, however, survive the editor
    // round-trip cleanly.
    //
    // We only add `margin: 0` if the element doesn't already declare a
    // margin (or margin-top/bottom etc.) — explicit margins in the source
    // (e.g., the From-block's `margin-bottom: 12pt`) stay intact.
    root.querySelectorAll("p, div").forEach((el) => {
      const existing = (el.getAttribute("style") || "").trim();
      // Skip if any margin declaration is already in the style.
      if (/(?:^|;)\s*margin(?:-(?:top|bottom|left|right))?\s*:/i.test(existing)) {
        return;
      }
      const prefix = existing && !existing.endsWith(";") ? existing + ";" : existing;
      el.setAttribute("style", "margin: 0;" + (prefix ? " " + prefix : ""));
    });

    // Pass 7: normalize font-family + collapse main-body font-sizes.
    //
    // (a) Strip every `font-family` declaration from descendant inline styles
    // so the outer Storm Search wrapper's `font-family: Calibri, Tahoma,
    // sans-serif` cascades through inheritance. Also strip the legacy `face`
    // attribute from any `<font>` tags.
    //
    // (b) For each `font-size: Npt` in the 10pt–12pt range, normalize to
    // 12pt. Sizes <10pt (8pt confidentiality notices, 9pt centered DXP-style
    // banners) are PRESERVED so fine print stays fine print. Sizes >12pt
    // are also preserved (probable headlines).
    //
    // Why this range: Outlook senders default to 11pt or 12pt, and quote
    // blocks often slip in 10pt. Without (b), the typed reply renders at
    // 12pt while quoted bodies render at 11pt — cosmetically inconsistent
    // even though authentic. With (b), main-body text unifies at 12pt
    // across reply + quoted thread, but the deliberate hierarchy markers
    // (small fine print) stay visually distinct.
    //
    // Confirmed by Nick on real DXP/Premier-flow thread previews — earlier
    // attempts at "everything to 12pt" blew up 8pt/9pt fine print and
    // looked horrendous, hence the bounded range.
    //
    // Rollback: change taskpane.html script src from `thread-formatter.js`
    // to `thread-formatter-v1.js` (frozen pre-Pass-7 snapshot), bump the
    // cache-bust query letter, push.
    const FONT_SIZE_PT_RE = /^font-size\s*:\s*(\d+(?:\.\d+)?)\s*pt$/i;
    let fontFamilyStripped = 0;
    let fontSizeNormalized = 0;
    root.querySelectorAll("[style]").forEach((el) => {
      const style = el.getAttribute("style") || "";
      const declarations = style.split(";").map((s) => s.trim()).filter(Boolean);
      const transformed = declarations
        .filter((d) => {
          if (/^font-family\s*:/i.test(d)) {
            fontFamilyStripped++;
            return false;
          }
          return true;
        })
        .map((d) => {
          const m = d.match(FONT_SIZE_PT_RE);
          if (!m) return d;
          const pt = parseFloat(m[1]);
          if (pt >= 10 && pt <= 12 && pt !== 12) {
            fontSizeNormalized++;
            return "font-size: 12pt";
          }
          return d;
        });
      if (transformed.length === 0) {
        el.removeAttribute("style");
      } else {
        el.setAttribute("style", transformed.join("; ") + ";");
      }
    });
    let fontFaceCleaned = 0;
    root.querySelectorAll("font[face]").forEach((el) => {
      el.removeAttribute("face");
      fontFaceCleaned++;
    });
    console.log(
      `[formatter] font normalize: ${fontFamilyStripped} font-family stripped, ${fontSizeNormalized} font-sizes 10-12pt collapsed to 12pt, ${fontFaceCleaned} <font face> attr(s) cleaned`
    );

    // Pass 8: repair literal markdown links (2026-07-08, seen in production).
    // Outlook on the web's compose editor (same engine as new Outlook for Mac)
    // sometimes serializes links in the body as literal markdown —
    // "[www.example.com](https://www.example.com)" — either bare in a span or
    // as the display text INSIDE a real <a>. Recipients would see the brackets.
    //   - inside an <a>: keep the anchor, replace the markdown with its label
    //   - bare in text: rebuild a real <a href="url">label</a>
    const MD_LINK_RE = /\[([^\[\]]{1,300}?)\]\((https?:\/\/[^()\s]+)\)/g;
    let mdLinksFixed = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const mdNodes = [];
    while (walker.nextNode()) {
      if (MD_LINK_RE.test(walker.currentNode.nodeValue)) mdNodes.push(walker.currentNode);
      MD_LINK_RE.lastIndex = 0;
    }
    mdNodes.forEach((node) => {
      const insideAnchor = !!(node.parentElement && node.parentElement.closest("a"));
      if (insideAnchor) {
        node.nodeValue = node.nodeValue.replace(MD_LINK_RE, (_, label) => { mdLinksFixed++; return label; });
        return;
      }
      const frag = document.createDocumentFragment();
      let last = 0;
      const text = node.nodeValue;
      let m;
      MD_LINK_RE.lastIndex = 0;
      while ((m = MD_LINK_RE.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const a = document.createElement("a");
        a.setAttribute("href", m[2]);
        a.textContent = m[1];
        frag.appendChild(a);
        last = m.index + m[0].length;
        mdLinksFixed++;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    });
    console.log(`[formatter] repaired ${mdLinksFixed} literal markdown link(s)`);
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
