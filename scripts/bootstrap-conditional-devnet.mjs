/**
 * Bootstrap helper for the conditional escrow buy devnet setup.
 *
 * Default mode is read-only:
 *   npm run bootstrap:conditional -- --pyth-feed <SOL_USD_PRICE_ACCOUNT>
 *
 * Mutating examples:
 *   npm run bootstrap:conditional -- --pyth-feed <SOL_USD_PRICE_ACCOUNT> --create-treasury-ata --init-vault-config --fund-sol-vault 0.2 --write-env-local
 *   npm run bootstrap:conditional -- --create-keeper ./.keys/conditional-keeper.json --enable-keeper --write-env-local
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const DEFAULT_PROGRAM_ID = 'FDwvY7eqeCNn27haATZJbqfnACJTr9YveG6yy9RcUt7u';
const ORCA_DEVNET_USDC_MINT = 'BRjpCHtyQLNCo8gqRUr8jtdAj5AjPYQaoqbvcZiHok1k';
const SOL_USD_FEED_ID = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
const DEFAULT_SOL_USD_FEED_ACCOUNT = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';

const VAULT_CONFIG_SEED = Buffer.from('vault-config');
const SOL_VAULT_SEED = Buffer.from('sol-vault');

function parseArgs(argv) {
  const getValue = (name) => {
    const index = argv.indexOf(name);
    if (index === -1) return undefined;
    return argv[index + 1];
  };
  const has = (name) => argv.includes(name);

  const rpcUrl = getValue('--rpc') || process.env.SOLANA_RPC_URL || DEFAULT_RPC_URL;
  const programId = new PublicKey(getValue('--program-id') || process.env.CONDITIONAL_ESCROW_BUY_PROGRAM_ID || DEFAULT_PROGRAM_ID);
  const adminKeypairPath = expandPath(getValue('--admin-keypair') || process.env.ANCHOR_WALLET || '~/.config/solana/id.json');
  const usdcMint = new PublicKey(getValue('--usdc-mint') || process.env.USDC_TEST_MINT || ORCA_DEVNET_USDC_MINT);
  const treasuryOwnerRaw = getValue('--treasury-owner') || process.env.TREASURY_OWNER;
  const treasuryAtaRaw = getValue('--treasury-ata') || process.env.TREASURY_USDC_ATA;
  const pythFeedRaw = getValue('--pyth-feed') || process.env.PYTH_SOL_USD_FEED || DEFAULT_SOL_USD_FEED_ACCOUNT;
  const fundSolVaultRaw = getValue('--fund-sol-vault');

  return {
    rpcUrl,
    programId,
    adminKeypairPath,
    usdcMint,
    treasuryOwner: treasuryOwnerRaw ? new PublicKey(treasuryOwnerRaw) : undefined,
    treasuryAta: treasuryAtaRaw ? new PublicKey(treasuryAtaRaw) : undefined,
    pythFeed: pythFeedRaw ? new PublicKey(pythFeedRaw) : undefined,
    usdcDecimals: Number(getValue('--usdc-decimals') || process.env.USDC_TEST_DECIMALS || '6'),
    maxOracleAgeSeconds: Number(getValue('--max-oracle-age-seconds') || process.env.CONDITIONAL_MAX_ORACLE_AGE_SECONDS || '120'),
    maxConfidenceBps: Number(getValue('--max-confidence-bps') || process.env.CONDITIONAL_MAX_CONFIDENCE_BPS || '500'),
    createTreasuryAta: has('--create-treasury-ata'),
    initVaultConfig: has('--init-vault-config'),
    fundSolVaultLamports: fundSolVaultRaw ? Math.floor(Number(fundSolVaultRaw) * LAMPORTS_PER_SOL) : 0,
    createKeeperPath: getValue('--create-keeper'),
    enableKeeper: has('--enable-keeper'),
    writeEnvLocal: has('--write-env-local'),
  };
}

function expandPath(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return resolve(path);
}

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const secret = Array.isArray(raw) ? raw : raw.secretKey;
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function tryLoadKeypair(path) {
  if (!existsSync(path)) return null;
  return loadKeypair(path);
}

function writeKeypairIfMissing(path) {
  if (existsSync(path)) return loadKeypair(path);
  mkdirSync(dirname(path), { recursive: true });
  const keypair = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(keypair.secretKey)));
  return keypair;
}

function instructionDiscriminator(name) {
  return createHash('sha256').update(`global:${name}`).digest().slice(0, 8);
}

function accountDiscriminator(name) {
  return createHash('sha256').update(`account:${name}`).digest().slice(0, 8);
}

function deriveVaultConfig(programId) {
  return PublicKey.findProgramAddressSync([VAULT_CONFIG_SEED], programId);
}

function deriveSolVault(programId, vaultConfig) {
  return PublicKey.findProgramAddressSync([SOL_VAULT_SEED, vaultConfig.toBuffer()], programId);
}

function buildInitializeVaultConfigIx(input) {
  const data = Buffer.alloc(8 + 32 + 32 + 32 + 1 + 4 + 2 + 1 + 1);
  let offset = 0;
  instructionDiscriminator('initialize_vault_config').copy(data, offset);
  offset += 8;
  input.treasuryAta.toBuffer().copy(data, offset);
  offset += 32;
  input.usdcMint.toBuffer().copy(data, offset);
  offset += 32;
  input.oracleFeed.toBuffer().copy(data, offset);
  offset += 32;
  data.writeUInt8(input.usdcDecimals, offset);
  offset += 1;
  data.writeUInt32LE(input.maxOracleAgeSeconds, offset);
  offset += 4;
  data.writeUInt16LE(input.maxConfidenceBps, offset);
  offset += 2;
  data.writeUInt8(input.vaultBump, offset);
  offset += 1;
  data.writeUInt8(0, offset);

  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.admin, isSigner: true, isWritable: true },
      { pubkey: input.vaultConfig, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function buildFundSolVaultIx(input) {
  const data = Buffer.alloc(8 + 8);
  instructionDiscriminator('fund_sol_vault').copy(data, 0);
  data.writeBigUInt64LE(BigInt(input.amountLamports), 8);
  return new TransactionInstruction({
    programId: input.programId,
    keys: [
      { pubkey: input.admin, isSigner: true, isWritable: true },
      { pubkey: input.vaultConfig, isSigner: false, isWritable: false },
      { pubkey: input.solVault, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function decodeVaultConfig(data) {
  const expected = accountDiscriminator('VaultConfig');
  if (!data.subarray(0, 8).equals(expected)) return null;
  let offset = 8;
  const readKey = () => {
    const key = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;
    return key;
  };
  const admin = readKey();
  const treasuryUsdcAta = readKey();
  const usdcTestMint = readKey();
  const oracleFeed = readKey();
  const usdcDecimals = data.readUInt8(offset);
  offset += 1;
  const maxOracleAgeSeconds = data.readUInt32LE(offset);
  offset += 4;
  const maxConfidenceBps = data.readUInt16LE(offset);
  offset += 2;
  const paused = data.readUInt8(offset) === 1;
  offset += 1;
  const vaultBump = data.readUInt8(offset);
  offset += 1;
  const bump = data.readUInt8(offset);
  return { admin, treasuryUsdcAta, usdcTestMint, oracleFeed, usdcDecimals, maxOracleAgeSeconds, maxConfidenceBps, paused, vaultBump, bump };
}

function upsertEnvLocal(values) {
  const path = resolve('.env.local');
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  const seen = new Set();
  const next = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const [key, value] of Object.entries(values)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }
  writeFileSync(path, `${next.filter((line, index, arr) => line.length > 0 || index < arr.length - 1).join('\n')}\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const connection = new Connection(args.rpcUrl, 'confirmed');

  if (!Number.isInteger(args.usdcDecimals) || args.usdcDecimals < 0 || args.usdcDecimals > 18) {
    throw new Error('--usdc-decimals must be an integer between 0 and 18');
  }
  if (!Number.isInteger(args.maxOracleAgeSeconds) || args.maxOracleAgeSeconds <= 0) {
    throw new Error('--max-oracle-age-seconds must be a positive integer');
  }
  if (!Number.isInteger(args.maxConfidenceBps) || args.maxConfidenceBps < 0 || args.maxConfidenceBps > 10_000) {
    throw new Error('--max-confidence-bps must be between 0 and 10000');
  }

  const admin = tryLoadKeypair(args.adminKeypairPath);
  const needsAdmin =
    args.createTreasuryAta ||
    args.initVaultConfig ||
    args.fundSolVaultLamports > 0;
  if (needsAdmin && !admin) {
    throw new Error(`Admin keypair not found at ${args.adminKeypairPath}`);
  }

  const treasuryOwner = args.treasuryOwner || admin?.publicKey;
  const treasuryAta = args.treasuryAta || (treasuryOwner
    ? getAssociatedTokenAddressSync(args.usdcMint, treasuryOwner, false, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
    : undefined);
  const [vaultConfig, vaultConfigBump] = deriveVaultConfig(args.programId);
  const [solVault, solVaultBump] = deriveSolVault(args.programId, vaultConfig);
  const programAccount = await connection.getAccountInfo(args.programId, 'confirmed');
  const vaultConfigAccount = await connection.getAccountInfo(vaultConfig, 'confirmed');
  const solVaultBalance = await connection.getBalance(solVault, 'confirmed');
  const treasuryAtaAccount = treasuryAta ? await connection.getAccountInfo(treasuryAta, 'confirmed') : null;

  console.log('\nConditional escrow devnet bootstrap');
  console.log('===================================');
  console.log('RPC:', args.rpcUrl);
  console.log('Admin:', admin ? admin.publicKey.toBase58() : `(missing keypair at ${args.adminKeypairPath})`);
  console.log('Program:', args.programId.toBase58(), programAccount?.executable ? '(deployed)' : '(not deployed or not executable)');
  console.log('USDC_TEST_MINT:', args.usdcMint.toBase58());
  console.log('Treasury owner:', treasuryOwner ? treasuryOwner.toBase58() : '(missing; pass --treasury-owner or --admin-keypair)');
  console.log('TREASURY_USDC_ATA:', treasuryAta ? treasuryAta.toBase58() : '(missing; pass --treasury-ata or treasury owner)', treasuryAtaAccount ? '(exists)' : treasuryAta ? '(missing)' : '');
  console.log('Vault config PDA:', vaultConfig.toBase58(), `(bump ${vaultConfigBump})`);
  console.log('SOL vault PDA:', solVault.toBase58(), `(bump ${solVaultBump}, balance ${solVaultBalance / LAMPORTS_PER_SOL} SOL)`);
  console.log('Pyth SOL/USD feed id:', SOL_USD_FEED_ID);
  console.log('PYTH_SOL_USD_FEED:', args.pythFeed ? args.pythFeed.toBase58() : '(missing)');

  let keeperKeypairJson;
  if (!programAccount?.executable) {
    console.log('\nACTION REQUIRED: deploy the program first:');
    console.log('  cd BACK/solana/conditional-escrow-buy');
    console.log('  anchor deploy --provider.cluster devnet');
  }
  if (!admin) {
    console.log('\nACTION REQUIRED: create or pass an admin keypair for mutating actions:');
    console.log('  solana-keygen new --outfile ~/.config/solana/id.json');
    console.log('  solana airdrop 2 ~/.config/solana/id.json --url devnet');
    console.log('Or run this script with --admin-keypair <path>.');
  }
  if (!args.pythFeed) {
    console.log('\nACTION REQUIRED: pass --pyth-feed <SOL/USD price account>');
    console.log('Source: Pyth docs list SOL/USD feed id ef0d8b...b56d and its Solana shard-0 account address.');
    console.log('Use the account address, not the hex feed id.');
  }

  if (args.createKeeperPath) {
    const keeperPath = expandPath(args.createKeeperPath);
    const keeper = writeKeypairIfMissing(keeperPath);
    keeperKeypairJson = JSON.stringify(Array.from(keeper.secretKey));
    console.log('\nKeeper keypair:', keeperPath);
    console.log('Keeper pubkey:', keeper.publicKey.toBase58());
    console.log('Fund it with small devnet SOL for execution fees.');
  }

  if (args.createTreasuryAta && treasuryAta && treasuryOwner && admin && !treasuryAtaAccount) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(
        admin.publicKey,
        treasuryAta,
        treasuryOwner,
        args.usdcMint,
        TOKEN_PROGRAM_ID,
        ASSOCIATED_TOKEN_PROGRAM_ID,
      ),
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: 'confirmed' });
    console.log('\nCreated treasury ATA:', signature);
  }

  if (vaultConfigAccount) {
    const decoded = decodeVaultConfig(Buffer.from(vaultConfigAccount.data));
    console.log('\nExisting vault_config:');
    if (decoded) {
      console.log('  admin:', decoded.admin.toBase58());
      console.log('  treasury_usdc_ata:', decoded.treasuryUsdcAta.toBase58());
      console.log('  usdc_test_mint:', decoded.usdcTestMint.toBase58());
      console.log('  oracle_feed:', decoded.oracleFeed.toBase58());
      console.log('  usdc_decimals:', decoded.usdcDecimals);
      console.log('  max_oracle_age_seconds:', decoded.maxOracleAgeSeconds);
      console.log('  max_confidence_bps:', decoded.maxConfidenceBps);
      console.log('  paused:', decoded.paused);
    } else {
      console.log('  exists, but discriminator did not match VaultConfig');
    }
  } else if (args.initVaultConfig) {
    if (!args.pythFeed) throw new Error('Cannot initialize vault config without --pyth-feed');
    if (!treasuryAta) throw new Error('Cannot initialize vault config without treasury ATA');
    if (!admin) throw new Error('Cannot initialize vault config without admin keypair');
    const tx = new Transaction().add(
      buildInitializeVaultConfigIx({
        programId: args.programId,
        admin: admin.publicKey,
        vaultConfig,
        treasuryAta,
        usdcMint: args.usdcMint,
        oracleFeed: args.pythFeed,
        usdcDecimals: args.usdcDecimals,
        maxOracleAgeSeconds: args.maxOracleAgeSeconds,
        maxConfidenceBps: args.maxConfidenceBps,
        vaultBump: solVaultBump,
      }),
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: 'confirmed' });
    console.log('\nInitialized vault_config:', signature);
  } else {
    console.log('\nVault config missing. Add --init-vault-config after deploy and --pyth-feed.');
  }

  if (args.fundSolVaultLamports > 0) {
    if (!admin) throw new Error('Cannot fund SOL vault without admin keypair');
    const freshVaultConfig = await connection.getAccountInfo(vaultConfig, 'confirmed');
    if (!freshVaultConfig) throw new Error('Cannot fund SOL vault before vault_config exists');
    const tx = new Transaction().add(
      buildFundSolVaultIx({
        programId: args.programId,
        admin: admin.publicKey,
        vaultConfig,
        solVault,
        amountLamports: args.fundSolVaultLamports,
      }),
    );
    const signature = await sendAndConfirmTransaction(connection, tx, [admin], { commitment: 'confirmed' });
    console.log('\nFunded SOL vault:', signature);
  }

  const envValues = {
    SOLANA_RPC_URL: args.rpcUrl,
    CONDITIONAL_ESCROW_BUY_PROGRAM_ID: args.programId.toBase58(),
    USDC_TEST_MINT: args.usdcMint.toBase58(),
    USDC_TEST_DECIMALS: String(args.usdcDecimals),
    CONDITIONAL_MAX_ORACLE_AGE_SECONDS: String(args.maxOracleAgeSeconds),
    CONDITIONAL_MAX_CONFIDENCE_BPS: String(args.maxConfidenceBps),
  };
  if (treasuryAta) envValues.TREASURY_USDC_ATA = treasuryAta.toBase58();
  if (args.pythFeed) envValues.PYTH_SOL_USD_FEED = args.pythFeed.toBase58();
  if (keeperKeypairJson) envValues.CONDITIONAL_ORDER_KEEPER_KEYPAIR = keeperKeypairJson;
  if (args.enableKeeper) envValues.CONDITIONAL_ORDER_KEEPER_ENABLED = 'true';

  console.log('\n.env.local values');
  console.log('-----------------');
  for (const [key, value] of Object.entries(envValues)) {
    console.log(`${key}=${value}`);
  }
  if (args.writeEnvLocal) {
    upsertEnvLocal(envValues);
    console.log('\nUpdated .env.local');
  }

  console.log('\nNext checks');
  console.log('-----------');
  console.log('1. Make sure the admin and keeper have devnet SOL.');
  console.log('2. Use Orca SOL->USDC to fund the user with devUSDC if needed.');
  console.log('3. Start the app and create a conditional order from chat.');
  console.log('4. Watch /api/conditional-orders?user=<wallet> for the open order.');
}

main().catch((error) => {
  console.error('\nBootstrap failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
