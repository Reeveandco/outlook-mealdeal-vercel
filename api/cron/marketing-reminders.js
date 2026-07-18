// Trigger this daily (e.g. 09:00 Europe/London) from an external scheduler.
// Emails opted-in customers who haven't ordered in 10+ days — one nudge per lapse.

const { runMarketingReminders } = require('../../server/jobs');
const { checkCronSecret } = require('../../server/cronAuth');

module.exports = async (req, res) => {
  if (!checkCronSecret(req, res)) return;
  try {
    const result = await runMarketingReminders();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
