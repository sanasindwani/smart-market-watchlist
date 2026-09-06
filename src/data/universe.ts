/**
 * The searchable universe.
 *
 * Deliberately a hardcoded list rather than a live symbol-search API. NSE
 * has ~2000 listed names; a hackathon does not need all of them, and a
 * static list means search works offline and instantly. If this were going
 * to production the same interface would be backed by a `symbols` table
 * refreshed nightly from the exchange's own bhavcopy file.
 */

export type Listing = { symbol: string; name: string; sector: string };

export const UNIVERSE: Listing[] = [
  { symbol: "RELIANCE", name: "Reliance Industries", sector: "Energy" },
  { symbol: "TCS", name: "Tata Consultancy Services", sector: "IT" },
  { symbol: "INFY", name: "Infosys", sector: "IT" },
  { symbol: "WIPRO", name: "Wipro", sector: "IT" },
  { symbol: "HDFCBANK", name: "HDFC Bank", sector: "Banking" },
  { symbol: "ICICIBANK", name: "ICICI Bank", sector: "Banking" },
  { symbol: "SBIN", name: "State Bank of India", sector: "Banking" },
  { symbol: "AXISBANK", name: "Axis Bank", sector: "Banking" },
  { symbol: "KOTAKBANK", name: "Kotak Mahindra Bank", sector: "Banking" },
  { symbol: "BAJFINANCE", name: "Bajaj Finance", sector: "Financials" },
  { symbol: "ZOMATO", name: "Eternal (Zomato)", sector: "Consumer" },
  { symbol: "ITC", name: "ITC", sector: "Consumer" },
  { symbol: "HINDUNILVR", name: "Hindustan Unilever", sector: "Consumer" },
  { symbol: "TATAMOTORS", name: "Tata Motors", sector: "Auto" },
  { symbol: "MARUTI", name: "Maruti Suzuki", sector: "Auto" },
  { symbol: "TATASTEEL", name: "Tata Steel", sector: "Metals" },
  { symbol: "SUNPHARMA", name: "Sun Pharmaceutical", sector: "Pharma" },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", sector: "Telecom" },
  { symbol: "LT", name: "Larsen & Toubro", sector: "Infrastructure" },
  { symbol: "ADANIENT", name: "Adani Enterprises", sector: "Conglomerate" },
];

/** The benchmark. Polled like any other symbol, never shown in a watchlist. */
export const INDEX_SYMBOL = "NIFTY";
export const INDEX_NAME = "NIFTY 50";

export function search(q: string, limit = 8): Listing[] {
  const needle = q.trim().toUpperCase();
  if (!needle) return [];
  return UNIVERSE.filter(
    (l) =>
      l.symbol.includes(needle) || l.name.toUpperCase().includes(needle)
  ).slice(0, limit);
}

export function lookup(symbol: string): Listing | undefined {
  return UNIVERSE.find((l) => l.symbol === symbol.toUpperCase());
}
