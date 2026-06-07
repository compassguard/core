/**
 * Script de prueba para el chat backend con wallet Solana
 * 
 * Ejecutar con: npx tsx scripts/test-chat.ts
 */

import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';

const CHAT_URL = process.env.CHAT_URL || 'http://localhost:3002/api/chat';
const DEVNET_URL = 'https://api.devnet.solana.com';

async function generateTestWallet() {
  const keypair = Keypair.generate();
  console.log('🔑 Nueva wallet generada:');
  console.log('   Public Key:', keypair.publicKey.toBase58());
  console.log('   Secret Key:', `[${keypair.secretKey.slice(0, 8).join(', ')}...]`);
  return keypair;
}

async function requestAirdrop(connection: Connection, publicKey: PublicKey, amount: number = 1) {
  console.log(`\n💰 Solicitando airdrop de ${amount} SOL en devnet...`);
  
  try {
    const signature = await connection.requestAirdrop(publicKey, amount * LAMPORTS_PER_SOL);
    console.log('   Signature:', signature);
    
    // Wait for confirmation
    const latestBlockhash = await connection.getLatestBlockhash();
    await connection.confirmTransaction({
      signature,
      ...latestBlockhash,
    });
    
    const balance = await connection.getBalance(publicKey);
    console.log('   ✅ Balance actual:', balance / LAMPORTS_PER_SOL, 'SOL');
    return true;
  } catch (error) {
    console.log('   ❌ Error en airdrop:', (error as Error).message);
    console.log('   (Puede que el rate limit de devnet esté activo, intenta de nuevo en unos minutos)');
    return false;
  }
}

async function sendChatMessage(sessionId: string, message: string) {
  console.log(`\n💬 Enviando mensaje al chat...`);
  console.log('   Session:', sessionId);
  console.log('   Mensaje:', message);
  
  try {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.log('   ❌ Error HTTP:', response.status, error);
      return null;
    }

    console.log('\n📡 Respuesta SSE:');
    console.log('---');

    // Parse SSE stream
    const reader = response.body?.getReader();
    if (!reader) {
      console.log('   ❌ No response body');
      return null;
    }

    const decoder = new TextDecoder();
    let result = '';
    let fullContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      result += decoder.decode(value, { stream: true });
      
      // Parse SSE events
      const lines = result.split('\n');
      result = lines.pop() || ''; // Keep incomplete line for next iteration
      
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          const eventType = line.slice(7);
          process.stdout.write(`[${eventType}] `);
        } else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.content) {
              process.stdout.write(data.content);
              fullContent += data.content;
            } else if (data.proposal) {
              console.log('\n🔔 PROPOSAL:', JSON.stringify(data.proposal, null, 2));
            } else if (data.error) {
              console.log('\n❌ ERROR:', data.error, data.message);
            } else {
              console.log(JSON.stringify(data));
            }
          } catch {
            // Not JSON, skip
          }
        }
      }
    }
    
    console.log('\n---');
    return fullContent;
  } catch (error) {
    console.log('   ❌ Error de conexión:', (error as Error).message);
    console.log('   Asegúrate de que el servidor esté corriendo con: npm run dev');
    return null;
  }
}

async function main() {
  console.log('🚀 Test de Chat Backend con Wallet Solana\n');
  console.log('=' .repeat(50));

  // 1. Generate test wallets
  const fromWallet = await generateTestWallet();
  const toWallet = await generateTestWallet();

  // 2. Connect to devnet
  const connection = new Connection(DEVNET_URL, 'confirmed');
  console.log('\n🌐 Conectado a Solana Devnet');

  // 3. Request airdrop for from wallet
  await requestAirdrop(connection, fromWallet.publicKey, 1);

  // 4. Test simple chat
  console.log('\n' + '=' .repeat(50));
  console.log('TEST 1: Chat simple');
  console.log('=' .repeat(50));
  
  await sendChatMessage('test-1', 'Hola, ¿qué puedes hacer?');

  // 5. Test transfer request
  console.log('\n' + '=' .repeat(50));
  console.log('TEST 2: Solicitud de transferencia');
  console.log('=' .repeat(50));

  const transferMessage = `Quiero transferir 0.1 SOL desde ${fromWallet.publicKey.toBase58()} hacia ${toWallet.publicKey.toBase58()}`;
  await sendChatMessage('test-2', transferMessage);

  console.log('\n' + '=' .repeat(50));
  console.log('✅ Tests completados');
  console.log('=' .repeat(50));
}

main().catch(console.error);
