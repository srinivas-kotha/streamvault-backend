/**
 * Check if an IP address matches any entry in a list of IPs/CIDRs.
 * Supports: exact IPs (192.168.1.100), CIDR ranges (192.168.1.0/24), IPv4-mapped IPv6 (::ffff:192.168.1.1)
 */

function normalizeIP(ip: string): string {
  // Strip IPv4-mapped IPv6 prefix
  if (ip.startsWith('::ffff:')) return ip.slice(7);
  return ip;
}

function ipToLong(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function cidrMatch(ip: string, cidr: string): boolean {
  const [range, bitsStr] = cidr.split('/');
  if (!bitsStr) return ip === range; // Exact match
  const bits = parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
}

export function isIPTrusted(requestIP: string, trustedList: string[]): boolean {
  if (trustedList.length === 0) return false;
  const normalized = normalizeIP(requestIP);
  // Skip non-IPv4 addresses
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized)) return false;
  return trustedList.some(entry => cidrMatch(normalized, entry.trim()));
}
