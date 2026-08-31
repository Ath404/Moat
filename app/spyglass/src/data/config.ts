/**
 * Deployment constants.
 *
 * Every value here is public — a program id, a devnet RPC URL, a vault address
 * that anyone can read off the chain. They are compiled into the client bundle
 * either way, so the only thing an environment variable buys is the ability to
 * repoint a build at another cluster without editing source.
 *
 * That is worth having, but it must not be *load-bearing*. `.env` is gitignored,
 * so a CI or Vercel build that has not had the variables copied into it would
 * otherwise ship a site with sending disabled and an empty vault field, which is
 * exactly the failure the live deployment had. So: env when present, the real
 * devnet deployment when not. The site works with no configuration at all.
 */

const env = import.meta.env as Record<string, string | undefined>;

const pick = (key: string, fallback: string): string => {
  const v = env[key];
  return v && v.trim().length > 0 ? v.trim() : fallback;
};

/**
 * Devnet, deliberately.
 *
 * Not `api.mainnet-beta.solana.com`: that endpoint answers the CORS preflight
 * happily and then returns 403 on the actual POST whenever an `Origin` header is
 * present, so from a browser it fails every time. Devnet's public RPC does serve
 * browser origins — and it is where the program and vault below actually live,
 * so pointing anywhere else would read the right addresses on the wrong cluster
 * and report them as missing.
 */
export const RPC_URL = pick("VITE_RPC_URL", "https://api.devnet.solana.com");

/** `moat` as deployed to devnet, 2026-08-30. */
export const PROGRAM_ID = pick("VITE_PROGRAM_ID", "FResswSN9ZiV6mCfhWJHowDY354km4cEgBXTYb1Ro7MQ");

/**
 * The first vault opened under that program.
 * tx FNHfERB1PEBUmiqYmqXaRpLFE93bDANVbVBFHwazyKWokVdLHdcGRwv7x6bzRisWE6PF1G9fnjRWC2MVtLcCife
 */
export const VAULT_ADDRESS = pick("VITE_VAULT", "BwBpUVTbzQCw5Xo7E6LHZTchJTPXcVZTw3KBAGBnXzQx");

/** The cluster these addresses belong to. Used to label the UI honestly. */
export const CLUSTER = "devnet";
