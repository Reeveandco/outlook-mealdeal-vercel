// Thin wrapper around Square's REST API - no SDK dependency, just fetch (Node 18+ has it built in).
// Reads credentials from environment variables (see .env). Switches between Sandbox and
// Production based on SQUARE_ENV.
//
// WHY THE ORDER IS NOW CREATED *BEFORE* THE PAYMENT
// -------------------------------------------------
// Square only pushes an order through to the Point of Sale / Order Manager - and therefore
// only auto-prints a kitchen ticket - when that order BOTH carries a fulfilment AND is fully
// paid. The original build took the payment on its own, then separately created an unpaid
// order with no fulfilment purely to act as a "ticket". Square accepted that order happily
// (no API error) but never surfaced it on the till, which is why nothing ever printed and
// front of house was left thinking Square wasn't connected.
//
// The flow below is Square's intended "order ahead" pattern instead:
//   1. create the Order, with a PICKUP fulfilment and real line items
//   2. take the Payment against that order_id
// which makes the order land on the till properly, print, and show correct item-level
// figures in Square's sales reporting (previously every sale was just an untyped payment).

const SQUARE_VERSION = '2026-05-20';

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

async function squarePost(path, body) {
    const res = await fetch(`${baseUrl()}${path}`, {
          method: 'POST',
          headers: {
                  'Square-Version': SQUARE_VERSION,
                  'Authorization': `Bearer ${accessToken()}`,
                  'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) {
          const detail = (data.errors || []).map(e => e.detail).join('; ') || 'Square request failed';
          throw new Error(detail);
    }
    return data;
}

// Turns a wall-clock time in Europe/London (e.g. dateKey '2026-08-07' + '13:00') into a
// proper RFC3339 instant, working out GMT/BST for that actual date so pickup times don't
// land an hour out either side of the clock change.
function londonWallTimeToISO(dateKey, hhmm) {
    const [y, m, d] = String(dateKey).split('-').map(Number);
    const [hh, mi] = String(hhmm).split(':').map(Number);
    const guess = Date.UTC(y, m - 1, d, hh || 0, mi || 0, 0);
    const parts = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Europe/London', hour12: false,
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(guess));
    const get = t => Number(parts.find(p => p.type === t).value);
    const asIfUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return new Date(guess - (asIfUTC - guess)).toISOString();
}

// Grab & Go always has a fixed collection slot. The cafe takes same-day orders with no
// specific slot, so those are treated as "about 15 minutes from now".
function pickupAtFor(dateKey, hhmm) {
    if (!hhmm) return new Date(Date.now() + 15 * 60 * 1000).toISOString();
    return londonWallTimeToISO(dateKey, hhmm);
}

// Best-effort tidy-up: if the card is declined after we've already created the order,
// cancel it so it doesn't sit on the till as an unpaid ghost order.
async function cancelOrder(orderId, version) {
    try {
          await fetch(`${baseUrl()}/orders/${orderId}`, {
                  method: 'PUT',
                  headers: {
                            'Square-Version': SQUARE_VERSION,
                            'Authorization': `Bearer ${accessToken()}`,
                            'Content-Type': 'application/json'
                  },
                  body: JSON.stringify({
                            idempotency_key: `cancel-${orderId}`.slice(0, 45),
                            order: { location_id: locationId(), version, state: 'CANCELED' }
                  })
          });
    } catch (err) {
          console.error('Could not cancel abandoned Square order', orderId, err.message);
    }
}

// Creates the Square Order (with its PICKUP fulfilment) that the till will display and print.
//   lineItems: [{ name, qty, pricePence, note }]
//   pickup:    { name, phone, email, pickupAt, referenceId, note }
async function createPickupOrder({ lineItems, pickup, idempotencyKey }) {
    const data = await squarePost('/orders', {
          idempotency_key: `order-${idempotencyKey}`.slice(0, 45),
          order: {
                  location_id: locationId(),
                  reference_id: String(pickup.referenceId || idempotencyKey).slice(0, 40),
                  line_items: lineItems.map(l => ({
                            name: String(l.name).slice(0, 512),
                            quantity: String(l.qty || 1),
                            base_price_money: { amount: l.pricePence, currency: 'GBP' },
                            note: l.note ? String(l.note).slice(0, 500) : undefined
                  })),
                  fulfillments: [{
                            type: 'PICKUP',
                            state: 'PROPOSED',
                            pickup_details: {
                                        schedule_type: 'SCHEDULED',
                                        pickup_at: pickup.pickupAt,
                                        note: pickup.note ? String(pickup.note).slice(0, 500) : undefined,
                                        recipient: {
                                                      display_name: String(pickup.name || 'Online order').slice(0, 255),
                                                      phone_number: pickup.phone || undefined,
                                                      email_address: pickup.email || undefined
                                        }
                            }
                  }]
          }
    });
    return data.order;
}

// amountPence: integer number of pence (Square wants the smallest currency unit).
//
// Pass `lineItems` + `pickup` to get a real till order/ticket. Without them this behaves
// exactly as before - a bare payment with no order attached - so any caller that hasn't
// been updated still works.
//
// Taking the money is the priority: if building the ticket fails for any reason we log it
// and fall back to a plain payment rather than failing the customer's order.
async function createPayment({ sourceId, amountPence, idempotencyKey, note, lineItems, pickup }) {
    if (!isConfigured()) {
          throw new Error('Square is not configured yet (missing access token / application id / location id).');
    }

  let order = null;
    if (pickup && Array.isArray(lineItems) && lineItems.length) {
          try {
                  order = await createPickupOrder({ lineItems, pickup, idempotencyKey });
          } catch (err) {
                  console.error('Square order creation failed - taking payment without a till ticket:', err.message);
          }
    }

  // Square rejects a payment whose amount doesn't match the order it's attached to, so if
  // the two ever disagree we drop the link rather than fail the sale.
  if (order && order.id) {
        const orderTotal = order.total_money && order.total_money.amount;
        if (orderTotal !== amountPence) {
                console.error(`Square order total ${orderTotal} != payment amount ${amountPence} - paying without linking the order.`);
                await cancelOrder(order.id, order.version);
                order = null;
        }
  }

  const body = {
        source_id: sourceId,
        idempotency_key: idempotencyKey,
        amount_money: { amount: amountPence, currency: 'GBP' },
        location_id: locationId(),
        note
  };
    if (order && order.id) body.order_id = order.id;

  try {
        const data = await squarePost('/payments', body);
        const payment = data.payment;
        payment.squareOrderId = order ? order.id : null;
        return payment;
  } catch (err) {
        if (order && order.id) await cancelOrder(order.id, order.version);
        throw err;
  }
}

// Creates ONE consolidated Square Order for a whole batch of customer orders (e.g. everything
// collecting at 10:30). NOTE: kept for backwards compatibility, but with each individual order
// now going onto the till in its own right (see createPayment above) this is no longer used to
// drive printing - it would produce an unpaid, fulfilment-less order that the till ignores.
async function createBatchOrder({ orders, slot, dateLabel }) {
    if (!isConfigured()) {
          throw new Error('Square is not configured yet (missing access token / application id / location id).');
    }
    const lineItems = orders.map(o => {
          const fulfilmentTag = o.fulfilment === 'delivery'
            ? ` - DELIVER TO: ${o.deliveryAddress}`
                  : '';
          return {
                  name: o.itemName,
                  quantity: '1',
                  note: `${o.name}${o.mobile ? ' (' + o.mobile + ')' : ''} - ${o.optionsText}${fulfilmentTag}`.slice(0, 500)
          };
    });

  const data = await squarePost('/orders', {
        idempotency_key: `grabgo-${slot}-${dateLabel}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 45),
        order: {
                location_id: locationId(),
                reference_id: `grabgo-${dateLabel}-${slot}`.slice(0, 40),
                line_items: lineItems
        }
  });
    return data.order;
}

// Creates a Square Order for a SINGLE cafe order. Also superseded by createPayment's
// order-then-pay flow, kept so existing callers don't break.
async function createCafeTicket({ order, dateLabel }) {
    if (!isConfigured()) {
          throw new Error('Square is not configured yet (missing access token / application id / location id).');
    }
    const lineItems = (order.items || []).map(line => ({
          name: line.name,
          quantity: String(line.qty),
          note: `${order.name}${order.mobile ? ' (' + order.mobile + ')' : ''}`.slice(0, 500)
    }));

  const data = await squarePost('/orders', {
        idempotency_key: `onsite-${order.id}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 45),
        order: {
                location_id: locationId(),
                reference_id: `onsite-${dateLabel}-${order.id}`.slice(0, 40),
                line_items: lineItems
        }
  });
    return data.order;
}

module.exports = {
    isProduction,
    isConfigured,
    publicConfig,
    createPayment,
    createBatchOrder,
    createCafeTicket,
    createPickupOrder,
    pickupAtFor,
    londonWallTimeToISO
};
