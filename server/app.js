// The Express app itself - no app.listen() here, so this file can be required both by
// server.js (local dev / traditional hosting, calls app.listen()) and by api/[...path].js
// (Vercel serverless - Vercel calls the exported app directly per-request).
//
// Every store.* call is now awaited (server/store.js is MongoDB-backed and therefore
// async) - this is the main structural difference from the original Render/JSON-file
// version. Route handlers, and every helper they call, are async all the way down.

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const store = require('./store');
const slots = require('./slots');
const square = require('./square');
const { sendOrderSummary, sendPasswordResetEmail, sendCafeOrderEmail, sendCustomerConfirmation } = require('./emailer');
const {
    compileAndSend,
    runCafeMorningJob,
    getSite,
    todayKey,
    todayLabel,
    DEFAULT_SITE,
    CHEF_EMAIL,
    unsubscribeSig
} = require('./jobs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- helpers ----------

async function requireAdmin(req, res, next) {
    try {
          const menu = await store.readMenu();
          const supplied = req.header('x-admin-password');
          if (!supplied || supplied !== menu.adminPassword) {
                  return res.status(401).json({ error: 'Incorrect or missing admin password' });
          }
          next();
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
}

async function publicMenu(siteId) {
    const menu = await store.readMenu();
    const site = getSite(menu, siteId);
    if (!site) return null;

  const forDates = slots.getSelectableForDates(site);
    const todayKeyValue = todayKey(site.settings.timezone);

  if (site.type === 'cart') {
        return {
                type: 'cart',
                label: site.label,
                items: (site.items || []).filter(i => i.active),
                noticeText: site.settings.noticeText,
                isOpenToday: slots.isOpenToday(site.settings),
                openDays: site.settings.openDays,
                ordersOpen: forDates.length > 0,
                forDates,
                todayKey: todayKeyValue,
                lastOrderTime: site.settings.lastOrderTime || null
        };
  }

  const available = slots.getAvailableSlots(site.settings);
    return {
          type: 'bundle',
          label: site.label,
          items: (site.items || []).filter(i => i.active),
          noticeText: site.settings.noticeText,
          cutoff1: site.settings.cutoff1,
          collection1: site.settings.collection1,
          cutoff2: site.settings.cutoff2,
          collection2: site.settings.collection2,
          availableSlots: available,
          futureSlots: [site.settings.collection1, site.settings.collection2].filter(Boolean),
          ordersOpen: forDates.length > 0,
          isOpenToday: slots.isOpenToday(site.settings),
          openDays: site.settings.openDays,
          deliveryEnabled: Boolean(site.settings.deliveryEnabled),
          forDates,
          todayKey: todayKeyValue
    };
}

function findChoice(option, label) {
    return (option.choices || []).find(c => c.label === label);
}

// ---------- public endpoints ----------

app.get('/api/menu', async (req, res) => {
    try {
          const menu = await publicMenu(req.query.site);
          if (!menu) return res.status(404).json({ error: 'Unknown site' });
          res.json(menu);
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.get('/api/square-config', (req, res) => {
    res.json(square.publicConfig());
});

app.post('/api/orders', async (req, res) => {
    try {
          const menu = await store.readMenu();
          const siteId = (req.body && req.body.site) || DEFAULT_SITE;
          const site = getSite(menu, siteId);
          if (!site) return res.status(400).json({ error: 'Unknown site' });

      if (site.type === 'cart') {
              return await handleCartOrder(req, res, site);
      }
          return await handleBundleOrder(req, res, site);
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

async function handleBundleOrder(req, res, site) {
    const { name, email, mobile, itemId, options, slot, sourceId, fulfilment, deliveryAddress, forDate, marketingOptIn } = req.body || {};

  if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
  }
    if (!email || !/^\S+@\S+\.\S+$/.test(email.trim())) {
          return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!mobile || !mobile.trim()) {
          return res.status(400).json({ error: 'Mobile number is required' });
    }
    const item = site.items.find(i => i.id === itemId && i.active);
    if (!item) {
          return res.status(400).json({ error: 'Unknown or unavailable item' });
    }

  const todayKeyValue = todayKey(site.settings.timezone);
    const resolvedForDate = forDate || todayKeyValue;
    if (!slots.isForDateValid(site, resolvedForDate)) {
          return res.status(400).json({
                  error: 'That date is no longer available to order for - please pick another.',
                  forDates: slots.getSelectableForDates(site)
          });
    }
    const isForToday = resolvedForDate === todayKeyValue;
    if (isForToday) {
          if (!slots.isSlotValid(site.settings, slot)) {
                  return res.status(400).json({
                            error: 'That collection slot is no longer available',
                            availableSlots: slots.getAvailableSlots(site.settings)
                  });
          }
    } else {
          const futureSlots = [site.settings.collection1, site.settings.collection2].filter(Boolean);
          if (!futureSlots.includes(slot)) {
                  return res.status(400).json({ error: 'Please choose a valid collection time.' });
          }
    }
    if (square.isConfigured() && !sourceId) {
          return res.status(400).json({ error: 'Payment details are required' });
    }

  const deliveryFeatureOn = Boolean(site.settings.deliveryEnabled);
    let resolvedFulfilment = 'collection';
    let resolvedDeliveryAddress = '';
    if (deliveryFeatureOn && fulfilment === 'delivery') {
          if (!deliveryAddress || !deliveryAddress.trim()) {
                  return res.status(400).json({ error: 'Please enter where you would like your order delivered.' });
          }
          resolvedFulfilment = 'delivery';
          resolvedDeliveryAddress = deliveryAddress.trim();
    }

  for (const opt of item.options || []) {
        const chosenLabel = options && options[opt.name];
        if (!chosenLabel) {
                return res.status(400).json({ error: `Please choose an option for ${opt.name}` });
        }
        if (opt.allowOther && chosenLabel !== 'Other' && !findChoice(opt, chosenLabel)) {
                continue;
        }
        if (chosenLabel === 'Other') continue;
        const choice = findChoice(opt, chosenLabel);
        if (!choice) {
                return res.status(400).json({ error: `Unknown choice for ${opt.name}` });
        }
        if ((choice.stock || 0) <= 0) {
                return res.status(409).json({ error: `Sorry, ${choice.label} just sold out. Please pick another option and try again.` });
        }
  }

  const optionsText = options
      ? Object.entries(options).map(([k, v]) => `${k}: ${v}`).join(', ')
        : '';

  const order = {
        id: crypto.randomUUID(),
        site: site.id,
        name: name.trim(),
        email: email.trim(),
        mobile: mobile.trim(),
        itemId: item.id,
        itemName: item.name,
        optionsText,
        slot,
        fulfilment: resolvedFulfilment,
        deliveryAddress: resolvedDeliveryAddress,
        dateKey: resolvedForDate,
        placedDateKey: todayKeyValue,
        placedAt: new Date().toISOString(),
        status: 'placed',
        marketingOptIn: !!marketingOptIn,
        paymentEnvironment: square.isProduction() ? 'production' : 'sandbox'
  };

  if (square.isConfigured()) {
        try {
                const amountPence = Math.round(item.price * 100);
                const dateNote = isForToday ? '' : ` on ${resolvedForDate}`;
                const fulfilmentNote = order.fulfilment === 'delivery'
                  ? `deliver to ${order.deliveryAddress}${dateNote}`
                          : `collection ${slot}${dateNote}`;
                const payment = await square.createPayment({
                          sourceId,
                          amountPence,
                          idempotencyKey: order.id,
                          note: `${item.name} - ${order.name} - ${fulfilmentNote}`
                });
                order.status = 'paid';
                order.squarePaymentId = payment.id;
        } catch (err) {
                return res.status(402).json({ error: `Payment failed: ${err.message}` });
        }
  }

  // Re-read fresh in case an admin edit landed in between, then decrement stock.
  const freshMenu = await store.readMenu();
    const freshSite = getSite(freshMenu, site.id);
    const freshItem = freshSite.items.find(i => i.id === item.id);
    for (const opt of freshItem.options || []) {
          const chosenLabel = options && options[opt.name];
          if (!chosenLabel || chosenLabel === 'Other') continue;
          const choice = findChoice(opt, chosenLabel);
          if (choice && choice.stock > 0) {
                  choice.stock -= 1;
          }
    }
    delete freshSite.id;
    freshMenu.sites[site.id] = freshSite;
    await store.writeMenu(freshMenu);

  const orders = await store.readOrders();
    orders.push(order);
    await store.writeOrders(orders);

  // Confirmation email to the customer (never blocks the order).
  try {
    await sendCustomerConfirmation({ to: order.email, order, siteLabel: site.label, totalPrice: item.price });
  } catch (err) {
    console.error('Customer confirmation email failed:', err.message);
  }
  
  res.json({ ok: true, order });
}

async function handleCartOrder(req, res, site) {
    const { name, email, mobile, items, sourceId, forDate, marketingOptIn } = req.body || {};

  if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Name is required' });
  }
    if (!email || !/^\S+@\S+\.\S+$/.test(email.trim())) {
          return res.status(400).json({ error: 'A valid email is required' });
    }
    const todayKeyValue = todayKey(site.settings.timezone);
    const resolvedForDate = forDate || todayKeyValue;
    if (!slots.isForDateValid(site, resolvedForDate)) {
          return res.status(400).json({
                  error: 'That date is no longer available to order for - please pick another.',
                  forDates: slots.getSelectableForDates(site)
          });
    }
    const isForToday = resolvedForDate === todayKeyValue;
    if (!Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ error: 'Please add at least one item' });
    }
    if (square.isConfigured() && !sourceId) {
          return res.status(400).json({ error: 'Payment details are required' });
    }

  const lines = [];
    let totalPence = 0;
    for (const line of items) {
          const qty = parseInt(line.qty, 10);
          if (!qty || qty < 1) {
                  return res.status(400).json({ error: 'Invalid quantity' });
          }
          const menuItem = site.items.find(i => i.id === line.itemId && i.active);
          if (!menuItem) {
                  return res.status(400).json({ error: 'Unknown or unavailable item in basket' });
          }
          if ((menuItem.stock || 0) < qty) {
                  return res.status(409).json({ error: `Sorry, ${menuItem.name} doesn't have ${qty} left. Please adjust your basket.` });
          }
          lines.push({ itemId: menuItem.id, name: menuItem.name, qty, price: menuItem.price });
          totalPence += Math.round(menuItem.price * 100) * qty;
    }

  const order = {
        id: crypto.randomUUID(),
        site: site.id,
        name: name.trim(),
        email: email.trim(),
        mobile: mobile ? mobile.trim() : '',
        items: lines,
        totalPrice: totalPence / 100,
        dateKey: resolvedForDate,
        placedDateKey: todayKeyValue,
        placedAt: new Date().toISOString(),
        status: 'placed',
        marketingOptIn: !!marketingOptIn,
        paymentEnvironment: square.isProduction() ? 'production' : 'sandbox'
  };

  if (square.isConfigured()) {
        try {
                const payment = await square.createPayment({
                          sourceId,
                          amountPence: totalPence,
                          idempotencyKey: order.id,
                          note: `On-Site Cafe - ${order.name} - ${lines.map(l => `${l.qty}x ${l.name}`).join(', ')}${isForToday ? '' : ' - for ' + resolvedForDate}`.slice(0, 500)
                });
                order.status = 'paid';
                order.squarePaymentId = payment.id;
        } catch (err) {
                return res.status(402).json({ error: `Payment failed: ${err.message}` });
        }
  }

  const freshMenu = await store.readMenu();
    const freshSite = getSite(freshMenu, site.id);
    for (const line of lines) {
          const freshItem = freshSite.items.find(i => i.id === line.itemId);
          if (freshItem && freshItem.stock >= line.qty) {
                  freshItem.stock -= line.qty;
          }
    }
    delete freshSite.id;
    freshMenu.sites[site.id] = freshSite;
    await store.writeMenu(freshMenu);

  const orders = await store.readOrders();
    orders.push(order);
    await store.writeOrders(orders);

  let ticket = { attempted: false };
    if (isForToday && site.ticketMode === 'immediate' && square.isConfigured()) {
          try {
                  const squareOrder = await square.createCafeTicket({ order, dateLabel: todayLabel(site.settings.timezone) });
                  ticket = { attempted: true, sent: true, squareOrderId: squareOrder.id };
                  order.ticketPrinted = true;
          } catch (err) {
                  ticket = { attempted: true, sent: false, error: err.message };
                  console.error('On-Site Cafe ticket failed:', err.message);
          }
    } else if (!isForToday) {
          ticket = { attempted: false, deferred: true, forDate: resolvedForDate };
          order.ticketPrinted = false;
    }

  // Email backup of every cafe order to The Outlook inbox — a missed or failed
  // till print never loses an order this way.
  try {
    await sendCafeOrderEmail({
      to: site.settings.orderEmailTo || 'theoutlookatfoxs@gmail.com',
      order,
      ticket,
      dateLabel: todayLabel(site.settings.timezone)
    });
  } catch (err) {
    console.error('On-Site Cafe backup email failed:', err.message);
  }

  // Confirmation email to the customer (never blocks the order).
  try {
    await sendCustomerConfirmation({ to: order.email, order, siteLabel: site.label, totalPrice: order.totalPrice });
  } catch (err) {
    console.error('Customer confirmation email failed:', err.message);
  }

  const allOrders = await store.readOrders();
    const idx = allOrders.findIndex(o => o.id === order.id);
    if (idx !== -1) { allOrders[idx] = order; await store.writeOrders(allOrders); }

  res.json({ ok: true, order, ticket });
}

// One-click unsubscribe from marketing/reminder emails. Link is signed with an HMAC
// so addresses can't be unsubscribed by guessing the URL.
app.get('/api/unsubscribe', async (req, res) => {
  try {
    const email = String(req.query.email || '').toLowerCase();
    const sig = String(req.query.sig || '');
    if (!email || sig !== unsubscribeSig(email)) {
      return res.status(400).send('This unsubscribe link is not valid.');
    }
    const orders = await store.readOrders();
    let changed = 0;
    for (const o of orders) {
      if ((o.email || '').toLowerCase() === email && o.marketingOptIn) {
        o.marketingOptIn = false;
        changed += 1;
      }
    }
    if (changed > 0) await store.writeOrders(orders);
    res.send('Done — you will no longer receive order reminders from The Outlook.');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- admin endpoints ----------

app.post('/api/admin/login', async (req, res) => {
    try {
          const menu = await store.readMenu();
          if (req.body && req.body.password === menu.adminPassword) {
                  return res.json({ ok: true });
          }
          res.status(401).json({ ok: false });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

// ---------- admin password recovery ----------

app.post('/api/admin/forgot-password', async (req, res) => {
    try {
          const menu = await store.readMenu();
          const token = crypto.randomBytes(24).toString('hex');
          menu.passwordReset = { token, expiresAt: Date.now() + 30 * 60 * 1000 };
          await store.writeMenu(menu);

      const origin = `${req.protocol}://${req.get('host')}`;
          const resetUrl = `${origin}/admin.html?reset=${token}`;
          const result = await sendPasswordResetEmail({ resetUrl });
          res.json({ ok: true, dryRun: !!result.dryRun });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/reset-password', async (req, res) => {
    try {
          const { token, newPassword } = req.body || {};
          if (!newPassword || newPassword.length < 4) {
                  return res.status(400).json({ error: 'Choose a password of at least 4 characters.' });
          }
          const menu = await store.readMenu();
          const reset = menu.passwordReset;
          if (!reset || !token || reset.token !== token) {
                  return res.status(400).json({ error: 'This reset link is invalid. Request a new one.' });
          }
          if (Date.now() > reset.expiresAt) {
                  return res.status(400).json({ error: 'This reset link has expired. Request a new one.' });
          }
          menu.adminPassword = newPassword;
          delete menu.passwordReset;
          await store.writeMenu(menu);
          res.json({ ok: true });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/menu', requireAdmin, async (req, res) => {
    try {
          const menu = await store.readMenu();
          const site = getSite(menu, req.query.site);
          if (!site) return res.status(404).json({ error: 'Unknown site' });
          res.json({ ...site, adminPassword: menu.adminPassword });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.put('/api/admin/menu', requireAdmin, async (req, res) => {
    try {
          const incoming = req.body;
          const siteId = req.query.site || DEFAULT_SITE;
          if (!incoming || !Array.isArray(incoming.items) || !incoming.settings) {
                  return res.status(400).json({ error: 'Invalid menu payload' });
          }
          const menu = await store.readMenu();
          if (incoming.adminPassword) {
                  menu.adminPassword = incoming.adminPassword;
          }
          const { adminPassword, id, ...siteData } = incoming;
          menu.sites[siteId] = siteData;
          await store.writeMenu(menu);
          res.json({ ok: true });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/orders', requireAdmin, async (req, res) => {
    try {
          const menu = await store.readMenu();
          const siteId = req.query.site || DEFAULT_SITE;
          const site = getSite(menu, siteId);
          const key = req.query.date || todayKey(site ? site.settings.timezone : 'Europe/London');
          const allOrders = await store.readOrders();
          const orders = allOrders.filter(o => (o.site || DEFAULT_SITE) === siteId && o.dateKey === key);
          res.json({ date: key, orders });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.get('/api/admin/upcoming-orders', requireAdmin, async (req, res) => {
    try {
          const menu = await store.readMenu();
          const siteId = req.query.site || DEFAULT_SITE;
          const site = getSite(menu, siteId);
          const todayKeyValue = todayKey(site ? site.settings.timezone : 'Europe/London');
          const allOrders = await store.readOrders();
          const orders = allOrders
            .filter(o => (o.site || DEFAULT_SITE) === siteId && o.dateKey > todayKeyValue)
            .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.placedAt.localeCompare(b.placedAt));
          res.json({ today: todayKeyValue, orders });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

app.post('/api/admin/send-summary', requireAdmin, async (req, res) => {
    try {
          const { slot } = req.body || {};
          const menu = await store.readMenu();
          const site = getSite(menu, DEFAULT_SITE);
          const targetSlot = slot || site.settings.collection1;
          const result = await compileAndSend(targetSlot);
          res.json(result);
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
});

module.exports = { app, compileAndSend, runCafeMorningJob, getSite, todayKey };
