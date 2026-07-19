const stopWords = new Set([
  "the", "and", "for", "from", "with", "without", "that", "this", "into", "while", "same",
  "fix", "task", "change", "changing", "preserve", "correct", "existing", "public", "produces",
  "receives", "including", "users", "have", "has", "one", "its", "not", "run"
]);

export function searchTokens(text) {
  const expanded = String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./\\-]+/g, " ")
    .toLowerCase();
  return [...new Set(expanded.match(/[\p{L}\p{N}]+/gu) ?? [])]
    .filter((token) => token.length >= 2 && !stopWords.has(token));
}

export function estimateTokens(value) {
  return Math.ceil(Buffer.byteLength(String(value), "utf8") / 4);
}
