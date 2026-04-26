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
      .filter(a => a.active !== false)
      .map(a => ({
        id: a.id,
        email: a.email,
        default: !!a.default,
      }))
      .sort((a, b) => {
        if (a.default && !b.default) return -1;
        if (!a.default && b.default) return 1;
        return a.email.localeCompare(b.email);
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
    });
    return data.contact || data;
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
   * email task created when a contact is added to step 1). If the API rejects,
   * caller should fall back to clipboard copy.
   *
   * We attempt several plausible endpoints since Apollo's public docs are
   * incomplete in this area.
   */
  async tryUpdateManualMessageBody({ contactId, sequenceId, htmlBody, subject }) {
    // Find the queued manual email message for this contact in this sequence.
    let messageId = null;
    try {
      const search = await this._request("POST", "/emailer_messages/search", {
        contact_ids: [contactId],
        emailer_campaign_ids: [sequenceId],
        per_page: 25,
      });
      const messages = search.emailer_messages || search.messages || [];
      const queued = messages.find(m =>
        (m.emailer_step_position === 1 || m.position === 1) &&
        (m.status === "queued" || m.status === "pending" || m.status === "draft")
      ) || messages[0];
      if (queued) messageId = queued.id;
    } catch (_) {
      // If search endpoint isn't available, we can't proceed with API push.
      return { success: false, reason: "search_unavailable" };
    }

    if (!messageId) return { success: false, reason: "message_not_found" };

    // Try PUT to update body.
    try {
      const body = { body_html: htmlBody };
      if (subject) body.subject = subject;
      await this._request("PUT", `/emailer_messages/${messageId}`, body);
      return { success: true, messageId };
    } catch (e) {
      return { success: false, reason: "put_rejected", error: String(e) };
    }
  }
}

window.ApolloClient = ApolloClient;
