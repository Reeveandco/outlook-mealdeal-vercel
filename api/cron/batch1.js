// Trigger this at exactly 09:30 Europe/London from an external scheduler (e.g. a
// free cron-job.org job) — GET this URL with header "x-cron-secret: <CRON_SECRET>"
// (or ?secret=<CRON_SECRET> query string if the scheduler can't set headers).
// Sends the Grab & Go 10:30-collection order summary email + till ticket.

const { compileAndSend, getSite } = require('../../server/app');
const store = require('../../server/store');
const { checkCronSecret } = require('../../server/cronAuth');

module.exports = async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  try {
    const menu = await store.readMenu();
    const site = getSite(menu, 'grabgo');
    const result = await compileAndSend(site.settings.collection1);
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
