# Verificación programática y gratuita de reputación de wallets en Solana: guía exhaustiva 2025‑2026

## TL;DR
- **No existe un único endpoint "trust score" gratuito y fiable para wallets de Solana**: la mejor estrategia es combinar (1) datos on‑chain crudos vía RPC público o free tier de Helius/QuickNode, (2) APIs enriquecidas gratis (Helius Wallet API, Solscan Public, Vybe, Birdeye, Bitquery, Shyft, SolanaFM, Hello Moon), (3) listas de bloqueo abiertas (OFAC SDN scrapers, Phantom/Solflare blocklists, GoPlus Malicious Address, Chainabuse, CryptoScamDB, HAPI Protocol on‑chain), y (4) servicios de scoring (Webacy/DD.xyz, GoPlus, De.Fi) — todo orquestado en un score propio ponderado.
- **El núcleo libre y sin límites prácticos** son las llamadas RPC nativas (`getAccountInfo`, `getSignaturesForAddress`, `getTransaction`, `getTokenAccountsByOwner`) más la resolución de identidad SNS/ANS/SAS y la verificación contra blocklists públicas en GitHub; con esto solo, ya puedes responder ~70 % de las preguntas de reputación (antigüedad, volumen, executable=false, tokens conocidos, dominio asociado, presencia en sanciones).
- **Pieza crítica para scams/phishing en Solana**: Phantom/Solflare blocklists son de URLs (no addresses), por lo que para *wallets* específicas debes apoyarte en **Chainabuse API**, **GoPlus Malicious Address API**, **Webacy DD.xyz** (free tier con API key), **HAPI Protocol** (on‑chain) y heurísticas de address poisoning/dusting (transferencias < 0.0001 SOL, prefijos coincidentes, edad < 24 h del remitente).

---

## Key Findings

1. **El mejor "stack gratuito" actual para verificar una wallet antes de enviar fondos** es: Helius free tier (1M créditos/mes, Wallet API + DAS + Enhanced Tx) + Solscan Public API + Vybe Network free (12 K créditos/mes, etiquetado de 10 K+ wallets) + Birdeye free (portafolio en USD) + Chainabuse + GoPlus Malicious Address API + listas OFAC en GitHub + SNS/SAS resolution.
2. **Helius Wallet API (beta)** ofrece *exactamente* lo que necesita el caso de uso: `getIdentity`/`getBatchIdentity` (etiqueta CEX/protocolo/bot conocido), `getFundedBy` (origen sybil), `getBalances`, `getHistory`, `getTransfers` — todo gratis hasta 1M créditos/mes.
3. **Vybe Network** tiene un endpoint específico `wallet-counterparties` para mapear contrapartes de una dirección y `programs/labeled-program-accounts` con 10 K+ wallets etiquetados (CEXs, VCs, KOLs, smart money, sybils) — gratuito con 4 RPM y 12 K créditos/mes.
4. **Para sanciones**, la lista oficial OFAC SDN se descarga libre desde `treasury.gov` y existen scrapers automatizados (`0xB10C/ofac-sanctioned-digital-currency-addresses`) actualizados cada noche; OpenSanctions ofrece un endpoint REST/JSON gratuito sobre el SDN.
5. **HAPI Protocol** mantiene una base de datos *on‑chain* en Solana de direcciones marcadas como maliciosas, accesible directamente por contrato (`@hapi.one/core-cli`) o REST API gratuita — datos provenientes de Chainalysis y Crystal Blockchain.
6. **Solana Attestation Service (SAS, mainnet desde 2025)** y **Civic Pass** son la nueva capa de identidad: una wallet con KYC vigente vía Civic/Sumsub/RNS.ID es una señal positiva fuerte de reputación; ambos exponen datos on‑chain consultables vía SDK gratuito.
7. **Distinción crítica**: las blocklists de Phantom y Solflare en GitHub son **listas de URLs phishing**, no de direcciones de wallets. Para listas de *wallets* maliciosas en Solana, las fuentes son Chainabuse, GoPlus, HAPI, Webacy, Solscan/Solana Foundation labels, y `tsmboa0/solana-scam-detector` (open source).
8. **Webacy/DD.xyz soporta Solana desde 2024**: ofrece SafetyScore para wallets (combinación de hasta 27 fuentes) con free tier API y endpoint dedicado `dapp.webacy.com/solana-risk-score`.
9. **GoPlus Security API** tiene endpoint **Malicious Address** gratuito y multi‑chain (incluye Solana): retorna si la dirección está en su biblioteca de threat‑intel en tiempo real, sin API key obligatoria para usos básicos.
10. **El campo `executable: false` y `owner: 11111111111111111111111111111111`** (System Program) en `getAccountInfo` confirma que es una wallet "normal" y no un programa ejecutable — paso previo obligatorio para cualquier verificación.

