import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  streamChat,
  postApprove,
  postFunctionResult,
  postReject,
  getHistory,
  ApiClientError,
  type SwapGuardWarning,
  type GuardRejection,
} from '@/lib/api/client';
import { useSettingsStore } from '@/stores/settingsStore';
import { useChatStore } from '@/stores/chatStore';
import { useWallet } from './useWallet';

type SignAndSendError = Error & {
  code?: string;
};

const hydratedSessionIds = new Set<string>();
const hydratingSessionIds = new Set<string>();

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
  const setGuardRejection = useChatStore((state) => state.setGuardRejection);
  const completeProposal = useChatStore((state) => state.completeProposal);
  const canApproveProposal = useChatStore((state) => state.canApproveProposal);
  const setConversationExpired = useChatStore((state) => state.setConversationExpired);
  const hydrateSessionHistory = useChatStore((state) => state.hydrateSessionHistory);
  const clearSessionData = useChatStore((state) => state.clearSessionData);

  // Track pending state
  const isPendingRef = useRef(false);
  const [isPending, setIsPending] = useState(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const hydrateSession = useCallback(async () => {
    const sessionId = useChatStore.getState().sessionId;
    if (!sessionId) return;
    if (hydratedSessionIds.has(sessionId) || hydratingSessionIds.has(sessionId)) return;
    hydratingSessionIds.add(sessionId);
    try {
      const history = await getHistory(sessionId);
      hydrateSessionHistory(history.session_id, history.messages, history.pending_proposal);
      hydratedSessionIds.add(sessionId);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'session_not_found') {
        hydratedSessionIds.delete(sessionId);
        clearSessionData();
      } else {
        console.error('[chat] Failed to hydrate session history:', error);
      }
    } finally {
      hydratingSessionIds.delete(sessionId);
    }
  }, [clearSessionData, hydrateSessionHistory]);

  useEffect(() => {
    void hydrateSession();
  }, [hydrateSession]);

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

  const approveProposal = useCallback(async (acceptRisk?: boolean) => {
    const currentSessionId = useChatStore.getState().sessionId;
    const proposal = useChatStore.getState().pendingProposal;
    const guardRejectionState = useChatStore.getState().guardRejection;
    const currentStatus = useChatStore.getState().status;
    
    console.log(`[approveProposal] Called with acceptRisk=${acceptRisk}`);
    console.log(`[approveProposal] sessionId=${currentSessionId}, proposal=${!!proposal}, guardRejection=${!!guardRejectionState}`);
    console.log(`[approveProposal] status=${currentStatus}, canApproveProposal()=${canApproveProposal()}`);
    
    // For guard rejection bypass, we only need sessionId (backend has all proposal data)
    const isBypassingGuard = guardRejectionState && acceptRisk === true;
    
    // Allow approval if: normal approval OR accepting risk after guard rejection
    const canApprove = canApproveProposal() || isBypassingGuard;
    console.log(`[approveProposal] canApprove=${canApprove}, isBypassingGuard=${isBypassingGuard}`);
    
    // For normal flow: need proposal + sessionId + canApprove
    // For bypass flow: only need sessionId (proposal data is in backend session)
    if (!currentSessionId || (!isBypassingGuard && (!proposal || !canApprove))) {
      console.log(`[approveProposal] BLOCKED: proposal=${!!proposal}, sessionId=${!!currentSessionId}, canApprove=${canApprove}, isBypassingGuard=${isBypassingGuard}`);
      return;
    }

    setCurrentWalletAddress(userAddress || null);
    setStatus('executing');
    setProposalUiState('preparing_transaction');

    try {
      console.log(`[chat] Approving proposal, acceptRisk=${acceptRisk}`);
      const response = await postApprove(currentSessionId, acceptRisk);
      if (response.messages.length > 0) {
        addAgentMessages(response.messages);
      }

      // Check if guard rejected the transaction (bypassable)
      if (response.guard_rejection && response.proposal_state?.state === 'guard_rejected_awaiting_bypass') {
        console.log('[chat] Guard rejected transaction, awaiting bypass decision');
        console.log('[chat] guard_rejection:', JSON.stringify(response.guard_rejection));
        setGuardRejection(response.guard_rejection);
        setProposalUiState('guard_rejected');
        setStatus('idle');
        return;
      }

      // Clear guard rejection if we got past it (bypass accepted or normal flow)
      setGuardRejection(null);

      // Store swap guard warning if present (for UI to display)
      if (response.swap_guard_warning) {
        console.log('[chat] Swap guard warning:', response.swap_guard_warning.message);
        setSwapGuardWarning(response.swap_guard_warning);
      } else {
        setSwapGuardWarning(null);
      }

      // Check if proposal was cancelled (user declined bypass)
      if (response.proposal_state?.state === 'cancelled') {
        console.log('[chat] Proposal cancelled');
        setProposalUiState('cancelled');
        setPendingProposal(null);
        setStatus('idle');
        return;
      }

      if (!response.transaction?.unsigned_tx_base64) {
        completeProposal('failed', {
          status: 'failed',
          error: 'No se pudo preparar la transacción para firma',
        });
        return;
      }

      // Log if this was a bypassed transaction
      if (response.guard_bypassed) {
        console.log('[chat] Transaction built WITHOUT guard protection (user accepted risk)');
      }

      setProposalUiState('awaiting_signature');

      // For bypass flow, proposal might be null, so get expected address from response or use current user
      const expectedUserAddress = proposal?.execution?.expected_user_address ?? userAddress;
      console.log('[chat] Sending TX to wallet for signature, expectedUserAddress:', expectedUserAddress);
      console.log('[chat] TX base64 length:', response.transaction.unsigned_tx_base64.length);
      
      let signResult;
      try {
        signResult = await signAndSendPreparedTransaction(
          response.transaction.unsigned_tx_base64,
          expectedUserAddress,
        );
        console.log('[chat] TX signed and sent successfully:', signResult.tx_signature);
      } catch (signError) {
        console.error('[chat] signAndSendPreparedTransaction failed:', signError);
        console.error('[chat] Sign error details:', {
          message: (signError as Error)?.message,
          code: (signError as SignAndSendError)?.code,
          name: (signError as Error)?.name,
        });
        throw signError; // Re-throw to be handled by outer catch
      }

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
    setGuardRejection,
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
