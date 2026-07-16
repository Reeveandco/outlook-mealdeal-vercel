// Thin wrapper around Square's REST API — no SDK dependency, just fetch (Node 18+ has it built in).
// Reads credentials from environment variables (see .env). Switches between Sandbox and
// Production based on SQUARE_ENV.

function isProduction() {
  return (process.env.SQUARE_ENV || 'sandbox').toLowerCase() === 'production';
}

function baseUrl() {
  return isProduction()
    ? 'https://connect.squareup.com/v2'
    : 'https://connect.squareupsandbox.com/v2';
}

function accessToken() {
  return isProduction()
    ? process.env.SQUARE_ACCESS_TOKEN
    : process.env.SQUARE_SANDBOX_ACCESS_TOKEN;
}

function applicationId() {
  return isProduction()
    ? process.env.SQUARE_APPLICATION_ID
    : process.env.SQUARE_SANDBOX_APPLICATION_ID;
}

function locationId() {
  return isProduction()
    ? process.env.SQUARE_LOCATION_ID
    : process.env.SQUARE_SANDBOX_LOCATION_ID;
}

function isConfigured() {
  return Boolean(accessToken() && applicationId() && locationId());
}

function publicConfig() {
  return {
    environment: isProduction() ? 'production' : 'sandbox',
    applicationId: applicationId(),
    locationId: locationId(),
    configured: isConfigured()
  };
}

// amountPence: integer number of pence (Square wants the smallest currency unit)
async function createPayment({ sourceId, amountPence, idempotencyKey, note }) {
  if (!isConfigured()) {
    throw new Error('Square is not configured yet (missing access token / application id / location id).');
  }
  const res = await fetch(`${baseUrl()}/payments`, {
    method: 'POST',
    headers: {
      'Square-Version': '2026-05-20',
      'Authorization': `Bearer ${accessToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      amount_money: { amount: amountPence, currency: 'GBP' },
      location_id: locationId(),
      note
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = (data.errors || []).map(e => e.detail).join('; ') || 'Square payment failed';
    throw new Error(detail);
  }
  return data.payment;
}

// Creates ONE consolidated Square Order for a whole batch of customer orders (e.g. everything
// collecting at 10:30), so the till prints a single ticket covering the full batch rather than
// one ticket per person. Relies on the Square Register/Terminal's own printer profile having
// "Online and kiosk order tickets" -> "Automatically Print New Orders" turned on (Settings ->
// Hardware -> Printers on the till) — see README for the exact steps.
async function createBatchOrder({ orders, slot, dateLabel }) {
  if (!isConfigured()) {
    throw new Error('Square is not configured yet (missing access token / application id / location id).');
  }
  const lineItems = orders.map(o => {
    const fulfilmentTag = o.fulfilment === 'delivery'
      ? ` — DELIVER TO: ${o.deliveryAddress}`
      : '';
    return {
      name: o.itemName,
      quantity: '1',
      note: `${o.name}${o.mobile ? ' (' + o.mobile + ')' : ''} — ${o.optionsText}${fulfilmentTag}`.slice(0, 500)
    };
  });

  const res = await fetch(`${baseUrl()}/orders`, {
    method: 'POST',
    headers: {
      'Square-Version': '2026-05-20',
      'Authorization': `Bearer ${accessToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      idempotency_key: `grabgo-${slot}-${dateLabel}`.replace(/[^a-zA-Z0-9-]/g, '-'),
      order: {
        location_id: locationId(),
        reference_id: `grabgo-${dateLabel}-${slot}`,
        line_items: lineItems
      }
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = (data.errors || []).map(e => e.detail).join('; ') || 'Square order creation failed';
    throw new Error(detail);
  }
  return data.order;
}

// Creates a Square Order for a SINGLE customer order the moment it's placed (used by the
// On-Site Café menu, which prints per-order rather than batching twice a day like Grab & Go).
// One line per distinct item in their basket, e.g. "2x Cappuccino", "1x Bacon Roll".
async function createCafeTicket({ order, dateLabel }) {
  if (!isConfigured()) {
    throw new Error('Square is not configured yet (missing access token / application id / location id).');
  }
  const lineItems = (order.items || []).map(line => ({
    name: line.name,
    quantity: String(line.qty),
    note: `${order.name}${order.mobile ? ' (' + order.mobile + ')' : ''}`.slice(0, 500)
  }));

  const res = await fetch(`${baseUrl()}/orders`, {
    method: 'POST',
    headers: {
      'Square-Version': '2026-05-20',
      'Authorization': `Bearer ${accessToken()}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      idempotency_key: `onsite-${order.id}`.replace(/[^a-zA-Z0-9-]/g, '-'),
      order: {
        location_id: locationId(),
        reference_id: `onsite-${dateLabel}-${order.id}`.slice(0, 40),
        line_items: lineItems
      }
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const detail = (data.errors || []).map(e => e.detail).join('; ') || 'Square order creation failed';
    throw new Error(detail);
  }
  return data.order;
}

module.exports = { isProduction, isConfigured, publicConfig, createPayment, createBatchOrder, createCafeTicket };
