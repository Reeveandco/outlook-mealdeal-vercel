// Trigger this at exactly 11:30 Europe/London from an external scheduler.
// Sends the Grab & Go 13:00-collection order summary email + till ticket.

const { compileAndSend, getSite } = require('../../server/app');
const store = require('../../server/store');
const { checkCronSecret } = require('../../server/cronAuth');

module.exports = async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  try {
    const menu = await store.readMenu();
    const site = getSite(menu, 'grabgo');
    const result = await compileAndSend(site.settings.collection2);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