---

## Details

### 1) Métodos ON‑CHAIN puros (RPC) — 100 % gratis usando endpoints públicos

Endpoint público canónico: `https://api.mainnet-beta.solana.com` (rate limit ~100 RPS, 429 si excedes; para producción se recomienda free tier de Helius/QuickNode). Documentación oficial: https://solana.com/docs/rpc

**a) `getAccountInfo`** — Determina la naturaleza de la cuenta.
- Confirma `executable=false` (wallet) vs `executable=true` (programa).
- Si `owner == "11111111111111111111111111111111"` (System Program) → wallet estándar válida para enviar SOL.
- Si `owner == "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"` → es un *token account* o *mint account* (¡no envíes SOL ahí!). Lee `data.parsed` con `encoding=jsonParsed` para distinguir.
- Si la cuenta no existe (`value: null`), valida si la dirección está on‑curve (Ed25519 pubkey) u off‑curve (PDA) usando `PublicKey.isOnCurve()` de `@solana/web3.js`. Las PDAs sin cuenta deben rechazarse conservadoramente.
- Documentación oficial sobre verificación de direcciones de pago: https://solana.com/docs/payments/send-payments/verify-address

```bash
curl https://api.mainnet-beta.solana.com -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["WALLET_ADDRESS",{"encoding":"jsonParsed"}]}'
```

**b) `getSignaturesForAddress`** — Antigüedad e historial.
- Pagina hacia atrás con `before` hasta llegar al inicio. La transacción más antigua = edad de la wallet (timestamp `blockTime`).
- Cuenta total → frecuencia/volumen.
- Limitación: sin `searchTransactionHistory: true`, sólo ~ últimos meses; con free tiers algunos providers lo limitan.

```js
const sigs = await connection.getSignaturesForAddress(new PublicKey(addr), { limit: 1000 });
const oldest = sigs[sigs.length - 1];
console.log("Primera tx:", new Date(oldest.blockTime * 1000));
```

**c) `getBalance`** — SOL en lamports (dividir entre 1e9).

**d) `getTokenAccountsByOwner`** (filtrando por SPL Token y Token‑2022 programs) — listado completo de tokens fungibles y NFTs. Combinar con `getProgramAccounts(TOKEN_PROGRAM_ID, { filters: [{dataSize:165},{memcmp:{offset:32, bytes: WALLET}}] })` para queries más finos. Ref: https://solanacookbook.com/guides/get-program-accounts.html

**e) `getTransaction(signature, {maxSupportedTransactionVersion:0})`** — desempacar instrucciones, programas invocados, balances pre/post; clave para detectar interacción con mixers, programas de scam y patrones MEV.

**f) Heurísticas de detección de patrones sospechosos**:
- **Address poisoning**: contar transferencias entrantes < 0.0001 SOL provenientes de direcciones cuyos primeros/últimos 4‑5 caracteres coinciden con direcciones de tu historial (ataque clásico). Implementación de referencia open source: `tsmboa0/solana-scam-detector` (LangGraph + Helius RPC), `Albert Adekanye/solana-scam-detector-api` (Express.js, < 0.0001 SOL = dust, prefijo 5 chars = poisoning). Análisis cuantitativo: Pine Analytics (https://pineanalytics.substack.com).
- **Dusting domain‑based**: remitentes con vanity domain (`flip.gg`, `casino.sol`) y "edad de wallet < 24 h" → score boost.
- **Cuenta nueva con gran volumen**: edad < 7 días + volumen > X SOL → bandera roja.
- **Funding source de exchange**: cuentas legítimas suelen estar fundadas inicialmente por CEX (Binance, Coinbase, OKX); cuentas fundadas por mixers son alta señal negativa. Endpoint Helius `getFundedBy` resuelve esto en una llamada.

**g) SDKs/librerías gratis y open source**:
- `@solana/web3.js` y el nuevo `@solana/kit` (TypeScript/JS) — https://github.com/solana-labs/solana-web3.js
- `solana-py` (Python) — https://github.com/michaelhly/solana-py
- `solders` (Python, Rust bindings, mayor performance) — https://github.com/kevinheavey/solders
- `solana-sdk` y `solana-client` (Rust) — https://docs.rs/solana-client
- `anchor-client` para programas IDL — https://www.anchor-lang.com

