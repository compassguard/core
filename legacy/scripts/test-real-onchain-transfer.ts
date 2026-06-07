/**
 * Script de prueba que ejecuta una transferencia REAL on-chain.
 * 
 * 1. Carga wallet de prueba con private key
 * 2. Envía mensaje al chat pidiendo transferir
 * 3. Recibe propuesta del chat
 * 4. Aprueba la propuesta
 * 5. Construye y firma la transacción real
 * 6. Envía a devnet
 * 7. Verifica balances antes/después
 * 
 * Ejecutar: npx tsx scripts/test-real-onchain-transfer.ts
 */

import {
  Keypair,
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as fs from 'fs';

const CHAT_URL = process.env.CHAT_URL || 'http://localhost:3000/api/chat';
const DEVNET_URL = 'https://api.devnet.solana.com';

// Cargar wallet de prueba
function loadTestWallet(): Keypair {
  const walletPath = '/tmp/test-wallet.json';
  if (!fs.existsSync(walletPath)) {
    throw new Error('No se encontró wallet de prueba. Ejecuta primero el script de generación.');
  }
  const data = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(data.secretKey));
}

// Generar wallet destino
function generateDestinationWallet(): Keypair {
  return Keypair.generate();
}

// Parsear respuesta SSE
function parseSSEResponse(response: string): { events: Array<{ type: string; data: any }> } {
  const events: Array<{ type: string; data: any }> = [];
  const lines = response.split('\n');
  
  let currentEvent = '';
  for (const line of lines) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7);
    } else if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        events.push({ type: currentEvent, data });
      } catch {
        // Skip invalid JSON
      }
    }
  }
  
  return { events };
}

// Enviar mensaje al chat
async function sendChatMessage(sessionId: string, message: string): Promise<string> {
  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      messages: [{ role: 'user', content: message }],
    }),
  });
  
  return response.text();
}

// Aprobar propuesta
async function approveProposal(sessionId: string): Promise<string> {
  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      threadId: sessionId,
      resume: { approved: true },
    }),
  });
  
  return response.text();
}

// Ejecutar transferencia real on-chain
async function executeRealTransfer(
  connection: Connection,
  fromKeypair: Keypair,
  toPublicKey: PublicKey,
  amountSOL: number
): Promise<string> {
  const lamports = Math.floor(amountSOL * LAMPORTS_PER_SOL);
  
  const transaction = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: fromKeypair.publicKey,
      toPubkey: toPublicKey,
      lamports,
    })
  );
  
  const signature = await sendAndConfirmTransaction(connection, transaction, [fromKeypair]);
  return signature;
}

// Obtener balance
async function getBalance(connection: Connection, publicKey: PublicKey): Promise<number> {
  const balance = await connection.getBalance(publicKey);
  return balance / LAMPORTS_PER_SOL;
}

async function main() {
  console.log('🚀 TEST DE TRANSFERENCIA REAL ON-CHAIN');
  console.log('='.repeat(50));
  console.log('');

  // 1. Cargar wallets
  console.log('📦 Cargando wallets...');
  const fromWallet = loadTestWallet();
  const toWallet = generateDestinationWallet();
  
  console.log('   FROM:', fromWallet.publicKey.toBase58());
  console.log('   TO:  ', toWallet.publicKey.toBase58());
  console.log('');

  // 2. Conectar a devnet
  const connection = new Connection(DEVNET_URL, 'confirmed');
  console.log('🌐 Conectado a Solana Devnet');
  console.log('');

  // 3. Verificar balance inicial
  console.log('💰 Balances iniciales:');
  const initialFromBalance = await getBalance(connection, fromWallet.publicKey);
  const initialToBalance = await getBalance(connection, toWallet.publicKey);
  console.log('   FROM:', initialFromBalance, 'SOL');
  console.log('   TO:  ', initialToBalance, 'SOL');
  console.log('');

  if (initialFromBalance < 0.01) {
    console.log('❌ ERROR: La wallet FROM no tiene suficiente SOL');
    console.log('   Carga al menos 0.1 SOL a:', fromWallet.publicKey.toBase58());
    process.exit(1);
  }

  const amountToTransfer = 0.01; // 0.01 SOL
  const sessionId = `real-transfer-${Date.now()}`;

  // 4. Enviar mensaje al chat
  console.log('💬 Enviando solicitud de transferencia al chat...');
  const chatMessage = `Transfiere ${amountToTransfer} SOL desde ${fromWallet.publicKey.toBase58()} hacia ${toWallet.publicKey.toBase58()}`;
  console.log('   Mensaje:', chatMessage);
  console.log('');

  const chatResponse = await sendChatMessage(sessionId, chatMessage);
  const { events } = parseSSEResponse(chatResponse);
  
  // 5. Buscar propuesta
  const proposalEvent = events.find(e => e.type === 'proposal');
  if (!proposalEvent) {
    console.log('❌ ERROR: No se recibió propuesta del chat');
    console.log('   Respuesta:', chatResponse.slice(0, 500));
    process.exit(1);
  }

  console.log('📋 Propuesta recibida:');
  console.log('   Tipo:', proposalEvent.data.proposal?.type);
  console.log('   From:', proposalEvent.data.proposal?.fromWallet);
  console.log('   To:  ', proposalEvent.data.proposal?.toWallet);
  console.log('   Amount:', proposalEvent.data.proposal?.amount, 'SOL');
  console.log('   On-chain:', proposalEvent.data.proposal?.executedOnChain);
  console.log('');

  // 6. Aprobar propuesta via chat
  console.log('✅ Aprobando propuesta via chat...');
  const approvalResponse = await approveProposal(sessionId);
  const approvalEvents = parseSSEResponse(approvalResponse);
  
  // Mostrar respuesta del LLM
  const tokens = approvalEvents.events
    .filter(e => e.type === 'token')
    .map(e => e.data.content)
    .join('');
  console.log('   LLM dice:', tokens.slice(0, 200) + '...');
  console.log('');

  // 7. EJECUTAR TRANSFERENCIA REAL ON-CHAIN
  console.log('🔥 EJECUTANDO TRANSFERENCIA REAL ON-CHAIN...');
  try {
    const signature = await executeRealTransfer(
      connection,
      fromWallet,
      toWallet.publicKey,
      amountToTransfer
    );
    console.log('   ✅ TRANSACCIÓN EXITOSA!');
    console.log('   Signature:', signature);
    console.log('   Explorer: https://explorer.solana.com/tx/' + signature + '?cluster=devnet');
  } catch (error) {
    console.log('   ❌ Error en transacción:', (error as Error).message);
    process.exit(1);
  }
  console.log('');

  // 8. Verificar balances finales
  console.log('💰 Balances finales:');
  const finalFromBalance = await getBalance(connection, fromWallet.publicKey);
  const finalToBalance = await getBalance(connection, toWallet.publicKey);
  console.log('   FROM:', finalFromBalance, 'SOL (antes:', initialFromBalance, ')');
  console.log('   TO:  ', finalToBalance, 'SOL (antes:', initialToBalance, ')');
  console.log('');

  // 9. Resumen
  console.log('='.repeat(50));
  console.log('📊 RESUMEN:');
  console.log('   Transferido:', amountToTransfer, 'SOL');
  console.log('   FROM perdió:', (initialFromBalance - finalFromBalance).toFixed(6), 'SOL (incluye fee)');
  console.log('   TO ganó:', (finalToBalance - initialToBalance).toFixed(6), 'SOL');
  console.log('');
  console.log('✅ TEST COMPLETADO EXITOSAMENTE');
}

main().catch(console.error);
