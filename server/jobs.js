// Shared job logic used by BOTH the admin "send now" button (via server/app.js) AND
// the Vercel cron-triggered endpoints (api/cron/*.js). Deliberately has ZERO dependency
// on Express - requiring server/app.js from api/cron/*.js pulled in Express as a
// transitive dependency, which Vercel's per-function bundler wasn't reliably including
// for these standalone cron functions (intermittent "Cannot find module 'express'"
// crashes on those routes only). Keeping this file Express-free avoids that entirely.

const store = require('./store');
const square = require('./square');
const { sendOrderSummary, sendReminderEmail } = require('./emailer');
const crypto = require('crypto');

const DEFAULT_SITE = 'grabgo';
const CHEF_EMAIL = 'mr.simongomes@googlemail.com';

function todayLabel(timezone) {
  return new Date().toLocaleDateString('en-GB', { timeZone: timezone || 'Europe/London' });
  }

  function todayKey(timezone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone || 'Europe/London',
            year: 'numeric', month: '2-digit', day: '2-digit'
              }).formatToParts(new Date());
                const y = parts.find(p => p.type === 'year').value;
                  const m = parts.find(p => p.type === 'month').value;
                    const d = parts.find(p => p.type === 'day').value;
                      return `${y}-${m}-${d}`;
                      }

                      function getSite(menu, siteId) {
                        const id = siteId || DEFAULT_SITE;
                          const site = menu.sites && menu.sites[id];
                            if (!site) return null;
                              return { id, ...site };
                              }

                              async function compileAndSend(slotLabel) {
                                const menu = await store.readMenu();
                                  const site = getSite(menu, DEFAULT_SITE);
                                    const key = todayKey(site.settings.timezone);
                                      const allOrders = await store.readOrders();
                                        const orders = allOrders.filter(o => (o.site || DEFAULT_SITE) === DEFAULT_SITE && o.dateKey === key && o.slot === slotLabel);

                                          const result = await sendOrderSummary({
                                              to: site.settings.orderEmailTo,
                                                  cc: site.settings.ccChef ? CHEF_EMAIL : undefined,
                                                      slot: slotLabel,
                                                          orders,
                                                              dateLabel: todayLabel(site.settings.timezone)
                                                                });

                                                                  let ticket = { attempted: false };
                                                                    if (square.isConfigured() && orders.length > 0) {
                                                                        try {
                                                                              const squareOrder = await square.createBatchOrder({
                                                                                      orders,
                                                                                              slot: slotLabel,
                                                                                                      dateLabel: todayLabel(site.settings.timezone)
                                                                                                            });
                                                                                                                  ticket = { attempted: true, sent: true, squareOrderId: squareOrder.id };
                                                                                                                      } catch (err) {
                                                                                                                            ticket = { attempted: true, sent: false, error: err.message };
                                                                                                                                  console.error(`Square ticket for ${slotLabel} failed:`, err.message);
                                                                                                                                      }
                                                                                                                                        }
                                                                                                                                        
                                                                                                                                          return { ...result, ticket };
                                                                                                                                          }
                                                                                                                                          
                                                                                                                                          async function runCafeMorningJob() {
                                                                                                                                            const menu = await store.readMenu();
                                                                                                                                              const site = getSite(menu, 'onsite');
                                                                                                                                                if (!site || site.ticketMode !== 'immediate' || !square.isConfigured()) {
                                                                                                                                                    return { ran: false, reason: 'Cafe site not found, not immediate-ticket mode, or Square not configured' };
                                                                                                                                                      }
                                                                                                                                                        const todayKeyValue = todayKey(site.settings.timezone);
                                                                                                                                                          const orders = await store.readOrders();
                                                                                                                                                            let printedCount = 0;
                                                                                                                                                              for (const order of orders) {
                                                                                                                                                                  if (order.site !== 'onsite') continue;
                                                                                                                                                                      if (order.dateKey !== todayKeyValue) continue;
                                                                                                                                                                          if (order.status !== 'paid') continue;
                                                                                                                                                                              if (order.ticketPrinted) continue;
                                                                                                                                                                                  try {
                                                                                                                                                                                        await square.createCafeTicket({ order, dateLabel: todayLabel(site.settings.timezone) });
                                                                                                                                                                                              order.ticketPrinted = true;
                                                                                                                                                                                                    printedCount += 1;
                                                                                                                                                                                                        } catch (err) {
                                                                                                                                                                                                              console.error(`Advance cafe ticket failed for order ${order.id}:`, err.message);
                                                                                                                                                                                                                  }
                                                                                                                                                                                                                    }
                                                                                                                                                                                                                      if (printedCount > 0) await store.writeOrders(orders);
                                                                                                                                                                                                                        return { ran: true, printedCount };
                                                                                                                                                                                                                        }
                                                                                                                                                                                                                        
                                                                                                                                                                                                                        // Daily marketing job: email opted-in customers who haven't ordered in REMINDER_DAYS.
// One reminder per lapse — reminderSentAt on their latest order stops repeats until
// they order again. Most recent order's opt-in choice always wins.
const REMINDER_DAYS = 10;
const PUBLIC_BASE_URL = 'https://outlook-mealdeal-vercel.vercel.app';

function unsubscribeSig(email) {
  return crypto.createHmac('sha256', process.env.CRON_SECRET || 'dev')
    .update(String(email).toLowerCase()).digest('hex');
}

async function runMarketingReminders() {
  const menu = await store.readMenu();
  const orders = await store.readOrders();
  const byEmail = new Map();
  for (const o of orders) {
    if (!o.email) continue;
    const k = o.email.toLowerCase();
    if (!byEmail.has(k)) byEmail.set(k, []);
    byEmail.get(k).push(o);
  }
  const now = Date.now();
  let sent = 0, skipped = 0;
  for (const [email, list] of byEmail) {
    list.sort((a, b) => String(a.placedAt).localeCompare(String(b.placedAt)));
    const latest = list[list.length - 1];
    if (!latest.marketingOptIn) { skipped++; continue; }
    const daysSince = (now - Date.parse(latest.placedAt)) / 86400000;
    if (daysSince < REMINDER_DAYS || latest.reminderSentAt) { skipped++; continue; }
    const siteId = latest.site || DEFAULT_SITE;
    const site = getSite(menu, siteId);
    const page = siteId === 'onsite' ? 'onsite-order.html' : 'order.html';
    try {
      await sendReminderEmail({
        to: latest.email,
        name: latest.name,
        siteLabel: site ? site.label : 'The Outlook',
        orderUrl: PUBLIC_BASE_URL + '/' + page,
        unsubscribeUrl: PUBLIC_BASE_URL + '/api/unsubscribe?email=' + encodeURIComponent(email) + '&sig=' + unsubscribeSig(email)
      });
      latest.reminderSentAt = new Date().toISOString();
      sent += 1;
    } catch (err) {
      console.error('Reminder email failed for ' + email + ':', err.message);
    }
  }
  if (sent > 0) await store.writeOrders(orders);
  return { ran: true, sent, skipped };
}

module.exports = { compileAndSend, runCafeMorningJob, runMarketingReminders, unsubscribeSig, getSite, todayKey, todayLabel, DEFAULT_SITE, CHEF_EMAIL };
                                                                                                                                                                                                                        