---

### 2) APIs Y SERVICIOS GRATUITOS enriquecidos

| Servicio | Free tier | Endpoints clave para reputación | Doc |
|---|---|---|---|
| **Helius** | 1M créditos/mes, 10 RPS, 1 API key | `mainnet.helius-rpc.com` (Solana RPC mejorado), `api.helius.xyz/v0/addresses/{addr}/transactions` (Enhanced Tx, parsea hasta intent humano), **Wallet API**: `/v1/wallet/{addr}/identity`, `/balances`, `/history`, `/transfers`, `/funded-by`, **DAS API** (`getAssetsByOwner`, `getTokenAccounts`) | helius.dev/docs |
| **QuickNode** | 10M créditos/mes, 15 RPS | RPC Solana + add‑ons (Metaplex DAS, Priority Fee, Jupiter v6) | quicknode.com/docs/solana |
| **Solscan Public API** (v2) | Gratis con rate limit, lite plan | `https://public-api.solscan.io/account/{addr}`, `/account/transactions`, `/account/tokens`, `/account/splTransfers`. *Quantitative Address Labeling*: tags por percentil de fees, NFT, aggregator volume — útil para diferenciar trader pro vs wallet recién creada. | docs.solscan.io |
| **SolanaFM** | Free 10 RPS, 1 GB BW | `api.solana.fm/v0/accounts/{hash}` (account data + friendly name), `/transactions` (lista parsed), `/v0/domains/bonfida/{hash}` (todos los SNS de la wallet). Coverage: Jupiter, Magic Eden, Tensor parsing built‑in. | docs.solana.fm |
| **Birdeye** | Free tier (web app); API key gratuita | `public-api.birdeye.so/v1/wallet/token_list?wallet=...` (portafolio en USD, multi‑chain), `/v1/wallet/portfolio`, `/wallet/tx_list`, **Wallet PnL API** (realized/unrealized) | docs.birdeye.so |
| **Bitquery** (V2 GraphQL) | Free dev tier | `streaming.bitquery.io/graphql` con schema `Solana { BalanceUpdates, Transfers, DEXTrades, Instructions }`. Crítico para detectar wash trading y bundles de bots. WebSocket subscriptions gratis. | docs.bitquery.io/docs/blockchain/Solana |
| **Vybe Network** | Free (4 RPM, 12 K créditos/mes), todos los endpoints | **`/v4/wallets/{owner}/counterparties`** (relaciones de transferencia), `/v4/wallets/{owner}/pnl`, `/v4/wallets/top-traders`, `/v4/programs/labeled-program-accounts` (10 K+ wallets etiquetados: CEX/VC/KOL/smart‑money/sybils). | docs.vybenetwork.com |
| **Shyft** | Free API key | `api.shyft.to/sol/v1/wallet/balance`, `/all_tokens`, `/get_portfolio`, `/get_domains`, `/resolve_address` (resuelve a `.sol`), `/transaction/history` (parsed). | docs.shyft.to |
| **Hello Moon** | Free (sólo conectar wallet) | RPC Solana + APIs especializadas en NFT/DeFi (wash‑trading flags, etiquetado de wallets por engagement). | docs.hellomoon.io |
| **Magic Eden API** | Pública gratuita 120 QPM / 2 QPS sin key | `api-mainnet.magiceden.dev/v2/wallets/{addr}/activities` (compras/ventas NFT), `/tokens`, `/collections`. Útil para historial NFT del receptor. | docs.magiceden.io/reference/solana-overview |
| **Tensor API** | Acceso público (con rate limits) | Histórico NFT trades, AMM positions de la wallet. | docs.tensor.trade |
| **Jupiter Tokens API v2** | `lite-api.jup.ag` sin key | `tokens/v2/tag?query=verified`, `tokens/v2/search?query={mint}` — devuelve `isVerified`, `organicScore`, `audit.mintAuthorityDisabled`, `audit.freezeAuthorityDisabled`, `holderCount`, lista CEXs donde cotiza. **Fundamental para juzgar la calidad de los tokens que tiene la wallet**. | dev.jup.ag/docs/tokens/v2 |
| **Solana Foundation Token List** (archivado pero todavía usado) | Estático en GitHub | https://github.com/solana-labs/token-list/blob/main/src/tokens/solana.tokenlist.json (npm `@solana/spl-token-registry`). | github.com/solana-labs/token-list |
| **dRPC, Chainstack** | RPC públicos free tier | Alternativas a Helius. | drpc.org/docs/solana-api, docs.chainstack.com/reference/solana-getsignaturesforaddress |

