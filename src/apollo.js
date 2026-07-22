/**
 * Apollo API client (browser-side, runs inside the Outlook task pane).
 *
 * Auth: Apollo uses API key in `X-Api-Key` header. Key is stored locally in
 * Office.context.roamingSettings — never in code, never sent except to api.apollo.io.
 *
 * Notes:
 *  - All endpoints below are documented public Apollo REST API (api.apollo.io/v1/*)
 *  - The `updateManualMessageBody` method is best-effort — we probe whether the
 *    API exposes per-contact body override on a queued manual email. If it
 *    doesn't, the caller falls back to clipboard copy + manual paste.
 */

class ApolloClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    // Browser → CORS proxy → Apollo. The proxy adds the Access-Control-Allow-Origin
    // headers Apollo doesn't return for our origin. See worker/src/index.js.
    this.baseUrl = "https://stormsearch-apollo-proxy.n-alioto7.workers.dev/v1";
  }

  async _request(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const opts = {
      method,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "X-Api-Key": this.apiKey,
      },
      mode: "cors",
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (!res.ok) {
      let detail = "";
      try { detail = await res.text(); } catch (_) {}
      throw new Error(`Apollo API ${method} ${path} → ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json();
  }

  /**
   * Search active (non-archived) sequences in the user's Apollo account.
   * Returns array of {id, name} sorted by most recently used.
   */
  async listActiveSequences() {
    const data = await this._request("POST", "/emailer_campaigns/search", {
      per_page: 100,
      page: 1,
    });
    const seqs = (data.emailer_campaigns || [])
      .filter(s => !s.archived && s.active !== false)
      .map(s => ({
        id: s.id,
        name: s.name,
        last_used_at: s.last_used_at,
        num_steps: s.num_steps,
      }))
      .sort((a, b) => (b.last_used_at || "").localeCompare(a.last_used_at || ""));
    return seqs;
  }

  /**
   * List all linked email accounts (sender mailboxes) for the user's team.
   * Returns array of {id, email, default}.
   */
  async listMailboxes() {
    const data = await this._request("GET", "/email_accounts");
    return (data.email_accounts || [])
      .filter(a => a && a.active !== false && a.email) // skip nulls / inactive / no-email
      .map(a => ({
        id: a.id,
        email: a.email,
        default: !!a.default,
      }))
      .sort((a, b) => {
        if (a.default && !b.default) return -1;
        if (!a.default && b.default) return 1;
        return (a.email || "").localeCompare(b.email || "");
      });
  }

  /**
   * Search Apollo contacts by exact email address.
   * Returns array of {id, name, title, organization_name, last_activity_date, primary_email}.
   * Email match is exact (Apollo's keyword search will match the full email).
   */
  async searchContactByEmail(email) {
    const data = await this._request("POST", "/contacts/search", {
      q_keywords: email,
      per_page: 25,
      page: 1,
    });
    const all = data.contacts || [];
    // Filter to only contacts whose contact_emails actually contain the lookup email (case-insensitive).
    const lower = email.toLowerCase();
    const matches = all.filter(c => {
      const emails = [c.email].concat((c.contact_emails || []).map(e => e.email)).filter(Boolean);
      return emails.some(e => e.toLowerCase() === lower);
    });
    return matches.map(c => ({
      id: c.id,
      name: c.name || `${c.first_name || ""} ${c.last_name || ""}`.trim(),
      title: c.title || "",
      organization_name: c.organization_name || "",
      last_activity_date: c.last_activity_date || null,
      primary_email: c.email || (c.contact_emails && c.contact_emails[0] && c.contact_emails[0].email) || "",
    }));
  }

  /**
   * Create a new contact in Apollo.
   * Required: email. Optional: first_name, last_name, organization_name, title.
   */
  async createContact({ email, first_name, last_name, organization_name, title }) {
    const data = await this._request("POST", "/contacts", {
      email,
      first_name: first_name || "",
      last_name: last_name || "",
      organization_name: organization_name || "",
      title: title || "",
      run_dedupe: true, // don't create a duplicate if the search missed an existing contact
    });
    return data.contact || data;
  }

  /**
   * Snapshot the ids of ALL messages that already exist for this contact in
   * this sequence — taken BEFORE enrollment so the picker can require a
   * message created BY this push (orphans from earlier remove/re-enroll
   * cycles are excluded by id, not by guessing from sort order).
   * Returns { ok, ids:Set } — ok:false means the snapshot itself failed.
   */
  async listContactMessageIds({ contactId, sequenceId }) {
    try {
      const search = await this._request("POST", "/emailer_messages/search", {
        contact_ids: [contactId],
        emailer_campaign_ids: [sequenceId],
        per_page: 100,
      });
      const messages = search.emailer_messages || search.messages || [];
      return { ok: true, ids: new Set(messages.map((m) => m.id).filter(Boolean)) };
    } catch (e) {
      console.warn("[apollo] pre-enrollment snapshot failed:", e);
      return { ok: false, ids: new Set() };
    }
  }

  /**
   * Add an existing contact to a sequence with a chosen sender mailbox.
   * Returns the response which includes contact_campaign_statuses[].current_step_id
   * — useful for finding the just-queued step 1 manual email.
   */
  async addContactToSequence({ sequenceId, contactId, mailboxId }) {
    return this._request("POST", `/emailer_campaigns/${sequenceId}/add_contact_ids`, {
      emailer_campaign_id: sequenceId,
      contact_ids: [contactId],
      send_email_from_email_account_id: mailboxId,
      sequence_active_in_other_campaigns: true,
      sequence_finished_in_other_campaigns: true,
      contact_verification_skipped: true,
    });
  }

  /**
   * Fetch one contact by id — includes contact_campaign_statuses, used to
   * explain a rejected enrollment (already active vs finished in the sequence).
   */
  async getContact(contactId) {
    const data = await this._request("GET", `/contacts/${contactId}`);
    return data.contact || data;
  }

  /**
   * Poll for the PUT-able drafted manual email for this contact+sequence.
   *
   * mode "new"      — only accept a message NOT in the pre-enrollment snapshot
   *                   (created by THIS push). Snapshot-failed fallback: created
   *                   within the last 10 minutes.
   * mode "existing" — accept any drafted manual message for this contact in
   *                   this sequence. Used when Apollo says the contact is
   *                   already enrolled (re-push onto the existing step-1 draft)
   *                   and when resuming an interrupted push.
   *
   * Polls up to maxWaitMs (Apollo creates the message asynchronously — the
   * 2026-07-08 incident proved it can take longer than 5s; the old 15s ceiling
   * was still a guess, so this is now generous and caller-visible via
   * onProgress(elapsedSeconds)).
   */
  async findManualDraft({ contactId, sequenceId, mode, preexistingIds, currentStepId, maxWaitMs, onProgress }) {
    const deadline = Date.now() + (maxWaitMs || 60000);
    const started = Date.now();
    let delay = 1000;
    for (let attempt = 1; ; attempt++) {
      try {
        const search = await this._request("POST", "/emailer_messages/search", {
          contact_ids: [contactId],
          emailer_campaign_ids: [sequenceId],
          per_page: 50,
        });
        const rawMessages = search.emailer_messages || search.messages || [];
        // HARD GUARD (2026-07-08): Apollo's /emailer_messages/search IGNORES the
        // contact_ids filter and returns every message in the campaign — verified
        // by searching with a bogus contact id and still getting other contacts'
        // messages. Without this client-side filter the picker can select ANOTHER
        // contact's scheduled email and overwrite it (happened in production).
        // Never operate on messages that don't belong to the target contact.
        const messages = rawMessages.filter(m =>
          String(m.contact_id || (m.contact && m.contact.id) || "") === String(contactId)
        );
        console.log(`[apollo] search attempt ${attempt}: ${rawMessages.length} returned, ${messages.length} for target contact`);

        // Candidate requirements (Codex review 2026-07-08, findings 1+2) —
        // every one must hold; any uncertainty means NO candidate:
        //  a. campaign matches, when the message carries the field;
        //  b. mode "new": NOT in the pre-enrollment snapshot;
        //  c. positively a manual email (an automatic email can never qualify);
        //  d. a drafted/live status ("drafted" confirmed in production);
        //  e. prefer the enrollment response's current step id when we have it.
        const liveStatus = (s) =>
          s === "drafted" || s === "queued" || s === "pending" || s === "draft" ||
          s === "unscheduled" || !s;
        const isManualEmail = (m) => {
          const t = m.type || m.emailer_step_type || "";
          return t.indexOf("manual") !== -1;
        };
        const campaignOk = (m) => {
          const c = m.emailer_campaign_id || (m.emailer_campaign && m.emailer_campaign.id);
          return !c || String(c) === String(sequenceId);
        };
        const isNewThisPush = (m) => {
          if (mode === "existing") return true;
          if (preexistingIds && preexistingIds.ok) return !preexistingIds.ids.has(m.id);
          const created = Date.parse(m.created_at || m.createdAt || "");
          return Number.isFinite(created) && Date.now() - created < 10 * 60 * 1000;
        };
        const sortNewestFirst = (a, b) => {
          const aT = a.created_at || a.createdAt || a.id || "";
          const bT = b.created_at || b.createdAt || b.id || "";
          return String(bT).localeCompare(String(aT));
        };

        const candidates = messages
          .filter(m => campaignOk(m) && isNewThisPush(m) && isManualEmail(m) && liveStatus(m.status))
          .sort(sortNewestFirst);
        const stepMatched = currentStepId
          ? candidates.filter(m => String(m.emailer_step_id || "") === String(currentStepId))
          : [];
        const candidate = stepMatched[0] || candidates[0];
        if (candidate) {
          console.log(`[apollo] picked message id=${candidate.id} status=${candidate.status} type=${candidate.type || candidate.emailer_step_type} stepMatch=${stepMatched.length > 0} (${candidates.length} qualifying candidate(s) of ${messages.length})`);
          return candidate;
        }
      } catch (e) {
        console.warn(`[apollo] search failed on attempt ${attempt}:`, e);
      }
      if (Date.now() + delay > deadline) return null;
      if (onProgress) onProgress(Math.round((Date.now() - started) / 1000));
      await new Promise(r => setTimeout(r, delay));
      delay = Math.min(delay + 500, 3000);
    }
  }

  /**
   * PUT the body and prove it STAYS there.
   *
   * The old flow verified once, immediately after the PUT — but Apollo renders
   * the step template into a freshly created message ASYNCHRONOUSLY, so a body
   * written too early can be silently overwritten right after a clean verify.
   * That yields the worst outcome: a success banner with nothing in Apollo.
   *
   * This version verifies immediately, then RE-verifies after ~3s and ~8s.
   * If the marker vanished at any check, the body is re-PUT (up to 3 PUTs
   * total). Success is only declared after a verify that survives the last
   * stability window.
   *
   * Verification requires, on the re-fetched message: the unique per-push
   * marker, the right contact, real text content (not just the marker — a
   * near-empty push must never read as success), and the subject we set.
   */
  async putBodyDurable({ messageId, contactId, htmlBody, subject, onProgress }) {
    const pushToken = `sapw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const markedBody = `<!--${pushToken}-->${htmlBody}`;
    const textLen = (h) => String(h || "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim().length;
    const expectedTextLen = textLen(htmlBody);

    const doPut = async () => {
      const body = { body_html: markedBody };
      if (subject) body.subject = subject;
      await this._request("PUT", `/emailer_messages/${messageId}`, body);
      console.log(`[apollo] PUT accepted for message ${messageId}`);
    };
    const check = async () => {
      const verify = await this._request("GET", `/emailer_messages/${messageId}`);
      const got = verify.emailer_message || verify;
      const gotBody = got.body_html || "";
      const gotContact = got.contact_id || (got.contact && got.contact.id) || "";
      const marker = gotBody.includes(pushToken);
      console.log(`[apollo] verify: bodylen=${gotBody.length} markerPresent=${marker} contactMatch=${!gotContact || String(gotContact) === String(contactId)}`);
      if (gotContact && String(gotContact) !== String(contactId)) return { ok: false, fatal: "verify_wrong_contact" };
      if (!marker) return { ok: false };
      // Content floor: the pushed text must actually be there. Guards against
      // a formatter/Outlook glitch producing a marker-only body that the old
      // marker-only verify waved through as green success.
      if (expectedTextLen >= 40 && textLen(gotBody) < Math.min(40, expectedTextLen)) return { ok: false };
      if (subject && got.subject && got.subject !== subject) return { ok: false, fatal: "verify_subject_mismatch" };
      return { ok: true };
    };

    for (let putAttempt = 1; putAttempt <= 3; putAttempt++) {
      try {
        await doPut();
      } catch (e) {
        console.error("[apollo] PUT rejected:", e);
        return { success: false, reason: "put_rejected", error: String(e), messageId };
      }
      let stable = true;
      // Immediate check, then stability re-checks at ~+3s and ~+8s.
      for (const wait of [0, 3000, 5000]) {
        if (wait) {
          if (onProgress) onProgress("confirming it sticks…");
          await new Promise(r => setTimeout(r, wait));
        }
        let res;
        try {
          res = await check();
        } catch (e) {
          // A failed verification is a FAILURE — never optimism (the pre-2026-07-08
          // code claimed success when the verify GET errored).
          console.warn("[apollo] verify GET failed — treating as FAILURE:", e);
          return { success: false, reason: "verify_unavailable", messageId };
        }
        if (res.fatal) return { success: false, reason: res.fatal, messageId };
        if (!res.ok) {
          console.warn(`[apollo] body did not hold (PUT attempt ${putAttempt}) — Apollo overwrote or dropped it; re-pushing`);
          stable = false;
          break;
        }
      }
      if (stable) return { success: true, messageId, putAttempts: putAttempt };
    }
    return { success: false, reason: "verify_mismatch", messageId };
  }

  /**
   * Orchestrator kept for the task pane: locate the drafted manual email
   * (mode "new" after a fresh enrollment, "existing" for re-push/resume),
   * then durably write and verify the body.
   */
  async tryUpdateManualMessageBody({ contactId, sequenceId, htmlBody, subject, preexistingIds, currentStepId, mode, maxWaitMs, onProgress }) {
    const target = await this.findManualDraft({
      contactId, sequenceId,
      mode: mode || "new",
      preexistingIds, currentStepId,
      maxWaitMs: maxWaitMs || 60000,
      onProgress: onProgress
        ? (sec) => onProgress(`waiting for Apollo to create the draft (${sec}s)… keep this window open`)
        : null,
    });
    if (!target) {
      console.warn("[apollo] no queued emailer_message found after retries");
      return { success: false, reason: "message_not_found" };
    }
    console.log(`[apollo] target message id: ${target.id}, current body length: ${(target.body_html || "").length}`);
    return this.putBodyDurable({
      messageId: target.id, contactId, htmlBody, subject,
      onProgress: onProgress || null,
    });
  }
}

window.ApolloClient = ApolloClient;
