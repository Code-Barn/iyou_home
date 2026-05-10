import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Note: In the future, we can import init, { verify_vp } from '../lib/did_rust_wasm/did_rust.js'
// to locally verify the created VP in WASM before returning it to the user.

export default function SovereignSigner() {
  const [activeDid, setActiveDid] = useState<string | null>(null);
  const [challenge, setChallenge] = useState('');
  const [presentation, setPresentation] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchActiveDid();
  }, []);

  const fetchActiveDid = async () => {
    try {
      const did = await invoke<string | null>('get_active_did');
      setActiveDid(did);
    } catch (err: any) {
      console.error("Failed to fetch active DID:", err);
    }
  };

  const handleSign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeDid) {
        setError("No active identity found. Please go to the Keys tab.");
        return;
    }

    setIsSigning(true);
    setError(null);
    setPresentation(null);

    try {
      const vpJson = await invoke<string>('sign_auth_challenge', {
          challenge: challenge,
          didId: activeDid
      });
      // Format the returned JSON for nice display
      const parsedVp = JSON.parse(vpJson);
      setPresentation(JSON.stringify(parsedVp, null, 2));
    } catch (err: any) {
      setError(err.toString());
    } finally {
      setIsSigning(false);
    }
  };

  return (
    <div className="component-container">
      <h2>Sovereign Signer</h2>
      <p>Sign an authentication challenge using your secure Vault identity.</p>

      {error && <div className="error-message">{error}</div>}

      <form onSubmit={handleSign} className="section sign-form">
        <div className="form-group">
          <label>Signer Identity</label>
          <div className="did-display muted">
            {activeDid ? activeDid : "No active identity (Check Keys tab)"}
          </div>
        </div>

        <div className="form-group">
          <label>IdP Challenge (JSON or String)</label>
          <textarea
            value={challenge}
            onChange={e => setChallenge(e.target.value)}
            placeholder='e.g., "auth-challenge-uuid-1234"'
            rows={4}
            required
          />
        </div>

        <button type="submit" disabled={isSigning || !activeDid || !challenge}>
          {isSigning ? 'Signing in Secure Enclave...' : 'Sign Challenge'}
        </button>
      </form>

      {presentation && (
        <div className="section result">
          <h3>Verifiable Presentation (VP)</h3>
          <p className="success-text">Successfully signed by Vault.</p>
          <pre className="json-display">
            {presentation}
          </pre>
        </div>
      )}
    </div>
  );
}
