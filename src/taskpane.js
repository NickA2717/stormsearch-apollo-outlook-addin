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
  const BUILD = "20260722a";     // must match the ?v= stamp in taskpane.html
  let apollo = null;            // ApolloClient instance once we have a key
  let draftContext = null;       // {to, subject, bodyHtml}
  let selectedContact = null;    // The contact picked / matched
  let cachedMailboxes = [];
  let cachedSequences = [];
  let pushInFlight = false;

  // Closing the reply window mid-push kills the whole flow silently — the
  // contact ends up enrolled with an empty step 1 and no error ever shown.
  window.addEventListener("beforeunload", (e) => {
    if (pushInFlight) { e.preventDefault(); e.returnValue = "A push to Apollo is still running."; }
  });

  /* ------------------------ Push journal (localStorage) ------------------------
   * Every push is recorded before any Apollo write and updated at each stage.
   * Two jobs: (1) if a push is interrupted (window closed, network died), the
   * next pane open finishes it automatically; (2) a durable diagnostic trail. */
  const JOURNAL_KEY = "sapw_push_journal_v1";
  function journalAll() {
    try { return JSON.parse(localStorage.getItem(JOURNAL_KEY)) || []; } catch (_) { return []; }
  }
  function journalSave(list) {
    try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(list.slice(-12))); } catch (_) {}
  }
  function journalStart(entry) {
    entry.id = "j" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    entry.ts = Date.now();
    entry.stage = "started";
    const list = journalAll();
    list.push(entry);
    journalSave(list);
    return entry.id;
  }
  function journalUpdate(id, patch) {
    const list = journalAll();
    const e = list.find(x => x.id === id);
    if (e) { Object.assign(e, patch); journalSave(list); }
  }

  // Visible text length of an HTML string (tags, comments, nbsp stripped).
  function textLenOfHtml(html) {
    return String(html || "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim().length;
  }

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
    checkVersion();          // fire-and-forget: warns if this iframe cached old code
    await loadEverything();
    resumeUnfinishedPush();  // fire-and-forget: completes any interrupted push
  }

  /* Office iframes cache aggressively; an old reply window can run stale code
   * long after a fix shipped. Compare our BUILD stamp against what GitHub
   * Pages currently serves and warn loudly on mismatch. */
  async function checkVersion() {
    try {
      const res = await fetch("taskpane.html?nocache=" + Date.now(), { cache: "no-store" });
      const txt = await res.text();
      const m = txt.match(/taskpane\.js\?v=([0-9a-z]+)/);
      if (m && m[1] !== BUILD) {
        setStatus("version-area",
          `This window is running an OLD copy of the add-in (${BUILD}; latest is ${m[1]}). Close this reply window, open a fresh one, and push from there.`,
          "warn");
      }
    } catch (_) { /* offline check is best-effort */ }
  }

  /* If a previous push was interrupted after enrolling the contact but before
   * the body landed (window closed, network drop), finish it now: find the
   * still-drafted step-1 manual email and write the journaled body into it.
   * Never overwrites a draft that already has real content without our marker
   * — that would clobber something Nick typed in Apollo by hand. */
  async function resumeUnfinishedPush() {
    try {
      const list = journalAll();
      const now = Date.now();
      const pending = list.filter(e =>
        e.stage !== "done" && e.stage !== "failed" &&
        e.html && e.contactId && e.sequenceId &&
        now - e.ts > 45 * 1000 && now - e.ts < 48 * 3600 * 1000
      );
      if (!pending.length) return;
      const e = pending[pending.length - 1];
      // Anything older we can't safely finish — mark closed so it stops resurfacing.
      pending.slice(0, -1).forEach(p => journalUpdate(p.id, { stage: "failed", result: "superseded" }));

      setStatus("version-area", `An earlier push (${e.contactName || "contact"}) was interrupted — finishing it now…`, "info");
      const target = await apollo.findManualDraft({
        contactId: e.contactId, sequenceId: e.sequenceId, mode: "existing", maxWaitMs: 10000,
      });
      if (!target) {
        journalUpdate(e.id, { stage: "failed", result: "resume_no_draft" });
        setStatus("version-area", `Heads up: your push to ${e.contactName || "a contact"} at ${new Date(e.ts).toLocaleString()} never finished, and no editable step-1 draft exists for them anymore. Re-do that one push.`, "warn");
        return;
      }
      const existingBody = target.body_html || "";
      if (textLenOfHtml(existingBody) >= 40 && existingBody.indexOf("sapw-") === -1) {
        journalUpdate(e.id, { stage: "done", result: "already_filled_manually" });
        setStatus("version-area", `An earlier push (${e.contactName || "contact"}) was interrupted, but their Apollo step-1 draft already has content — it was left untouched. Double-check it before sending.`, "warn");
        return;
      }
      const res = await apollo.putBodyDurable({
        messageId: target.id, contactId: e.contactId, htmlBody: e.html, subject: e.subject,
      });
      journalUpdate(e.id, { stage: res.success ? "done" : "failed", result: res.success ? "resumed" : res.reason });
      setStatus("version-area",
        res.success
          ? `✓ Finished your interrupted push to ${e.contactName || "contact"} — their step-1 draft in Apollo is now filled and verified.`
          : `Could not finish the interrupted push to ${e.contactName || "contact"} (${res.reason}). Re-do that one push.`,
        res.success ? "success" : "warn");
    } catch (err) {
      console.warn("[resume] failed:", err);
    }
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
          const recipientCount = (to || []).length;
          resolve({ subject, recipientEmail, recipientName, recipientCount, bodyHtml });
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

    // Re-read recipient, subject, AND body together at click time (Codex
    // findings 5+6). The pane-load snapshot drove contact selection; if the
    // draft changed since — different recipient, extra recipients — pushing
    // would target the WRONG Apollo contact. Fresh read only: the old
    // "longer body wins" cached-fallback could push stale content and then
    // destroy newer typed edits with the draft discard.
    let fresh;
    try {
      fresh = await readDraft();
    } catch (e) {
      setStatus("status-area", "", null);
      setStatus("result-area", "Push failed: couldn't re-read the draft from Outlook. Nothing was sent; your draft is untouched.", "error");
      $("push-btn").disabled = false;
      return;
    }
    if (fresh.recipientCount !== 1) {
      setStatus("status-area", "", null);
      setStatus("result-area", `Push blocked: the draft has ${fresh.recipientCount || 0} recipients — an Apollo push targets exactly one contact. Fix the To line and try again.`, "error");
      $("push-btn").disabled = false;
      return;
    }
    if (
      (fresh.recipientEmail || "").toLowerCase() !==
      (draftContext.recipientEmail || "").toLowerCase()
    ) {
      setStatus("status-area", "", null);
      setStatus("result-area", "Push blocked: the recipient changed after this pane loaded, so the selected Apollo contact no longer matches. Close and reopen the pane to re-match.", "error");
      $("push-btn").disabled = false;
      return;
    }
    const bodyToUse = fresh.bodyHtml || "";
    draftContext = fresh;
    console.log(`[push] click-time re-read: recipients=1, body ${bodyToUse.length} chars`);

    if (!bodyToUse) {
      setStatus("status-area", "", null);
      setStatus("result-area", "Push failed: the draft body read back empty from Outlook. Nothing was sent; your draft is untouched.", "error");
      $("push-btn").disabled = false;
      return;
    }

    // Host inline (cid:) images BEFORE formatting so signature logos survive:
    // attachment bytes → image-host worker → https URLs the formatter keeps.
    // Fail-soft: on any error this returns the body unchanged and the push
    // proceeds exactly as before (cid images stripped).
    let bodyForFormat = bodyToUse;
    try {
      if (window.InlineImageHoster) {
        // Hard 25s ceiling on the whole image stage — a hung call must never
        // stall the push (fail-soft: images drop, push proceeds).
        bodyForFormat = await Promise.race([
          InlineImageHoster.hostInlineImages(
            bodyToUse,
            Office.context.roamingSettings.get(SETTINGS_KEY),
            Office.context.mailbox.item
          ),
          new Promise((res) => setTimeout(() => res(bodyToUse), 25000)),
        ]);
      }
    } catch (e) {
      console.warn("[push] inline-image hosting failed, continuing without:", e);
    }

    // Format the body for Apollo.
    const apolloHtml = ThreadFormatter.format(bodyForFormat, { stripImages: true });
    // Log lengths only, never content — browser logs have been committed by
    // accident before (Codex finding 16).
    console.log(`[push] formatted apolloHtml length: ${apolloHtml.length}`);

    // CONTENT FLOOR (2026-07-22): a push whose body carries no real text must
    // never proceed. Before this check, an Outlook body-read glitch or a
    // formatter over-strip could push a near-empty email; the verify only
    // matched the invisible marker, so the pane showed GREEN SUCCESS while
    // Apollo held nothing — exactly the "everything pushed except my email"
    // failure. Block it here, loudly, with the draft untouched.
    const rawTextLen = textLenOfHtml(bodyToUse);
    const formattedTextLen = textLenOfHtml(apolloHtml);
    console.log(`[push] text lengths: raw=${rawTextLen} formatted=${formattedTextLen}`);
    if (rawTextLen < 20) {
      setStatus("status-area", "", null);
      setStatus("result-area", "Push blocked: Outlook returned a nearly empty draft body. Nothing was sent; your draft is untouched. Click into the message text, then push again (or close this reply window and open a fresh one).", "error");
      $("push-btn").disabled = false;
      return;
    }
    if (formattedTextLen < 40 || formattedTextLen < rawTextLen * 0.3) {
      setStatus("status-area", "", null);
      setStatus("result-area", `Push blocked: formatting reduced the email from ${rawTextLen} to ${formattedTextLen} characters of text, so a blank email would have reached Apollo. Nothing was sent; your draft is untouched. Close this reply window, open a fresh one, and try again.`, "error");
      $("push-btn").disabled = false;
      return;
    }

    // Journal the push BEFORE any Apollo write — if this window dies mid-push,
    // the next pane open finishes the job from this record.
    const journalId = journalStart({
      contactId: selectedContact.id,
      contactName: selectedContact.name || "",
      sequenceId,
      mailboxId,
      subject: draftContext.subject || "",
      html: apolloHtml.length <= 300000 ? apolloHtml : "",
    });
    pushInFlight = true;

    try {
      // 0. Snapshot the contact's existing messages in this sequence BEFORE
      //    enrolling — the picker will only accept a message created by THIS
      //    push, excluding orphans from earlier remove/re-enroll cycles.
      const preexistingIds = await apollo.listContactMessageIds({
        contactId: selectedContact.id,
        sequenceId,
      });
      console.log(`[push] pre-enrollment snapshot: ok=${preexistingIds.ok}, ${preexistingIds.ids.size} existing message id(s)`);

      // 1. Add contact to sequence.
      console.log("[push] adding contact to sequence", { sequenceId, contactId: selectedContact.id, mailboxId });
      const addRes = await apollo.addContactToSequence({
        sequenceId,
        contactId: selectedContact.id,
        mailboxId,
      });

      // Guard (hardened per Codex finding 3): require POSITIVE confirmation
      // that Apollo enrolled OUR contact — a response without a matching
      // contact entry is never treated as enrolled.
      const enrolled = (Array.isArray(addRes.contacts) ? addRes.contacts : []).find(
        (c) => c && String(c.id) === String(selectedContact.id)
      );

      // Mode "new" = fresh enrollment this push; "existing" = the contact was
      // already in this sequence, so update their existing step-1 draft
      // instead of dead-ending (2026-07-22: an already-enrolled contact used
      // to hard-fail here, forcing the remove-and-redo dance).
      let mode = "new";
      let currentStepId = null;
      if (enrolled) {
        const statuses = enrolled.contact_campaign_statuses || [];
        const thisCampaign = statuses.find((s) => String(s.emailer_campaign_id) === String(sequenceId));
        currentStepId = (thisCampaign && thisCampaign.current_step_id) || null;
        console.log(`[push] enrollment confirmed; current_step_id=${currentStepId || "n/a"}`);
        journalUpdate(journalId, { stage: "enrolled" });
      } else {
        console.warn("[push] enrollment not confirmed; contacts in response:", (addRes.contacts || []).length);
        // Why did Apollo refuse? Ask for the contact's status in THIS sequence.
        let seqStatus = "unknown";
        try {
          const c = await apollo.getContact(selectedContact.id);
          const st = (c.contact_campaign_statuses || []).find(
            (s) => String(s.emailer_campaign_id) === String(sequenceId)
          );
          seqStatus = st ? (st.status || "unknown") : "none";
          if (st && st.current_step_id) currentStepId = st.current_step_id;
        } catch (e) {
          console.warn("[push] contact status lookup failed:", e);
        }
        console.log(`[push] contact status in this sequence: ${seqStatus}`);
        if (seqStatus === "active" || seqStatus === "paused") {
          mode = "existing";
          journalUpdate(journalId, { stage: "enrolled", note: "already_in_sequence" });
          setStatus("status-area", "Contact is already in this sequence — updating their existing step-1 draft…", "info");
        } else if (seqStatus === "finished") {
          journalUpdate(journalId, { stage: "failed", result: "finished_in_sequence" });
          pushInFlight = false;
          setStatus("status-area", "", null);
          setStatus("result-area",
            "Push blocked: this contact already FINISHED this sequence once, and Apollo will not re-add them from here. In Apollo, remove them from the sequence (find the contact inside the sequence → Remove), then push again. Your draft is untouched.",
            "error");
          $("push-btn").disabled = false;
          return;
        } else {
          journalUpdate(journalId, { stage: "failed", result: "enroll_not_confirmed" });
          pushInFlight = false;
          setStatus("status-area", "", null);
          setStatus("result-area",
            "Push failed: Apollo did not enroll this contact in the sequence (they may be unsubscribed, blocked, or missing an email there). Your draft is untouched — check the contact in Apollo and try again.",
            "error");
          $("push-btn").disabled = false;
          return;
        }
      }

      // 2. Push the body into the step-1 manual email and PROVE it stuck
      //    (immediate verify + stability re-checks, auto re-push on revert).
      console.log("[push] attempting body update; HTML length:", apolloHtml.length);
      const pushResult = await apollo.tryUpdateManualMessageBody({
        contactId: selectedContact.id,
        sequenceId,
        htmlBody: apolloHtml,
        subject: draftContext.subject,
        preexistingIds,
        currentStepId,
        mode,
        maxWaitMs: 60000,
        onProgress: (msg) => setStatus("status-area", "Pushing to Apollo — " + msg, "info"),
      });
      console.log("[push] body update result:", pushResult.success ? "success" : pushResult.reason);
      // message_not_found after a fresh enrollment stays PENDING in the journal:
      // Apollo may create the draft minutes later, and the resume pass on the
      // next pane open will then fill it automatically.
      journalUpdate(journalId, {
        stage: pushResult.success ? "done"
          : (pushResult.reason === "message_not_found" && mode === "new") ? "enrolled"
          : "failed",
        result: pushResult.success ? "verified" : pushResult.reason,
        messageId: pushResult.messageId || "",
      });

      if (pushResult.success) {
        pushInFlight = false;
        setStatus("status-area", "", null);
        setStatus("result-area",
          (mode === "existing"
            ? "✓ Contact was already in this sequence — its step-1 draft was replaced and verified. Go to Apollo and click Send."
            : "✓ Pushed to Apollo and verified (checked three times over ~10 seconds). Step 1 is pre-filled — go to Apollo and click Send.")
          + (pushResult.putAttempts > 1 ? ` (Apollo tried to overwrite it ${pushResult.putAttempts - 1}x; we re-pushed until it held.)` : ""),
          "success");
      } else {
        pushInFlight = false;
        // Fallback: clipboard. Tell the user WHY so we can debug — and be
        // honest about whether the copy actually worked (Codex cleanup item).
        const copied = await copyToClipboard(apolloHtml);
        const why = pushResult.reason === "message_not_found"
          ? (mode === "existing"
            ? "the contact is already PAST step 1 in this sequence (no editable step-1 draft exists)"
            : "Apollo never created the step-1 draft, even after a full minute")
          : `body push failed (${pushResult.reason})`;
        setStatus("status-area", "", null);
        setStatus("result-area",
          `⚠ Contact is in the sequence, but ${why}. ${copied ? "The email HTML is on your clipboard — paste it into Apollo step 1 and click Send." : "Clipboard copy ALSO failed — your Outlook draft is the only copy; re-push or copy it manually."} Your Outlook draft was kept as a backup. If you push again from this window, it will finish the job automatically.`,
          "warn");
        // Keep the draft on failure (2026-07-08): the clipboard is fragile and the
        // draft is the only durable copy of the typed reply. Only a verified push
        // discards it.
        $("push-btn").disabled = false;
        return;
      }

      // 3. Discard the Outlook draft — but FIRST prove it hasn't changed since
      //    the content we just pushed (Codex finding 6: the user can keep
      //    typing during the retry window; destroying those edits loses them).
      try {
        const item = Office.context.mailbox.item;
        let latestBody = null;
        try {
          latestBody = await new Promise((res, rej) =>
            item.body.getAsync(Office.CoercionType.Html, (r) =>
              r.status === Office.AsyncResultStatus.Succeeded ? res(r.value) : rej(r.error)
            )
          );
        } catch (_) {}
        // Compare TEXT, not raw HTML: consecutive Outlook body reads can differ
        // cosmetically (re-serialized ids/attributes) with identical content,
        // which used to spuriously keep the draft after a clean push.
        const textNorm = (h) => String(h || "")
          .replace(/<!--[\s\S]*?-->/g, "")
          .replace(/<[^>]*>/g, " ")
          .replace(/&nbsp;/gi, " ")
          .replace(/\s+/g, " ")
          .trim();
        if (latestBody !== null && textNorm(latestBody) !== textNorm(bodyToUse)) {
          console.warn(`[push] draft text changed during push (${bodyToUse.length} → ${latestBody.length} chars) — keeping the draft`);
          setStatus("result-area",
            "✓ Pushed to Apollo — but the draft changed while the push ran, so it was KEPT (your newest edits are only in Outlook, not in Apollo).",
            "warn");
          $("push-btn").disabled = false;
          return;
        }

        // Replace body with a marker BEFORE closing — if Outlook saves anyway,
        // the persisted draft will be empty/marked rather than a duplicate of
        // what we just pushed. Await it so the close can't race the write.
        try {
          await new Promise((res) =>
            item.body.setAsync(
              "[Pushed to Apollo — safe to delete this draft]",
              { coercionType: Office.CoercionType.Text },
              () => res()
            )
          );
        } catch (_) {}

        // Modern: close({ closeBehavior: Discard }) — Mailbox 1.10+
        const CloseBehavior = Office.MailboxEnums && Office.MailboxEnums.CloseBehavior;
        if (CloseBehavior && CloseBehavior.Discard) {
          try {
            item.close({ closeBehavior: CloseBehavior.Discard });
          } catch (_) {
            // Legacy fallback
            try { item.close({ discardItem: true }); } catch (_) {
              try { item.close(); } catch (_) {}
            }
          }
        } else {
          try { item.close({ discardItem: true }); } catch (_) {
            try { item.close(); } catch (_) {}
          }
        }
      } catch (_) {}
    } catch (err) {
      pushInFlight = false;
      journalUpdate(journalId, { stage: "failed", result: "exception: " + (err && err.message) });
      setStatus("status-area", "", null);
      setStatus("result-area", "Push failed: " + err.message + " — your draft is untouched. Push again from this window; it picks up where it left off.", "error");
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
      let ok = false;
      try { ok = document.execCommand("copy") === true; } catch (_) {}
      document.body.removeChild(ta);
      resolve(ok);
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
