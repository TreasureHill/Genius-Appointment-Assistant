export function smsSegments(body: string): number {
  const isUnicode = /[^\x00-\x7F]/.test(body);
  if (isUnicode) {
    if (body.length <= 70) return 1;
    return Math.ceil(body.length / 67);
  }
  if (body.length <= 160) return 1;
  return Math.ceil(body.length / 153);
}
