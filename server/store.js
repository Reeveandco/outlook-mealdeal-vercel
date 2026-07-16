// MongoDB-backed persistence — swapped in to replace the original local-JSON-file
// version so this can run on stateless hosting (Vercel), where the filesystem isn't
// writable/shared between invocations.
//
// Requires MONGODB_URI as an environment variable (a MongoDB Atlas free-tier cluster
// is fine). Data lives in a database called "outlookMealdeal" (override with
// MONGODB_DB_NAME) with two collections:
//   - "singletons"  -> one document (_id: "menu") holding the whole menu/settings blob,
//                       exactly the same shape as the old menu.json file.
//   - "orders"      -> one document per order, exactly the same shape as the old
//                       orders.json array entries.
//
// Every exported function is now ASYNC (returns a Promise) because Mongo calls are
// asynchronous — every call site in server/app.js awaits these.

const { MongoClient } = require('mongodb');

const DB_NAME = process.env.MONGODB_DB_NAME || 'outlookMealdeal';
const MENU_DOC_ID = 'menu';

let clientPromise = null;

function getClient() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI environment variable is not set — cannot connect to MongoDB.');
  }
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, {
      maxPoolSize: 5 // serverless functions should keep connection pools small
    });
    clientPromise = client.connect();
  }
  return clientPromise;
}

async function getDb() {
  const client = await getClient();
  return client.db(DB_NAME);
}

// Seed data used only the very first time this runs against a brand-new, empty
// database — mirrors the original server/data/menu.json starting content so a
// fresh Atlas cluster behaves the same as a fresh local install.
const DEFAULT_MENU = require('./data/menu.json');

async function readMenu() {
  const db = await getDb();
  const doc = await db.collection('singletons').findOne({ _id: MENU_DOC_ID });
  if (!doc) {
    // First run against an empty database — seed it, then return the seed.
    const seed = { _id: MENU_DOC_ID, ...DEFAULT_MENU };
    await db.collection('singletons').insertOne(seed);
    const { _id, ...menu } = seed;
    return menu;
  }
  const { _id, ...menu } = doc;
  return menu;
}

async function writeMenu(menu) {
  const db = await getDb();
  await db.collection('singletons').replaceOne(
    { _id: MENU_DOC_ID },
    { _id: MENU_DOC_ID, ...menu },
    { upsert: true }
  );
}

async function readOrders() {
  const db = await getDb();
  const docs = await db.collection('orders').find({}).sort({ placedAt: 1 }).toArray();
  return docs.map(({ _id, ...rest }) => rest);
}

// Orders are always written back as the FULL array (matches the old file-based
// store's contract — every call site does read-modify-write on the whole list) —
// so we upsert everything present, then delete anything no longer in the array,
// to mirror the old "overwrite the whole file" behaviour exactly.
async function writeOrders(orders) {
  const db = await getDb();
  const coll = db.collection('orders');
  if (orders.length > 0) {
    const bulk = orders.map(order => ({
      replaceOne: {
        filter: { id: order.id },
        replacement: order,
        upsert: true
      }
    }));
    await coll.bulkWrite(bulk);
  }
  const idsToKeep = orders.map(o => o.id);
  await coll.deleteMany({ id: { $nin: idsToKeep.length ? idsToKeep : ['__none__'] } });
}

module.exports = { readMenu, writeMenu, readOrders, writeOrders };
