// Sends the order-summary emails via Microsoft Graph, using an Office 365 mailbox.
//
// Set these as environment variables on whatever server this runs on:
//   MS_TENANT_ID       — your Microsoft 365 tenant (directory) ID
//   MS_CLIENT_ID        — the Application (client) ID of the Azure app registration
//   MS_CLIENT_SECRET    — a client secret created for that app registration
//   MS_SENDER_EMAIL     — the Office 365 mailbox the emails are sent FROM (needs a licence)
// See README.md ("Order emails — Microsoft 365 / Graph") for how to create the app
// registration and grant it permission, step by step.
//
// If these aren't set, the system runs in "dry run" mode: it logs the email it
// WOULD have sent to the server console instead of actually sending it, so the
// rest of the system can still be tested and demoed without Microsoft set up yet.

function isConfigured() {
  return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET && process.env.MS_SENDER_EMAIL);
}

async function getGraphToken() {
  const tenantId = process.env.MS_TENANT_ID;
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID,
    client_secret: process.env.MS_CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });

  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Could not get Microsoft Graph token: ${res.status} ${errText}`);
  }
  const data = await res.json();
  return data.access_token;
}

function formatOrderLine(order) {
  const opts = order.optionsText ? ` — ${order.optionsText}` : '';
  const contact = [order.mobile, order.email].filter(Boolean).join(' / ');
  const fulfilment = order.fulfilment === 'delivery'
    ? ` [DELIVERY: ${order.deliveryAddress}]`
    : '';
  return `- ${order.name}${contact ? ' (' + contact + ')' : ''}: ${order.itemName}${opts}${fulfilment}`;
}

// Generic raw-email sender — used for order summaries and for admin password-reset
// emails. `cc` may be a single address, an array of addresses, or omitted.
async function sendRawEmail({ to, cc, subject, text }) {
  if (!isConfigured()) {
    console.log('=== [DRY RUN — no Microsoft 365 credentials configured] ===');
    console.log('To:', to, cc ? `(cc: ${[].concat(cc).join(', ')})` : '');
    console.log('Subject:', subject);
    console.log(text);
    console.log('============================================================');
    return { sent: false, dryRun: true, subject, text };
  }

  const token = await getGraphToken();
  const senderEmail = process.env.MS_SENDER_EMAIL;
  const ccRecipients = cc
    ? [].concat(cc).filter(Boolean).map(address => ({ emailAddress: { address } }))
    : [];

  const res = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(senderEmail)}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: 'Text', content: text },
        toRecipients: [{ emailAddress: { address: to } }],
        ...(ccRecipients.length ? { ccRecipients } : {})
      },
      saveToSentItems: true
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Microsoft Graph sendMail failed: ${res.status} ${errText}`);
  }

  return { sent: true, dryRun: false, subject, text };
}

async function sendOrderSummary({ to, cc, slot, orders, dateLabel }) {
  const subject = `Meal deal orders for ${slot} collection — ${dateLabel}`;
  const body = orders.length
    ? orders.map(formatOrderLine).join('\n')
    : 'No orders placed for this slot today.';
  const text = `Boatyard staff meal deal orders — collection at ${slot}\n\n${body}\n\nTotal orders: ${orders.length}`;
  const result = await sendRawEmail({ to, cc, subject, text });
  return result;
}

const RECOVERY_EMAIL = 'Torben.reeve@me.com';

async function sendPasswordResetEmail({ resetUrl }) {
  const subject = 'The Outlook at Fox\'s — admin password reset';
  const text = `A password reset was requested for the ordering admin panel.\n\nClick this link to set a new password (valid for 30 minutes):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email — your current password stays unchanged.`;
  return sendRawEmail({ to: RECOVERY_EMAIL, subject, text });
}

module.exports = { sendOrderSummary, sendPasswordResetEmail, sendRawEmail, RECOVERY_EMAIL };
