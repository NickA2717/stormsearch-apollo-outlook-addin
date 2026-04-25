/**
 * Main task pane controller for the Push-to-Apollo Outlook add-in.
 *
 * Flow on open:
 *   1. Office.onReady() fires when Outlook has loaded the pane.
 *   2. Read API key from Office.context.roamingSettings.
 *      - If missing: show Settings panel, wait for user to save key.
 *      - If present: hide Settings, show Main.
 *   3. Read current Outlook draft (recipient, subject, body HTML).
 *   4. In parallel: load Apollo sequences, mailboxes, and contact-by-email.
 *   5. Populate dropdowns and contact card.
 *   6. Wait for "Push to Apollo" click → execute push.
 *
 * Push action:
 *   1. Format body HTML (strip images, clean MS-specific tags).
 *   2. Add contact to chosen sequence with chosen sender mailbox.
 *   3. Try API body push to step 1's queued manual email.
 *      - On success: notify, discard draft.
 *      - On failure: copy HTML to clipboard, instruct user to paste in Apollo, discard draft.
 */

(function () {
  "use strict";

  const SETTINGS_KEY = "apolloApiKey";
  let apollo = null;            // ApolloClient instance once we have a key
  let draftContext = null;       // {to, subject, bodyHtml}
  let selectedContact = null;    // The contact picked / matched
  let cachedMailboxes = [];
  let cachedSequences = [];

  /* ------------------------ DOM helpers ------------------------ */
  const $ = (id) => document.getElementById(id);
  const show = (el) => el && el.classList.remove("hidden");
  const hide = (el) => el && el.classList.add("hidden");

  function setStatus(area, text, level) {
    const el = typeof area === "string" ? $(area) : area;
    if (!el) return;
    el.innerHTML = "";
    if (text) {
      const div = document.createElement("div");
      div.className = "status " + (level || "info");
      div.textContent = text;
      el.appendChild(div);
    }
  }

  function clearStatus(area) {
    const el = typeof area === "string" ? $(area) : area;
    if (el) el.innerHTML = "";
  }

  /* ------------------------ Office init ------------------------ */
  Office.onReady((info) => {
    if (info.host !== Office.HostType.Outlook) {
      document.body.innerHTML = "<div class='status error'>This add-in only works inside Outlook.</div>";
      return;
    }
    init().catch((err) => {
      console.error("Init failed:", err);
      setStatus("status-area", "Init failed: " + err.message, "error");
    });
  });

  async function init() {
    wireSettingsHandlers();
    wireMainHandlers();

    const apiKey = Office.context.roamingSettings.get(SETTINGS_KEY);
    if (!apiKey) {
      showSettings();
      return;
    }
    apollo = new ApolloClient(apiKey);
    showMain();
    await loadEverything();
  }

  /* ------------------------ Settings ------------------------ */
  function wireSettingsHandlers() {
    $("save-key-btn").addEventListener("click", saveKey);
    $("cancel-settings-btn").addEventListener("click", () => {
      // If we already have a key, just go back to main. Otherwise, do nothing.
      const existing = Office.context.roamingSettings.get(SETTINGS_KEY);
      if (existing) showMain();
    });
    $("open-settings-btn").addEventListener("click", showSettings);
  }

  function showSettings() {
    show($("settings-panel"));
    hide($("main-panel"));
    const existing = Office.context.roamingSettings.get(SETTINGS_KEY) || "";
    $("api-key-input").value = existing;
    $("api-key-input").focus();
  }

  function showMain() {
    hide($("settings-panel"));
    show($("main-panel"));
  }

  function saveKey() {
    const key = $("api-key-input").value.trim();
    if (!key) {
      alert("Paste your Apollo API key first.");
      return;
    }
    Office.context.roamingSettings.set(SETTINGS_KEY, key);
    Office.context.roamingSettings.saveAsync((res) => {
      if (res.status !== Office.AsyncResultStatus.Succeeded) {
        alert("Failed to save key: " + (res.error && res.error.message));
        return;
      }
      apollo = new ApolloClient(key);
      showMain();
      loadEverything().catch((err) => setStatus("status-area", "Load failed: " + err.message, "error"));
    });
  }

  /* ------------------------ Main panel ------------------------ */
  function wireMainHandlers() {
    $("push-btn").addEventListener("click", handlePush);
    $("create-contact-btn") && $("create-contact-btn").addEventListener("click", handleCreateContact);
  }

  async function loadEverything() {
    setStatus("status-area", "", null);
    clearStatus("result-area");

    // Step 1: read draft from Outlook (single shot — gets recipient, subject, body).
    try {
      draftContext = await readDraft();
    } catch (err) {
      setStatus("status-area", "Couldn't read draft: " + err.message, "error");
      return;
    }

    // Step 2: kick off three parallel API calls.
    const [seqRes, mbRes, contactRes] = await Promise.allSettled([
      apollo.listActiveSequences(),
      apollo.listMailboxes(),
      draftContext.recipientEmail
        ? apollo.searchContactByEmail(draftContext.recipientEmail)
        : Promise.resolve([]),
    ]);

    // Sequences
    if (seqRes.status === "fulfilled") {
      cachedSequences = seqRes.value;
      populateSequenceSelect(cachedSequences);
    } else {
      $("sequence-select").innerHTML = "<option>Failed to load sequences</option>";
      setStatus("status-area", "Sequences load failed: " + seqRes.reason.message, "error");
    }

    // Mailboxes
    if (mbRes.status === "fulfilled") {
      cachedMailboxes = mbRes.value;
      populateMailboxSelect(cachedMailboxes);
    } else {
      $("mailbox-select").innerHTML = "<option>Failed to load mailboxes</option>";
      setStatus("status-area", "Mailboxes load failed: " + mbRes.reason.message, "error");
    }

    // Contact
    if (contactRes.status === "fulfilled") {
      renderContactResult(contactRes.value);
    } else {
      hide($("contact-loading"));
      setStatus("status-area", "Contact lookup failed: " + contactRes.reason.message, "error");
    }

    updatePushButtonState();
  }

  /* ------------------------ Outlook draft reader ------------------------ */
  function readDraft() {
    return new Promise((resolve, reject) => {
      const item = Office.context.mailbox.item;
      if (!item) return reject(new Error("No mail item context"));

      const subjectP = new Promise((res, rej) =>
        item.subject.getAsync((r) => r.status === Office.AsyncResultStatus.Succeeded ? res(r.value) : rej(r.error))
      );
      const toP = new Promise((res, rej) =>
        item.to.getAsync((r) => r.status === Office.AsyncResultStatus.Succeeded ? res(r.value) : rej(r.error))
      );
      const bodyP = new Promise((res, rej) =>
        item.body.getAsync(Office.CoercionType.Html, (r) =>
          r.status === Office.AsyncResultStatus.Succeeded ? res(r.value) : rej(r.error)
        )
      );

      Promise.all([subjectP, toP, bodyP])
        .then(([subject, to, bodyHtml]) => {
          const recipientEmail = (to && to[0] && to[0].emailAddress) || "";
          const recipientName = (to && to[0] && to[0].displayName) || "";
          resolve({ subject, recipientEmail, recipientName, bodyHtml });
        })
        .catch(reject);
    });
  }

  /* ------------------------ Contact UI ------------------------ */
  function renderContactResult(matches) {
    hide($("contact-loading"));
    const target = $("contact-result");
    target.innerHTML = "";

    if (!matches || matches.length === 0) {
      hide(target);
      show($("contact-not-found"));
      selectedContact = null;
      return;
    }

    hide($("contact-not-found"));
    show(target);

    if (matches.length === 1) {
      selectedContact = matches[0];
      target.appendChild(contactCard(matches[0]));
      return;
    }

    // Multiple — build a dropdown.
    const label = document.createElement("label");
    label.textContent = `${matches.length} matches found — pick the right one:`;
    target.appendChild(label);

    const sel = document.createElement("select");
    matches.forEach((c, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${c.name} — ${c.title || "(no title)"} @ ${c.organization_name || "(no co.)"}`;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => {
      selectedContact = matches[parseInt(sel.value, 10)];
      preview.innerHTML = "";
      preview.appendChild(contactCard(selectedContact));
      updatePushButtonState();
    });
    target.appendChild(sel);

    const preview = document.createElement("div");
    preview.style.marginTop = "8px";
    target.appendChild(preview);

    selectedContact = matches[0];
    preview.appendChild(contactCard(selectedContact));
  }

  function contactCard(c) {
    const card = document.createElement("div");
    card.className = "contact-card";
    const lastAct = c.last_activity_date
      ? new Date(c.last_activity_date).toLocaleDateString()
      : "no recent activity";
    card.innerHTML = `
      <div class="name">${escapeHtml(c.name || "(no name)")}</div>
      <div class="meta">${escapeHtml(c.title || "(no title)")} @ ${escapeHtml(c.organization_name || "(no company)")}</div>
      <div class="meta">${escapeHtml(c.primary_email || "")} · last: ${lastAct}</div>
    `;
    return card;
  }

  async function handleCreateContact() {
    if (!draftContext) return;
    setStatus("status-area", "Creating contact in Apollo…", "info");
    try {
      const recipientName = draftContext.recipientName || "";
      const [first, ...rest] = recipientName.split(/\s+/);
      const last = rest.join(" ");
      const created = await apollo.createContact({
        email: draftContext.recipientEmail,
        first_name: first || "",
        last_name: last || "",
      });
      selectedContact = {
        id: created.id,
        name: created.name || recipientName || draftContext.recipientEmail,
        title: created.title || "",
        organization_name: created.organization_name || "",
        last_activity_date: null,
        primary_email: draftContext.recipientEmail,
      };
      hide($("contact-not-found"));
      show($("contact-result"));
      $("contact-result").innerHTML = "";
      $("contact-result").appendChild(contactCard(selectedContact));
      setStatus("status-area", "Contact created.", "success");
      updatePushButtonState();
    } catch (err) {
      setStatus("status-area", "Create failed: " + err.message, "error");
    }
  }

  /* ------------------------ Mailbox + Sequence dropdowns ------------------------ */
  function populateMailboxSelect(mailboxes) {
    const sel = $("mailbox-select");
    sel.innerHTML = "";
    if (!mailboxes.length) {
      sel.innerHTML = "<option>No mailboxes found</option>";
      return;
    }
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— Choose sender —";
    sel.appendChild(placeholder);

    mailboxes.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.email + (m.default ? "  (default)" : "");
      sel.appendChild(opt);
    });
    sel.addEventListener("change", updatePushButtonState);
  }

  function populateSequenceSelect(sequences) {
    const sel = $("sequence-select");
    sel.innerHTML = "";
    if (!sequences.length) {
      sel.innerHTML = "<option>No active sequences</option>";
      return;
    }
    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = "— Choose sequence —";
    sel.appendChild(placeholder);

    sequences.forEach((s) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = s.name;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", updatePushButtonState);
  }

  function updatePushButtonState() {
    const ready =
      apollo &&
      selectedContact &&
      $("mailbox-select").value &&
      $("sequence-select").value;
    $("push-btn").disabled = !ready;
  }

  /* ------------------------ Push ------------------------ */
  async function handlePush() {
    if (!apollo || !selectedContact || !draftContext) return;
    const sequenceId = $("sequence-select").value;
    const mailboxId = $("mailbox-select").value;
    if (!sequenceId || !mailboxId) return;

    $("push-btn").disabled = true;
    setStatus("result-area", "", null);
    setStatus("status-area", "Pushing to Apollo…", "info");

    // Format the body for Apollo.
    const apolloHtml = ThreadFormatter.format(draftContext.bodyHtml, { stripImages: true });

    try {
      // 1. Add contact to sequence.
      await apollo.addContactToSequence({
        sequenceId,
        contactId: selectedContact.id,
        mailboxId,
      });

      // 2. Try to push the body into step 1's manual email message via API.
      const pushResult = await apollo.tryUpdateManualMessageBody({
        contactId: selectedContact.id,
        sequenceId,
        htmlBody: apolloHtml,
        subject: draftContext.subject,
      });

      if (pushResult.success) {
        setStatus("status-area", "", null);
        setStatus("result-area",
          "✓ Pushed to Apollo. Step 1's body is pre-filled — go to Apollo and click Send.",
          "success");
      } else {
        // Fallback: clipboard.
        await copyToClipboard(apolloHtml);
        setStatus("status-area", "", null);
        setStatus("result-area",
          "⚠ Contact added to sequence. The reply HTML was copied to your clipboard — paste it into Apollo's manual email step, then click Send. (API body push not available.)",
          "warn");
      }

      // 3. Discard the Outlook draft.
      try {
        Office.context.mailbox.item.close({ discardItem: true });
      } catch (_) {
        // Older Outlook may not support discardItem option — fall back to plain close.
        try { Office.context.mailbox.item.close(); } catch (_) {}
      }
    } catch (err) {
      setStatus("status-area", "", null);
      setStatus("result-area", "Push failed: " + err.message, "error");
      $("push-btn").disabled = false;
    }
  }

  function copyToClipboard(text) {
    return new Promise((resolve) => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (_) {}
      document.body.removeChild(ta);
      resolve();
    });
  }

  /* ------------------------ Utilities ------------------------ */
  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
})();
