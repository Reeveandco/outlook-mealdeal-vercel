// Sends the order-summary emails via SMTP (nodemailer), using info@theoutlookatfoxs.com
// on GoDaddy/123-reg's email hosting.
//
// Set these as environment variables on whatever server this runs on:
//   MAIL_USER      - the mailbox address the emails are sent FROM (info@theoutlookatfoxs.com)
//   MAIL_PASSWORD  - that mailbox's normal email password (the one used to log into webmail /
//                     set up the account in Outlook or Mail apps - not an app-specific password,
//                     GoDaddy's basic email hosting doesn't use those)
//
// Server settings (from productivity.secureserver.net -> Server settings for this mailbox):
//   Outgoing server (SMTP): smtpout.secureserver.net, SSL port 465
//
// If MAIL_USER/MAIL_PASSWORD aren't set, the system runs in "dry run" mode: it logs the
// email it WOULD have sent to the server console instead of actually sending it, so the
// rest of the system can still be tested and demoed without this mailbox set up yet.

const nodemailer = require('nodemailer');

function isConfigured() {
      return !!(process.env.MAIL_USER && process.env.MAIL_PASSWORD);
}

let cachedTransporter = null;
function getTransporter() {
      if (!cachedTransporter) {
              cachedTransporter = nodemailer.createTransport({
                        host: 'smtpout.secureserver.net',
                        port: 465,
                        secure: true,
                        auth: {
                                    user: process.env.MAIL_USER,
                                    pass: process.env.MAIL_PASSWORD
                        }
              });
      }
      return cachedTransporter;
}

function formatOrderLine(order) {
      const opts = order.optionsText ? ` - ${order.optionsText}` : '';
      const contact = [order.mobile, order.email].filter(Boolean).join(' / ');
      const fulfilment = order.fulfilment === 'delivery'
        ? ` [DELIVERY: ${order.deliveryAddress}]`
              : '';
      return `- ${order.name}${contact ? ' (' + contact + ')' : ''}: ${order.itemName}${opts}${fulfilment}`;
}

// Generic raw-email sender - used for order summaries and for admin password-reset
// emails. `cc` may be a single address, an array of addresses, or omitted.
async function sendRawEmail({ to, cc, subject, text }) {
      if (!isConfigured()) {
              console.log('=== [DRY RUN - no SMTP credentials configured] ===');
              console.log('To:', to, cc ? `(cc: ${[].concat(cc).join(', ')})` : '');
              console.log('Subject:', subject);
              console.log(text);
              console.log('============================================================');
              return { sent: false, dryRun: true, subject, text };
      }

  const transporter = getTransporter();
      const ccAddresses = cc ? [].concat(cc).filter(Boolean).join(', ') : undefined;

  await transporter.sendMail({
          from: `"The Outlook at Fox's" <${process.env.MAIL_USER}>`,
          to,
          ...(ccAddresses ? { cc: ccAddresses } : {}),
          subject,
          text
  });

  return { sent: true, dryRun: false, subject, text };
}

async function sendOrderSummary({ to, cc, slot, orders, dateLabel }) {
      const subject = `Meal deal orders for ${slot} collection - ${dateLabel}`;
      const body = orders.length
        ? orders.map(formatOrderLine).join('\n')
              : 'No orders placed for this slot today.';
      const text = `Boatyard staff meal deal orders - collection at ${slot}\n\n${body}\n\nTotal orders: ${orders.length}`;
      const result = await sendRawEmail({ to, cc, subject, text });
      return result;
}

const RECOVERY_EMAIL = 'Torben.reeve@me.com';

async function sendPasswordResetEmail({ resetUrl }) {
      const subject = 'The Outlook at Fox\'s - admin password reset';
      const text = `A password reset was requested for the ordering admin panel.\n\nClick this link to set a new password (valid for 30 minutes):\n${resetUrl}\n\nIf you didn't request this, you can ignore this email - your current password stays unchanged.`;
      return sendRawEmail({ to: RECOVERY_EMAIL, subject, text });
}

// Plain-text backup of a single On-Site Cafe order - emailed to The Outlook inbox the
// moment the order is placed, so a missed or failed till print never loses an order.
async function sendCafeOrderEmail({ to, order, ticket, dateLabel }) {
      const lines = (order.items || []).map(l => `- ${l.qty}x ${l.name} (£${(l.price * l.qty).toFixed(2)})`).join('\n');
      const contact = [order.mobile, order.email].filter(Boolean).join(' / ');
      const printed = ticket && ticket.sent
        ? 'Till ticket: printed automatically.'
              : (ticket && ticket.deferred
                       ? `Till ticket: will print on the morning of ${ticket.forDate}.`
                       : 'TILL TICKET DID NOT PRINT - use this email as the order ticket.');
      const subject = `Cafe order - ${order.name} - for ${order.dateKey}${order.status === 'paid' ? ' (PAID)' : ''}`;
      const text = `On-Site Cafe order (backup copy)

      For date: ${order.dateKey}
      Placed: ${dateLabel}
      Name: ${order.name}${contact ? '\nContact: ' + contact : ''}

      ${lines}

      Total: £${order.totalPrice.toFixed(2)}
      Payment: ${order.status === 'paid' ? 'PAID via Square' : order.status}

      ${printed}`;
      return sendRawEmail({ to, subject, text });
}

// Confirmation email to the CUSTOMER the moment their order is placed. Works for both
// order shapes: cart orders (order.items array) and bundle orders (order.itemName).
async function sendCustomerConfirmation({ to, order, siteLabel, totalPrice }) {
      const itemsText = Array.isArray(order.items)
        ? order.items.map(l => `- ${l.qty}x ${l.name}`).join('\n')
              : `- ${order.itemName}${order.optionsText ? ' (' + order.optionsText + ')' : ''}`;
      const when = order.slot
        ? `Collection: ${order.slot} on ${order.dateKey}`
              : `For: ${order.dateKey} - collect from The Outlook`;
      const paidLine = order.status === 'paid' && totalPrice != null
        ? `\nPaid: £${Number(totalPrice).toFixed(2)} (card)`
              : '';
      const subject = `Order confirmed - ${siteLabel} - ${order.dateKey}`;
      const text = `Hi ${order.name},

      Thanks for your order - here's your confirmation.

      ${itemsText}

      ${when}${paidLine}

      Any problems, call The Outlook on 07346 149142.

      The Outlook at Fox's
      Fox's Marina & Boatyard, The Strand, Ipswich, Suffolk, IP2 8NJ`;
      return sendRawEmail({ to, subject, text });
}

// Gentle 'we miss you' reminder for opted-in customers who haven't ordered in a while.
async function sendReminderEmail({ to, name, siteLabel, orderUrl, unsubscribeUrl }) {
      const subject = `Fancy something from The Outlook this week?`;
      const text = `Hi ${name},

      It's been a little while since your last ${siteLabel} order - just a nudge in case
      you'd like to get something in for this week.

      Order here: ${orderUrl}

      The Outlook at Fox's
      Fox's Marina & Boatyard, The Strand, Ipswich, Suffolk, IP2 8NJ

      Don't want these reminders? Unsubscribe here: ${unsubscribeUrl}`;
      return sendRawEmail({ to, subject, text });
}

module.exports = { sendOrderSummary, sendPasswordResetEmail, sendCafeOrderEmail, sendCustomerConfirmation, sendReminderEmail, sendRawEmail, RECOVERY_EMAIL };
