import { useCallback, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { streamChat, postApprove, postReject, ApiClientError, TransactionPayload } from '@/lib/api/client';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useWallet } from './useWallet';
import { getPhantomProvider } from '@/types/phantom';
import { Connection, SendTransactionError, VersionedTransaction, Transaction } from '@solana/web3.js';

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Signs and sends a transaction using Phantom wallet.
 * Handles different formats: versioned message, versioned transaction, legacy transaction.
 * @returns The transaction signature if successful
 * @throws Error if wallet not detected or transaction fails
 */
async function signAndSendTransaction(txPayload: TransactionPayload): Promise<string> {
  const provider = getPhantomProvider();
  if (!provider) throw new Error('Phantom wallet not detected');

  const raw = base64ToUint8Array(txPayload.unsigned_tx_base64);
  const conn = new Connection('https://api.devnet.solana.com', 'confirmed');

  try {
    if (txPayload.format === 'base64_versioned_transaction') {
      const tx = VersionedTransaction.deserialize(raw);
      const signed = await provider.signTransaction(tx);
      const sig = await conn.sendRawTransaction((signed as VersionedTransaction).serialize(), {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      });
      await conn.confirmTransaction({
        signature: sig,
        blockhash: txPayload.recent_blockhash ?? tx.message.recentBlockhash,
        lastValidBlockHeight: txPayload.last_valid_block_height,
      }, 'confirmed');
      return sig;
    }

    const legacyTx = Transaction.from(raw);
    const signed = await provider.signTransaction(legacyTx);
    const sig = await conn.sendRawTransaction((signed as Transaction).serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await conn.confirmTransaction({
      signature: sig,
      blockhash: txPayload.recent_blockhash ?? legacyTx.recentBlockhash,
      lastValidBlockHeight: txPayload.last_valid_block_height,
    }, 'confirmed');
    return sig;
  } catch (error) {
    if (error instanceof SendTransactionError) {
      const logs = await error.getLogs(conn).catch(() => []);
      const logText = logs.length > 0 ? ` Logs: ${logs.join(' | ')}` : '';
      throw new Error(`${error.message}${logText}`);
    }
    throw error;
  }
}

export function useAgentMessage() {
  const queryClient = useQueryClient();
  const threshold = useSettingsStore((state) => state.autoConfirmThresholdUsd);
  const { address: userAddress } = useWallet();
  
  // Store actions
  const sessionId = useChatStore((state) => state.sessionId);
  const setSessionId = useChatStore((state) => state.setSessionId);
  const addUserMessage = useChatStore((state) => state.addUserMessage);
  const addAgentMessages = useChatStore((state) => state.addAgentMessages);
  const startStreaming = useChatStore((state) => state.startStreaming);
  const appendToken = useChatStore((state) => state.appendToken);
  const finishStreaming = useChatStore((state) => state.finishStreaming);
  const setProposalFromSSE = useChatStore((state) => state.setProposalFromSSE);
  const setStatus = useChatStore((state) => state.setStatus);
  const setProposalUiState = useChatStore((state) => state.setProposalUiState);
  const setPendingProposal = useChatStore((state) => state.setPendingProposal);
  const completeProposal = useChatStore((state) => state.completeProposal);

  // Track pending state
  const isPendingRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sendUserMessage = useCallback(async (content: string) => {
    const blocked = useChatStore.getState().isInputBlocked();
    if (blocked || isPendingRef.current) return;

    isPendingRef.current = true;
    addUserMessage(content);
    startStreaming();

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
      await streamChat(
        {
          type: 'user_message',
          content,
          session_id: sessionId || undefined,
          user_address: userAddress || undefined,
          user_threshold_usd: threshold,
        },
        {
          onSession: (newSessionId) => {
            setSessionId(newSessionId);
          },
          onToken: (tokenContent) => {
            appendToken(tokenContent);
          },
          onProposal: (proposal) => {
            setProposalFromSSE(proposal);
          },
          onDone: (data) => {
            if (!data.awaiting_approval) {
              finishStreaming();
            }
            // If awaiting_approval, the proposal handler already updated status
          },
          onError: (error) => {
            console.error('[chat] SSE error:', error);
            finishStreaming();
            setStatus('idle');
          },
        },
        abortControllerRef.current.signal
      );
    } catch (error) {
      if (error instanceof ApiClientError) {
        console.error('[chat] API error:', error.code, error.message);
      } else {
        console.error('[chat] Unknown error:', error);
      }
      finishStreaming();
      setStatus('idle');
    } finally {
      isPendingRef.current = false;
      abortControllerRef.current = null;
    }
  }, [
    sessionId,
    userAddress,
    threshold,
    addUserMessage,
    startStreaming,
    appendToken,
    finishStreaming,
    setSessionId,
    setProposalFromSSE,
    setStatus,
  ]);

  const approveProposal = useCallback(async () => {
    const currentSessionId = useChatStore.getState().sessionId;
    const proposal = useChatStore.getState().pendingProposal;
    if (!proposal || !currentSessionId) return;

    setStatus('executing');
    setProposalUiState('awaiting_execution');

    try {
      const response = await postApprove(currentSessionId);

      // Check if backend returned a transaction to sign
      if (!response.transaction) {
        // No transaction to sign - this is an error state
        console.error('[chat] No transaction in approve response');
        completeProposal('failed', { 
          status: 'failed', 
          error: 'El servidor no devolvió una transacción para firmar' 
        });
        return;
      }

      // Sign and send the transaction using Phantom
      const txSig = await signAndSendTransaction(response.transaction);

      // Transaction was successful - complete with real signature
      // Don't add backend messages to avoid duplication - completeProposal will add the result message
      completeProposal('success', { 
        status: 'success', 
        tx_hash: txSig 
      });
      
      // Invalidate wallet queries to refresh balances
      await queryClient.invalidateQueries({ queryKey: ['wallet'] });
      
    } catch (error) {
      console.error('[chat] Approve error:', error);
      const errorMessage = error instanceof Error ? error.message : 'Error desconocido al ejecutar la transacción';
      completeProposal('failed', { status: 'failed', error: errorMessage });
    }
  }, [completeProposal, setStatus, setProposalUiState, queryClient]);

  const rejectProposal = useCallback(async () => {
    const currentSessionId = useChatStore.getState().sessionId;
    const proposal = useChatStore.getState().pendingProposal;
    if (!proposal || !currentSessionId) return;

    setProposalUiState('cancelled');
    setPendingProposal(null);
    setStatus('idle');

    try {
      const response = await postReject(currentSessionId);
      if (response.messages.length > 0) {
        addAgentMessages(response.messages);
      }
    } catch (error) {
      console.error('[chat] Reject error:', error);
      // Already cleared the proposal, just log the error
    }
  }, [addAgentMessages, setPendingProposal, setProposalUiState, setStatus]);

  return {
    sendUserMessage,
    approveProposal,
    rejectProposal,
    isPending: isPendingRef.current,
    error: null,
  };
}
