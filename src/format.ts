const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

export const fmtInt = (value: number) => integer.format(value);

export function fmtBtc(sats: number, digits: number): string {
  return (sats / 1e8).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtUsd(dollars: number): string {
  if (dollars >= 1e9) return `$${(dollars / 1e9).toFixed(2)}B`;
  if (dollars >= 1e6) return `$${(dollars / 1e6).toFixed(2)}M`;
  return `$${integer.format(Math.round(dollars))}`;
}

export function fmtPercent(part: number, whole: number, digits = 2): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(digits)}%` : '0%';
}

/** "24 Jun" in the visitor's time zone. */
export function fmtDay(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${date.getDate()} ${MONTHS[date.getMonth()] ?? ''}`;
}

/** "08:40" in the visitor's time zone. */
export function fmtClock(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fmtAgo(unixSeconds: number, nowSeconds: number): string {
  const seconds = Math.max(0, nowSeconds - unixSeconds);
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
