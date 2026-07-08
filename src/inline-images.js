/**
 * Inline-image hosting for Push-to-Apollo (2026-07-08, Nick: "logos must
 * carry over").
 *
 * Problem: signature logos in Outlook bodies are usually cid: references to
 * attachments embedded INSIDE the email. Pushed to Apollo they render as
 * broken icons, so the formatter strips them — and the signature loses its
 * logo.
 *
 * This module runs BEFORE the formatter: it pulls each inline attachment's
 * bytes out of the draft via Office.js, uploads them to our image-host
 * worker (apollo-addin-images.jyurk.workers.dev — content-addressed,
 * Apollo-key-gated), and rewrites the <img> src to the public URL. The
 * formatter then sees ordinary https images and keeps them.
 *
 * Fail-soft by design: any error on any image leaves that img as cid: (the
 * formatter strips it, same as before this feature). The push NEVER fails
 * because of an image.
 *
 * Requires Mailbox 1.8 (getAttachmentContentAsync); silently skips on older
 * hosts.
 */

(function (global) {
  "use strict";

  console.log("[inline-images] inline-images.js v=20260708e loaded");

  const IMG_HOST = "https://apollo-addin-images.jyurk.workers.dev";

  // Content types the host accepts (mirror of the worker's allowlist).
  const EXT_CONTENT_TYPES = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
  };

  function contentTypeForName(name) {
    const ext = (String(name || "").split(".").pop() || "").toLowerCase();
    return EXT_CONTENT_TYPES[ext] || null;
  }

  /**
   * Match a cid reference to an attachment. Outlook cids usually embed the
   * attachment filename: "image001.png@01DC1234.5678" → name "image001.png".
   * Fallbacks: substring match, then — if exactly one unmatched cid and one
   * unused inline attachment remain — pair them (OWA sometimes uses opaque
   * GUID cids that share nothing with the name).
   */
  function matchAttachment(cid, attachments, usedIds) {
    const bare = cid.replace(/^cid:/i, "");
    const namePart = (bare.split("@")[0] || "").toLowerCase();
    const unused = attachments.filter((a) => !usedIds.has(a.id));
    let hit = unused.find((a) => (a.name || "").toLowerCase() === namePart);
    if (!hit && namePart) {
      hit = unused.find((a) => {
        const n = (a.name || "").toLowerCase();
        return n && (namePart.indexOf(n) !== -1 || n.indexOf(namePart) !== -1);
      });
    }
    if (!hit && unused.length === 1) hit = unused[0];
    return hit || null;
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function getAttachments(item) {
    return new Promise((resolve, reject) => {
      item.getAttachmentsAsync((r) =>
        r.status === Office.AsyncResultStatus.Succeeded ? resolve(r.value || []) : reject(r.error)
      );
    });
  }

  function getAttachmentContent(item, id) {
    return new Promise((resolve, reject) => {
      item.getAttachmentContentAsync(id, (r) =>
        r.status === Office.AsyncResultStatus.Succeeded ? resolve(r.value) : reject(r.error)
      );
    });
  }

  async function uploadImage(bytes, contentType, apiKey) {
    const res = await fetch(`${IMG_HOST}/img`, {
      method: "POST",
      headers: { "Content-Type": contentType, "X-Api-Key": apiKey },
      body: bytes,
    });
    if (!res.ok) throw new Error(`image host rejected upload: ${res.status}`);
    const data = await res.json();
    if (!data || !data.url) throw new Error("image host returned no url");
    return data.url;
  }

  /**
   * Rewrite cid: images in bodyHtml to hosted https URLs.
   *
   * @param {string} bodyHtml   the compose body HTML
   * @param {string} apiKey     the user's Apollo API key (upload gate)
   * @param {object} item       Office.context.mailbox.item
   * @param {function} [uploadFn] test override for uploadImage
   * @returns {Promise<string>} rewritten HTML (or the original on any failure)
   */
  async function hostInlineImages(bodyHtml, apiKey, item, uploadFn) {
    const upload = uploadFn || ((bytes, ct) => uploadImage(bytes, ct, apiKey));

    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><head></head><body>${bodyHtml}</body></html>`,
      "text/html"
    );
    const cidImgs = Array.from(doc.querySelectorAll("img")).filter((el) =>
      /^cid:/i.test((el.getAttribute("src") || "").trim())
    );
    if (cidImgs.length === 0) return bodyHtml;

    if (
      !uploadFn &&
      !(Office.context.requirements && Office.context.requirements.isSetSupported("Mailbox", "1.8"))
    ) {
      console.warn("[inline-images] Mailbox 1.8 not supported — skipping image hosting");
      return bodyHtml;
    }

    let attachments;
    try {
      attachments = (await getAttachments(item)).filter(
        (a) => a.attachmentType === "file" || a.isInline
      );
    } catch (e) {
      console.warn("[inline-images] getAttachmentsAsync failed — skipping:", e);
      return bodyHtml;
    }

    // Unique cids, preserving order.
    const cids = [];
    cidImgs.forEach((el) => {
      const src = el.getAttribute("src").trim();
      if (cids.indexOf(src) === -1) cids.push(src);
    });

    const usedIds = new Set();
    const cidToUrl = {};
    let hosted = 0;
    for (const cid of cids) {
      try {
        const att = matchAttachment(cid, attachments, usedIds);
        if (!att) {
          console.warn(`[inline-images] no attachment match for ${cid} — leaving as cid`);
          continue;
        }
        usedIds.add(att.id);
        const ct = contentTypeForName(att.name);
        if (!ct) {
          console.warn(`[inline-images] unsupported image type for "${att.name}" — leaving as cid`);
          continue;
        }
        const content = await getAttachmentContent(item, att.id);
        const b64Format =
          typeof Office !== "undefined" && Office.MailboxEnums
            ? Office.MailboxEnums.AttachmentContentFormat.Base64
            : "base64";
        if (!content || content.format !== b64Format) {
          console.warn(`[inline-images] non-base64 content for "${att.name}" — leaving as cid`);
          continue;
        }
        cidToUrl[cid] = await upload(base64ToBytes(content.content), ct);
        hosted++;
        console.log(`[inline-images] hosted "${att.name}" (${cid}) → ${cidToUrl[cid]}`);
      } catch (e) {
        console.warn(`[inline-images] failed for ${cid} — leaving as cid:`, e);
      }
    }

    if (hosted === 0) return bodyHtml;
    cidImgs.forEach((el) => {
      const url = cidToUrl[el.getAttribute("src").trim()];
      if (url) el.setAttribute("src", url);
    });
    console.log(`[inline-images] rewrote ${hosted} of ${cids.length} inline image(s) to hosted URLs`);
    return doc.body.innerHTML;
  }

  global.InlineImageHoster = { hostInlineImages, _test: { matchAttachment, base64ToBytes, contentTypeForName } };
})(window);
