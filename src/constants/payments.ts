// Stablecoins and networks documented by Busha (docs.busha.io/guides/reference/supported-currencies).
// Checkout offers only the configured subset (BUSHA_STABLECOIN_OPTIONS) of this list.
export const DOCUMENTED_STABLECOIN_NETWORKS: Record<string, Record<string, string>> = {
  USDT: { BSC: 'BNB Smart Chain (BEP-20)', ETH: 'Ethereum (ERC-20)', TRX: 'Tron (TRC-20)', SOL: 'Solana' },
  USDC: { BASE: 'Base', ETH: 'Ethereum (ERC-20)', TRX: 'Tron (TRC-20)', XLM: 'Stellar', SOL: 'Solana' },
};

export const ASSET_NAMES: Record<string, string> = {
  USDT: 'Tether USD',
  USDC: 'USD Coin',
};

export interface StablecoinOption {
  asset: string;
  network: string;
  label: string;
  networkLabel: string;
}

export const parseStablecoinOptions = (raw: string): { options: StablecoinOption[]; rejected: string[] } => {
  const options: StablecoinOption[] = [];
  const rejected: string[] = [];
  for (const entry of raw.split(',').map((item) => item.trim()).filter(Boolean)) {
    const [asset = '', network = ''] = entry.toUpperCase().split(':');
    const networkLabel = DOCUMENTED_STABLECOIN_NETWORKS[asset]?.[network];
    if (!networkLabel) {
      rejected.push(entry);
      continue;
    }
    if (!options.some((o) => o.asset === asset && o.network === network)) {
      options.push({ asset, network, networkLabel, label: `${asset} on ${networkLabel}` });
    }
  }
  return { options, rejected };
};

// Attempt statuses that still expect provider activity.
export const ACTIVE_ATTEMPT_STATUSES = ['creating', 'awaiting_payment', 'processing'] as const;
// Closed attempts are still watched for late funds for this long.
export const LATE_FUNDS_WATCH_HOURS = 48;

export const REVIEW_REASON_TEXT: Record<string, string> = {
  underpayment: 'Less than the order total was received.',
  overpayment: 'More than the order total was received.',
  multiple_deposits: 'More than one deposit was made for this payment.',
  late_payment: 'Funds arrived after the payment instructions had expired or were closed.',
  duplicate_payment: 'This order was already paid by another payment.',
  currency_mismatch: 'The payment arrived in a different currency than expected.',
  reference_mismatch: 'The provider reported a reference that does not match this order.',
};
