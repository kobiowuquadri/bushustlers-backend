export const BUSINESS_CATEGORIES = {
  fashion: 'Fashion and clothing',
  beauty: 'Beauty and personal care',
  food: 'Food and drinks',
  home: 'Home and living',
  electronics: 'Phones and electronics',
  crafts: 'Art and crafts',
  services: 'Services',
  other: 'Other',
} as const;

export type BusinessCategory = keyof typeof BUSINESS_CATEGORIES;

export const SETTLEMENT_PREFERENCES = {
  naira: { label: 'Naira to a Nigerian bank account', available: true },
  stablecoin: { label: 'Keep stablecoin balance', available: false },
} as const;

// "Amaka Clothing" => "AMK": first letter plus the next consonants of the first word, then other words.
export const suggestOrderPrefix = (businessName: string) => {
  const words = businessName.toUpperCase().replace(/[^A-Z ]/g, ' ').split(/\s+/).filter(Boolean);
  if (!words.length) return 'ORD';
  const [first, ...rest] = words;
  let prefix = first[0];
  for (const char of first.slice(1)) {
    if (prefix.length === 3) break;
    if (!'AEIOU'.includes(char)) prefix += char;
  }
  for (const word of rest) {
    if (prefix.length === 3) break;
    prefix += word[0];
  }
  return prefix.padEnd(3, 'X').slice(0, 3);
};