**Ejemplo combinado (Node.js)** — pipeline mínimo de reputación con Helius + Vybe:

```js
const HEL = process.env.HELIUS_API_KEY;
const VYBE = process.env.VYBE_API_KEY;
async function score(addr){
  const [acct, tx, balances, identity, fundedBy, cps] = await Promise.all([
    fetch(`https://mainnet.helius-rpc.com/?api-key=${HEL}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[addr,{encoding:'jsonParsed'}]})}).then(r=>r.json()),
    fetch(`https://api.helius.xyz/v0/addresses/${addr}/transactions?api-key=${HEL}&limit=100`).then(r=>r.json()),
    fetch(`https://api.helius.xyz/v1/wallet/${addr}/balances?api-key=${HEL}`).then(r=>r.json()),
    fetch(`https://api.helius.xyz/v1/wallet/${addr}/identity?api-key=${HEL}`).then(r=>r.json()).catch(()=>null),
    fetch(`https://api.helius.xyz/v1/wallet/${addr}/funded-by?api-key=${HEL}`).then(r=>r.json()).catch(()=>null),
    fetch(`https://api.vybenetwork.xyz/v4/wallets/${addr}/counterparties`,{headers:{'X-API-KEY':VYBE}}).then(r=>r.json()).catch(()=>null)
  ]);
  return { acct, txCount: tx.length, balances, identity, fundedBy, cps };
}
```

---

### 3) SERVICIOS DE REPUTACIÓN Y RIESGO

**Webacy / DD.xyz** — Solana soportado desde 2024. SafetyScore (1‑10) con explicación, monitoreo de wallets, evaluación de riesgo histórico.
- Endpoint front: `dapp.webacy.com/solana-risk-score?address={addr}`
- API: `api.webacy.com/...` con API key (free tier "demo key" disponible solicitando upgrade vía email).
- Documentación: https://docs.webacy.com/reference/

**GoPlus Security API** — Multi‑chain incluyendo Solana, gratuita y con SDK MCP.
- **Malicious Address API**: `https://api.gopluslabs.io/api/v1/address_security/{address}?chain_id=solana` — devuelve flags de honeypot, money_laundering, blacklist_doubt, malicious_mint, etc.
- Solana Token Security API: `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses={mint}` (para tokens, no wallets, pero útil para evaluar la "limpieza" del portfolio).
- Documentación: https://docs.gopluslabs.io / GitHub: https://github.com/GoPlusSecurity/awesome-goplus-security
- Modelo: 10 millones de llamadas diarias, free, opcional API key/secret para Pro.

**De.Fi Scanner** (GraphQL) — Solana soportado dentro de las 35+ chains.
- API GraphQL: `https://public-api.de.fi/graphql`. Endpoints: `assetBalances`, `scannerProject` (security score + similar contracts), `scannerHolderAnalysis`, `scannerLiquidityAnalysis`, `shieldApprovals`. SDK JS: `@de.fi/api-sdk`. Free con API key.
- Documentación: https://docs.de.fi/api/api

**Chainabuse API** (TRM Labs) — Base de datos pública multi‑chain de reportes de scams y fraudes.
- `GET https://api.chainabuse.com/v0/reports?address={addr}&chain=solana` — devuelve reportes con confidence score, número de víctimas, monto perdido, categoría (rug pull, sextortion, ransomware, impersonation, hack, etc.).
- Auth: Basic Auth con API key (registro gratuito como Partner para acceso completo, lectura básica disponible).
- Documentación: https://docs.chainabuse.com

**HAPI Protocol** — Datos on‑chain en Solana (PDAs propios) sobre direcciones maliciosas, alimentado por Chainalysis + Crystal Blockchain + reportes comunitarios.
- Acceso vía contrato Solana directamente con `@hapi.one/core-cli` (npm) — gratuito.
- API REST disponible (revisar docs). Repo: https://github.com/HAPIprotocol/hapi-core
- Documentación: https://hapi-one.gitbook.io/hapi-protocol/developers/

