const mongoose = require('mongoose');
const env = require('./env');

mongoose.set('strictQuery', true);

async function connect() {
  await mongoose.connect(env.mongoUrl, {
    serverSelectionTimeoutMS: 10_000,
  });
  console.log(`[db] connected to ${env.mongoUrl}`);
}

module.exports = { connect, mongoose };
