import { useState, useEffect } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';

interface SignRequest {
  challenge: string;
}

export default function WsSignPopup() {
  const [request, setRequest] = useState<SignRequest | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [autoSign, setAutoSign] = useState(false);

  useEffect(() => {
    const channel = new Channel<string>();
    channel.onmessage = (challenge) => {
      console.log("REACT: Received challenge via direct channel pipe:", challenge);
      setRequest({ challenge });
    };
    invoke('register_challenge_pipe', { channel });
    console.log("REACT: Challenge channel registered with backend");

    const interval = setInterval(async () => {
      console.log("INTERNAL: Polling Rust for challenge...");
      try {
        const challenge = await invoke<string | null>('get_pending_ws_challenge');
        if (challenge) {
          alert("CHALLENGE CAPTURED BY UI (polling fallback): " + challenge);
          setRequest({ challenge });
        }
      } catch (e) {
        console.error("INTERNAL: Invoke failed! Permission issue?", e);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoSign && request && !isProcessing) {
      console.log("REACT: Auto-sign enabled, approving immediately");
      handleResponse(true);
    }
  }, [autoSign, request]);

  const handleResponse = async (approved: boolean) => {
    if (!request) return;
    setIsProcessing(true);

    try {
      await invoke('submit_ws_response', {
        id: '',
        challenge: request.challenge,
        approved
      });
      console.log("REACT: submit_ws_response succeeded");
    } catch (err) {
      console.error("Failed to submit WS response:", err);
    } finally {
      setIsProcessing(false);
      setRequest(null);
    }
  };

  if (!request) return null;

  return (
    <div className="popup-overlay" style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div className="popup-content" style={{
        background: 'white', padding: '2rem', borderRadius: '12px',
        maxWidth: '400px', width: '100%', boxShadow: '0 10px 25px rgba(0,0,0,0.2)'
      }}>
        <h2 style={{marginTop: 0}}>Signature Request</h2>
        <p>A local application is requesting a signature from your Vault identity.</p>

        <div style={{margin: '1.5rem 0'}}>
          <strong>Challenge:</strong>
          <pre style={{
            background: '#f4f4f4', padding: '1rem', borderRadius: '6px',
            overflowX: 'auto', fontSize: '0.85em', color: '#333'
          }}>{request.challenge}</pre>
        </div>

        <div style={{display: 'flex', gap: '1rem', justifyContent: 'space-between', alignItems: 'center'}}>
          <label style={{fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.3rem'}}>
            <input
              type="checkbox"
              checked={autoSign}
              onChange={(e) => setAutoSign(e.target.checked)}
            />
            Auto-sign (dev)
          </label>
          <div style={{display: 'flex', gap: '1rem'}}>
            <button
              onClick={() => handleResponse(false)}
              disabled={isProcessing}
              style={{background: '#f4f4f4', color: '#333', border: '1px solid #ccc'}}
            >
              Deny
            </button>
            <button
              onClick={() => handleResponse(true)}
              disabled={isProcessing}
              style={{background: '#137333', color: 'white'}}
            >
              {isProcessing ? 'Signing...' : 'Approve & Sign'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
