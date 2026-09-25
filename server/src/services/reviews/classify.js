// Tags a review with the reps it mentions and whether it is Genius-related.
//
// Pure functions: the caller passes the reps (name + aliases) and the Genius
// terms, so the same code runs in the sync, in the "re-run matching" action,
// and in the tests without a database.
//
// Matching is whole-word and case-insensitive: "Jason" matches "Jason", "jason's"
// and "JASON!", but not "Jasonville". Multi-word aliases ("syed salman") match
// across any whitespace. Word boundaries are Unicode-aware so accented names
// work too.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeTerm(t) {
  return String(t || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function uniq(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (!x || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

// Not preceded or followed by a letter or digit.
function termRegex(term) {
  const body = escapeRegex(term).replace(/ /g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'iu');
}

// reps: [{ _id|id, name, aliases, active }], geniusTerms: [string],
// hintTerms: [string] — words that suggest a Genius job (smart-home gear) in a
// review that names nobody and never says "Genius"; they only flag the review
// as "possibly Genius" for a human to look at, never tag it.
function compileMatchers({ reps = [], geniusTerms = [], hintTerms = [] } = {}) {
  return {
    hints: uniq((hintTerms || []).map(normalizeTerm)).map((term) => ({ term, re: termRegex(term) })),
    reps: reps
      .filter((r) => r && r.active !== false)
      .map((r) => ({
        id: String(r._id || r.id),
        name: r.name,
        patterns: uniq([r.name, ...(r.aliases || [])].map(normalizeTerm)).map((alias) => ({
          alias,
          re: termRegex(alias),
        })),
      })),
    terms: uniq((geniusTerms || []).map(normalizeTerm)).map((term) => ({ term, re: termRegex(term) })),
  };
}

// → { reps: [repId], aliases: [alias hit], terms: [genius term hit], termHit, genius,
//     hints: [hint term hit], hint }
// A review is Genius-related when it uses a Genius term OR names any rep.
function classifyText(text, matchers) {
  const s = String(text || '');
  const reps = [];
  const aliases = [];
  const terms = [];
  const hints = [];
  for (const rep of matchers.reps) {
    const hits = rep.patterns.filter((p) => p.re.test(s)).map((p) => p.alias);
    if (hits.length) {
      reps.push(rep.id);
      aliases.push(...hits);
    }
  }
  for (const t of matchers.terms) if (t.re.test(s)) terms.push(t.term);
  for (const h of matchers.hints || []) if (h.re.test(s)) hints.push(h.term);
  const termHit = terms.length > 0;
  return { reps, aliases, terms, termHit, genius: termHit || reps.length > 0, hints, hint: hints.length > 0 };
}

// The effective classification: the manual override wins wherever it is set.
//   manual.repsSet  → manual.reps replaces the matcher's reps (an empty list
//                     means "nobody", which is different from "no override")
//   manual.genius   → true / false forces the Genius flag; null inherits
// A review mapped to a rep by hand counts as Genius-related unless the
// Genius flag was explicitly forced off.
function effective(auto, manual) {
  const a = auto || {};
  const m = manual || {};
  const reps = (m.repsSet ? m.reps || [] : a.reps || []).map(String);
  const forced = m.genius === true || m.genius === false;
  const genius = forced ? m.genius : Boolean(a.termHit) || reps.length > 0;
  return { reps, genius, mappingSource: m.repsSet || forced ? 'manual' : 'auto' };
}

module.exports = { compileMatchers, classifyText, effective, normalizeTerm, termRegex };
