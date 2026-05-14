import { useState, useEffect } from 'react';
import { invoke, Channel } from '@tauri-apps/api/core';

type SignRequest =
  | { type: 'sign'; challenge: string }
  | { type: 'sign_event'; event: any }
  | { type: 'sign_credential'; credential: any; holder_did: string };

export default function WsSignPopup() {
  const [request, setRequest] = useState<SignRequest | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [autoSign, setAutoSign] = useState(false);

  useEffect(() => {
    const channel = new Channel<string>();
    channel.onmessage = (data) => {
      console.log("REACT: Received message via direct channel pipe:", data);
      try {
        const parsed = JSON.parse(data);
        if (parsed.__type__ === 'sign_event') {
          setRequest({ type: 'sign_event', event: parsed.event });
        } else if (parsed.__type__ === 'sign_credential') {
          setRequest({ type: 'sign_credential', credential: parsed.credential, holder_did: parsed.holder_did });
        } else if (parsed.__type__ === 'sign') {
          setRequest({ type: 'sign', challenge: parsed.challenge });
        } else {
          setRequest({ type: 'sign', challenge: data });
        }
      } catch {
        setRequest({ type: 'sign', challenge: data });
      }
    };
    invoke('register_challenge_pipe', { channel });
    console.log("REACT: Challenge channel registered with backend");
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
      if (request.type === 'sign_event') {
        await invoke('submit_ws_event_response', {
          eventJson: JSON.stringify(request.event),
          approved
        });
        console.log("REACT: submit_ws_event_response succeeded");
      } else if (request.type === 'sign_credential') {
        await invoke('submit_ws_credential_response', {
          credentialJson: JSON.stringify(request.credential),
          holderDid: request.holder_did,
          approved
        });
        console.log("REACT: submit_ws_credential_response succeeded");
      } else {
        await invoke('submit_ws_response', {
          id: '',
          challenge: request.challenge,
          approved
        });
        console.log("REACT: submit_ws_response succeeded");
      }
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
        maxWidth: '500px', width: '100%', boxShadow: '0 10px 25px rgba(0,0,0,0.2)'
      }}>
        <h2 style={{marginTop: 0}}>
          {request.type === 'sign_event' ? 'Nostr Event Signing Request'
            : request.type === 'sign_credential' ? 'Credential Signing Request'
            : 'Signature Request'}
        </h2>

        {request.type === 'sign' && (
          <>
            <p>A local application is requesting a signature from your Vault identity.</p>
            <div style={{margin: '1.5rem 0'}}>
              <strong>Challenge:</strong>
              <pre style={{
                background: '#f4f4f4', padding: '1rem', borderRadius: '6px',
                overflowX: 'auto', fontSize: '0.85em', color: '#333'
              }}>{request.challenge}</pre>
            </div>
          </>
        )}

        {request.type === 'sign_event' && (
          <>
            <p>A local application is requesting to sign a Nostr event with your Vault identity.</p>
            <div style={{margin: '1.5rem 0'}}>
              <strong>Event Details:</strong>
              <pre style={{
                background: '#f4f4f4', padding: '1rem', borderRadius: '6px',
                overflowX: 'auto', fontSize: '0.85em', color: '#333',
                maxHeight: '250px', overflowY: 'auto'
              }}>{JSON.stringify(request.event, null, 2)}</pre>
            </div>
          </>
        )}

        {request.type === 'sign_credential' && (
          <>
            <p>A local application is requesting to issue a Verifiable Credential with your Vault identity as issuer.</p>
            <div style={{margin: '1.5rem 0'}}>
              <strong>Issuer DID:</strong>
              <span style={{fontFamily: 'monospace', fontSize: '0.85em', display: 'block', marginTop: '0.3rem'}}>{request.holder_did}</span>
            </div>
            <div style={{margin: '1rem 0'}}>
              <strong>Credential Body:</strong>
              <pre style={{
                background: '#f4f4f4', padding: '1rem', borderRadius: '6px',
                overflowX: 'auto', fontSize: '0.85em', color: '#333',
                maxHeight: '250px', overflowY: 'auto'
              }}>{JSON.stringify(request.credential, null, 2)}</pre>
            </div>
          </>
        )}

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
