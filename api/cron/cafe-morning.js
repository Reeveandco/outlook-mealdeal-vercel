// Trigger this at 06:45 Europe/London from an external scheduler.
// Prints till tickets for any On-Site Cafe orders placed in advance for today.

const { runCafeMorningJob } = require('../../server/jobs');
const { checkCronSecret } = require('../../server/cronAuth');

module.exports = async (req, res) => {
    if (!checkCronSecret(req, res)) return;
    try {
          const result = await runCafeMorningJob();
          res.json({ ok: true, ...result });
    } catch (err) {
          res.status(500).json({ error: err.message });
    }
};
