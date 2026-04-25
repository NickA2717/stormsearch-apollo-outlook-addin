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

  /** Remove Microsoft "Word"/"VML" attributes that Apollo's editor doesn't like. */
  function cleanMsAttributes(html) {
    return html
      .replace(/\sclass="?Mso[A-Za-z0-9]*"?/gi, "")
      .replace(/\sxmlns:[a-z]+="[^"]*"/gi, "")
      .replace(/<\/?(v|w|m|st1|o):[a-z]+\b[^>]*>/gi, "");
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
