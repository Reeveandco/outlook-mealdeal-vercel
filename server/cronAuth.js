// Shared guard for the three /api/cron/* endpoints. These replace node-cron (which
// can't run persistently on Vercel's serverless functions) — an external scheduler
// (e.g. the free cron-job.org) hits these URLs at the exact times instead. Anyone
// who doesn't know CRON_SECRET gets a 401, so these can't be used to spam emails or
// print tickets by a stranger who finds the URL.

function checkCronSecret(req, res) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(500).json({ error: 'CRON_SECRET is not set on the server — refusing to run.' });
    return false;
  }
  const supplied = req.header('x-cron-secret') || req.query.secret;
  if (supplied !== expected) {
    res.status(401).json({ error: 'Invalid or missing cron secret' });
    return false;
  }
  return true;
}

module.exports = { checkCronSecret };
