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
   * Best-effort: try to update the body of a queued emailer_message (the manual
   * email task created when a contact is added to step 1). If the API rejects
   * or the verification fetch shows the body didn't actually change, the caller
   * should fall back to clipboard copy.
   *
   * Apollo's add_contact_ids creates the queued message asynchronously, so we
   * retry the search a few times if no message is found yet.
   */
  async tryUpdateManualMessageBody({ contactId, sequenceId, htmlBody, subject, preexistingIds, currentStepId }) {
    // 1. Find the queued manual email message — retry to dodge race on enrollment.
    let messageId = null;
    let queuedMessage = null;
    // 10 × 1500ms ≈ 15s window (was 6 × 800ms ≈ 5s): in the 2026-07-08 incident the
    // drafted message still didn't exist ~5s after enrollment, which is what let the
    // old fallback grab another contact's message.
    for (let attempt = 0; attempt < 10 && !messageId; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 1500));
      try {
        const search = await this._request("POST", "/emailer_messages/search", {
          contact_ids: [contactId],
          emailer_campaign_ids: [sequenceId],
          per_page: 25,
        });
        const rawMessages = search.emailer_messages || search.messages || [];
        // HARD GUARD (2026-07-08): Apollo's /emailer_messages/search now IGNORES the
        // contact_ids filter and returns every message in the campaign — verified by
        // searching with a bogus contact id and still getting other contacts' messages.
        // Without this client-side filter the picker below can select ANOTHER contact's
        // scheduled email and overwrite it (happened in production: one contact's thread
        // was written onto a different contact's scheduled follow-up). Never operate on
        // messages that don't belong to the target contact.
        const messages = rawMessages.filter(m =>
          String(m.contact_id || (m.contact && m.contact.id) || "") === String(contactId)
        );
        console.log(`[apollo] search attempt ${attempt + 1}: ${rawMessages.length} returned, ${messages.length} for target contact`);

        // Candidate requirements (Codex review 2026-07-08, findings 1+2) —
        // every one must hold; any uncertainty means NO candidate:
        //  a. campaign matches, when the message carries the field (the server-
        //     side campaign filter held in testing, but don't trust it alone);
        //  b. NOT in the pre-enrollment snapshot — the message must have been
        //     created by THIS push, so orphans from earlier remove/re-enroll
        //     cycles are excluded by id. If the snapshot itself failed, fall
        //     back to requiring created_at within the last 10 minutes;
        //  c. positively a manual email (type contains "manual" — an automatic
        //     email can never qualify; the old any-type step-1 fallback that
        //     contradicted this is DELETED);
        //  d. a drafted/live status ("drafted" confirmed in production; older
        //     guesses kept for forward-compat);
        //  e. when Apollo's enrollment response told us the current step id,
        //     prefer the message on that exact step.
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
          queuedMessage = candidate;
          messageId = candidate.id;
          console.log(`[apollo] picked message id=${candidate.id} status=${candidate.status} type=${candidate.type || candidate.emailer_step_type} stepMatch=${stepMatched.length > 0} (${candidates.length} qualifying candidate(s) of ${messages.length})`);
        }
      } catch (e) {
        console.warn(`[apollo] search failed on attempt ${attempt + 1}:`, e);
      }
    }

    if (!messageId) {
      console.warn("[apollo] no queued emailer_message found after retries");
      return { success: false, reason: "message_not_found" };
    }

    console.log(`[apollo] target message id: ${messageId}, current body length: ${(queuedMessage.body_html || "").length}`);

    // 2. PUT the new body, stamped with a unique per-push marker (an HTML
    //    comment — invisible to recipients). The old verification matched the
    //    first ~20 chars, which are the SAME wrapper on every formatted push,
    //    so it could false-pass against a previous body (Codex finding 4).
    const pushToken = `sapw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const markedBody = `<!--${pushToken}-->${htmlBody}`;
    try {
      const body = { body_html: markedBody };
      if (subject) body.subject = subject;
      await this._request("PUT", `/emailer_messages/${messageId}`, body);
      console.log(`[apollo] PUT accepted for message ${messageId}`);
    } catch (e) {
      console.error("[apollo] PUT rejected:", e);
      return { success: false, reason: "put_rejected", error: String(e) };
    }

    // 3. Verify: re-fetch and require the unique marker, the right contact,
    //    and (when we set it) the right subject. A failed verification is a
    //    FAILURE — never optimism (the old code claimed success when the
    //    verify GET errored, which could reach draft destruction).
    try {
      const verify = await this._request("GET", `/emailer_messages/${messageId}`);
      const got = verify.emailer_message || verify;
      const gotContact = got.contact_id || (got.contact && got.contact.id) || "";
      console.log(`[apollo] verify: bodylen=${(got.body_html || "").length} markerPresent=${(got.body_html || "").includes(pushToken)} contactMatch=${!gotContact || String(gotContact) === String(contactId)}`);
      if (!got.body_html || !got.body_html.includes(pushToken)) {
        return { success: false, reason: "verify_mismatch", messageId };
      }
      if (gotContact && String(gotContact) !== String(contactId)) {
        return { success: false, reason: "verify_wrong_contact", messageId };
      }
      if (subject && got.subject && got.subject !== subject) {
        return { success: false, reason: "verify_subject_mismatch", messageId };
      }
    } catch (e) {
      console.warn("[apollo] verify GET failed — treating as FAILURE:", e);
      return { success: false, reason: "verify_unavailable", messageId };
    }

    return { success: true, messageId };
  }
}

window.ApolloClient = ApolloClient;
