// Vercel serverless entry point. This single catch-all function handles every
// request under /api/* (Vercel's file-system router maps /api/[...path].js to
// any path starting with /api/) by handing it straight to the Express app.
//
// Static files (order.html, admin.html, onsite-order.html, styles.css, logos) are
// served automatically by Vercel from the top-level /public folder and never hit
// this function at all — only the JSON API calls do.

const { app } = require('../server/app');

module.exports = (req, res) => app(req, res);