**OFAC SDN List (sanciones US Treasury)** — Listado oficial gratuito.
- XML completo: `https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/ADVANCED_XML` (descarga libre, actualizado nightly).
- Lista de direcciones cripto pre‑extraídas, actualizada cada noche por GitHub Actions: https://github.com/0xB10C/ofac-sanctioned-digital-currency-addresses (rama `lists`). Cubre USDT/USDC pero **a fecha de búsqueda no incluye SOL nativo** — debes parsear `sdn_advanced.xml` y filtrar `Digital Currency Address - SOL` manualmente (añadiendo "SOL" al script de Python `generate-address-list.py`).
- API estructurada free: OpenSanctions (`https://api.opensanctions.org/match/sanctions` + dataset `us_ofac_sdn`).

**Listas de tokens de scam / verificación**:
- **Jupiter Verify** (V3, dentro de Tokens API v2) — `lite-api.jup.ag/tokens/v2/tag?query=verified`. Filtra contra el portfolio de la wallet para detectar si tiene mayoritariamente "memecoins basura no verificadas" (señal débil pero útil).
- Solana Foundation Token List: GitHub estático.

**Phantom blocklist** (URLs phishing): https://github.com/phantom/blocklist/blob/master/blocklist.yaml — útil para validar dApps con las que la wallet ha interactuado, **no para wallets directamente**.
**Solflare blocklist**: https://github.com/solflare-wallet/blocklist (mismo modelo: URLs).
**Keplr/CosmosShield phishing list** (Solana sólo parcial): https://github.com/chainapsis/phishing-block-list

**CryptoScamDB** — Base open source, pero principalmente Ethereum. API REST: `https://api.cryptoscamdb.org` (limitada, no actualizada con Solana específicamente).

---

### 4) NAME SERVICES Y VERIFICACIÓN DE IDENTIDAD

Una wallet con dominio human‑readable asociado **es señal positiva** (capital depositado en el dominio, dificultad para descartar identidad). Verificación programática:

**Solana Name Service (SNS, .sol)** — Bonfida.
- SDK JS: `@bonfida/spl-name-service`, `@bonfida/sns-react`. Función `resolve(connection, "name")` y reverso `getAllDomains(connection, owner)` → array de PDAs → `performReverseLookup` → string del dominio.
- SDK Rust: `sns-sdk` (cargo install).
- Cloudflare worker REST proxy gratis: `https://sdk-proxy.sns.id/resolve/{domain}` y `/domains/{owner}` — sin auth.
- CLI: `cargo install --git https://github.com/SolanaNameService/sns-sdk.git sns` y `sns resolve bonfida`.
- Documentación: https://sns.guide

**ANS (Alternative Name Service por Onsol Labs, .abc, .bonk, .poor, etc.)** — npm `@onsol/tldparser`.
- `parser.getAllUserDomains(pubkey)`, `parser.resolveDomain("name.abc")`, `parser.getMainDomain(addr)`.

**Multi‑resolver unificado**: `@portal-payments/solana-wallet-names` — soporta `.sol`, `.abc`, `.backpack`, `.bonk`, `.glow`, `.poor`. Función `walletAddressToNameAndProfilePicture(connection, addr)`.

**Solana Attestation Service (SAS, on‑chain desde 2025)** — protocolo permissionless para credenciales verificables.
- Smart contract on Solana mainnet, SDK TypeScript en https://github.com/solana-foundation/solana-attestation-service
- Issuers públicos: Civic, Sumsub, RNS.ID, Solana.ID, Trusta.AI, Solid.
- Lectura: `fetchAttestation(client.rpc, attestationPda)` — verifica si la wallet tiene KYC válido, prueba de unicidad humana, ciudadanía, no está en sanctions, etc.
- Documentación: https://attest.solana.com — fuerte señal positiva; la *ausencia* no es necesariamente negativa.

**Civic Pass** — verificación on‑chain reusable (KYC, age, OFAC).
- npm `@civic/solana-gateway-react` y `@identity.com/solana-gatekeeper-lib`.
- Script para listar todas las wallets con Civic Uniqueness Pass: https://gist.github.com/dankelleher/ba831b79aa5602482e0e92a7702d7919
- `findGatewayToken(connection, wallet, gatekeeperNetwork)` → `null` si no tiene pass.

**Backpack username** — almacenado en perfil del wallet, no expuesto programáticamente más allá del SDK propio (limitado).

