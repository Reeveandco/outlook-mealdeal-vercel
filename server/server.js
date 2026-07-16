// Local-dev / traditional-hosting entry point ONLY. On Vercel this file is never
// executed — Vercel calls api/[...path].js directly per-request instead, and the
// three scheduled jobs run via api/cron/*.js hit by an external scheduler rather
// than this file's node-cron block. Keeping node-cron here too means you can still
// run/test this exact codebase locally (or on any normal always-on host) with
// `npm start` and get working scheduled jobs without needing an external pinger.

require('dotenv').config();
const cron = require('node-cron');

const { app, compileAndSend, runCafeMorningJob, getSite } = require('./app');
const store = require('./store');

const PORT = process.env.PORT || 3000;

function startLocalScheduler() {
  cron.schedule('30 9 * * *', async () => {
    try {
      const menu = await store.readMenu();
      const site = getSite(menu, 'grabgo');
      await compileAndSend(site.settings.collection1);
    } catch (err) { console.error('09:30 email failed:', err); }
  }, { timezone: 'Europe/London' });

  cron.schedule('30 11 * * *', async () => {
    try {
      const menu = await store.readMenu();
      const site = getSite(menu, 'grabgo');
      await compileAndSend(site.settings.collection2);
    } catch (err) { console.error('11:30 email failed:', err); }
  }, { timezone: 'Europe/London' });

  cron.schedule('45 6 * * *', async () => {
    try {
      await runCafeMorningJob();
    } catch (err) { console.error('06:45 café morning job failed:', err); }
  }, { timezone: 'Europe/London' });
}

startLocalScheduler();

app.listen(PORT, () => {
  console.log(`Outlook meal deal server (local/traditional-hosting mode) running on http://localhost:${PORT}`);
});

module.exports = app;
