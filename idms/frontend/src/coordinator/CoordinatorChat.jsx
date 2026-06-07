import { useEffect, useRef, useState, useCallback } from 'react';
import { getConversations, postCoordinatorMessage, closeHandoff } from '../api.js';

/**
 * CoordinatorChat
 * A sliding drawer that lets a coordinator chat directly with a donor.
 * The AI is blocked server-side while this handoff is open.
 *
 * Props:
 *   handoff   — { donor_id, patient_id, donor_message, flagged_at }
 *   onClose   — called after handoff is closed
 */
export function CoordinatorChat({ handoff, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [closing, setClosing] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const bottomRef = useRef(null);
  const pollRef = useRef(null);

  const loadHistory = useCallback(async () => {
    try {
      const data = await getConversations(handoff.donor_id, handoff.patient_id);
      const msgs = Array.isArray(data?.messages)
        ? data.messages
        : Array.isArray(data)
        ? data
        : [];
      setMessages(msgs);
    } catch {
      // silently keep old messages
    } finally {
      setLoadingHistory(false);
    }
  }, [handoff.donor_id, handoff.patient_id]);

  // Load history on open + poll every 5s for new messages
  useEffect(() => {
    loadHistory();
    pollRef.current = setInterval(loadHistory, 5000);
    return () => clearInterval(pollRef.current);
  }, [loadHistory]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await postCoordinatorMessage(handoff.donor_id, handoff.patient_id, text);
      setDraft('');
      await loadHistory();
    } catch {
      // silent
    } finally {
      setSending(false);
    }
  };

  const handleClose = async () => {
    setClosing(true);
    try {
      await closeHandoff(handoff.donor_id, handoff.patient_id);
      onClose();
    } catch {
      setClosing(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Role → display config
  const roleConfig = {
    user:        { label: '🩸 Donor',       bg: 'rgba(49,130,206,0.12)', align: 'flex-start', color: '#2b6cb0' },
    assistant:   { label: '🤖 AI (Priya)',  bg: 'rgba(113,128,150,0.10)', align: 'flex-start', color: '#4a5568' },
    coordinator: { label: '👤 Coordinator', bg: 'rgba(56,161,105,0.14)', align: 'flex-end',   color: '#276749' },
  };

  function shortId(id) {
    if (!id) return '—';
    const s = String(id);
    return s.length > 14 ? s.slice(0, 14) + '…' : s;
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={handleClose}
        style={{
          position: 'fixed', inset: 0,
          background: 'rgba(0,0,0,0.45)',
          zIndex: 1000,
          backdropFilter: 'blur(2px)',
        }}
      />

      {/* Drawer */}
      <div style={{
        position: 'fixed',
        top: 0, right: 0,
        width: 'min(480px, 100vw)',
        height: '100vh',
        background: 'var(--surface, #1a1d2e)',
        borderLeft: '1.5px solid rgba(229,62,62,0.3)',
        zIndex: 1001,
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '-8px 0 40px rgba(0,0,0,0.4)',
      }}>

        {/* Header */}
        <div style={{
          padding: '1rem 1.25rem',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: 'linear-gradient(135deg, rgba(229,62,62,0.15), rgba(229,62,62,0.05))',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{
                  width: 10, height: 10, borderRadius: '50%',
                  background: '#e53e3e',
                  display: 'inline-block',
                  boxShadow: '0 0 6px #e53e3e',
                  animation: 'pulse 1.2s infinite',
                }} />
                Coordinator Chat — LIVE
              </div>
              <div style={{ fontSize: '0.75rem', opacity: 0.65, marginTop: 2 }}>
                Donor: <code style={{ fontSize: '0.72rem' }}>{shortId(handoff.donor_id)}</code>
                {' · '}Patient: <code style={{ fontSize: '0.72rem' }}>{shortId(handoff.patient_id)}</code>
              </div>
            </div>
            <button
              onClick={handleClose}
              style={{
                background: 'transparent', border: 'none',
                color: 'inherit', fontSize: '1.3rem',
                cursor: 'pointer', opacity: 0.6,
                lineHeight: 1,
              }}
            >✕</button>
          </div>

          {/* Flagged message banner */}
          {handoff.donor_message && (
            <div style={{
              marginTop: '0.75rem',
              padding: '8px 12px',
              borderRadius: 8,
              background: 'rgba(229,62,62,0.1)',
              border: '1px solid rgba(229,62,62,0.3)',
              fontSize: '0.78rem',
            }}>
              <span style={{ fontWeight: 700, color: '#e53e3e' }}>⚠ Uncertain response flagged:</span>
              <br />
              <em>"{handoff.donor_message}"</em>
            </div>
          )}

          <div style={{
            marginTop: '0.5rem',
            fontSize: '0.72rem',
            opacity: 0.55,
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
          }}>
            🤖 AI is paused — you are now in control
          </div>
        </div>

        {/* Message thread */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.6rem',
        }}>
          {loadingHistory ? (
            <div style={{ textAlign: 'center', opacity: 0.5, marginTop: '2rem' }}>Loading conversation…</div>
          ) : messages.length === 0 ? (
            <div style={{ textAlign: 'center', opacity: 0.4, marginTop: '2rem', fontSize: '0.85rem' }}>
              No messages yet. Start the conversation below.
            </div>
          ) : (
            messages.map((msg, i) => {
              const cfg = roleConfig[msg.role] || roleConfig.user;
              const ts = msg.timestamp ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
              return (
                <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: cfg.align }}>
                  <div style={{
                    maxWidth: '85%',
                    background: cfg.bg,
                    borderRadius: msg.role === 'coordinator' ? '12px 12px 3px 12px' : '12px 12px 12px 3px',
                    padding: '8px 12px',
                    fontSize: '0.84rem',
                    lineHeight: 1.5,
                    border: `1px solid ${cfg.color}22`,
                  }}>
                    <div style={{ fontSize: '0.68rem', fontWeight: 700, color: cfg.color, marginBottom: 2 }}>
                      {cfg.label}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.message}</div>
                  </div>
                  {ts && (
                    <div style={{ fontSize: '0.65rem', opacity: 0.4, marginTop: 2, padding: '0 4px' }}>{ts}</div>
                  )}
                </div>
              );
            })
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input area */}
        <div style={{
          padding: '0.875rem 1rem',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          display: 'flex',
          gap: '0.5rem',
          alignItems: 'flex-end',
        }}>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message to the donor… (Enter to send)"
            rows={2}
            style={{
              flex: 1,
              resize: 'none',
              background: 'rgba(255,255,255,0.06)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 8,
              color: 'inherit',
              padding: '8px 10px',
              fontSize: '0.85rem',
              outline: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.5,
            }}
          />
          <button
            onClick={handleSend}
            disabled={sending || !draft.trim()}
            style={{
              background: '#3182ce',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '8px 14px',
              fontWeight: 700,
              fontSize: '0.85rem',
              cursor: sending || !draft.trim() ? 'not-allowed' : 'pointer',
              opacity: sending || !draft.trim() ? 0.5 : 1,
              whiteSpace: 'nowrap',
              alignSelf: 'stretch',
            }}
          >
            {sending ? '⏳' : '↑ Send'}
          </button>
        </div>

        {/* Footer — close handoff */}
        <div style={{
          padding: '0.75rem 1rem',
          borderTop: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          background: 'rgba(0,0,0,0.15)',
        }}>
          <span style={{ fontSize: '0.75rem', opacity: 0.5 }}>
            Closing will let AI resume the conversation.
          </span>
          <button
            onClick={handleClose}
            disabled={closing}
            style={{
              background: 'transparent',
              color: '#38a169',
              border: '1.5px solid #38a169',
              borderRadius: 8,
              padding: '6px 14px',
              fontWeight: 700,
              fontSize: '0.8rem',
              cursor: closing ? 'not-allowed' : 'pointer',
              opacity: closing ? 0.6 : 1,
            }}
          >
            {closing ? '⏳ Closing…' : '✅ Close Handoff & Resume AI'}
          </button>
        </div>
      </div>
    </>
  );
}
