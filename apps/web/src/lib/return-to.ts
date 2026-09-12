export function safeReturnTo(value: unknown, fallback = "/chat") {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\r\n]|%5c|%2f%2f/i.test(value)
  )
    return fallback;
  return value;
}
