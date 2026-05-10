import { useCallback, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  streamChat,
  postApprove,
  postFunctionResult,
  postReject,
  ApiClientError,
  type SwapGuardWarning,
} from '@/lib/api/client';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useWallet } from './useWallet';

type SignAndSendError = Error & {
  code?: string;
};

function getApprovalFailureMessage(error: unknown): string {
  if (error instanceof ApiClientError) {
    const messages: Record<string, string> = {
      ONCHAIN_ACTION_APPROVAL_ACCOUNT_MISSING: 'La aprobación on-chain ya no está disponible. Regenerá la propuesta.',
      ONCHAIN_ACTION_APPROVAL_EXPIRED: 'La aprobación on-chain expiró. Regenerá la propuesta.',
      ONCHAIN_ACTION_APPROVAL_ALREADY_EXECUTED: 'Esta aprobación ya fue usada. Regenerá la propuesta.',
      ONCHAIN_ACTION_APPROVAL_REVOKED: 'La aprobación on-chain fue revocada. Regenerá la propuesta.',
      ONCHAIN_ACTION_APPROVAL_RECIPIENT_MISMATCH: 'El destino no coincide con la aprobación on-chain.',
      ONCHAIN_ACTION_APPROVAL_AMOUNT_MISMATCH: 'El monto no coincide con la aprobación on-chain.',
      ONCHAIN_WALLET_SAFETY_ATTESTATION_ACCOUNT_MISSING: 'La validación de seguridad on-chain no está disponible. Regenerá la propuesta.',
      ONCHAIN_WALLET_SAFETY_ATTESTATION_EXPIRED: 'La validación de seguridad on-chain expiró. Regenerá la propuesta.',
      ONCHAIN_WALLET_SAFETY_ATTESTATION_RECIPIENT_MISMATCH: 'El destino no coincide con la validación de seguridad on-chain.',
      ONCHAIN_WALLET_SAFETY_ATTESTATION_ACTION_HASH_MISMATCH: 'La validación on-chain no corresponde a esta propuesta.',
      onchain_guard_context_missing: 'Falta contexto del guardrail on-chain. Regenerá la propuesta.',
      action_hash_mismatch: 'La propuesta cambió desde que fue creada. Regenerá la propuesta.',
      pending_proposal_expired: 'La propuesta expiró. Generá una nueva.',
    };
    return messages[error.code] || error.message;
  }

  return error instanceof Error ? error.message : 'Error al aprobar la transferencia';
}