**Twitter mapping** — históricamente vía Bonfida; en práctica, casi ningún wallet de Solana lo usa actualmente (deprecado).

---

### 5) ANÁLISIS DE CLUSTERING Y ATTRIBUTION

**Helius** `getIdentity` y `getBatchIdentity` — devuelven label si la wallet pertenece a exchanges (Coinbase, Binance, Kraken, OKX), protocolos conocidos (Jupiter, Drift, Marinade) o bots.

**Vybe Network** — endpoint `/v4/programs/labeled-program-accounts` con 10 K+ etiquetas: CEXs, VCs, KOLs, protocols, smart money, sybils. Adicionalmente `/v4/wallets/{owner}/counterparties` mapea contrapartes de transferencias y el `/v4/wallets/top-traders` permite cross‑reference.

**Solscan** — Quantitative Address Labeling (no API directa pero el frontend usa `api-v2.solscan.io` que es accesible; ver `paoloanzn/free-solscan-api` para wrapper Python no oficial).

**SolanaFM** — Friendly names + protocol parsing (Jupiter, Magic Eden, Tensor) ya integrados.

**Hello Moon** — etiqueta wallets engaged en cada ecosistema NFT/DeFi.

**Range API** — compliance‑grade (real‑time risk screening, address attribution multi‑jurisdiccional, sanctions). Forma parte del Solana Developer Platform; tiene API pero el free tier es limitado y orientado a empresa. Documentación: https://www.range.org

**Arkham Intelligence** — gratis para uso individual via UI; **no expone API pública gratuita** (sólo enterprise). En producción NO contar con esto programáticamente sin contrato.

**Heurísticas DIY de clustering** (gratis, sólo código):
- Detección de exchange hot wallets: dirección con > 100 K transferencias/día y patrones de in/out simétricos.
- Detección de cold wallet: balance grande, frecuencia baja, > 30 días sin actividad.
- Detección de bot: > 1 tx por bloque/segundo durante > N minutos, interacciones sólo con DEX programs.
- Detección de sybil: múltiples wallets con `getFundedBy` apuntando al mismo origen y patrones similares.

---

### 6) SEÑALES DE COMPORTAMIENTO SOSPECHOSO (heurísticas)

| Señal | Cómo detectar programáticamente |
|---|---|
| **Mixer/Tornado‑like** | En Solana no hay un equivalente exacto a Tornado Cash, pero existieron Cyclos (cerrado), Elusiv (cerrado tras hackeo), Solana Mixer. Detección: lista de program IDs conocidos en `getTransaction.message.accountKeys` — mantener un set actualizado en GitHub propio. |
| **Direcciones en hacks reportados** | Cross‑check con Chainabuse, HAPI, GoPlus, Webacy. |
| **Wash trading NFT** | Hello Moon flag `washTrading=true`, Bitquery DEXTrades agrupadas por mismo funder. |
| **Honeypot / dump bots** | Para tokens en portfolio: GoPlus `solana_token_security` flags `cannot_sell`, `transfer_pausable`. |
| **Dusting attacks** | Transferencias entrantes < 0.0001 SOL sin contexto, con sender de edad < 24 h y con vanity domain. |
| **Address poisoning** | Sender prefix/suffix coincide ≥ 5 chars con dirección legítima del historial; monto < 0.0001 SOL; timing < 5 min después de tx grande. |
| **Sandwich/MEV** | Búsqueda de patrones front‑run/back‑run en mismo bloque/slot vía `getTransaction` + Bitquery DEXTrades. |
| **Rug pulls de creator** | Cruzar con De.Fi Scanner `scannerProject`, RugCheck (`rugcheck.xyz/tokens/{mint}` API gratuita), Solanatracker risk score. |

**Implementaciones open source**:
- `tsmboa0/solana-scam-detector` (LangGraph multi‑agent + Helius)
- `Albert Adekanye/solana-scam-detector-api` (Express.js sencillo)
- Pine Analytics methodology: https://pineanalytics.substack.com/p/solana-account-dusting-and-address

---

### 7) HERRAMIENTAS OPEN SOURCE relevantes

