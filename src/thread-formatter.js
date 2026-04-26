/**
 * HTML thread formatter — turns the Outlook compose body into Apollo-ready HTML.
 *
 * Outlook's compose body already includes the user's typed reply at the top
 * and the auto-quoted thread below. Our job here is mostly to:
 *   1. Strip inline images (per project decision: cleaner than broken images)
 *   2. Normalize Outlook-specific styles that Apollo's editor may mangle
 *   3. Wrap in a stable font/size declaration matching the reference format
 *
 * Tested approach: for MVP, minimal transformation. Outlook's HTML pastes well
 * into Apollo as-is. Iterate later if specific issues surface.
 */

(function (global) {
  "use strict";

  /** Strip <img>, <video>, <object>, <embed>, and any base64 image data URIs. */
  function stripImages(html) {
    if (!html) return "";
    return html
      .replace(/<img\b[^>]*>/gi, "")
      .replace(/<video\b[\s\S]*?<\/video>/gi, "")
      .replace(/<object\b[\s\S]*?<\/object>/gi, "")
      .replace(/<embed\b[^>]*>/gi, "");
  }

  /** Strip <script>, <style>, and Outlook MSO conditional comments. */
  function stripDangerous(html) {
    if (!html) return "";
    return html
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "")
      .replace(/<o:p\b[^>]*>[\s\S]*?<\/o:p>/gi, "")
      .replace(/<\/?o:p\b[^>]*>/gi, "");
  }

  /**
   * Strip Microsoft/Outlook "Word"/"VML" attributes and Outlook-specific clutter
   * that Apollo's editor doesn't like. Handles x_, x_x_, x_x_x_ prefixes Outlook
   * adds when nesting quoted messages. Also drops `class="elementToProof"` and
   * `class="WordSection1"` style classes.
   */
  function cleanMsAttributes(html) {
    return html
      // class="x_*Mso*", class="MsoNormal", class="x_x_xxmsonormal", etc.
      .replace(/\sclass="?(x_)*(xx)?Mso[A-Za-z0-9]*"?/gi, "")
      .replace(/\sclass="?(x_)*(xx)?msonormal"?/gi, "")
      .replace(/\sclass="?(x_)*(xx)?wordsection\d*"?/gi, "")
      .replace(/\sclass="?(x_)*elementToProof"?/gi, "")
      .replace(/\sclass="?(x_)*Signature"?/gi, "")
      // Strip mso-* inline style declarations e.g. mso-fareast-font-family:...;
      .replace(/\smso-[a-z-]+\s*:\s*[^;"']+;?/gi, "")
      // VML / Office namespace tags
      .replace(/\sxmlns:[a-z]+="[^"]*"/gi, "")
      .replace(/<\/?(v|w|m|st1|o):[a-z]+\b[^>]*>/gi, "");
  }

  /**
   * Strip Outlook's "EXTERNAL" orange banner that Outlook ATP/Defender injects
   * into emails coming from outside the org. Variants: "EXTERNAL", "[EXTERNAL]",
   * sometimes wrapped in a span with white text on orange background.
   */
  function stripExternalBanners(html) {
    return html
      // Span with the orange ATP styling, e.g. <span style="...background:#FF6600">EXTERNAL</span>
      .replace(/<span\b[^>]*background\s*:\s*#FF6600[^>]*>[\s\S]*?<\/span>/gi, "")
      .replace(/<span\b[^>]*background\s*:\s*#ff6600[^>]*>[\s\S]*?<\/span>/gi, "")
      // Plain "EXTERNAL" or "[EXTERNAL]" stand-alone banner paragraphs
      .replace(/<p[^>]*>\s*\[?\s*EXTERNAL\s*\]?\s*<\/p>/gi, "")
      .replace(/<div[^>]*>\s*\[?\s*EXTERNAL\s*\]?\s*<\/div>/gi, "");
  }

  /**
   * Microsoft wraps every link in `nam11.safelinks.protection.outlook.com/?url=...`.
   * Unwrap so the rendered email shows the real destination URL.
   */
  function unwrapSafelinks(html) {
    return html.replace(
      /href="https?:\/\/[a-z0-9-]+\.safelinks\.protection\.outlook\.com\/\?url=([^&"]+)[^"]*"/gi,
      (_match, encoded) => {
        try {
          return `href="${decodeURIComponent(encoded)}"`;
        } catch (_) {
          return _match;
        }
      }
    );
  }

  /**
   * Main: format the Outlook draft body for Apollo's manual email step.
   * @param {string} bodyHtml - The HTML body from Office.context.mailbox.item.body.getAsync()
   * @param {object} opts
   * @param {boolean} opts.stripImages - default true
   * @returns {string} Apollo-ready HTML
   */
  function format(bodyHtml, opts) {
    opts = opts || {};
    const doStrip = opts.stripImages !== false;

    let html = String(bodyHtml || "");
    html = stripDangerous(html);
    if (doStrip) html = stripImages(html);
    html = stripExternalBanners(html);
    html = unwrapSafelinks(html);
    html = cleanMsAttributes(html);

    // Trim leading/trailing whitespace-only nodes.
    html = html.trim();

    // Wrap in a default font block if not already wrapped at the top level.
    const wrapper =
      '<div style="font-family: Calibri, Arial, Helvetica, sans-serif; font-size: 12pt; color: rgb(0, 0, 0);">' +
      html +
      "</div>";

    return wrapper;
  }

  global.ThreadFormatter = { format };
})(window);
