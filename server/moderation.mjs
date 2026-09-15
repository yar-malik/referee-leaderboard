// First-line moderation for comments. Returns a message explaining the refusal, or null when the text is fine.
// It's deliberately blunt: reports from readers and the admin endpoints handle what this misses.

const RULES = [
  // Slurs (stems, matched with common letter swaps). Zero tolerance.
  [/\bn+[i1!|y]+[gq]+(?:[e3]+r+|[a@]+h?|[e3]+r+[sz]|[a@]+[sz]|u?h?s?)\b/i, 'Slurs are not allowed.'],
  [/\bf+[a@4]+[gq]+(?:[o0]+[t7]+|[sz]|\b)/i, 'Slurs are not allowed.'],
  [/\b(?:p[a@]ki|sp[i1]c|ch[i1]nk|k[i1]ke|g[o0][o0]k|w[o0]g|c[o0][o0]n|tr[a@]nn(?:y|ie)|r[e3]t[a@]rd(?:ed|s)?)\b/i, 'Slurs are not allowed.'],
  [/\b(?:monkey|banana)s?\b.*\b(?:player|him|his|black)\b|\b(?:black|player)\b.*\b(?:monkey|banana)s?\b/i, 'Racist abuse is not allowed.'],
  // Threats and self-harm incitement.
  [/\b(?:kys|kill (?:your|him|her|them)sel(?:f|ves)|(?:hope|wish) (?:he|she|they|you|the ref)\w* (?:dies|die|gets? cancer)|should be (?:shot|killed|hanged)|find where (?:he|she|they) li?ves?)\b/i, 'Threats and wishing harm on people are not allowed.'],
  // Allegations of dishonesty against officials: criticise the call, not someone's integrity.
  [/\b(?:corrupt(?:ion|ed)?|bent (?:ref\w*|officials?|var|linesm[ae]n|pgmol|pro ref)|(?:ref\w*|officials?|var|pgmol|pro ref) (?:is|are|was|were) bent|bribe[ds]?|brib(?:ery|ing)|paid off|on the take|match[- ]?fix(?:ing|ed)?|fixed (?:game|match)|rigged)\b/i, "Criticise the decision, not someone's honesty. Claims that officials are corrupt or bribed aren't allowed."],
];

export const moderate = (text, { name = false, max = name ? 24 : 600 } = {}) => {
  if (!name && text.length < 3) return 'Say a little more.';
  if (text.length > max) return `Keep it under ${max} characters.`;
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|uk|ly|gg|tv|me)\b/i.test(text)) return 'Links are not allowed.';
  if (/(.)\1{9,}/.test(text)) return "That looks like spam.";
  if (!name && text.replace(/[^A-Z]/g, '').length > 40 && text === text.toUpperCase()) return 'Easy on the caps lock.';
  for (const [rx, message] of RULES) if (rx.test(text)) return message;
  return null;
};