- **`@solana/web3.js` / `@solana/kit`** — SDK oficial JS/TS.
- **`@solana/spl-token`** — utilidades para SPL tokens.
- **`@bonfida/sns-react`, `@bonfida/spl-name-service`** — SNS.
- **`@onsol/tldparser`** — ANS y dominios alternativos.
- **`@portal-payments/solana-wallet-names`** — multi‑resolver de nombres.
- **`@hapi.one/core-cli`** — HAPI Protocol on‑chain reads.
- **`solana-py`, `solders`** — Python.
- **`anchor-py`, `anchorpy`** — IDL de programas.
- **`solana-fm/ExplorerKit`** — parser open source de instrucciones (https://github.com/solana-fm).
- **`paoloanzn/free-solscan-api`** — wrapper Python de la API interna de Solscan (uso bajo riesgo, puede romperse).
- **`Shyft-to/translator`** — explorer open source que ya integra varias fuentes.
- **`hapi-one/awesome-goplus-security`** — listado curado de proyectos basados en GoPlus.

---

### 8) INTEGRACIONES CRUZADAS

- **Twitter ↔ wallet**: prácticamente desuso en 2025‑2026. Si se necesita, la única vía pública es scraping de profiles que muestran su SNS o consultar SAS attestations emitidas por proveedores que verifican Twitter (Trusta.AI emite uno).
- **Civic Pass** — descrito arriba; método más fiable de "esta wallet pasó KYC".
- **SAS** — descrito arriba; plataforma estándar nueva.
- **Gitcoin Passport** — *no oficialmente soportado en Solana* a fecha de búsqueda; existen integraciones tipo wrapper pero sin API pública nativa para Solana wallets.
- **Solana ID** (ex‑Bonfida) — proveedor SAS para credenciales de empleo/historial laboral.

---

## Cómo construir un score propio (estrategia recomendada)

Pondera y combina señales en un score 0‑100 (mayor = más confiable):

| Categoría | Peso sugerido | Señales positivas (+) | Negativas (−) |
|---|---|---|---|
| **Antigüedad** | 15 % | Edad > 180 días | Edad < 7 días, fundada por mixer |
| **Volumen/actividad** | 10 % | > 50 tx, frecuencia regular | < 3 tx, ráfaga única |
| **Sanciones (OFAC + HAPI + Chainabuse + GoPlus)** | 30 % (kill‑switch si aparece) | Ausente en todas las listas | Presente en cualquiera = bloqueo |
| **Reputación scoring (Webacy + GoPlus + De.Fi)** | 15 % | Score limpio | Flag explícito |
| **Identidad on‑chain (SNS + ANS + SAS + Civic)** | 15 % | Tiene .sol/.abc + SAS KYC + Civic Uniqueness | Sin nada (neutral, no negativo) |
| **Composición de portfolio (Jupiter Verified)** | 10 % | Mayoría tokens verificados | Mayoría memecoins basura recién creadas |
| **Contrapartes (Helius identity + Vybe counterparties)** | 5 % | CEX legítimo, protocolo conocido | Otra wallet flagged |

**Pseudocódigo de pipeline**:
1. **Validación sintáctica + naturaleza** (`getAccountInfo`): si `executable=true` o `owner` ≠ System Program → REJECT.
2. **Sanctions kill‑switch**: paralelo a OFAC list, GoPlus malicious_address, HAPI on‑chain check, Chainabuse `/v0/reports`. Si cualquiera devuelve match → REJECT.
3. **Datos on‑chain** (`getSignaturesForAddress` + `getBalance` + `getTokenAccountsByOwner`).
4. **Enrichment** (Helius identity + funded‑by, Vybe counterparties + labels, Birdeye portfolio).
5. **Identity** (SNS resolve + Civic Pass + SAS attestation lookup).
6. **Heurísticas dust/poisoning** sobre los últimos 200 tx.
7. **Webacy SafetyScore + De.Fi Scanner** como capa AI/ML adicional.
8. Calcular score ponderado, devolver decisión: `{ allow | warn | reject }` con `reasons[]`.

**Costo total**: $0/mes para volúmenes pequeños‑medios (cientos de checks/día). Si superas free tiers, el upgrade más eficiente es Helius Developer ($49/mes, 10M créditos, 50 RPS) o Vybe paid.

---

## Recommendations

1. **Implementa hoy** (orden de prioridad):
   - Paso 1 (mismo día): RPC público + `getAccountInfo` + `getSignaturesForAddress` + Phantom blocklist (URLs) + OFAC SDN scraper + verificación SNS via `sns.id` proxy. Sin API key, totalmente gratis.
   - Paso 2 (semana 1): Sign‑up Helius free + Vybe free + Birdeye free + GoPlus (no requiere key). Integra Webacy SafetyScore y Chainabuse (registro gratuito como Partner).
   - Paso 3 (semana 2‑4): Añade Civic Pass + SAS attestation lookup, heurísticas de dust/poisoning, motor de scoring ponderado.

2. **Define umbrales de decisión claros**:
   - **REJECT (bloqueo duro)**: match en OFAC, HAPI, Chainabuse confirmado, o `executable=true` cuando el destinatario debería ser wallet.
   - **WARN (UI con confirmación adicional)**: edad < 7 días, score Webacy ≤ 4, > 30 % portfolio en tokens no verificados, sin historial.
   - **ALLOW**: edad > 180 días, score limpio en ≥ 3 fuentes, contraparte conocida o identidad SNS/SAS.

3. **Cachea agresivamente**: las labels de Helius/Vybe/Solscan no cambian frecuentemente; cache TTL 24 h reduce uso de free tier 10×.

4. **Usa "fail‑open" para listas, "fail‑closed" para sanciones**: si Webacy devuelve error → continúa; si OFAC scraper falla → rechaza por defecto.

5. **Monitoriza cambios**: lo que es seguro hoy puede ser flaggeado mañana. Ejecuta re‑checks periódicos sobre wallets recurrentes y suscríbete a webhooks de Helius (free tier incluye 1 webhook) para alertas en tiempo real.

6. **Cuándo subir de tier**:
   - > 1000 checks/día → Helius Developer ($49) o Vybe paid.
   - Necesitas SLA y compliance‑grade attribution → Range API (contactar) o Chainalysis (de pago).
   - Casos de uso B2B regulados → Chainabuse Pro Partner + Webacy enterprise (contactar; precios no públicos).

---

## Caveats

- **Las "free tiers" cambian frecuentemente**: a fecha de búsqueda, Helius ofrece 1M créditos/mes pero algunos artículos referencian "100 K DAS calls/mes" o "500 K credits" — confirma directamente en el dashboard antes de comprometerte.
- **Webacy/DD.xyz no publica precios ni límites exactos del free tier API**: requiere registro y a veces upgrade vía email para acceder a endpoints específicos como `/holder-analysis/`. Su SafetyScore para wallets es propietaria; no replicable sin la API.
- **GoPlus Malicious Address API en Solana es relativamente más nueva** que su versión EVM — coverage podría ser menor; combinar siempre con HAPI y Chainabuse.
- **OFAC SDN solo cubre lo que el US Treasury ha sancionado**: muchos scams operan sin estar en la lista. No es una garantía, sólo un kill‑switch legal.
- **HAPI Protocol** depende de la calidad de sus reporters (Chainalysis y Crystal son fuertes, comunidad puede tener falsos positivos). Verifica el campo `category` y `reporter` cuando consultas el contrato.
- **Phantom/Solflare blocklists son de URLs, NO de wallets**: error común pensar que cubren direcciones de destinatarios.
- **`free-solscan-api` (paoloanzn)** es ingeniería inversa no autorizada de la API interna de Solscan; útil para experimentación, **no para producción** (puede romperse o tener consecuencias legales).
- **Arkham Intelligence** no tiene API pública gratuita (a fecha actual) — la UI es gratuita pero los datos no son extraíbles programáticamente sin acuerdo enterprise.
- **SAS (Solana Attestation Service)** es relativamente nuevo (2025) — la cobertura de issuers crece pero todavía la mayoría de wallets activas no tienen ninguna attestation. Su ausencia NO debe ser señal negativa fuerte.
- **Heurísticas de address poisoning/dusting** generan falsos positivos: un usuario legítimo puede mandar 0.00001 SOL como prueba. Combina siempre múltiples señales, nunca una sola.
- **Endpoints públicos de RPC** (`api.mainnet-beta.solana.com`) están heavily rate‑limited; si construyes un servicio, usa Helius/QuickNode free tier desde el inicio.
- **Magic Eden API pública** (120 QPM sin auth) cambia ocasionalmente de schema; mantente atento a su changelog.
- **Range API** es excelente pero su "free tier" real es muy limitado (orientado a enterprise / Solana Developer Platform). No cuentes con ella para producto consumer gratis.
- **Jupiter `isVerified=false`** no implica scam — sólo significa que el token no ha pasado el sistema de "smart likes" comunitario; muchos tokens nuevos legítimos están temporalmente sin verificar.