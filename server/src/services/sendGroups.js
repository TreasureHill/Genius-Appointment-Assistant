const mongoose = require('mongoose');

// A "send" is one lot × one channel × one round. The lot is the unit the app
// counts, paces and shows — not the individual buyer. Every Outbox and
// MessageLog row carries the id of the send group it belongs to (the email to
// all buyers, or the one text per phone that went out together). Rows written
// before this existed have no group and count as a group of one.

// Aggregation expression for the group key of a row.
const GROUP_KEY_EXPR = {
  $cond: [{ $eq: [{ $ifNull: ['$sendGroup', ''] }, ''] }, { $toString: '$_id' }, '$sendGroup'],
};

function groupKeyOf(row) {
  return row.sendGroup || String(row._id);
}

function newSendGroup() {
  return new mongoose.Types.ObjectId().toString();
}

module.exports = { GROUP_KEY_EXPR, groupKeyOf, newSendGroup };