export function useAgentMessage() {
  const queryClient = useQueryClient();
  const threshold = useSettingsStore((state) => state.autoConfirmThresholdUsd);
  const { address: userAddress, signAndSendPreparedTransaction } = useWallet();

  // Store actions
  const setCurrentWalletAddress = useChatStore((state) => state.setCurrentWalletAddress);
  const setSessionId = useChatStore((state) => state.setSessionId);
  const ensureConversationForInput = useChatStore((state) => state.ensureConversationForInput);
  const addUserMessage = useChatStore((state) => state.addUserMessage);
  const addAgentMessages = useChatStore((state) => state.addAgentMessages);
  const startStreaming = useChatStore((state) => state.startStreaming);
  const appendToken = useChatStore((state) => state.appendToken);
  const finishStreaming = useChatStore((state) => state.finishStreaming);
  const setProposalFromSSE = useChatStore((state) => state.setProposalFromSSE);
  const setStatus = useChatStore((state) => state.setStatus);
  const setProposalUiState = useChatStore((state) => state.setProposalUiState);
  const setPendingProposal = useChatStore((state) => state.setPendingProposal);
  const setSwapGuardWarning = useChatStore((state) => state.setSwapGuardWarning);
  const completeProposal = useChatStore((state) => state.completeProposal);
  const canApproveProposal = useChatStore((state) => state.canApproveProposal);
  const setConversationExpired = useChatStore((state) => state.setConversationExpired);

  // Track pending state
  const isPendingRef = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sendUserMessage = useCallback(async (content: string) => {
    const blocked = useChatStore.getState().isInputBlocked();
    if (blocked || isPendingRef.current) return;

    setCurrentWalletAddress(userAddress || null);
    ensureConversationForInput(userAddress || null);
    isPendingRef.current = true;
    setIsPending(true);
    addUserMessage(content);
    startStreaming();

    // Create abort controller for this request
    abortControllerRef.current = new AbortController();

    try {
      await streamChat(
        {
          type: 'user_message',
          content,
          session_id: useChatStore.getState().sessionId || undefined,
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
              return;
            }
            // Safety fallback: if backend says awaiting approval but proposal was
            // rejected by schema/parsing, avoid leaving UI in "thinking" state.
            const hasPendingProposal = useChatStore.getState().pendingProposal !== null;
            if (!hasPendingProposal) {
              finishStreaming();
              setStatus('idle');
            }
          },
          onError: (error) => {
            console.warn('[chat] SSE error:', error.code, error.message);
            addAgentMessages([
              {
                type: 'text',
                content: error.message || 'No pude completar la respuesta. Probá reformular el pedido.',
                timestamp: new Date().toISOString(),
              },
            ]);
            finishStreaming();
            setStatus('idle');
          },
        },
        abortControllerRef.current.signal
      );
    } catch (error) {
      if (error instanceof ApiClientError) {
        if (error.code === 'session_not_found') {
          setConversationExpired();
        }
        console.error('[chat] API error:', error.code, error.message);
      } else {
        console.error('[chat] Unknown error:', error);
      }
      finishStreaming();
      setStatus('idle');
    } finally {
      isPendingRef.current = false;
      setIsPending(false);
      abortControllerRef.current = null;
    }
  }, [
    userAddress,
    threshold,
    setCurrentWalletAddress,
    ensureConversationForInput,
    addUserMessage,
    startStreaming,
    appendToken,
    finishStreaming,
    setSessionId,
    setProposalFromSSE,
    addAgentMessages,
    setStatus,
    setConversationExpired,
  ]);

  const approveProposal = useCallback(async () => {
    const currentSessionId = useChatStore.getState().sessionId;
    const proposal = useChatStore.getState().pendingProposal;
    const canApprove = canApproveProposal();
    if (!proposal || !currentSessionId || !canApprove) return;

    setCurrentWalletAddress(userAddress || null);
    setStatus('executing');
    setProposalUiState('preparing_transaction');

    try {
      const response = await postApprove(currentSessionId);
      if (response.messages.length > 0) {
        addAgentMessages(response.messages);
      }

      // Store swap guard warning if present (for UI to display)
      if (response.swap_guard_warning) {
        console.log('[chat] Swap guard warning:', response.swap_guard_warning.message);
        setSwapGuardWarning(response.swap_guard_warning);
      } else {
        setSwapGuardWarning(null);
      }

      if (!response.transaction?.unsigned_tx_base64) {
        completeProposal('failed', {
          status: 'failed',
          error: 'No se pudo preparar la transacción para firma',
        });
        return;
      }

      setProposalUiState('awaiting_signature');

      const expectedUserAddress = proposal.execution?.expected_user_address;
      const signResult = await signAndSendPreparedTransaction(
        response.transaction.unsigned_tx_base64,
        expectedUserAddress ?? userAddress,
      );

      setProposalUiState('submitted');
      postFunctionResult(currentSessionId, signResult.tx_signature, 'submitted').catch((callbackError) => {
        console.warn('[chat] Optional function_result submitted callback failed:', callbackError);
      });

      completeProposal('success', {
        status: 'success',
        tx_hash: signResult.tx_signature,
      });

      await queryClient.invalidateQueries({ queryKey: ['wallet'] });
      try {
        const confirmedResponse = await postFunctionResult(currentSessionId, signResult.tx_signature, 'confirmed');
        if (confirmedResponse.messages.length > 0) {
          addAgentMessages(confirmedResponse.messages);
        }
      } catch (callbackError) {
        console.warn('[chat] Optional function_result confirmed callback failed:', callbackError);
      }
    } catch (error) {
      const errorMessage = getApprovalFailureMessage(error);
      const errorCode = (error as SignAndSendError)?.code;
      const rejectedByUser = errorCode === 'user_rejected' || /rejected|denied/i.test(errorMessage);
      const shouldCancel =
        errorCode === 'wallet_mismatch' ||
        errorCode === 'phantom_not_connected' ||
        errorCode === 'account_changed';

      if (error instanceof ApiClientError && error.code === 'session_not_found') {
        setConversationExpired();
      }
      console.error('[chat] Approve error:', error);

      if (rejectedByUser || shouldCancel) {
        setProposalUiState('cancelled');
        setPendingProposal(null);
        setStatus('idle');
        postReject(currentSessionId, errorMessage).catch((rejectError) => {
          console.warn('[chat] Optional reject cleanup failed:', rejectError);
        });
        return;
      }

      completeProposal('failed', {
        status: 'failed',
        error: errorMessage,
      });
    }
  }, [
    userAddress,
    addAgentMessages,
    canApproveProposal,
    completeProposal,
    setConversationExpired,
    setCurrentWalletAddress,
    setStatus,
    setProposalUiState,
    setPendingProposal,
    setSwapGuardWarning,
    signAndSendPreparedTransaction,
    queryClient,
  ]);

  const rejectProposal = useCallback(async () => {
    const currentSessionId = useChatStore.getState().sessionId;
    const proposal = useChatStore.getState().pendingProposal;
    const canApprove = canApproveProposal();
    if (!proposal || !currentSessionId || !canApprove) return;

    setProposalUiState('cancelled');
    setPendingProposal(null);
    setStatus('idle');
    setCurrentWalletAddress(userAddress || null);

    try {
      const response = await postReject(currentSessionId);
      if (!response.messages.length) return;
      if (response.messages.length > 0) {
        addAgentMessages(response.messages);
      }
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'session_not_found') {
        setConversationExpired();
      }
      console.error('[chat] Reject error:', error);
      // Already cleared the proposal, just log the error
    }
  }, [addAgentMessages, canApproveProposal, setCurrentWalletAddress, setConversationExpired, setPendingProposal, setProposalUiState, setStatus, userAddress]);

  return {
    sendUserMessage,
    approveProposal,
    rejectProposal,
    isPending,
    error: null,
  };
}
